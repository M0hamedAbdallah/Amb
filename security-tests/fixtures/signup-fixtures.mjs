// one-shot: create fixture users via GoTrue signup (canonical rows)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', '.env.local'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean).map((m) => [m[1], m[2]]),
);

const emails = ['cust1', 'cust2', 'vendor', 'support', 'admin2', 'locked', 'off'];

for (const e of emails) {
  const email = 'sec+' + e + '@sectest.dev';
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/signup', {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: env.FIXTURE_PASSWORD }),
  });
  const j = await r.json().catch(() => null);
  console.log(e.padEnd(8), 'HTTP', r.status,
    j?.id ? 'uid=' + j.id : '',
    j?.access_token ? 'SESSION-GRANTED' : String(j?.msg ?? j?.error_code ?? JSON.stringify(j).slice(0, 80)));
  await new Promise((res) => setTimeout(res, 800));
}
