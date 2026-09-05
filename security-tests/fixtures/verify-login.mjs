import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', '.env.local'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean).map((m) => [m[1], m[2]]),
);

const URL = env.SUPABASE_URL;
const ANON = env.SUPABASE_ANON_KEY;
const PW = env.FIXTURE_PASSWORD || 'SecTest!2026#Amb';

const emails = [
  { key: 'cust1', email: 'sec+cust1@sectest.dev', expectRole: 'customer' },
  { key: 'cust2', email: 'sec+cust2@sectest.dev', expectRole: 'customer' },
  { key: 'vendor', email: 'sec+vendor@sectest.dev', expectRole: 'vendor' },
  { key: 'support', email: 'sec+support@sectest.dev', expectRole: 'support' },
  { key: 'admin', email: 'sec+admin2@sectest.dev', expectRole: 'admin' },
  { key: 'locked', email: 'sec+locked@sectest.dev', expectRole: 'customer' },
  { key: 'off', email: 'sec+off@sectest.dev', expectRole: 'customer' },
];

for (const { key, email, expectRole } of emails) {
  const r = await fetch(URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  const j = await r.json();
  const ok = r.status === 200 && j.access_token;
  console.log(ok ? 'OK' : 'FAIL', key.padEnd(8), 'HTTP', r.status,
    ok ? 'role=' + j.user?.role + ' uid=' + j.user?.id : j.error?.message || JSON.stringify(j).slice(0, 100));
  if (ok) {
    // Also verify JWT custom claims contain role
    const payload = JSON.parse(Buffer.from(j.access_token.split('.')[1], 'base64url').toString());
    console.log('         JWT claims:', JSON.stringify({ role: payload.role, aud: payload.aud }));
  }
}
