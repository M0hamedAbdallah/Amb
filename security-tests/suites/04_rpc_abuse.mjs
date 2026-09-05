// ─────────────────────────────────────────────────────────────────────────
// 04_rpc_abuse.mjs — RPC-layer abuse: BFLA (function-level authorization)
// and injection probes. Two classes:
//   1. RPCs that must be UNREACHABLE by clients entirely (revoked EXECUTE
//      in 0008/0019/0020/0023/0024): rollback_promo, maybe_auto_suspend,
//      dispatch_engine_step, notify_dispatch_on_order_insert,
//      settle_kashier_payment, cancel_expired_awaiting_payments.
//   2. RPCs granted to authenticated but gated internally on role/ownership
//      (0010/0027): resolve_complaint, admin_process_withdrawal — a regular
//      user's call must return an auth error inside the JSON, never a
//      successful mutation.
// Injection probes hit parameterized text args with SQL payloads — a clean
// business error (not a 500 / SQLSTATE leak) proves parameter binding.
// All UUIDs are non-existent: nothing real is mutated in this suite.
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, finding } from '../lib/harness.mjs';
import { rpc, restGet, cust1, cust2 } from '../lib/api.mjs';

const DEAD_UUID = '00000000-0000-0000-0000-00000000dead';

// name -> args builder. Every probe targets a nonexistent row so a policy
// failure is the ONLY way a mutation could "succeed".
const REVOKED_RPCS = [
  ['rollback_promo', () => ({ p_code: 'X', p_user_id: DEAD_UUID, p_order_id: DEAD_UUID })],
  ['maybe_auto_suspend', () => ({ p_subject_kind: 'customer', p_subject_id: DEAD_UUID })],
  ['dispatch_engine_step', () => ({ p_order_id: DEAD_UUID })],
  ['notify_dispatch_on_order_insert', () => ({})],
  ['settle_kashier_payment', () => ({
    p_order_id: DEAD_UUID, p_payment_status: 'paid',
    p_kashier_transaction_id: 'sec-test', p_amount: 1,
  })],
  ['cancel_expired_awaiting_payments', () => ({})],
];

const ROLE_GATED_RPCS = [
  // resolve_complaint (0010/0019): granted to authenticated, must refuse non-admin.
  ['resolve_complaint', () => ({
    p_complaint_id: DEAD_UUID, p_action: 'none',
    p_admin_note: 'sec-test', p_suspend_until: null,
  })],
  // admin_process_withdrawal (0027): granted to anon+authenticated, must refuse non-admin.
  ['admin_process_withdrawal', () => ({
    p_withdrawal_id: DEAD_UUID, p_action: 'approve', p_admin_note: 'sec-test',
  })],
];

