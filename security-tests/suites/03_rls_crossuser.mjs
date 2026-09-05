// ─────────────────────────────────────────────────────────────────────────
// 03_rls_crossuser.mjs — authenticated cross-user access (BOLA/IDOR) and
// privilege self-escalation. Fixtures: cust1, cust2, vendor.
// Highest-priority probe: profiles UPDATE policy (0016) pins only
// wallet_balance — nothing in any migration pins `role`, so a self-UPDATE
// to role='admin' may succeed. If it does: CRITICAL + immediate self-heal.
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, expect, finding, getState } from '../lib/harness.mjs';
import { restGet, restWrite, cust1, cust2, vendor } from '../lib/api.mjs';

export async function run() {
  suite('03 cross-user RLS (BOLA/IDOR)');
  const inv = getState().inventory;
  inv.uid = inv.uid ?? {};

  const c1 = await cust1();
  const c2 = await cust2();
  inv.uid.cust1 = c1.uid;
  inv.uid.cust2 = c2.uid;
  const randomOrderId = '00000000-0000-0000-0000-00000000dead';

  // cust1 reads cust2's rows on every sensitive table → must be empty.
  const probes = [
    ['profiles', { id: 'eq.' + c2.uid }],
    ['orders', { customer_id: 'eq.' + c2.uid }],
    ['wallet_transactions', { user_id: 'eq.' + c2.uid }],
    ['withdrawals', { user_id: 'eq.' + c2.uid }],
    ['complaints', { reporter_id: 'eq.' + c2.uid }],
    ['promo_usages', { user_id: 'eq.' + c2.uid }],
    ['referral_credits', { referrer_id: 'eq.' + c2.uid }],
    ['messages', { order_id: 'eq.' + randomOrderId }],
  ];
  for (const [table, q] of probes) {
    await t('cust1 cannot read cust2 rows in ' + table, async () => {
      const res = await restGet(table, c1.hdr, { select: '*', ...q });
      const rows = Array.isArray(res.json) ? res.json : [];
      if (res.status === 200 && rows.length > 0) {
        finding('High', 'Cross-user read leak on ' + table, 'cust1 fetched ' + rows.length + ' of cust2 rows: ' + JSON.stringify(rows[0]).slice(0, 120));
      }
      return rows.length + ' rows';
    });
  }

  await t('vendor cannot read orders it is NOT assigned to', async () => {
    const v = await vendor();
    // Vendor's own vendors row — orders with this vendor_id are legitimately
    // readable by the vendor (RLS policy allows participant reads).
    const vrow = await restGet('vendors', v.hdr, { select: 'id', user_id: 'eq.' + v.uid });
    const ownVendorId = vrow.json?.[0]?.id ?? null;
    const res = await restGet('orders', v.hdr, { select: 'id,vendor_id', customer_id: 'eq.' + c1.uid });
    const rows = Array.isArray(res.json) ? res.json : [];
    const foreign = rows.filter((r) => r.vendor_id !== ownVendorId);
    if (foreign.length) {
      finding('High', 'Vendor can read orders it is not assigned to', foreign.length + ' rows not assigned to this vendor');
    }
    return rows.length + ' rows, ' + foreign.length + ' foreign (own-assigned reads are by-design)';
  });

  await t('cust1 cannot read vendor-only tables (order_rejections)', async () => {
    const res = await restGet('order_rejections', c1.hdr, { select: '*', limit: '5' });
    const rows = Array.isArray(res.json) ? res.json : [];
    if (rows.length) finding('Medium', 'order_rejections readable by customers', rows.length + ' rows');
    return rows.length + ' rows (expected 0 — deny-all)';
  });

  await t('cust1 cannot read payment_events', async () => {
    const res = await restGet('payment_events', c1.hdr, { select: '*', limit: '5' });
    const rows = Array.isArray(res.json) ? res.json : [];
    if (rows.length) finding('High', 'payment_events readable by customers', rows.length + ' rows');
    return rows.length + ' rows (expected 0 — deny-all)';
  });

  // ── Self-escalation probes ───────────────────────────────────────────────
  await t('cust1 cannot UPDATE cust2 profile (role)', async () => {
    const res = await restWrite('profiles', 'PATCH', c1.hdr, { role: 'admin' }, { id: 'eq.' + c2.uid });
    const affected = Array.isArray(res.json) ? res.json.length : 0;
    if (affected > 0) {
      finding('Critical', 'User can change ANOTHER user role to admin', 'cust1 promoted cust2');
      // self-heal is impossible from cust1; flag for immediate manual fix
    }
    return 'affected ' + affected;
  });

  await t('cust1 cannot set own wallet_balance', async () => {
    const res = await restWrite('profiles', 'PATCH', c1.hdr, { wallet_balance: 999999 }, { id: 'eq.' + c1.uid });
    const affected = Array.isArray(res.json) ? res.json.length : 0;
    const balanceOk = affected === 0 || Number(res.json[0]?.wallet_balance ?? 0) < 9999;
    if (affected > 0 && !balanceOk) finding('Critical', 'User can set own wallet_balance directly', 'balance now ' + res.json[0].wallet_balance);
    return affected === 0 ? 'blocked' : 'allowed but value pinned (' + res.json[0]?.wallet_balance + ')';
  });

  await t('CRITICAL PROBE: cust1 self-promote role=admin via direct PATCH', async () => {
    const res = await restWrite('profiles', 'PATCH', c1.hdr, { role: 'admin' }, { id: 'eq.' + c1.uid });
    const affected = Array.isArray(res.json) ? res.json.length : 0;
    const newRole = res.json?.[0]?.role;
    if (affected > 0 && newRole === 'admin') {
      finding('Critical', 'PRIVILEGE ESCALATION: any user can self-promote to admin via profiles.role PATCH', 'profiles UPDATE policy (0016) pins only wallet_balance; role column is writable by the owner. Attack: PATCH /rest/v1/profiles?id=eq.<self> {role:"admin"} then use the full admin-api console. Immediate self-heal applied by test (role reverted).');
      // self-heal immediately — revert to customer
      const undo = await restWrite('profiles', 'PATCH', c1.hdr, { role: 'customer' }, { id: 'eq.' + c1.uid });
      return 'ESCALATED then reverted (undo affected ' + (Array.isArray(undo.json) ? undo.json.length : 0) + ')';
    }
    return 'blocked (HTTP ' + res.status + ')';
  });

  await t('cust1 cannot UPDATE others order status', async () => {
    const res = await restWrite('orders', 'PATCH', c1.hdr, { status: 'delivered' }, { id: 'eq.' + randomOrderId });
    const affected = Array.isArray(res.json) ? res.json.length : 0;
    if (affected > 0) finding('High', 'Customer can UPDATE arbitrary orders', 'affected ' + affected);
    return 'affected ' + affected;
  });

  await t('cust1 cannot insert wallet_transactions', async () => {
    const res = await restWrite('wallet_transactions', 'POST', c1.hdr, {
      user_id: c1.uid, type: 'credit', amount: '500', description: 'sec-test-forge',
    });
    if (res.status < 400) {
      finding('Critical', 'User can forge wallet_transactions', 'HTTP ' + res.status);
      // self-heal attempt: delete own row (probably blocked too)
      await restWrite('wallet_transactions', 'DELETE', c1.hdr, undefined, { description: 'eq.sec-test-forge' });
    }
    return 'HTTP ' + res.status;
  });

  await t('cust1 cannot insert withdrawals directly', async () => {
    const res = await restWrite('withdrawals', 'POST', c1.hdr, {
      user_id: c1.uid, amount: '10', method: 'vodafone_cash',
    });
    if (res.status < 400) {
      finding('Critical', 'User can insert withdrawals directly', 'HTTP ' + res.status + ' — bypasses request_withdrawal balance check');
      const id = res.json?.[0]?.id ?? res.json?.id;
      if (id) await restWrite('withdrawals', 'DELETE', c1.hdr, undefined, { id: 'eq.' + id });
    }
    return 'HTTP ' + res.status;
  });
}
