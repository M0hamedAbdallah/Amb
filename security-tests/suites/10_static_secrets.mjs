// ─────────────────────────────────────────────────────────────────────────
// 10_static_secrets.mjs — local repository scan for hardcoded secrets
// (OWASP A02/A06): service-role keys, payment-gateway secrets, private
// keys, JWTs, password literals. Scans source + the deployed-shape build
// output (web/dist). Skips node_modules/.git/caches. The anon key and the
// FIXTURE_PASSWORD inside security-tests/.env.local are public-by-design
// and explicitly allowed.
// ─────────────────────────────────────────────────────────────────────────
import { suite, t, finding } from '../lib/harness.mjs';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..'); // D:\Amb — the whole project root

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.cache', '.cache-dispatch-deploy.json', '.mimosa',
  '.zcode', 'build', '.expo', '.dart_tool', 'gui-test-screenshots', 'reports',
]);
const SKIP_FILES = new Set([
  'package-lock.json', '.env.local', // harness's own public config
  // local gitignored scratch from earlier emulator runs (contain live user
  // session JWTs; never committed — .gitignore has RKStorage.*)
  'RKStorage.live.cust', 'RKStorage.live.injected',
]);
// Local gitignored env files — a service-role key may legitimately live here
// for local scripts; their posture is checked by the dedicated tests below,
// so the generic repo walk must not double-report them.
const DEDICATED_ENV_FILES = new Set([join(REPO, '.env'), join(REPO, 'web', '.env')]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.css',
  '.xml', '.md', '.env', '.example', '.local', '.cust', '.injected', '.properties', '.gradle', '.kt', '.plist',
]);
const MAX_FILE = 3 * 1024 * 1024;

