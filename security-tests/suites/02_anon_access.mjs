// ─────────────────────────────────────────────────────────────────────────
// 02_anon_access.mjs — what the anon key alone can read/write. RLS should
// scope every business table to zero rows for anon; writes must 4xx.
// By-design public reads: promo_codes (active only), system_settings,
// spatial_ref_sys (postgis reference data, RLS per 0002).
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, expect, finding, getState } from '../lib/harness.mjs';
import { restGet, restWrite, ENV, bearer } from '../lib/api.mjs';

const PUBLIC_BY_DESIGN = new Set(['promo_codes', 'system_settings', 'spatial_ref_sys']);
// Vendor catalog (name/address/prices/stock/rating) is customer-facing and
// readable without login by design — but sensitive columns must stay hidden
// (checked in a dedicated test below).
const CATALOG_BY_DESIGN = new Set(['vendors']);

// Tables where an anon/client write must never succeed (money + identity).
const WRITE_TARGETS = [
  'profiles', 'orders', 'wallet_transactions', 'withdrawals', 'messages',
  'complaints', 'vendors', 'promo_codes', 'promo_usages', 'referral_credits',
  'order_ratings', 'order_rejections', 'payment_events', 'system_settings',
];

const FALLBACK_TABLES = [
  'profiles', 'vendors', 'orders', 'order_ratings', 'promo_codes', 'promo_usages',
  'referral_credits', 'complaints', 'wallet_transactions', 'withdrawals',
  'messages', 'system_settings', 'order_rejections', 'payment_events',
  'spatial_ref_sys',
];

export async function run() {
  suite('02 anon access (RLS read scope)');
  const inv = getState().inventory;
  const hdr = bearer(ENV.ANON_KEY);
  const tables = inv.tables?.length ? inv.tables : FALLBACK_TABLES;

  let leaked = [];
  let publicOk = [];
  let catalogOk = [];
  for (const table of tables) {
    const res = await restGet(table, hdr, { select: '*', limit: '3' });
    const rows = Array.isArray(res.json) ? res.json : [];
    if (res.status === 200 && rows.length > 0) {
      if (PUBLIC_BY_DESIGN.has(table)) publicOk.push(table);
      else if (CATALOG_BY_DESIGN.has(table)) catalogOk.push(table);
      else leaked.push(table + ' (' + rows.length + ' rows)');
    }
    // 4xx or 200-empty are both "blocked" for anon.
  }

  await t('anon cannot read any business table rows', async () => {
    if (leaked.length) {
      finding('High', 'Anon key can read business tables: ' + leaked.join(', '), 'RLS SELECT policies leak rows to the anon role.');
    }
    return leaked.length ? 'LEAK: ' + leaked.join(',') : 'all reads blocked (or 200-empty' + (catalogOk.length ? '; ' + catalogOk.join(',') + ' catalog readable by design' : '') + ')';
  });

  await t('vendors catalog exposes no sensitive columns to anon', async () => {
    // PostgREST answers 200 for a reachable column (even when the value is
    // null) and 400 for a hidden/nonexistent one — so column reachability is
    // observable without any populated data.
    const sensitive = ['national_id', 'national_id_url', 'business_license_url', 'user_id', 'warnings_count', 'suspended_until'];
    const exposed = [];
    for (const col of sensitive) {
      const res = await restGet('vendors', hdr, { select: col, limit: '1' });
      if (res.status === 200) exposed.push(col);
    }
    if (exposed.length) {
      finding('Medium', 'vendors table exposes sensitive columns to the anon key: ' + exposed.join(', '), 'Catalog rows are public by design, but national_id / KYC document URLs / user_id are PII. Currently null everywhere, yet any future vendor onboarding would leak them to unauthenticated callers. Restrict the anon SELECT policy to catalog columns (column-level policy or a public view).');
    }
    return exposed.length ? 'EXPOSED: ' + exposed.join(',') : 'only catalog columns reachable';
  });

  await t('by-design public tables readable', async () => {
    return publicOk.length ? 'public: ' + publicOk.join(',') : 'none readable (promo_codes/system_settings may be locked down tighter than 0001)';
  });

  await t('promo_codes leaks no inactive/admin rows to anon', async () => {
    const res = await restGet('promo_codes', hdr, { select: 'code,is_active', is_active: 'eq.false', limit: '5' });
    const rows = Array.isArray(res.json) ? res.json : [];
    if (rows.length) finding('Low', 'promo_codes exposes inactive codes to anon', JSON.stringify(rows).slice(0, 120));
    return rows.length + ' inactive rows visible';
  });

  // ── Write probes ─────────────────────────────────────────────────────────
  for (const table of WRITE_TARGETS) {
    await t('anon INSERT on ' + table + ' rejected', async () => {
      const res = await restWrite(table, 'POST', hdr, {});
      if (res.status < 400) {
        finding('Critical', 'anon can INSERT into ' + table, 'HTTP ' + res.status + ' body: ' + String(res.text).slice(0, 150));
      }
      return 'HTTP ' + res.status;
    });
  }

  // PostgREST returns HTTP 200 with an empty array when a write matches zero
  // RLS-visible rows — the vuln signal is affected > 0, not the status code.
  await t('anon UPDATE on profiles rejected', async () => {
    const res = await restWrite('profiles', 'PATCH', hdr, { name: 'anon-evil' }, { id: 'ne.00000000-0000-0000-0000-000000000000' });
    const affected = Array.isArray(res.json) ? res.json.length : 0;
    if (affected > 0) finding('Critical', 'anon can UPDATE profiles', 'HTTP ' + res.status + ' affected ' + affected);
    return 'HTTP ' + res.status + ', affected ' + affected + (res.status < 400 && affected === 0 ? ' (200-empty = RLS blocked, normal PostgREST)' : '');
  });

  await t('anon DELETE on orders rejected', async () => {
    const res = await restWrite('orders', 'DELETE', hdr, undefined, { customer_id: 'is.null' });
    const affected = Array.isArray(res.json) ? res.json.length : 0;
    if (affected > 0) finding('Critical', 'anon can DELETE orders', 'HTTP ' + res.status + ' affected ' + affected);
    return 'HTTP ' + res.status + ', affected ' + affected + (res.status < 400 && affected === 0 ? ' (200-empty = RLS blocked, normal PostgREST)' : '');
  });

  await t('storage object list denied to anon', async () => {
    const url = new URL('object/list/vendor-docs', ENV.URL + '/storage/v1/');
    const res = await fetch(url, {
      method: 'POST',
      headers: { apikey: ENV.ANON_KEY, Authorization: bearer(ENV.ANON_KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    });
    return expect(res.status >= 400, 'expected 4xx, got ' + res.status) ?? undefined;
  });
}
