// ─────────────────────────────────────────────────────────────────────────
// 08_auth_flows.mjs — Supabase Auth attack surface (OWASP A07 / API2):
// credential stuffing response uniformity (enumeration), JWT hardening,
// OTP flows, weak-password policy. Rate-limit probes are CAPPED (5 tries)
// to stay friendly to the shared Supabase auth rate limiter; the FX.locked
// fixture absorbs wrong-password noise so real accounts stay clean.
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, finding } from '../lib/harness.mjs';
import {
  passwordGrant, signUp, otpRequest, otpVerify, restGet,
  decodeJwtPayload, decodeJwtHeader, bearer, session, FX, ENV,
} from '../lib/api.mjs';

export async function run() {
  suite('08 auth flows');

  // ── Enumeration: nonexistent vs existing account responses ───────────────
  await t('password login error is uniform (no user enumeration)', async () => {
    const ghost = await passwordGrant('sec+ghost@sectest.dev', 'WrongPassword!1');
    const real = await passwordGrant(FX.cust1, 'WrongPassword!1');
    const g = JSON.stringify(ghost.json?.error_description ?? ghost.json?.msg ?? ghost.json?.error ?? ghost.text).slice(0, 120);
    const r = JSON.stringify(real.json?.error_description ?? real.json?.msg ?? real.json?.error ?? real.text).slice(0, 120);
    if (ghost.status === real.status && g === r) return 'identical: "' + g.slice(0, 60) + '"';
    finding('Low', 'Login responses allow account enumeration', 'ghost: ' + g + ' | real: ' + r);
    return 'DIFFERENT — ghost: ' + g + ' | real: ' + r;
  });

  await t('OTP request responses are uniform (no enumeration)', async () => {
    const ghost = await otpRequest('sec+ghost@sectest.dev', false);
    const real = await otpRequest('sec+ghost2@sectest.dev', false); // both nonexistent — sanity that noise is deterministic
    // (real-email OTP omitted on purpose: never spam a real inbox.)
    if (ghost.status !== real.status) return 'nondeterministic between two ghosts — rerun';
    return 'HTTP ' + ghost.status + ' body: ' + String(ghost.json?.msg ?? ghost.json?.error ?? '').slice(0, 50);
  });

  // ── Signup policy ────────────────────────────────────────────────────────
  await t('signup rejects weak password', async () => {
    const res = await signUp('sec+weak@sectest.dev', '123');
    if (res.status === 200 && res.json?.access_token) {
      finding('Medium', 'signup accepts 3-char password', 'weak password policy');
    }
    return 'HTTP ' + res.status + ' ' + String(res.json?.msg ?? res.json?.error_code ?? '').slice(0, 50);
  });

  await t('signup with duplicate email does not leak existence loudly', async () => {
    const res = await signUp(FX.cust1, 'AnotherPass!9');
    const body = JSON.stringify(res.json ?? res.text);
    if (/already (been )?(registered|exists)/i.test(body) && res.status !== 200) {
      // Supabase may reveal this depending on "Confirm email" setting — Info.
      finding('Info', 'signup reveals duplicate email', body.slice(0, 120));
      return 'enumerable: ' + body.slice(0, 80);
    }
    return 'opaque response (HTTP ' + res.status + ')';
  });

  // ── JWT hardening (fixture token) ────────────────────────────────────────
  await t('access token alg is a real signature algorithm (not none)', async () => {
    const s = await session(FX.cust1);
    const hdr = decodeJwtHeader(s.token);
    if (hdr.alg === 'none' || !hdr.alg) {
      finding('Critical', 'JWT allows alg=none', JSON.stringify(hdr));
    }
    return 'alg=' + hdr.alg + ' typ=' + hdr.typ;
  });

  await t('access token has sane claims (exp, sub, role)', async () => {
    const s = await session(FX.cust1);
    const p = decodeJwtPayload(s.token);
    const ttl = p.exp - p.iat;
    if (!p.sub || p.role !== 'authenticated') {
      finding('Medium', 'JWT claims unexpected', JSON.stringify(p).slice(0, 120));
    }
    if (ttl > 4000) {
      finding('Low', 'Access-token TTL unusually long', ttl + 's (>1h)');
    }
    return 'sub=' + String(p.sub).slice(0, 8) + '… role=' + p.role + ' ttl=' + ttl + 's';
  });

  await t('tampered token signature is rejected by PostgREST', async () => {
    const s = await session(FX.cust1);
    const parts = s.token.split('.');
    parts[2] = parts[2].slice(0, -4) + 'AAAA';
    const res = await restGet('profiles', bearer(parts.join('.')), { select: 'id', id: 'eq.' + s.uid });
    if (res.status === 200) {
      finding('Critical', 'PostgREST accepted a forged signature', 'token mangled in last 4 b64 chars');
    }
    return 'HTTP ' + res.status;
  });

  await t('expired token is rejected', async () => {
    const s = await session(FX.cust1);
    const p = decodeJwtPayload(s.token);
    p.exp = Math.floor(Date.now() / 1000) - 3600; // backdate 1h
    const forged = [
      s.token.split('.')[0],
      Buffer.from(JSON.stringify(p)).toString('base64url'),
      s.token.split('.')[2],
    ].join('.');
    const res = await restGet('profiles', bearer(forged), { select: 'id', id: 'eq.' + s.uid });
    // signature no longer matches payload → 401 either way; if it were
    // accepted that would mean neither exp nor signature enforced.
    if (res.status === 200) {
      finding('Critical', 'Expired/modified payload accepted', 'exp not enforced');
    }
    return 'HTTP ' + res.status;
  });

  await t('service-role-style role claim in forged token is rejected', async () => {
    const s = await session(FX.cust1);
    const p = decodeJwtPayload(s.token);
    p.role = 'service_role';
    const forged = [
      s.token.split('.')[0],
      Buffer.from(JSON.stringify(p)).toString('base64url'),
      s.token.split('.')[2],
    ].join('.');
    const res = await restGet('profiles', bearer(forged), { select: 'id', limit: '1' });
    if (res.status === 200 && Array.isArray(res.json) && res.json.length) {
      finding('Critical', 'Forged role=service_role claim honored', 'signature must reject this');
    }
    return 'HTTP ' + res.status;
  });

  // ── OTP verify: wrong codes (capped ×3) ──────────────────────────────────
  await t('OTP verify with wrong code fails cleanly (3 tries, capped)', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await otpVerify('sec+ghost@sectest.dev', '000000');
      if (res.status === 200) {
        finding('High', 'OTP verify accepted code 000000', 'verify without a prior request?');
        return 'ACCEPTED on try ' + (i + 1);
      }
      if (res.status === 429) return 'HTTP 429 rate-limited after ' + (i + 1) + ' tries';
    }
    return 'all 4xx';
  });

  // ── Wrong-password hammering on the locked fixture (capped ×5) ───────────
  await t('5 wrong passwords do not lock the account (availability check)', async () => {
    for (let i = 0; i < 5; i++) {
      await passwordGrant(FX.locked, 'DefinitelyWrong!' + i);
    }
    const ok = await passwordGrant(FX.locked, ENV.FIXTURE_PASSWORD);
    if (ok.status !== 200) {
      finding('Info', 'Account login blocked after 5 wrong tries', 'Supabase rate limiter — check ' + String(ok.json?.msg ?? ok.text).slice(0, 80));
    }
    return ok.status === 200 ? 'correct login still works' : 'HTTP ' + ok.status;
  });

  await t('auth endpoints send no cacheable session material', async () => {
    const res = await passwordGrant(FX.locked, ENV.FIXTURE_PASSWORD);
    const cc = String(res.headers?.get('cache-control') ?? '');
    if (/max-age=[1-9]/.test(cc) && !/no-store|no-cache/.test(cc)) {
      finding('Low', 'Token response cacheable', 'cache-control: ' + cc);
    }
    return 'cache-control: ' + (cc || '(none)');
  });
}
