// ─────────────────────────────────────────────────────────────────────────
// 07_adminapi_abuse.mjs — hostile PARAMETERS from an authorized admin
// session (OWASP API3 property-level + filter injection). The function
// builds every query through the supabase-js query builder with sanitized
// inputs (searchTerm regex, UUID_RE, enum whitelists, numeric clamps) —
// these probes try to defeat each of those guards. Side-effect-free by
// design: filters run against real reads; writes target dead UUIDs.
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, finding } from '../lib/harness.mjs';
import { adminApi, admin } from '../lib/api.mjs';

const DEAD_UUID = '00000000-0000-0000-0000-00000000dead';

export async function run() {
  suite('07 admin-api parameter abuse');
  const a = await admin();

  // ── users_list: search-term filter injection ─────────────────────────────
  const injectTerms = [
    ['comma+or-breakout', '%,phone.ilike.%'],
    ['paren-close', ')),('],
    ['postgrest operator', 'phone.eq.01000000000'],
    ['dot-wildcard', '...%.%'],
    ['unicode control', 'a%09b'],
  ];
  for (const [label, payload] of injectTerms) {
    await t('users_list q is inert to filter injection (' + label + ')', async () => {
      const res = await adminApi('users_list', { q: payload }, a.hdr);
      const body = JSON.stringify(res.json ?? res.text ?? '');
      // A broken .or() filter → PostgREST 400 surfaced as server_error 500.
      if (res.status >= 500 || /error/i.test(body.slice(0, 40))) {
        finding('Medium', 'users_list filter injection breaks query (' + label + ')', body.slice(0, 150));
      }
      return 'HTTP ' + res.status;
    });
  }

  await t('users_list ignores non-whitelisted role filter', async () => {
    const res = await adminApi('users_list', { role: "customer' or 1=1--" }, a.hdr);
    if (res.status >= 500) {
      finding('Medium', 'users_list role filter not sanitized', String(res.text).slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });

  // ── orders_list: status regex + limit clamp ──────────────────────────────
  await t('orders_list status regex-injection payload is inert', async () => {
    const res = await adminApi('orders_list', { status: 'pending,in(1,2' }, a.hdr);
    if (res.status >= 500) {
      finding('Medium', 'orders_list status filter injection reaches query', String(res.text).slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });

  await t('orders_list limit is clamped (requested 999999)', async () => {
    const res = await adminApi('orders_list', { limit: 999999 }, a.hdr);
    const rows = Array.isArray(res.json?.data) ? res.json.data : [];
    if (res.status === 200 && rows.length > 500) {
      finding('Low', 'orders_list limit not clamped to 500', rows.length + ' rows returned');
    }
    return 'HTTP ' + res.status + ', ' + rows.length + ' rows';
  });

  await t('analytics days is clamped (requested 999999)', async () => {
    const res = await adminApi('analytics', { days: 999999 }, a.hdr);
    if (res.status === 200 && res.json?.data?.days > 365) {
      finding('Low', 'analytics days not clamped to 365', 'days=' + res.json.data.days);
    }
    return 'HTTP ' + res.status + (res.json?.data ? ' days=' + res.json.data.days : '');
  });

  // ── settings_update: key allow-list ──────────────────────────────────────
  await t('settings_update rejects hostile keys (SQL/metachars)', async () => {
    const res = await adminApi('settings_update', {
      settings: { "x'; drop table system_settings;--": '1', 'ok_key_sectest': '1' },
    }, a.hdr);
    if (res.status >= 500) {
      finding('Medium', 'settings_update key injection reaches query', String(res.text).slice(0, 150));
    }
    return 'HTTP ' + res.status + ' ' + JSON.stringify(res.json ?? {}).slice(0, 60);
  });

  await t('settings_update rejects array/object payload', async () => {
    const res = await adminApi('settings_update', { settings: ['a', 'b'] }, a.hdr);
    if (res.status === 200) finding('Low', 'settings_update accepted an array', 'type confusion');
    return 'HTTP ' + res.status;
  });

  // ── promo_create: code sanitization ──────────────────────────────────────
  let createdPromoId = null;
  await t('promo_create sanitizes code metacharacters', async () => {
    const res = await adminApi('promo_create', {
      code: 'sec<script>alert(1)</script>TEST',
      discount_type: 'fixed', discount_value: 1,
    }, a.hdr);
    const row = res.json?.data;
    if (res.status === 200 && row) {
      createdPromoId = row.id;
      if (!/^[A-Z0-9_-]+$/.test(row.code)) {
        finding('Low', 'promo_create keeps dangerous chars in code', JSON.stringify(row.code));
      }
      return 'code=' + JSON.stringify(row.code);
    }
    return 'HTTP ' + res.status;
  });

  await t('promo_create rejects zero/negative discount', async () => {
    const res = await adminApi('promo_create', { code: 'SECTEST0', discount_value: 0 }, a.hdr);
    if (res.status === 200) {
      finding('Low', 'promo_create accepts zero discount', 'creates useless rows');
      createdPromoId = res.json?.data?.id ?? createdPromoId;
    }
    return 'HTTP ' + res.status;
  });

  await t('sec-test promo deleted (cleanup)', async () => {
    if (!createdPromoId) return 'nothing to clean up';
    const res = await adminApi('promo_delete', { id: createdPromoId }, a.hdr);
    return 'HTTP ' + res.status;
  });

  // ── UUID / enum validation on write actions (dead ids → 400, never 500) ──
  const badParamProbes = [
    ['user_set_active non-uuid', 'user_set_active', { id: "1' or '1'='1", is_active: false }],
    ['user_set_role bad enum', 'user_set_role', { id: DEAD_UUID, role: 'superadmin' }],
    ['vendor_verify non-uuid', 'vendor_verify', { id: 'not-a-uuid' }],
    ['order_force_cancel empty reason', 'order_force_cancel', { id: DEAD_UUID, reason: '   ' }],
    ['complaint_resolve bad sanction', 'complaint_resolve', { id: DEAD_UUID, sanction: 'execute' }],
    ['withdrawal_process bad action', 'withdrawal_process', { id: DEAD_UUID, process: 'steal' }],
    ['support_send_message non-uuid order', 'support_send_message', { order_id: "x'; drop", body: 'hi' }],
    ['support_order_messages non-uuid', 'support_order_messages', { order_id: '../../etc/passwd' }],
  ];
  for (const [label, action, params] of badParamProbes) {
    await t(action + ' rejects hostile params (' + label + ')', async () => {
      const res = await adminApi(action, params, a.hdr);
      if (res.status >= 500) {
        finding('Medium', action + ' 500s on hostile params (' + label + ')', String(res.text).slice(0, 150));
      }
      if (res.status === 200) {
        finding('High', action + ' accepted hostile params (' + label + ')', String(res.text).slice(0, 150));
      }
      return 'HTTP ' + res.status;
    });
  }

  // ── support_lookup: lookup by hostile term ───────────────────────────────
  await t('support_lookup sanitizes hostile search term', async () => {
    const res = await adminApi('support_lookup', { q: '01000000000,phone.ilike.%' }, a.hdr);
    if (res.status >= 500) {
      finding('Medium', 'support_lookup filter injection breaks query', String(res.text).slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });

  await t('support_lookup "order:" prefix cannot smuggle operators', async () => {
    const res = await adminApi('support_lookup', { q: 'order: ' + DEAD_UUID + '&select=*' }, a.hdr);
    if (res.status >= 500) {
      finding('Medium', 'support_lookup order-prefix injection', String(res.text).slice(0, 150));
    }
    return 'HTTP ' + res.status;
  });
}