// [label, regex, severity, verifier?] — verifier filters false positives.
const RULES = [
  ['service_role JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'Critical',
    (tok) => {
      try {
        const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
        // anon = public by design; authenticated = ordinary user session
        // tokens (test artifacts like RKStorage/session.json) — neither is a
        // server secret. Only elevated roles (service_role, …) are Critical.
        if (p.role && p.role !== 'anon' && p.role !== 'authenticated') return 'role=' + p.role;
        return null;
      } catch { return null; }
    }],
  ['service-role env var literal', /(SUPABASE_SERVICE_ROLE(?:_KEY)?|SERVICE_ROLE_KEY)\s*[:=]\s*['"]?eyJ[A-Za-z0-9_-]{10,}/g, 'Critical', null],
  ['sb_secret publishable-secret key', /sb_secret_[A-Za-z0-9_-]{10,}/g, 'Critical', null],
  ['Kashier secret literal', /(KASHIER[A-Z_]*SECRET|secret_?[Kk]ey)\s*[:=]\s*['"][A-Za-z0-9+/_-]{12,}['"]/g, 'High', null],
  ['payment gateway live key', /(sk_live_[0-9a-zA-Z]{12,}|PAYMOB_[A-Z_]*(?:KEY|SECRET)\s*[:=]\s*['"][^'"]{8,}['"])/g, 'High', null],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'Critical', null],
  ['Google API key (AIza…)', /AIza[0-9A-Za-z_-]{35}/g, 'Info', null],
  ['password literal', /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"\s$]{6,}['"]/gi, 'Low',
    (m) => /your|xxxx|changeme|example|placeholder|dummy|<[^>]+>|\$\{|process\.env|import\.meta|sectest!2026/i.test(m) ? null : m.slice(0, 40)],
];

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env' && !e.name.startsWith('.env')) continue;
    if (SKIP_DIRS.has(e.name) || SKIP_FILES.has(e.name)) continue;
    const full = join(dir, e.name);
    if (DEDICATED_ENV_FILES.has(full)) continue;
    if (e.isDirectory()) walk(full, out);
    else {
      const ext = e.name.slice(e.name.lastIndexOf('.'));
      const isEnv = e.name.startsWith('.env') || e.name === 'RKStorage.live.cust' || e.name === 'RKStorage.live.injected';
      if (TEXT_EXT.has(ext) || isEnv) {
        try { if (statSync(full).size <= MAX_FILE) out.push(full); } catch { /* ignore */ }
      }
    }
  }
}

export async function run() {
  suite('10 static secrets (repo scan)');

  const files = [];
  walk(REPO, files);
  await t('repository walk covers source + build output', async () => {
    return files.length + ' text files scanned';
  });

  const hits = [];
  // Root .env / web/.env are local-only (gitignored — verified below) and hold
  // server secrets by design; hits there are hygiene notes, not repo leaks.
  const LOCAL_ONLY = new Set(['.env', join('web', '.env').replace(/\\/g, '/')]);
  outer:
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const rel = relative(REPO, file).replace(/\\/g, '/');
    for (const [label, re, sev, verifier] of RULES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const detail = verifier ? verifier(m[0]) : m[0].slice(0, 40);
        if (detail === null) continue;
        const line = text.slice(0, m.index).split('\n').length;
        const localOnly = LOCAL_ONLY.has(rel);
        hits.push({ file: rel, line, label, sev: localOnly ? 'Info' : sev, detail: localOnly ? String(detail) + ' (gitignored local file — not a repo leak)' : detail });
        if (hits.length > 40) break outer;
      }
    }
  }

  await t('no service-role keys / payment secrets in repo', async () => {
    const critical = hits.filter((h) => h.sev === 'Critical' || h.sev === 'High');
    for (const h of critical) {
      finding(h.sev, h.label + ' in ' + h.file + ':' + h.line, String(h.detail));
    }
    if (critical.length) return critical.length + ' CRITICAL/HIGH hits — see findings';
    const lows = hits.filter((h) => h.sev !== 'Critical' && h.sev !== 'High');
    for (const h of lows.slice(0, 8)) {
      finding(h.sev, h.label + ' in ' + h.file + ':' + h.line, String(h.detail));
    }
    return lows.length ? 'no critical hits; ' + lows.length + ' low/info literals' : 'clean';
  });

  await t('.gitignore excludes .env and harness secrets', async () => {
    const p = join(REPO, '.gitignore');
    if (!existsSync(p)) {
      finding('Medium', 'No .gitignore', '.env would be committed');
      return 'missing';
    }
    const gi = readFileSync(p, 'utf8');
    const misses = [];
    // \r? handles Windows CRLF checkouts.
    if (!/(^|\r?\n)\.env(\.local)?(\r?\n|$)/.test(gi)) misses.push('.env');
    // \r? handles Windows CRLF; [^#\r\n]* accepts both `.env.local` and the
    // `.env*.local` glob (which covers .env.local, .env.production.local, …).
    if (!/(^|\r?\n)\.env[^#\r\n]*\.local(\r?\n|$)/.test(gi)) misses.push('.env.local');
    if (misses.length) finding('Medium', '.gitignore does not exclude ' + misses.join(', '), 'secret files could be committed');
    return misses.length ? 'MISSING: ' + misses.join(',') : 'env files ignored';
  });

  // Inspect every secret-looking value in an env file: ALL JWTs (not just
  // the first match — a file can hold anon + service keys) and new-style
  // sb_secret_ keys which are not JWTs at all.
  const auditEnvFile = (text) => {
    const jwts = text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? [];
    const roles = [];
    for (const tok of jwts) {
      try {
        const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
        if (payload.role && payload.role !== 'anon') roles.push(payload.role);
      } catch { /* not a JWT */ }
    }
    const sbSecrets = (text.match(/sb_secret_[A-Za-z0-9_-]{10,}/g) ?? []).length;
    return { jwtCount: jwts.length, roles, sbSecrets };
  };

  await t('root .env contains only public values (URL + anon key)', async () => {
    const p = join(REPO, '.env');
    if (!existsSync(p)) return '.env absent (app would read defaults)';
    const { jwtCount, roles, sbSecrets } = auditEnvFile(readFileSync(p, 'utf8'));
    if (roles.length) {
      finding('Critical', 'Non-anon JWT in root .env', 'roles: ' + roles.join(', '));
    }
    if (sbSecrets) {
      finding('Medium', 'sb_secret_ key in root .env', sbSecrets + ' secret key(s). Acceptable ONLY because .env is gitignored and local-only — keep it out of any client bundle path (Expo inlines EXPO_PUBLIC_* only) and never commit.');
    }
    return jwtCount + ' JWT(s), roles=[' + (roles.join(',') || 'anon-only') + '], ' + sbSecrets + ' sb_secret_ key(s)';
  });

  await t('web/.env (deployed site) contains only public values', async () => {
    const p = join(REPO, 'web', '.env');
    if (!existsSync(p)) return 'web/.env absent';
    const text = readFileSync(p, 'utf8');
    const { jwtCount, roles, sbSecrets } = auditEnvFile(text);
    if (roles.length) {
      finding('Critical', 'Non-anon JWT in web/.env', 'roles: ' + roles.join(', ') + ' — this ships in the Vercel build env');
    }
    if (sbSecrets) {
      finding('Critical', 'sb_secret_ key in web/.env', 'ships to the Vercel build environment — must be anon/public values only');
    }
    if (!jwtCount && !sbSecrets && /SECRET|sk_live|PRIVATE/i.test(text)) {
      finding('High', 'web/.env contains SECRET-named values', text.split(/\r?\n/).filter((l) => /SECRET|sk_live/i.test(l)).join('; ').slice(0, 120));
    }
    return jwtCount + ' JWT(s), roles=[' + (roles.join(',') || 'anon-only') + '], ' + sbSecrets + ' sb_secret_ key(s)';
  });

  await t('edge functions read secrets from env only (no literals)', async () => {
    const fnDir = join(REPO, 'supabase', 'functions');
    let bad = [];
    const scan = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) scan(full);
        else if (e.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          const m = text.match(/(?:HMAC|SECRET|API_KEY|TOKEN)[A-Z_]*\s*[:=]\s*['"][A-Za-z0-9+/_-]{12,}['"]/);
          if (m) bad.push(relative(REPO, full) + ': ' + m[0].slice(0, 50));
        }
      }
    };
    scan(fnDir);
    for (const b of bad) finding('High', 'Hardcoded secret literal in edge function', b);
    return bad.length ? bad.length + ' literals' : 'all via Deno.env';
  });
}
