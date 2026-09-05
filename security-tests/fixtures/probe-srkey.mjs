// One-off probe: what can the sb_secret_ key in D:\Amb\.env actually do?
// 1) GET /rest/v1/ root  -> 200 only for service-role credentials (AMB-SEC-007)
// 2) POST dispatch-engine with sb_secret bearer -> current posture
// 3) Same root call with anon key -> expect 401 (control)
// Reads .env directly; prints statuses only, never key material.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('D:/Amb/.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const URL_ = env.EXPO_PUBLIC_SUPABASE_URL;
const sr = env.SUPABASE_SERVICE_ROLE_KEY;
const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

async function root(key, label) {
  const res = await fetch(`${URL_}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const len = (await res.text()).length;
  console.log(`root ${label}: HTTP ${res.status} (body ${len} bytes) — ${res.ok ? 'SERVICE-ROLE POWER' : 'not service'}`);
}

await root(sr, 'sb_secret');
await root(anon, 'anon(control)');

const res2 = await fetch(`${URL_}/functions/v1/dispatch-engine`, {
  method: 'POST',
  headers: { apikey: sr, Authorization: `Bearer ${sr}`, 'Content-Type': 'application/json' },
  body: '{}',
});
console.log(`dispatch-engine POST w/ sb_secret: HTTP ${res2.status} ${(await res2.text()).slice(0, 120)}`);
