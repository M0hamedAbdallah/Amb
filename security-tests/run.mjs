// ─────────────────────────────────────────────────────────────────────────
// run.mjs — executes suites 01–10 in order and writes the markdown report
// to reports/report-<timestamp>.md.  Usage:  node run.mjs
// ─────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getState } from './lib/harness.mjs';
import { ENV } from './lib/env.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const suites = [
  './suites/01_discovery.mjs',
  './suites/02_anon_access.mjs',
  './suites/03_rls_crossuser.mjs',
  './suites/04_rpc_abuse.mjs',
  './suites/05_money_integrity.mjs',
  './suites/06_adminapi_authz.mjs',
  './suites/07_adminapi_abuse.mjs',
  './suites/08_auth_flows.mjs',
  './suites/09_web_deployed.mjs',
  './suites/10_static_secrets.mjs',
];

for (const s of suites) {
  try {
    const mod = await import(s);
    await mod.run();
  } catch (e) {
    console.error('SUITE ERROR in ' + s + ': ' + e);
  }
}

// ── Report ────────────────────────────────────────────────────────────────
const state = getState();
const pass = state.tests.filter((x) => x.status === 'PASS').length;
const fail = state.tests.filter((x) => x.status === 'FAIL').length;
const sevOrder = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const findings = [...state.findings].sort(
  (a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity),
);

const now = new Date();
const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 17);
const lines = [];
lines.push('# Ambobtak Security Test Report');
lines.push('');
lines.push('- Date: ' + now.toISOString());
lines.push('- Target: ' + ENV.URL + ' (project kazcnxfpmgyzjpevqxiu) + deployed web console');
lines.push('- Result: **' + pass + ' passed / ' + fail + ' failed** of ' + state.tests.length + ' tests; ' + findings.length + ' findings');
lines.push('');
lines.push('## Executive summary');
lines.push('');
if (findings.length) {
  for (const f of findings) {
    lines.push('- **[' + f.severity + '] ' + f.title + '** — ' + f.detail);
  }
} else {
  lines.push('No findings recorded.');
}
lines.push('');
lines.push('## Findings detail');
lines.push('');
lines.push('| Severity | Title | Suite | Detail |');
lines.push('|---|---|---|---|');
for (const f of findings) {
  lines.push('| ' + f.severity + ' | ' + f.title + ' | ' + f.suite + ' | ' + String(f.detail).replace(/\|/g, '\\|') + ' |');
}
lines.push('');
lines.push('## Test matrix');
lines.push('');
let lastSuite = '';
for (const rec of state.tests) {
  if (rec.suite !== lastSuite) {
    lines.push('');
    lines.push('### ' + rec.suite);
    lastSuite = rec.suite;
  }
  const flag = rec.status === 'PASS' ? '✅' : '❌';
  lines.push('- ' + flag + ' ' + rec.name + (rec.note ? ' — ' + rec.note : ''));
}
lines.push('');
lines.push('## OWASP coverage');
lines.push('');
lines.push('| Threat (OWASP Top 10 / API Top 10) | Covered by |');
lines.push('|---|---|');
lines.push('| A01 Broken Access Control / API1 BOLA | suites 02, 03, 06 |');
lines.push('| A02 Cryptographic Failures | suites 08 (JWT/transport), 09 (TLS headers) |');
lines.push('| A03 Injection / API3 Broken Object Property Level Authorization | suites 04 (SQLi), 06 (mass assignment via role params), 07 (filter injection) |');
lines.push('| A04 Insecure Design / API8 Security Misconfiguration | suites 01, 02, 05 (business-flow money abuse) |');
lines.push('| A05 Security Misconfiguration | suites 01, 07, 09 (headers, CORS, verbose errors) |');
lines.push('| A06 Vulnerable Components | suite 10 (static repo scan only) |');
lines.push('| A07 Auth Failures / API2 Broken Authentication | suite 08 (enumeration, lockout, OTP) |');
lines.push('| API4 Unrestricted Resource Consumption | suite 08 (rate limits — capped probes) |');
lines.push('| API5 BFLA (function-level authorization) | suites 04, 06 |');
lines.push('| API6 Sensitive Business Flows | suite 05 (withdrawal abuse, idempotency) |');
lines.push('| API7 SSRF | n/a — no user-supplied URL fetch paths in API surface (verified in code review) |');
lines.push('| A08 Software/Data Integrity Failures / A09 Logging / A10 SSRF | out of runtime scope; see report README |');
lines.push('');
lines.push('## Out of scope');
lines.push('');
lines.push('Volumetric DoS/load testing, Supabase/Vercel platform internals, social engineering, mobile binary analysis.');

const reportDir = join(here, 'reports');
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, 'report-' + stamp + '.md');
writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log('\n────────────────────────────────────────');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed, ' + findings.length + ' findings');
console.log('Report: ' + reportPath);
process.exitCode = fail > 0 ? 1 : 0;
