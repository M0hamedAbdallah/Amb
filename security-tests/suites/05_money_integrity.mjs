// ─────────────────────────────────────────────────────────────────────────
// 05_money_integrity.mjs — business-flow money abuse (OWASP API6/ API8):
// withdrawal validation + idempotency (0018 arbiter), order quantity /
// wallet-payment validation (0005/ 0023), promo validation (0008), and the
// Kashier edge functions' webhook-signature posture (0023/ 0024).
//
// Safety: all mutations use tiny amounts (1 EGP) on fixture accounts with an
// undeliverable domain, and created orders are cancelled in cleanup. Over-
// balance / negative probes must FAIL, so they mutate nothing.
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, finding, getState } from '../lib/harness.mjs';
import { rpc, restGet, fnCall, cust1, vendor } from '../lib/api.mjs';

const DEAD_UUID = '00000000-0000-0000-0000-00000000dead';

async function ownBalance(hdr, uid) {
  const res = await restGet('profiles', hdr, { select: 'wallet_balance', id: 'eq.' + uid });
  const rows = Array.isArray(res.json) ? res.json : [];
  return rows.length ? Number(rows[0].wallet_balance ?? 0) : null;
}

export async function run() {
  suite('05 money integrity (business-flow abuse)');
  const inv = getState().inventory;

  const c1 = await cust1();
  const v = await vendor();

  // Vendor's own row (RLS: vendors can read own row). Needed for create_order.
  let vendorRow = null;
  await t('vendor fixture has a readable vendor row', async () => {
    const res = await restGet('vendors', v.hdr, {
      select: 'id,business_name,small_price,large_price,small_stock,large_stock,is_active,is_verified',
      user_id: 'eq.' + v.uid,
    });
    const rows = Array.isArray(res.json) ? res.json : [];
    vendorRow = rows[0] ?? null;
    inv.vendorRow = vendorRow;
    if (!vendorRow) return 'no vendor row — order probes fall back to dead-uuid negatives';
    return rows[0].business_name + ' (' + rows[0].id + ')';
  });

  // ── request_withdrawal validation (0007/ 0018) ───────────────────────────
  const wd = async (args, hdr = c1.hdr) => rpc('request_withdrawal', args, hdr);

  await t('withdrawal with negative amount rejected', async () => {
    const res = await wd({ p_amount: -50, p_method: 'vodafone_cash' });
    const ok = res.status === 200 && res.json && !res.json.error;
    if (ok) finding('Critical', 'request_withdrawal accepts negative amount', JSON.stringify(res.json).slice(0, 150));
    return 'HTTP ' + res.status;
  });

  await t('withdrawal with zero amount rejected', async () => {
    const res = await wd({ p_amount: 0, p_method: 'vodafone_cash' });
    const ok = res.status === 200 && res.json && !res.json.error;
    if (ok) finding('Critical', 'request_withdrawal accepts zero amount', JSON.stringify(res.json).slice(0, 150));
    return 'HTTP ' + res.status;
  });

  await t('withdrawal above balance rejected (999999 EGP)', async () => {
    const res = await wd({ p_amount: 999999, p_method: 'vodafone_cash' });
    const ok = res.status === 200 && res.json && !res.json.error;
    if (ok) finding('Critical', 'request_withdrawal accepts amount above balance', JSON.stringify(res.json).slice(0, 150));
    return 'HTTP ' + res.status;
  });

  await t('withdrawal with invalid method rejected', async () => {
    const res = await wd({ p_amount: 1, p_method: 'bank_wire_international' });
    const ok = res.status === 200 && res.json && !res.json.error;
    if (ok) finding('Medium', 'request_withdrawal accepts arbitrary method enum', JSON.stringify(res.json).slice(0, 150));
    return 'HTTP ' + res.status;
  });

  await t('withdrawal idempotency: same key cannot double-withdraw (0018 arbiter)', async () => {
    const key = 'sectest-' + Date.now();
    const before = await ownBalance(c1.hdr, c1.uid);
    const r1 = await wd({ p_amount: 1, p_method: 'vodafone_cash', p_idempotency_key: key });
    const r2 = await wd({ p_amount: 1, p_method: 'vodafone_cash', p_idempotency_key: key });
    const after = await ownBalance(c1.hdr, c1.uid);
    if (before !== null && after !== null && before - after >= 2) {
      finding('High', 'Idempotency key ignored — repeated withdrawal double-deducts', 'balance ' + before + ' → ' + after);
    }
    const bodies = [r1, r2].map((r) => 'HTTP ' + r.status + ' ' + JSON.stringify(r.json ?? '').slice(0, 60));
    return 'before=' + before + ' after=' + after + ' | ' + bodies.join(' | ');
  });

  // ── create_order validation (0005/ 0023/ 0025) ───────────────────────────
  const co = (args) => rpc('create_order', args, c1.hdr);
  const baseOrder = () => vendorRow ? {
    p_vendor_id: vendorRow.id, p_size: 'small', p_quantity: 1,
    p_payment_method: 'cash', p_delivery_address: 'sec-test probe',
    p_delivery_lat: 30.0444, p_delivery_lng: 31.2357,
  } : { p_vendor_id: DEAD_UUID, p_size: 'small', p_quantity: 1, p_payment_method: 'cash' };

  const extractOrderId = (j) => j?.order?.id ?? j?.order_id ?? j?.id ?? j?.data?.order_id ?? null;

  await t('create_order rejects quantity 0', async () => {
    const res = await co({ ...baseOrder(), p_quantity: 0 });
    const ok = res.status === 200 && res.json && !res.json.error;
    if (ok) {
      finding('High', 'create_order accepts quantity 0', JSON.stringify(res.json).slice(0, 120));
      await rpc('cancel_order', { p_order_id: extractOrderId(res.json), p_reason: 'sec-test cleanup' }, c1.hdr);
    }
    return 'HTTP ' + res.status;
  });

  await t('create_order rejects negative quantity', async () => {
    const res = await co({ ...baseOrder(), p_quantity: -5 });
    const ok = res.status === 200 && res.json && !res.json.error;
    if (ok) {
      finding('Critical', 'create_order accepts negative quantity (money-printing vector)', JSON.stringify(res.json).slice(0, 120));
      await rpc('cancel_order', { p_order_id: extractOrderId(res.json), p_reason: 'sec-test cleanup' }, c1.hdr);
    }
    return 'HTTP ' + res.status;
  });

  await t('create_order rejects absurd quantity (100000)', async () => {
    const res = await co({ ...baseOrder(), p_quantity: 100000 });
    const ok = res.status === 200 && res.json && !res.json.error;
    if (ok) {
      finding('Medium', 'create_order accepts quantity 100000 (no stock/upper bound)', JSON.stringify(res.json).slice(0, 120));
      await rpc('cancel_order', { p_order_id: extractOrderId(res.json), p_reason: 'sec-test cleanup' }, c1.hdr);
    }
    return 'HTTP ' + res.status;
  });

  await t('create_order rejects invalid size enum', async () => {
    const res = await co({ ...baseOrder(), p_size: 'jumbo_xxl_free' });
    const ok = res.status === 200 && res.json && !res.json.error;
    if (ok) {
      finding('Medium', 'create_order accepts arbitrary size', JSON.stringify(res.json).slice(0, 120));
      await rpc('cancel_order', { p_order_id: extractOrderId(res.json), p_reason: 'sec-test cleanup' }, c1.hdr);
    }
    return 'HTTP ' + res.status;
  });

  await t('create_order rejects unknown vendor (dead uuid)', async () => {
    const res = await co({ ...baseOrder(), p_vendor_id: DEAD_UUID });
    const ok = res.status === 200 && res.json && !res.json.error;
    if (ok) {
      finding('High', 'create_order accepted a nonexistent vendor', JSON.stringify(res.json).slice(0, 120));
      await rpc('cancel_order', { p_order_id: extractOrderId(res.json), p_reason: 'sec-test cleanup' }, c1.hdr);
    }
    return 'HTTP ' + res.status;
  });

  // ── One real round-trip order (created, then cancelled) ───────────────────
  let createdOrderId = null;
  await t('create_order happy path works for own account (then cancelled)', async () => {
    if (!vendorRow) return 'skipped — no vendor row';
    const res = await co(baseOrder());
    const ok = res.status === 200 && res.json && !res.json.error;
    if (!ok) return 'HTTP ' + res.status + ' (order flow unavailable — note only)';
    createdOrderId = extractOrderId(res.json);
    inv.orderId = createdOrderId;
    return 'created ' + createdOrderId;
  });

  await t('created sec-test order is cancelled (cleanup)', async () => {
    if (!createdOrderId) return 'nothing to clean up';
    const res = await rpc('cancel_order', { p_order_id: createdOrderId, p_reason: 'sec-test cleanup' }, c1.hdr);
    if (res.status === 200) inv.orderCancelled = true;
    return 'HTTP ' + res.status + ' ' + JSON.stringify(res.json ?? '').slice(0, 80);
  });

  // ── Promo validation (0008) ──────────────────────────────────────────────
  await t('preview_promo rejects negative cart total', async () => {
    const res = await rpc('preview_promo', { p_code: 'ANY', p_cart_total: -100 }, c1.hdr);
    const ok = res.status === 200 && res.json && !res.json.error && res.json.valid !== false;
    if (ok && Number(res.json.discount ?? 0) > 0) {
      finding('Medium', 'preview_promo computes discount on negative total', JSON.stringify(res.json).slice(0, 120));
    }
    return 'HTTP ' + res.status;
  });

  await t('preview_promo unknown code returns invalid (no crash)', async () => {
    const res = await rpc('preview_promo', { p_code: 'SECTEST_NOPE', p_cart_total: 100 }, c1.hdr);
    if (/sqlstate|syntax error/i.test(JSON.stringify(res.json ?? res.text ?? ''))) {
      finding('Medium', 'preview_promo leaks SQL errors on unknown code', String(res.text).slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });

  // ── Kashier edge functions (0023/ 0024) ──────────────────────────────────
  // The webhook acks 200 for garbage by design ("200 to stop retries") but
  // must NEVER verify or settle. A full forgery attempt supplies everything
  // the verification chain wants — correct User-Agent, a signatureKeys array,
  // a well-formed hex signature header — and only the HMAC itself is wrong.
  const forgedWebhook = (sig) => fnCall('kashier-webhook', undefined, {
    event: 'pay',
    data: {
      status: 'SUCCESS', orderRef: DEAD_UUID, amount: '1.00', currency: 'EGP',
      merchantId: 'MID-0000', orderId: DEAD_UUID, transactionId: 'sec-test',
      signatureKeys: ['amount', 'currency', 'merchantId', 'orderId', 'status', 'transactionId'],
    },
  }, 'POST', { 'user-agent': 'KASHIER', 'x-kashier-signature': sig });

  await t('kashier-webhook does NOT verify or settle a forged signature', async () => {
    const res = await forgedWebhook('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    const j = res.json ?? {};
    if (j.verified === true || j.settled === true) {
      finding('Critical', 'kashier-webhook settles with a forged HMAC signature', JSON.stringify(j).slice(0, 200));
    }
    return 'HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 100);
  });

  await t('kashier-webhook payload without signatureKeys is refused (no settle)', async () => {
    const res = await fnCall('kashier-webhook', undefined, {
      event: 'pay', data: { status: 'SUCCESS', orderRef: DEAD_UUID, amount: '1.00' },
    }, 'POST', { 'user-agent': 'KASHIER' });
    const j = res.json ?? {};
    if (j.settled === true) {
      finding('Critical', 'kashier-webhook settled a payload with no signatureKeys', JSON.stringify(j).slice(0, 200));
    }
    return 'HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 100);
  });

  await t('kashier-webhook rejects non-Kashier user-agent', async () => {
    // Forged sig but DEFAULT fetch user-agent — must not verify either.
    const res = await fnCall('kashier-webhook', undefined, {
      event: 'pay',
      data: {
        status: 'SUCCESS', orderRef: DEAD_UUID, amount: '1.00', currency: 'EGP',
        merchantId: 'MID-0000', orderId: DEAD_UUID, transactionId: 'sec-test',
        signatureKeys: ['amount', 'currency', 'merchantId', 'orderId', 'status', 'transactionId'],
      },
    }, 'POST', { 'x-kashier-signature': 'a'.repeat(64) });
    const j = res.json ?? {};
    if (j.verified === true || j.settled === true) {
      finding('Critical', 'kashier-webhook verified without Kashier UA', JSON.stringify(j).slice(0, 200));
    }
    return 'HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 100);
  });

  await t('kashier-checkout-status cannot be polled for a foreign order id', async () => {
    const res = await fnCall('kashier-checkout-status', c1.hdr, { orderId: DEAD_UUID });
    // 404/4xx expected — must NOT return another user's payment data.
    if (res.status === 200 && res.json && JSON.stringify(res.json).includes('paid')) {
      finding('High', 'kashier-checkout-status leaks payment state for foreign order', String(res.text).slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });

  await t('payment-redirect with garbage params fails cleanly', async () => {
    const res = await fnCall('payment-redirect', undefined, {}, 'GET');
    // GET with no query — expect 4xx/redirect, never a 500.
    if (res.status >= 500) finding('Low', 'payment-redirect 500s on empty request', 'HTTP ' + res.status);
    return 'HTTP ' + res.status;
  });
}
