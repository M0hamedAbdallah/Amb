// Create fixture accounts via GoTrue admin API (service_role).
// Skips existence check since admin/users?email= filter is unreliable.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', '.env.local'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean).map((m) => [m[1], m[2]]),
);

const rootEnv = Object.fromEntries(
  readFileSync(join(here, '..', '..', '.env'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean).map((m) => [m[1], m[2]]),
);

const URL = env.SUPABASE_URL;
const SR = rootEnv.SUPABASE_SERVICE_ROLE_KEY;
const PW = env.FIXTURE_PASSWORD || 'SecTest!2026#Amb';

const emails = [
  { key: 'cust1', email: 'sec+cust1@sectest.dev' },
  { key: 'cust2', email: 'sec+cust2@sectest.dev' },
  { key: 'vendor', email: 'sec+vendor@sectest.dev' },
  { key: 'support', email: 'sec+support@sectest.dev' },
  { key: 'admin2', email: 'sec+admin2@sectest.dev' },
  { key: 'locked', email: 'sec+locked@sectest.dev' },
  { key: 'off', email: 'sec+off@sectest.dev' },
];

for (const { key, email } of emails) {
  const r = await fetch(URL + '/auth/v1/admin/users', {
    method: 'POST',
    headers: { apikey: SR, Authorization: 'Bearer ' + SR, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW, email_confirm: true, aud: 'authenticated' }),
  });
  const j = await r.json();
  console.log(key.padEnd(8), 'HTTP', r.status, j.id || '', j.error?.message || JSON.stringify(j).slice(0, 120));
  await new Promise((res) => setTimeout(res, 500));
}

console.log('\nDone.');
