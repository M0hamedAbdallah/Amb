# Ambobtak Security Test Suite

Black-box security test harness for the Ambobtak gas-delivery marketplace
(Supabase project `kazcnxfpmgyzjpevqxiu` + deployed admin web console
`ambobtak.vercel.app`). 158 tests across ten suites, zero npm dependencies
(built-in `fetch` against raw HTTP), live against the production project.

## What this is

Ten suites (~70 distinct assertions; 158 atomic checks total) cover OWASP Top
10 + OWASP API Top 10 against the actual server:

| Suite | Coverage |
|---|---|
| 01 — surface discovery | OpenAPI root, edge-function POST posture, storage denial |
| 02 — anon access (BOLA) | anon SELECT/INSERT/UPDATE/DELETE on every business table |
| 03 — cross-user RLS (IDOR) | customer-vs-customer, customer-vs-vendor, self-promote probes |
| 04 — RPC abuse (BFLA + SQLi) | revoked-RPC rejection, admin-gated RPC, SQLi payloads on text params |
| 05 — money integrity | withdrawal idempotency, negative/over-balance, promo reuse, webhook forgery |
| 06 — admin-api authorization | full `25-actions × roles` matrix (anon/garbage/custo/vendor/support/admin) |
| 07 — admin-api parameter abuse | filter-injection, regex-injection, hostile settings keys, hostile param types |
| 08 — auth flows | password-grant enumeration, OTP, weak-password rejection, JWT structure, lockout |
| 09 — deployed web console | TLS/security headers, SPA-shell hygiene, no secrets in JS bundles |
| 10 — static secrets (repo scan) | greps for service_role / private keys / payment keys / hard-coded JWTs |

The companion `FINDINGS.md` is the human-readable report: per-finding
evidence, impact, drop-in remediation code (SQL / TypeScript / `vercel.json`)
and a verification step for each finding. The auto-generated
`reports/report-<timestamp>.md` (one per run) holds the raw PASS/FAIL
matrix plus a one-line detail field per finding.

## Files

```
security-tests/
  README.md                 this file
  FINDINGS.md               enriched findings + remediation (per-finding evidence)
  run.mjs                    executes suites 01–10 → writes reports/report-<ts>.md
  lib/
    env.mjs                  loads SUPABASE_URL, anon key, fixture creds from .env.local
    harness.mjs              t(name, fn), findings recorder, PASS/FAIL/INFO counting
    api.mjs                  fetch helpers (URL/URLSearchParams objects only, no concat)
  suites/
    01_discovery.mjs … 10_static_secrets.mjs
  fixtures/
    setup.md                 documents the 7 fixture accounts + setup/teardown SQL
  reports/
    report-<timestamp>.md    auto-generated raw report (regenerated every run)
```

## How to run

Requirements: Node ≥ 18 (built-in `fetch`). No `npm install`.

```cmd
cd /d D:\Amb\security-tests
:: copy .env.local.example to .env.local and fill in the public anon key + fixtures password
node run.mjs
```

The harness opens every suite in order, prints one line per assertion to
stdout, and writes `reports/report-<timestamp>.md`. Exit code is `1` if
any test FAILed (a FAIL means a test assertion was wrong, *not* a finding
— a successfully-detected vulnerability still passes the test).

## Fixtures

Seven throwaway accounts on the `@sectest.local` undeliverable domain + one
vendor row + small wallet balances. Created and destroyed via the Supabase
MCP `execute_sql` tool (or SQL Editor) under direct operator control — never
by the test scripts, because all client writes to money tables are
intentionally revoked. See `fixtures/setup.md` for the idempotent setup
and teardown SQL.

All money-integrity probes run only on the fixture vendor's wallet. No
real user data is ever read or mutated. OTP probes target `@test.local`
only.

## OWASP coverage matrix

| OWASP Top 10 / API Top 10 | Suite(s) |
|---|---|
| A01 Broken Access Control / API1 BOLA | 02, 03, 06 |
| A02 Cryptographic Failures | 08 (JWT/transport), 09 (TLS headers) |
| A03 Injection / API3 Property-Level Auth | 04 (SQLi), 06 (role mass-assign), 07 (filter injection) |
| A04 Insecure Design / API8 Misconfig | 01, 02, 05 (business-flow money abuse) |
| A05 Security Misconfiguration | 01, 07, 09 (headers, CORS, verbose errors) |
| A06 Vulnerable Components | 10 (static repo scan) |
| A07 Auth Failures / API2 Broken Auth | 08 (enumeration, lockout, OTP) |
| API4 Unrestricted Resource Consumption | 08 (rate limits, ≤6 attempts) |
| API5 BFLA | 04, 06 |
| API6 Sensitive Business Flows | 05 (withdrawal, idempotency) |
| API7 SSRF | n/a — code review verified no user-supplied URL fetch paths |
| A08 / A09 / A10 | out of runtime scope (see below) |

## Out of scope

Volumetric DoS / load testing, the Supabase platform and Vercel
infrastructure themselves, social engineering, mobile-binary / app-store
package analysis. Rate-limit probes in suite 08 are capped at ≤6 attempts
to avoid volumetric abuse.

## Safety rules enforced by the harness

- Fixtures only — no real accounts or data mutated.
- No volumetric DoS — every rate-limit probe is capped at 6 attempts.
- OTP requests go to undeliverable `@test.local` addresses only.
- No destructive DB writes scripted — fixture create / delete is in
  `fixtures/setup.md` and executed by the operator via Supabase MCP under
  direct control.
- All HTTP helpers build URLs via `new URL()` and `URLSearchParams.set()`
  (no string concatenation).

## After fixing a finding

Each finding in `FINDINGS.md` ends with a "Verification" subsection
explaining which suite probe to re-run. In short:

```cmd
node run.mjs
```

…then check the new `reports/report-<timestamp>.md` for the affected
probe. The Critical finding's self-promote probe (suite 03) must report
`affected 0`; the High finding's dispatch-engine probe (suite 01) must
report `HTTP 401`; the Medium finding's sensitive-column probe (suite 02)
must report all sensitive columns hidden.
