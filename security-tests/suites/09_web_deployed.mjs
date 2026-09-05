// ─────────────────────────────────────────────────────────────────────────
// 09_web_deployed.mjs — the deployed marketing site + admin console
// (Vite SPA on Vercel, WEB_ORIGIN). Checks transport/security headers,
// that /admin is a client-gated shell (no server-rendered PII), and that
// the shipped JS bundle contains no secrets. The anon key + project URL
// in the bundle are PUBLIC by design and explicitly allowed.
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, finding } from '../lib/harness.mjs';
import { webGet } from '../lib/api.mjs';

// Patterns that must NEVER appear in a public bundle.
const SECRET_PATTERNS = [
  ['service_role JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['sb_secret_ key', /sb_secret_[A-Za-z0-9_-]{10,}/g],
  ['Kashier secret key literal', /(?:secret_?[Kk]ey|KASHIER_SECRET)\s*[:=]\s*['"][A-Za-z0-9_-]{12,}['"]/g],
  ['Paymob key', /sk_live_|pk_live_[0-9a-zA-Z]{12,}|PAYMOB_[A-Z_]*KEY\s*[:=]\s*['"][^'"]{8,}['"]/g],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['hardcoded password literal', /password\s*[:=]\s*['"][^'"\s]{6,}['"]/gi],
];

async function scanBundle(url, label) {
  const res = await fetch(url);
  const text = await res.text();
  const hits = [];
  for (const [name, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m) {
      // service-role check: decode candidate JWTs, only flag role!=anon.
      if (name === 'service_role JWT') {
        for (const tok of m) {
          try {
            const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
            if (payload.role && payload.role !== 'anon') {
              hits.push(name + ' (role=' + payload.role + ')');
            }
          } catch { /* not a JWT */ }
        }
      } else {
        hits.push(name + ' ×' + m.length);
      }
    }
  }
  return { status: res.status, bytes: text.length, hits };
}

export async function run() {
  suite('09 deployed web console');

  const home = await webGet('/');
  await t('site is up (GET / → 200 html)', async () => {
    const ct = String(home.headers.get('content-type') ?? '');
    if (home.status !== 200) return 'HTTP ' + home.status + ' — deployed?';
    if (!/text\/html/.test(ct)) finding('Low', 'Homepage not served as text/html', ct);
    return home.status + ' ' + ct;
  });

  // ── Security headers ─────────────────────────────────────────────────────
  await t('HSTS present on web origin', async () => {
    const hsts = String(home.headers.get('strict-transport-security') ?? '');
    if (!hsts) {
      finding('Low', 'No Strict-Transport-Security on web origin', 'Vercel usually injects it — verify vercel.json/headers');
    }
    return hsts || '(missing)';
  });

  await t('x-content-type-options: nosniff present', async () => {
    const x = String(home.headers.get('x-content-type-options') ?? '');
    if (!/nosniff/i.test(x)) finding('Low', 'Missing x-content-type-options: nosniff', x || '(missing)');
    return x || '(missing)';
  });

  await t('clickjacking protection (XFO or CSP frame-ancestors)', async () => {
    const xfo = String(home.headers.get('x-frame-options') ?? '');
    const csp = String(home.headers.get('content-security-policy') ?? '');
    const ok = /deny|sameorigin/i.test(xfo) || /frame-ancestors/i.test(csp);
    if (!ok) finding('Low', 'No frame-busting header on web origin', 'XFO="' + xfo + '" CSP=' + (csp ? 'set' : 'none'));
    return ok ? 'protected' : 'none';
  });

  await t('referrer-policy set', async () => {
    const rp = String(home.headers.get('referrer-policy') ?? '');
    if (!rp) finding('Info', 'No Referrer-Policy header', 'browsers default strict-origin-when-cross-origin');
    return rp || '(default)';
  });

  await t('HTML is not long-cache immutable', async () => {
    const cc = String(home.headers.get('cache-control') ?? '');
    if (/immutable/.test(cc)) finding('Low', 'index.html served immutable', 'stale SPA deploys');
    return cc || '(none)';
  });

  // ── /admin shell ─────────────────────────────────────────────────────────
  const admin = await webGet('/admin');
  await t('/admin returns the SPA shell (client-gated)', async () => {
    if (admin.status >= 500) {
      finding('Medium', '/admin 5xx', 'HTTP ' + admin.status);
    }
    const isShell = admin.status === 200 || admin.status === 404; // SPA fallback
    return 'HTTP ' + admin.status + (isShell ? ' (shell)' : '');
  });

  await t('/admin HTML carries no server-rendered PII', async () => {
    const body = home.text + admin.text;
    const phones = body.match(/\+201[0125][0-9]{8}/g);
    const emails = (body.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [])
      .filter((e) => !/sectest|example|vercel|supabase|schemas|w3\.org/i.test(e));
    if (phones?.length || emails?.length) {
      finding('Medium', 'Server-rendered PII in admin/site HTML',
        'phones: ' + (phones?.slice(0, 3).join(',') ?? 'none') + ' emails: ' + (emails?.slice(0, 3).join(',') ?? 'none'));
    }
    return (phones?.length ?? 0) + ' phones, ' + (emails?.length ?? 0) + ' emails in shell';
  });

  // ── Bundle secret scan ───────────────────────────────────────────────────
  await t('JS bundles contain no secrets (anon key allowed)', async () => {
    const srcs = [...home.text.matchAll(/(?:src|href)="(\/[^"]+\.js)"/g)].map((m) => m[1]);
    if (!srcs.length) return 'no /assets/*.js referenced in index.html (inline or different layout?)';
    const results = [];
    for (const src of srcs.slice(0, 3)) { // cap at 3 bundles
      const url = new URL(src, 'https://ambobtak.vercel.app');
      const r = await scanBundle(url, src);
      results.push(src + ' (' + Math.round(r.bytes / 1024) + ' KB): ' + (r.hits.join(', ') || 'clean'));
      if (r.hits.length) {
        finding('High', 'Secrets in deployed bundle ' + src, r.hits.join(', '));
      }
    }
    return results.join(' | ');
  });

  await t('env-config endpoint /admin data requires auth (no open dump)', async () => {
    // The console must not expose any JSON data route without a JWT.
    const res = await webGet('/admin/users');
    const isHtml = /text\/html/.test(String(res.headers.get('content-type') ?? ''));
    if (!isHtml && res.status === 200) {
      finding('Medium', '/admin/users returns non-HTML 200', 'possible unauthenticated data route');
    }
    return 'HTTP ' + res.status + ' ' + (isHtml ? 'html shell' : 'non-html!');
  });
}
