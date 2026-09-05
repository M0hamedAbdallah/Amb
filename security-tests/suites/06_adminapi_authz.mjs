// ─────────────────────────────────────────────────────────────────────────
// 06_adminapi_authz.mjs — Edge Function admin-api role gating (API1 BOLA /
// API5 BFLA). The function is the single privileged gateway for the web
// admin console, so its authz matrix is the crown-jewel check:
//   anon / garbage JWT        → 401 for everything
//   customer / vendor         → 403 for everything
//   support                   → only SUPPORT_ACTIONS (me, complaints_list,
//                               complaint_set_status[reviewing], support_*)
//   admin                     → everything
// Probes with random UUIDs / read-only actions only — no real rows mutated.
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, finding } from '../lib/harness.mjs';
import { adminApi, fnCall, session, ENV, FX, cust1, vendor, support, admin } from '../lib/api.mjs';

const DEAD_UUID = '00000000-0000-0000-0000-00000000dead';

// Representative admin-only actions across every privilege wing.
const ADMIN_ONLY_ACTIONS = [
  ['stats', {}],
  ['analytics', { days: 7 }],
  ['users_list', {}],
  ['user_set_role', { id: DEAD_UUID, role: 'admin' }],
  ['user_set_active', { id: DEAD_UUID, is_active: false }],
  ['vendors_list', {}],
  ['vendor_verify', { id: DEAD_UUID }],
  ['orders_list', {}],
  ['order_force_cancel', { id: DEAD_UUID, reason: 'sec-test' }],
  ['complaint_resolve', { id: DEAD_UUID, sanction: 'none' }],
  ['withdrawals_list', {}],
  ['withdrawal_process', { id: DEAD_UUID, process: 'approve' }],
  ['promos_list', {}],
  ['promo_create', { code: 'SECTEST', discount_type: 'fixed', discount_value: 1 }],
  ['settings_get', {}],
  ['settings_update', { settings: { commission_pct: '10' } }],
  ['referrals_stats', {}],
];

const SUPPORT_ALLOWED = ['me', 'complaints_list', 'support_lookup'];

