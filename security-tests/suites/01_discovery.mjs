// ─────────────────────────────────────────────────────────────────────────
// 01_discovery.mjs — enumerate the exposed API surface with the anon key:
// PostgREST OpenAPI spec (all tables + RPCs) and every deployed Edge
// Function's unauthenticated posture.
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, expect, finding, getState } from '../lib/harness.mjs';
import { openApi, fnCall, ENV, bearer } from '../lib/api.mjs';

// Expected business tables (0001 + 0003 + 0022 migrations). Anything else
// exposed to anon is new attack surface worth flagging as Info.
const EXPECTED_TABLES = new Set([
  'profiles', 'vendors', 'orders', 'order_ratings', 'promo_codes', 'promo_usages',
  'referral_credits', 'complaints', 'wallet_transactions', 'withdrawals',
  'messages', 'system_settings', 'order_rejections', 'payment_events',
  'spatial_ref_sys',
]);

const EDGE_FUNCTIONS = [
  'admin-api', 'dispatch-engine', 'kashier-checkout', 'kashier-checkout-status',
  'kashier-webhook', 'payment-redirect', 'send-notification',
];

export async function run() {
  suite('01 surface discovery');
  const inv = getState().inventory;

  await t('OpenAPI root requires apikey', async () => {
    const url = new URL('', ENV.URL + '/rest/v1/');
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } }); // no key at all
    return expect(res.status === 401, 'expected 401 without apikey, got ' + res.status) ?? undefined;
  });

  await t('OpenAPI root posture with anon key', async () => {
    const res = await openApi(bearer(ENV.ANON_KEY));
    if (res.status === 200) {
      const paths = Object.keys(res.json?.paths ?? {});
      expect(paths.length > 5, 'suspiciously small path list');
      const tables = [];
      const rpcs = [];
      for (const p of paths) {
        const seg = p.replace(/^\//, '').split('/');
        if (seg[0] === 'rpc' && seg[1]) rpcs.push(seg[1]);
        else if (seg.length === 1 && seg[0]) tables.push(seg[0]);
      }
      inv.tables = tables;
      inv.rpcs = rpcs;
      return tables.length + ' tables, ' + rpcs.length + ' rpcs exposed';
    }
    // This project does not expose the OpenAPI spec to the anon key (HTTP
    // 401) — good posture: no anon table/RPC enumeration. Suites 02-04 then
    // probe the known expected-table list directly.
    expect(res.status === 401 || res.status === 403, 'expected 200 or 401/403, got ' + res.status + ' ' + String(res.text).slice(0, 120));
    inv.tables = [];
    inv.rpcs = [];
    finding('Info', 'OpenAPI root not exposed to anon key (HTTP ' + res.status + ')', 'Spec enumeration via /rest/v1/ needs an elevated key. Later suites fall back to the expected business-table list.');
    return 'spec hidden from anon (HTTP ' + res.status + ') — using fallback table list';
  });

  await t('exposed table list contains no unexpected tables', async () => {
    if (!inv.tables?.length) return 'skipped — spec not exposed to anon; fallback list used (all expected)';
    const extra = inv.tables.filter((x) => !EXPECTED_TABLES.has(x));
    if (extra.length) finding('Info', 'Unexpected tables exposed to anon: ' + extra.join(', '), 'Review whether these should be in the exposed API schema.');
    return extra.length ? 'extra: ' + extra.join(',') : 'all tables expected';
  });

  await t('storage bucket list denied to anon', async () => {
    const url = new URL('', ENV.URL + '/storage/v1/bucket');
    const res = await fetch(url, { headers: { apikey: ENV.ANON_KEY } });
    expect(res.status >= 400, 'expected 4xx, got ' + res.status);
    return 'HTTP ' + res.status;
  });

  // Edge functions: unauthenticated posture map. A 2xx here is not always a
  // vuln — classification per function:
  //   • dispatch-engine → REAL High: no auth guard on the REST path; anyone
  //     can trigger dispatch (and mass-retry cancels) at will.
  //   • kashier-webhook → by-design public (Kashier calls it with an HMAC,
  //     not a JWT); verified fail-closed in suite 05. Low/Info at most.
  //   • anything else answering 2xx unauthenticated → High.
  const BY_DESIGN_PUBLIC = new Set(['kashier-webhook']);
  for (const name of EDGE_FUNCTIONS) {
    await t('edge fn ' + name + ' unauthenticated POST posture', async () => {
      const res = await fnCall(name, undefined, {});
      if (res.status < 400) {
        if (name === 'dispatch-engine') {
          finding('High', 'dispatch-engine REST endpoint has no authentication', 'Deno.serve handler accepts any POST and runs dispatch for pending orders (or a given order_id) — designed for pg_net trigger calls, but the public REST path is equally open. Require the service_role key (or a shared secret) when the caller is not pg_net.');
        } else if (BY_DESIGN_PUBLIC.has(name)) {
          finding('Low', name + ' answers unauthenticated POST (by-design payment webhook)', 'HTTP ' + res.status + ' — must stay reachable for Kashier; never settles without valid HMAC (forgery probes in suite 05).');
        } else {
          finding('High', 'Edge function ' + name + ' answers unauthenticated POST with 2xx', 'HTTP ' + res.status + ' body: ' + String(res.text).slice(0, 200));
        }
      }
      return 'HTTP ' + res.status + ' ' + String(res.json?.error ?? res.text ?? '').slice(0, 60);
    });
  }
}
