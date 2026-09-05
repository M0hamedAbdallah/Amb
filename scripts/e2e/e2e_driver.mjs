// e2e_driver.mjs — mint per-user RLS-enforced sessions via service_role magic-link,
// drive PostgREST RPCs directly with the per-user Bearer JWT (no supabase-js session
// machinery, which hits a node:undici import quirk in the REPL loader).
import { URL as NodeURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const envText = await readFile('E:/app/Ambobtak/.env', 'utf8');
const get = (k) => { const m = envText.match(new RegExp(`^${k}=(.+)$`, 'm')); return m ? m[1].trim() : null; };
const SUPABASE_URL = get('EXPO_PUBLIC_SUPABASE_URL');
const ANON_KEY     = get('EXPO_PUBLIC_SUPABASE_ANON_KEY');
const SERVICE_ROLE = get('SUPABASE_SERVICE_ROLE_KEY');

let _fetch = null;
async function getFetch() {
  if (_fetch) return _fetch;
  // Node 18+ ships a global fetch; fall back to CommonJS-loaded cross-fetch only if missing.
  if (typeof globalThis.fetch === 'function') {
    _fetch = globalThis.fetch;
    return _fetch;
  }
  // cross-fetch is CommonJS — use createRequire to load it without a bare ESM import path
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const mod = require('cross-fetch');
  _fetch = mod.fetch || mod.default?.fetch || mod.default;
  if (typeof _fetch !== 'function') throw new Error('cross-fetch did not yield a fetch function');
  return _fetch;
}

export async function mintTokenByEmail(email) {
  const fetch = await getFetch();
  const r1 = await fetch(SUPABASE_URL + '/auth/v1/admin/generate_link', {
    method: 'POST',
    headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!r1.ok) throw new Error('generate_link HTTP ' + r1.status + ': ' + (await r1.text()).slice(0,200));
  const gl = await r1.json();
  const u = new NodeURL(gl.action_link);
  const token = u.searchParams.get('token');
  const type = u.searchParams.get('type') || 'magiclink';
  const verifyUrl = SUPABASE_URL + `/auth/v1/verify?token=${token}&type=${type}&redirect_to=${encodeURIComponent('https://example.invalid/')}`;
  const r2 = await fetch(verifyUrl, {
    method: 'GET', redirect: 'manual',
    headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY, 'Accept': 'application/json' },
  });
  if (r2.status !== 303) throw new Error('verify expected HTTP 303, got ' + r2.status + ': ' + (await r2.text()).slice(0,200));
  const loc = r2.headers.get('location');
  if (!loc) throw new Error('verify returned no Location header');
  const hash = loc.split('#')[1] || '';
  const params = Object.fromEntries(new URLSearchParams(hash));
  if (!params.access_token) throw new Error('no access_token in redirect fragment');
  return {
    access_token: params.access_token,
    refresh_token: params.refresh_token,
    expires_at: Number(params.expires_at),
    expires_in: Number(params.expires_in),
    payload: JSON.parse(Buffer.from(params.access_token.split('.')[1], 'base64url').toString('utf8')),
  };
}

export async function rpcAsUser(email, fnName, args) {
  const fetch = await getFetch();
  const session = await mintTokenByEmail(email);
  if (!session.payload?.sub) throw new Error('minted token has no sub claim');
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fnName, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': 'Bearer ' + session.access_token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
  return { ok: res.ok, status: res.status, data, error: res.ok ? null : data };
}

export async function selectAsUser(email, table, query = '*', filters = {}) {
  const fetch = await getFetch();
  const session = await mintTokenByEmail(email);
  const qs = new URLSearchParams();
  qs.set('select', query);
  for (const [k, v] of Object.entries(filters)) qs.set(k, String(v));
  const res = await fetch(SUPABASE_URL + `/rest/v1/${table}?${qs.toString()}`, {
    method: 'GET',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': 'Bearer ' + session.access_token,
      'Accept': 'application/json',
    },
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
  return { ok: res.ok, status: res.status, data, error: res.ok ? null : data };
}

export const ACCOUNTS = {
  customer: { email: 'mohammed.customer.e2e@example.invalid', uid: '021ccb4c-d489-4b8b-b682-518e103766c8' },
  vendor1 : { email: 'testvendor1@example.invalid', uid: '11111111-1111-1111-1111-111111111111' },
  vendorId: 'a96bd534-ed65-404a-8a5e-25573a760c8b', // [TEST] Cairo Premium Water
};
export const SURL  = SUPABASE_URL;
export const AKEY  = ANON_KEY;
export const SROLE = SERVICE_ROLE;