export async function run() {
  suite('06 admin-api authorization matrix');

  await t('admin-api rejects anon (no Authorization header)', async () => {
    const res = await adminApi('stats', {});
    if (res.status !== 401) {
      finding('Critical', 'admin-api answers without a JWT', 'HTTP ' + res.status + ' ' + String(res.text).slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });

  await t('admin-api rejects garbage bearer token', async () => {
    const res = await fnCall('admin-api', 'Bearer not.a.jwt', { action: 'stats' });
    if (res.status !== 401) {
      finding('Critical', 'admin-api accepts invalid JWT', 'HTTP ' + res.status + ' ' + String(res.text).slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });

  await t('admin-api rejects well-formed but forged JWT (bad signature)', async () => {
    // cust1's real token with a mangled signature — server-side getUser()
    // must reject it.
    const c1 = await cust1();
    const parts = c1.token.split('.');
    parts[2] = parts[2].slice(0, -4) + 'AAAA';
    const res = await fnCall('admin-api', 'Bearer ' + parts.join('.'), { action: 'stats' });
    if (res.status !== 401) {
      finding('Critical', 'admin-api accepts JWT with tampered signature', 'HTTP ' + res.status);
    }
    return 'HTTP ' + res.status;
  });

  await t('admin-api rejects the anon key as Authorization', async () => {
    const res = await fnCall('admin-api', 'Bearer ' + ENV.ANON_KEY, { action: 'stats' });
    if (res.status !== 401) {
      finding('Critical', 'admin-api accepts the anon key as a user JWT', 'HTTP ' + res.status);
    }
    return 'HTTP ' + res.status;
  });

  await t('admin-api rejects GET (method discipline)', async () => {
    const res = await fnCall('admin-api', undefined, undefined, 'GET');
    return res.status === 405 ? 'HTTP 405' : ('HTTP ' + res.status + ' (non-405 — check)');
  });

  await t('admin-api rejects malformed action name', async () => {
    const c1 = await cust1();
    const res = await fnCall('admin-api', c1.hdr, { action: 'DROP TABLE users' });
    if (res.status < 400) finding('Medium', 'admin-api accepts weird action names', 'HTTP ' + res.status);
    return 'HTTP ' + res.status;
  });

  // ── customer / vendor: everything must 403 ───────────────────────────────
  const c1 = await cust1();
  const v = await vendor();
  for (const who of [['cust1', c1], ['vendor', v]]) {
    let leaks = [];
    for (const [action, params] of ADMIN_ONLY_ACTIONS) {
      const res = await adminApi(action, params, who[1].hdr);
      if (res.status === 200) leaks.push(action);
    }
    await t(who[0] + ' is forbidden on every admin action (17 probed)', async () => {
      if (leaks.length) {
        finding('Critical', 'admin-api allows ' + who[0] + ' to run: ' + leaks.join(', '), 'Role check missing for these actions.');
      }
      return leaks.length ? 'LEAK: ' + leaks.join(',') : 'all 403';
    });
  }

  // ── support: narrow surface ──────────────────────────────────────────────
  const sup = await support();
  for (const action of SUPPORT_ALLOWED) {
    await t('support CAN call ' + action + ' (by-design)', async () => {
      const res = await adminApi(action, action === 'support_lookup' ? { q: 'sec+' } : {}, sup.hdr);
      if (res.status === 403) {
        finding('Low', 'support blocked from allowed action ' + action, 'console would break — functional regression');
      }
      return 'HTTP ' + res.status;
    });
  }

  const SUPPORT_DENIED = ADMIN_ONLY_ACTIONS.filter(([a]) => !SUPPORT_ALLOWED.includes(a));
  let supLeaks = [];
  for (const [action, params] of SUPPORT_DENIED) {
    const res = await adminApi(action, params, sup.hdr);
    if (res.status === 200) supLeaks.push(action);
  }
  await t('support is forbidden on all admin-only actions', async () => {
    if (supLeaks.length) {
      finding('Critical', 'admin-api allows SUPPORT role to run: ' + supLeaks.join(', '), 'Support must be limited to triage/read.');
    }
    return supLeaks.length ? 'LEAK: ' + supLeaks.join(',') : 'all 403';
  });

  await t('support cannot set complaint status beyond reviewing', async () => {
    for (const status of ['resolved', 'rejected', 'open']) {
      const res = await adminApi('complaint_set_status', { id: DEAD_UUID, status }, sup.hdr);
      if (res.status === 200) {
        finding('High', 'support can set complaint status=' + status, 'Support triage must be reviewing-only.');
        return 'LEAK: status ' + status + ' accepted';
      }
    }
    return 'resolved/rejected/open all refused';
  });

  // ── deactivated account (FX.off): must be 401 everywhere ─────────────────
  await t('deactivated account (is_active=false) gets no access', async () => {
    let res;
    try {
      const off = await session(FX.off);
      res = await adminApi('complaints_list', {}, off.hdr);
    } catch (e) {
      return 'login refused (' + String(e.message).slice(0, 60) + ')';
    }
    if (res.status === 200) {
      finding('High', 'Deactivated account can still call admin-api', 'authenticate() checks profiles.is_active — bypassed?');
    }
    return 'HTTP ' + res.status;
  });

  // ── admin sanity ─────────────────────────────────────────────────────────
  await t('admin fixture CAN call stats (sanity)', async () => {
    const a = await admin();
    const res = await adminApi('stats', {}, a.hdr);
    if (res.status !== 200) return 'HTTP ' + res.status + ' — admin fixture broken? (fixture issue, not vuln)';
    const s = JSON.stringify(res.json?.data ?? {});
    return 'ok, ' + s.length + ' bytes';
  });

  await t('admin cannot change own role (self-lockout guard)', async () => {
    const a = await admin();
    const res = await adminApi('user_set_role', { id: a.uid, role: 'customer' }, a.hdr);
    if (res.status === 200) {
      finding('Low', 'admin can change own role', 'Self-demotion/escalation footgun (guarded in code — check regression).');
    }
    return 'HTTP ' + res.status;
  });
}
