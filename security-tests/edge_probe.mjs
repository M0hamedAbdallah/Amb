// ─────────────────────────────────────────────────────────────────────────
// edge_probe.mjs — AMB-SEC-002 verification probe (manual, not in run.mjs).
// Confirms dispatch-engine accepts ONLY the service credential, using a
// nonce order id (nonexistent → processed:0, zero side effects).
// Run: node edge_probe.mjs
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fnCall, ENV, bearer } from './lib/api.mjs';

const m = readFileSync('D:/Amb/.env', 'utf8').match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m);
const SR = m[1].trim();

const nonce = '00000000-0000-0000-0000-00000000face';
const cases = [
  ['no Authorization (apikey=anon only)', undefined, {}],
  ['Bearer anon JWT', bearer(ENV.ANON_KEY), {}],
  ['Bearer service key', bearer(SR), { apikey: SR }],
  ['apikey=service key (no Bearer)', undefined, { apikey: SR }],
];
let fail = 0;
for (const [label, hdr, extra] of cases) {
  const res = await fnCall('dispatch-engine', hdr, { order_id: nonce }, 'POST', extra);
  const expectAuth = label.includes('service key');
  const ok = expectAuth ? res.status === 200 : res.status === 401;
  if (!ok) fail++;
  console.log(
    (ok ? 'OK  ' : 'FAIL'),
    label.padEnd(36),
    'HTTP', res.status,
    String(res.json?.error ?? res.json?.processed ?? res.text ?? '').slice(0, 60),
  );
}
process.exit(fail ? 1 : 0);
