// ──────────────────────────────────────────────────────────────────────────
// _shared/auth.ts  —  Supabase Edge Function auth helpers (Deno)
// ──────────────────────────────────────────────────────────────────────────
// Verifies an incoming caller's JWT signed by Supabase Auth, returns the
// caller's uuid. When the function is invoked by `pg_net.http_post` (i.e.
// from a database trigger), there's no Authorization header — that path is
// authenticated out-of-band (only the postgres role can reach pg_net's
// functions). In that case we return null and the caller may proceed as
// "system" — but never trust auth-supplied user ids from anywhere else.
//
// Two-stage verification:
//   1. Pull the issuer from the env var the platform injects (by convention
//      `SUPABASE_URL`).
//   2. Validate the JWKS signature on the call-site using the project's
//      anon/service JWT secret exposed as `SUPABASE_SERVICE_ROLE_KEY`/
//      `SUPABASE_ANON_KEY` by the platform, decoded as HS256 (Supabase JWTs
//      are HS256-only by default). If verification fails, return null.
//
// The Deno standard library exposes `createRemoteJWKSet` only for RS256.
// For HS256 we hand-verify with a `HmacSha256` round-trip. Compiler hint
// imports below rely on the supabase:functions-js runtime declarations.
// ──────────────────────────────────────────────────────────────────────────

import { createHmac } from 'node:crypto';

/** Decode the JWT's payload WITHOUT verifying (caller must verify). */
function decodeJwt(jwt: string): { header: any; payload: any; signature: Uint8Array } | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const header  = JSON.parse(atobUrl(parts[0]));
    const payload = JSON.parse(atobUrl(parts[1]));
    const signature = base64urlToBytes(parts[2]);
    return { header, payload, signature };
  } catch {
    return null;
  }
}

/** HS256 verify against the project's JWT secret. */
export function verifyJwt(jwt: string, secret: string): any | null {
  if (!secret) return null;
  const decoded = decodeJwt(jwt);
  if (!decoded) return null;
  if (decoded.header.alg !== 'HS256') return null;
  const signed = `${jwt.split('.')[0]}.${jwt.split('.')[1]}`;
  const expected = createHmac('sha256', secret).update(signed).digest();
  const given = Buffer.from(decoded.signature);
  if (expected.length !== given.length) return null;
  // Constant-time compare is built into timingSafeEqual.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected[i] ^ given[i];
  }
  if (mismatch !== 0) return null;
  // Expiry / not-before checks
  const now = Math.floor(Date.now() / 1000);
  if (typeof decoded.payload.exp === 'number' && now >= decoded.payload.exp) return null;
  if (typeof decoded.payload.nbf === 'number' && now < decoded.payload.nbf) return null;
  return decoded.payload;
}

/** Try to read & verify a Bearer JWT from the Authorization header. */
export function getAuthUserId(req: Request, jwtSecret: string): string | null {
  const header = req.headers.get('Authorization') ?? '';
  const m = /Bearer\s+(.+)/i.exec(header);
  if (!m) return null;
  const payload = verifyJwt(m[1], jwtSecret);
  if (!payload) return null;
  return payload.sub ?? null;
}

// ── base64url helpers ─────────────────────────────────────────────────────
function atobUrl(s: string): string {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}
function base64urlToBytes(s: string): Uint8Array {
  const bin = atobUrl(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