export async function run() {
  suite('04 rpc abuse (BFLA + injection)');

  const c1 = await cust1();
  const c2 = await cust2();

  // ── 1. Revoked EXECUTE probes ────────────────────────────────────────────
  for (const [name, args] of REVOKED_RPCS) {
    await t('cust1 cannot call revoked RPC ' + name, async () => {
      const res = await rpc(name, args(), c1.hdr);
      // Revoked functions are invisible to PostgREST: 404 function-not-found,
      // or 42501 permission denied. NEVER a 200 with executed results.
      const executed = res.status === 200;
      if (executed) {
        const body = JSON.stringify(res.json ?? res.text).slice(0, 150);
        finding('Critical', 'Revoked RPC ' + name + ' is callable by authenticated users', 'HTTP 200 body: ' + body);
      }
      return 'HTTP ' + res.status + (res.json?.message ? ' ' + String(res.json.message).slice(0, 60) : '');
    });
  }

  // ── 2. Role-gated RPCs as regular users ──────────────────────────────────
  for (const [name, args] of ROLE_GATED_RPCS) {
    await t('cust1 cannot run admin-gated RPC ' + name, async () => {
      const res = await rpc(name, args(), c1.hdr);
      const body = JSON.stringify(res.json ?? res.text).slice(0, 200);
      const refused =
        res.status >= 400 ||
        (res.json && typeof res.json === 'object' && res.json.error && !res.json.success);
      if (!refused) {
        finding('Critical', 'BFLA: ' + name + ' executed for a regular user', 'HTTP ' + res.status + ' body: ' + body);
      }
      return 'HTTP ' + res.status + ' ' + body.slice(0, 80);
    });
    await t('anon cannot run admin-gated RPC ' + name, async () => {
      const res = await rpc(name, args());
      const refused = res.status >= 400 || (res.json?.error && !res.json?.success);
      if (!refused) {
        finding('Critical', 'BFLA: ' + name + ' executed for ANON key', 'HTTP ' + res.status);
      }
      return 'HTTP ' + res.status;
    });
  }

  // ── 3. Ownership probes on customer-facing RPCs (foreign/dead ids) ───────
  await t('cust2 cannot cancel cust1-space order via cancel_order (dead id)', async () => {
    const res = await rpc('cancel_order', { p_order_id: DEAD_UUID, p_reason: 'sec-test' }, c2.hdr);
    const body = JSON.stringify(res.json ?? res.text).slice(0, 150);
    if (res.status === 200 && res.json && !res.json.error) {
      finding('High', 'cancel_order returned success for nonexistent order', body);
    }
    if (/sqlstate|syntax error|relation "|PG-/i.test(body)) {
      finding('Medium', 'cancel_order leaks SQL error details', body);
    }
    return 'HTTP ' + res.status + ' ' + body.slice(0, 80);
  });

  await t('cust2 cannot verify delivery on a foreign order (dead id)', async () => {
    const res = await rpc('verify_delivery', { p_order_id: DEAD_UUID, p_otp: '0000' }, c2.hdr);
    const body = JSON.stringify(res.json ?? res.text).slice(0, 150);
    if (res.status === 200 && res.json && !res.json.error) {
      finding('High', 'verify_delivery returned success for nonexistent order', body);
    }
    return 'HTTP ' + res.status + ' ' + body.slice(0, 80);
  });

  await t('cust2 cannot accept orders as vendor via vendor_accept_order (dead id)', async () => {
    const res = await rpc('vendor_accept_order', { p_order_id: DEAD_UUID }, c2.hdr);
    const body = JSON.stringify(res.json ?? res.text).slice(0, 150);
    const refused = res.status >= 400 || res.json?.error;
    if (!refused) finding('High', 'vendor_accept_order usable by a customer', body);
    return 'HTTP ' + res.status + ' ' + body.slice(0, 80);
  });

  await t('anon cancel_awaiting_payment on dead id refuses cleanly', async () => {
    // granted to anon in 0024 — must still gate on auth.uid() ownership.
    const res = await rpc('cancel_awaiting_payment', { p_order_id: DEAD_UUID, p_reason: 'sec-test' });
    const body = JSON.stringify(res.json ?? res.text).slice(0, 150);
    const refused = res.status >= 400 || res.json?.error;
    if (!refused) finding('High', 'anon can invoke cancel_awaiting_payment successfully', body);
    return 'HTTP ' + res.status + ' ' + body.slice(0, 80);
  });

  // ── 4. SQL injection probes on parameterized text args ───────────────────
  const sqli = [
    ["x' OR '1'='1", 'single-quote OR tautology'],
    ['%; DROP TABLE orders;--', 'statement injection'],
    ['${jndi:ldap://sectest.local}', 'template/log4j-style'],
  ];
  for (const [payload, label] of sqli) {
    await t('preview_promo p_code is inert to SQLi (' + label + ')', async () => {
      const res = await rpc('preview_promo', { p_code: payload, p_cart_total: 100 }, c1.hdr);
      const body = JSON.stringify(res.json ?? res.text);
      if (/sqlstate|syntax error|unterminated quoted|i'm sorry/i.test(body)) {
        finding('High', 'SQL error leak from preview_promo payload', body.slice(0, 150));
      }
      return 'HTTP ' + res.status;
    });
  }

  await t('cancel_order p_reason is inert to SQLi', async () => {
    const res = await rpc('cancel_order', {
      p_order_id: DEAD_UUID,
      p_reason: "'; UPDATE orders SET status='delivered';--",
    }, c1.hdr);
    const body = JSON.stringify(res.json ?? res.text);
    if (/sqlstate|syntax error/i.test(body)) {
      finding('High', 'SQL error leak from cancel_order p_reason', body.slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });

  await t('verify_delivery p_otp is inert to SQLi', async () => {
    const res = await rpc('verify_delivery', {
      p_order_id: DEAD_UUID, p_otp: "' OR '1'='1",
    }, c1.hdr);
    const body = JSON.stringify(res.json ?? res.text);
    if (/sqlstate|syntax error/i.test(body)) {
      finding('High', 'SQL error leak / possible OTP bypass via verify_delivery', body.slice(0, 150));
    }
    if (res.status === 200 && res.json?.success === true) {
      finding('Critical', 'OTP bypass: verify_delivery accepted SQLi OTP string on dead id', body.slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });

  // ── 5. Type confusion ────────────────────────────────────────────────────
  await t('request_withdrawal rejects non-numeric amount (type confusion)', async () => {
    const res = await rpc('request_withdrawal', {
      p_amount: '1; DELETE FROM withdrawals', p_method: 'vodafone_cash',
    }, c1.hdr);
    if (res.status < 400) {
      finding('High', 'request_withdrawal accepted non-numeric amount', 'HTTP ' + res.status);
    }
    return 'HTTP ' + res.status;
  });

  await t('get_referral_stats works for the caller (sanity, own data only)', async () => {
    const res = await rpc('get_referral_stats', {}, c1.hdr);
    if (res.status !== 200) return 'HTTP ' + res.status + ' (RPC unavailable?)';
    const s = JSON.stringify(res.json ?? '');
    // stats must not embed another user's phone/email.
    if (c2.uid && s.includes(c2.uid)) {
      finding('Medium', 'get_referral_stats leaks other-user refs', s.slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });
}
