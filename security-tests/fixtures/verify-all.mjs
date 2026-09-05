// one-shot: verify every fixture can log in, then dump its profile row.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', '.env.local'), 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean).map((m) => [m[1], m[2]]),
);

const FIXTURES = [
  ['cust1', 'sec+cust1@sectest.dev'],
  ['cust2', 'sec+cust2@sectest.dev'],
  ['vendor', 'sec+vendor@sectest.dev'],
  ['support', 'sec+support@sectest.dev'],
  ['admin2', 'sec+admin2@sectest.dev'],
  ['locked', 'sec+locked@sectest.dev'],
  ['off', 'sec+off@sectest.dev'],
];

for (const [key, email] of FIXTURES) {
  try {
    const r = await fetch(env.SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: env.FIXTURE_PASSWORD || 'SecTest!2026#Amb' }),
    });
    const j = await r.json();
    if (!j.access_token) {
      console.log(key.padEnd(8), 'LOGIN-FAIL', JSON.stringify(j.msg ?? j.error_description ?? j).slice(0, 80));
      continue;
    }
    const uid = j.user.id;
    const p = await fetch(env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + uid + '&select=id,phone,role,wallet_balance,is_active,name', {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + j.access_token },
    });
    const rows = await p.json();
    const prof = Array.isArray(rows) && rows[0] ? rows[0] : rows;
    console.log(key.padEnd(8), 'uid=' + uid, 'profile=' + JSON.stringify(prof).slice(0, 140));
  } catch (e) {
    console.log(key.padEnd(8), 'ERROR', e.message);
  }
}

// vendor fixture's vendors row (read as the vendor itself)
{
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sec+vendor@sectest.dev', password: env.FIXTURE_PASSWORD || 'SecTest!2026#Amb' }),
  });
  const j = await r.json();
  if (j.access_token) {
    const p = await fetch(env.SUPABASE_URL + '/rest/v1/vendors?user_id=eq.' + j.user.id + '&select=id,business_name,is_active,is_verified,small_stock,large_stock,small_price,large_price', {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + j.access_token },
    });
    console.log('vendor-row', JSON.stringify(await p.json()).slice(0, 200));
  }
}
