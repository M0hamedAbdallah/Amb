// ─────────────────────────────────────────────────────────────────────────
// api.mjs — raw HTTP helpers against Supabase (PostgREST / Auth / Functions
// / Storage) and the deployed web app. Zero dependencies, built-in fetch.
//
// Conventions (kept consistent everywhere):
//   • URLs are ALWAYS built with `new URL(path, base)` and query values go
//     through searchParams.set() — no string concatenation into request URLs.
//   • `hdr` arguments are FULL Authorization header values ("Bearer xyz")
//     built once in bearer() and forwarded verbatim.
// ─────────────────────────────────────────────────────────────────────────
import { ENV, FX } from './env.mjs';
export { ENV, FX } from './env.mjs';

const REST_BASE = ENV.URL + '/rest/v1/';
const AUTH_BASE = ENV.URL + '/auth/v1/';
const FN_BASE = ENV.URL + '/functions/v1/';

export function bearer(token) {
  return 'Bearer ' + token;
}

const baseHeaders = () => ({ apikey: ENV.ANON_KEY, 'Content-Type': 'application/json' });

async function call(url, method, hdr, body, extraHeaders) {
  const headers = { ...baseHeaders(), ...(extraHeaders ?? {}) };
  if (hdr) headers.Authorization = hdr; // verbatim — never rebuilt here
  const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  const res = await fetch(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
}

// ── PostgREST ─────────────────────────────────────────────────────────────

export function restUrl(table) {
  return new URL(encodeURIComponent(table).replace(/%2F/gi, '/'), REST_BASE);
}

/** GET /rest/v1/<table>?query… */
export async function restGet(table, hdr, query) {
  const url = restUrl(table);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  return call(url, 'GET', hdr);
}

/** POST / PATCH / DELETE on a table. `representation` returns affected rows. */
export async function restWrite(table, method, hdr, body, query) {
  const url = restUrl(table);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  return call(url, method, hdr, body, { Prefer: 'return=representation' });
}

/** POST /rest/v1/rpc/<name> */
export async function rpc(name, args, hdr) {
  const url = new URL('rpc/' + encodeURIComponent(name), REST_BASE);
  return call(url, 'POST', hdr, args ?? {});
}

/** GET /rest/v1/ (OpenAPI spec) — enumerates everything exposed to the key. */
export async function openApi(hdr) {
  const url = new URL('', ENV.URL + '/rest/v1/');
  return call(url, 'GET', hdr);
}

// ── Auth ──────────────────────────────────────────────────────────────────

export async function passwordGrant(email, password) {
  const url = new URL('token', AUTH_BASE);
  url.searchParams.set('grant_type', 'password');
  return call(url, 'POST', null, { email, password });
}

export async function otpRequest(email, createUser) {
  const url = new URL('otp', AUTH_BASE);
  return call(url, 'POST', null, { email, create_user: createUser });
}

export async function otpVerify(email, token) {
  const url = new URL('verify', AUTH_BASE);
  return call(url, 'POST', null, { type: 'email', email, token });
}

export async function signUp(email, password) {
  const url = new URL('signup', AUTH_BASE);
  return call(url, 'POST', null, { email, password });
}

// ── Edge Functions ────────────────────────────────────────────────────────

export async function fnCall(name, hdr, body, method = 'POST', extraHeaders) {
  const url = new URL(encodeURIComponent(name), FN_BASE);
  return call(url, method, hdr, body, extraHeaders);
}

export async function adminApi(action, params, hdr) {
  return fnCall('admin-api', hdr, { action, ...(params ?? {}) });
}

// ── Token cache (one login per fixture per run) ──────────────────────────

const sessions = {}; // email -> { token, uid, hdr }

export async function session(email) {
  if (sessions[email]) return sessions[email];
  const res = await passwordGrant(email, ENV.FIXTURE_PASSWORD);
  if (res.status !== 200 || !res.json?.access_token) {
    throw new Error('login failed for ' + email + ': HTTP ' + res.status + ' ' + String(res.json?.msg ?? res.json?.error ?? '').slice(0, 120));
  }
  const hdr = bearer(res.json.access_token);
  sessions[email] = { token: res.json.access_token, uid: res.json.user?.id, hdr };
  return sessions[email];
}

export async function cust1() { return session(FX.cust1); }
export async function cust2() { return session(FX.cust2); }
export async function vendor() { return session(FX.vendor); }
export async function support() { return session(FX.support); }
export async function admin() { return session(FX.admin); }

// ── Web app ───────────────────────────────────────────────────────────────

export async function webGet(pathname) {
  const url = new URL(pathname.startsWith('/') ? pathname.slice(1) : pathname, ENV.WEB_ORIGIN);
  const res = await fetch(url, { method: 'GET', redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

export function decodeJwtPayload(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export function decodeJwtHeader(token) {
  const part = token.split('.')[0];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}
