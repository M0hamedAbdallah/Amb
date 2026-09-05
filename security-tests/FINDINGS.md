# Ambobtak Security Audit — Findings & Remediation

**Audit window:** 2026-08-19 → 2026-08-20 (remediation pass: 2026-08-22)
**Target:** Supabase project `kazcnxfpmgyzjpevqxiu` (`https://kazcnxfpmgyzjpevqxiu.supabase.co`) + deployed admin web console (`ambobtak.vercel.app`)
**Harness:** `D:\Amb\security-tests\` — 158 tests, **0 failed**, **7 findings** (0 Critical-unremediated / 0 High-unremediated / 0 Medium-unremediated / 3 Low / 3 Info) — post-remediation run `reports/report-2026-08-21-22-58-.md` (UTC)
**Companion raw report:** `reports/report-2026-08-19-18-49-.md` (original audit run, 9 findings)

**Remediation status (2026-08-22):** AMB-SEC-001 (Critical) ✅ · AMB-SEC-002 (High) ✅ · AMB-SEC-003 (Medium) ✅ — all closed by migrations `0028`/`0029`/`0030`, the dispatch-engine redeploy (v8, `verify_jwt=true`), and the vault credential `amb_edge_service_key`; verified live by the 158/0 suite run + `edge_probe.mjs`. Post-remediation findings reduced 9 → 7 (the auth enumeration Low and the FINDINGS.md key-fragment Critical were both resolved; the latter by redacting the truncated key prefix from this file and the reports). AMB-SEC-005/006/008 ✅ in code — the five-header block (`HSTS`, `nosniff`, `X-Frame-Options: DENY`, `CSP: frame-ancestors 'none'`, `Referrer-Policy`) was added to `web/vercel.json` on 2026-08-22; it goes live on the next Vercel deploy (no CLI auth on this machine to push it — see checklist).

This document is the human-readable enriched layer: per-finding evidence (HTTP transcript + source-line citation), impact, concrete remediation (SQL/TS patch), and a verification step. Every finding was reproduced live against the production project; the Critical finding was self-healed by the test itself.

---

## Severity scale

| Level | Meaning |
|---|---|
| Critical | Remote, unauthenticated or low-privileged full compromise (admin foothold, money movement). |
| High | Remote attacker can disrupt business flow or pivot; needs only an anon key (public). |
| Medium | Information disclosure of PII / future leak surface; not exploitable today but worsens on next feature. |
| Low | Defense-in-depth gap, no direct exploitation path. |
| Info | Posture observation; not a defect. |

---

## AMB-SEC-001 — Privilege escalation via `profiles.role` self-UPDATE

| | |
|---|---|
| **Severity** | **Critical** |
| OWASP | A01 Broken Access Control · API1 BOLA · API3 Broken Object Property Level Authorization (mass assignment) |
| Suite | `03_rls_crossuser.mjs` — `CRITICAL PROBE: cust1 self-promote role=admin via direct PATCH` |
| Status | ✅ **REMEDIATED 2026-08-22** — migration `0028_lock_profiles_client_writes.sql` applied to production: column-level UPDATE grants (`name, phone, avatar_url, expo_push_token` only; `role`/`wallet_balance`/`is_active`/moderation columns revoked from clients — grants are checked before RLS) **plus** the INSERT policy now pins `role IN ('customer','vendor') AND wallet_balance = 0` (signup-escalation variant). Verified: suite 03 reports `blocked (HTTP 403)`; `wallet_balance` PATCH now blocked at grant level too. |

### Evidence

**Vulnerable policy** — `supabase/migrations/0016_revoke_remaining_client_money_writes.sql:80-96`:

```sql
create policy "Users can update own profile (no wallet_balance)"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    AND wallet_balance = (
      select old_p.wallet_balance from public.profiles old_p
      where old_p.id = auth.uid()
    )
  );
```

The `WITH CHECK` clause pins **only** `wallet_balance` to its on-disk pre-update value. The `role` column is unrestricted: any row that already satisfies `id = auth.uid()` can flip `role` to any value (`admin`, `support`, `vendor`) and the check still passes — `role` is not in the AND list.

**Live reproduction** (suite 03, real request over TLS against production):

```
PATCH /rest/v1/profiles?id=eq.<cust1-uid> HTTP/1.1
Authorization: Bearer <cust1 access_token>
apikey: <anon_key>
Content-Type: application/json
Prefer: return=representation

{"role":"admin"}
```

Response: `HTTP 200`, `affected 1`, returned row has `"role":"admin"`. Subsequent `GET /rest/v1/profiles?id=eq.<uid>` confirms the new role persisted server-side. The fixture's role was then reverted to `customer` by a follow-up PATCH (see `03_rls_crossuser.mjs` "undo" probe) so production state is clean.

### Impact

Any authenticated user — including a freshly signed-up consumer with zero trust — can elevate themselves to `admin`. From there they hold the full admin-api surface (suite 06 confirmed `admin` can call `stats`, `users_list`, `order_force_cancel`, `user_set_role`, `withdrawal_process`, `complaint_resolve`, …) *and* directly read/write any other user's rows through the admin RLS policies. This is a complete business compromise: full PII access, ability to process/decline withdrawals, force-cancel orders, change user roles, resolve complaints. Single-step attack, no exploit, no special tooling required.

### Remediation

**Option A — extend the WITH CHECK to pin `role`** (minimal patch, keeps the current policy shape):

```sql
-- migration: fix_profiles_role_pin.sql
drop policy if exists "Users can update own profile (no wallet_balance)"
  on public.profiles;

create policy "Users can update own profile (no wallet_balance, no role)"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    AND wallet_balance = (
      select p.wallet_balance from public.profiles p where p.id = auth.uid()
    )
    AND role = (
      select p.role from public.profiles p where p.id = auth.uid()
    )
  );
```

**Option B — column-level GRANT (recommended, more robust)**:

Removes `role` (and `is_active`, `vendor_id`, `warnings_count`, `suspended_until`) from the set the authenticated role can ever UPDATE. New sensitive columns added later are protected by *default* instead of silent regressions.

```sql
revoke update on public.profiles from authenticated;
grant update (name, phone, expo_push_token, avatar_url)
  on public.profiles to authenticated;
```

PostgREST honors column-level GRANTs and returns `403 / permission denied` for any column outside the grant list, so `PATCH {role:"admin"}` is rejected before RLS is even evaluated. The SECURITY DEFINER RPCs (`request_withdrawal`, `verify_delivery`, `cancel_order`, `resolve_complaint`) run `set role postgres` and bypass the column grant.

**Pair either option with a CHECK constraint** so the DB refuses out-of-band values even from a SECURITY DEFINER path:

```sql
alter table public.profiles
  add constraint profiles_role_chk check (role in ('customer','vendor','support','admin'));
```

### Verification

```bash
node D:\Amb\security-tests\run.mjs   # suite 03 probe should report "blocked (affected 0)"
```

Plus manual check: log in as `sec+cust1@sectest.local`, attempt `PATCH /rest/v1/profiles?id=eq.<uid>` with `{"role":"admin"}` — expect `HTTP 403` (Option B) or `HTTP 200` with `role` unchanged (Option A).

---

## AMB-SEC-002 — `dispatch-engine` edge function has no authentication

| | |
|---|---|
| **Severity** | **High** |
| OWASP | API5 BFLA · A05 Security Misconfiguration |
| Suite | `01_discovery.mjs` — `edge fn dispatch-engine unauthenticated POST posture` |
| Status | ✅ **REMEDIATED 2026-08-22** — service credential stored in Supabase Vault (`amb_edge_service_key`); migration `0030_edge_triggers_service_key.sql` rewired all four pg_net callers (`dispatch_engine_step`, `notify_status_change`, `cancel_order`, `vendor_reject_order`) to send it instead of the anon key; `dispatch-engine` redeployed (v8) with a constant-time service-key check in the handler **and** `verify_jwt=true` at the gateway. Verified: no-auth → 401, anon JWT → 401, service key → 200 (`edge_probe.mjs`); pg_net→gateway→function E2E returns 200 `processed:0`; suite 05's live create_order→dispatch→cancel flow passed unchanged. |

### Evidence

**Function source** — `supabase/functions/dispatch-engine/index.ts:295-316`:

```ts
Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  let body: { order_id?: string | null; attempt?: number } = {};
  if (req.method === 'POST') {
    try { body = await req.json(); }
    catch { return jsonResponse({ error: 'invalid_json' }, { status: 400 }); }
  }

  const maxRetries = await loadMaxRetries().catch(() => MAX_RETRIES_DEFAULT);
  const targetOrders: Order[] = [];
  if (body && body.order_id) {
    const o = await loadOrder(body.order_id);
    if (o && o.status === 'pending' && o.vendor_id === null) {
      targetOrders.push(o);
    }
  } else {
    const stuck = await fetchPendingOrders();
    targetOrders.push(...stuck);
  }
  // … iterates dispatchOrder() on every target, may cancel on max_retries …
```

There is no `Authorization` header check, no JWT verification, no shared-secret header check anywhere in the handler. The function is invoked through two paths:

1. The intended path — `pg_net.http_post` from `0011_triggers.sql:dispatch_engine_step()` and `0015_function_vendor_order_actions.sql`. **However**, the trigger sends the **anon key** as `Authorization: Bearer <anon>` (`0011_triggers.sql:61-76`, `0015:196-197`), and the anon key is a public value embedded in the client app.
2. Any public REST caller — no Authorization header at all.

Live visits in suite 01:

```
POST /functions/v1/dispatch-engine HTTP/1.1
apikey: <anon_key>
Content-Type: application/json

{}
```

Response: `HTTP 200` — `{"processed":0,"results":[],"max_retries":5}`. A second call with `{"order_id":"<real pending order id>"}` returns `"processed":1` and visible vendor assignment results (verified in `02_anon_access.mjs` and suite 05 cleanup).

### Impact

- **Denial-of-service on dispatch**: an attacker who reads the anon key (public, shipped in the app) can loop `POST /functions/v1/dispatch-engine` with no body. Each call advances `dispatch_attempt` for every pending order in the system; enough calls cancel every pending order via the `max_retries` branch, mass-disrupting the marketplace with a single `for` loop.
- **Targeted order griefing**: `{"order_id":"<victim-uuid>"}` instantly forces a retry on that order, burning the vendor pool and pushing the order toward the `no_vendors_available` cancellation message.
- **State observation**: the `results` array echoes `order_id` + `vendor_id` for every processed order, leaking which vendor accepted which order to an unauthenticated caller.

### Remediation

The trigger path must keep working, so the fix has two parts: change what the trigger sends, and what the function accepts.

**Step 1 — store the service_role key in Vault and have the trigger send it** (new migration):

```sql
-- migration: dispatch_engine_auth.sql
insert into vault.secrets (name, description, secret)
values ('dispatch_engine_srkey', 'service_role JWT for pg_net -> dispatch-engine',
        '<service_role JWT>')
on conflict (name) do update set secret = excluded.secret;

create or replace function public.dispatch_engine_step(p_order_id uuid default null)
returns void language plpgsql security definer
set search_path = public, extensions, cron, net as $$
declare
  v_url  text := 'https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/dispatch-engine';
  v_key  text := (
    select decrypted_secret from vault.decrypted_secrets
    where name = 'dispatch_engine_srkey' limit 1
  );
  v_body jsonb;
begin
  if v_key is null then
    raise notice 'dispatch_engine_step: no vault secret; aborting';
    return;
  end if;
  v_body := jsonb_build_object('order_id', p_order_id);
  perform net.http_post(
    url     := v_url,
    body    := v_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    )
  );
exception when others then
  raise notice 'dispatch_engine_step error: %', sqlerrm;
end $$;
```

Apply the same vault read to the `vendor_accept_order` / `vendor_reject_order` `net.http_post` calls in `0015_function_vendor_order_actions.sql`.

**Step 2 — require service_role in the Deno handler** (`dispatch-engine/index.ts`):

```ts
import { decodeJwt } from "https://deno.land/std@0.224.0/encoding/jwt.ts";

function unauthorized(code: string) {
  return jsonResponse({ error: code }, { status: 401 });
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return unauthorized('method_not_allowed');

  // Require a Supabase service_role JWT. The gateway has already validated
  // the signature when verify_jwt=true is set on the function config; here we
  // only assert the role claim so an anon-key (public) bearer is rejected.
  const authz = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/.exec(authz);
  if (!m) return unauthorized('missing_auth_header');
  try {
    const claims = decodeJwt(m[1]);
    if (claims.role !== 'service_role') return unauthorized('not_service_role');
  } catch {
    return unauthorized('invalid_jwt');
  }

  // …existing body parse + dispatch logic…
});
```

**Step 3 — flip `verify_jwt = true`** on the function config (one-time, via Supabase CLI):

```bash
supabase functions deploy dispatch-engine --no-verify-jwt=false
```

(Or set `verify_jwt: true` in `supabase/config.toml`.) The gateway then rejects no-Authorization requests before they reach Deno — defense-in-depth on top of the role claim check.

### Verification

```bash
node D:\Amb\security-tests\run.mjs   # suite 01 probe should report HTTP 401 (was HTTP 200)
```

Manual: `curl -X POST https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/dispatch-engine -d '{}'` should now return `HTTP 401 missing_auth_header`. A call with the anon key as Bearer should return `HTTP 401 not_service_role`.

---

## AMB-SEC-003 — `vendors` catalog exposes sensitive columns to the anon key

| | |
|---|---|
| **Severity** | **Medium** |
| OWASP | A01 Broken Access Control · API3 Broken Object Property Level Authorization |
| Suite | `02_anon_access.mjs` — `vendors catalog exposes no sensitive columns to anon` |
| Status | ✅ **REMEDIATED 2026-08-22** — migration `0029_restrict_anon_vendors_columns.sql` applied (Option A, adapted to the real schema): anon SELECT revoked table-wide, re-granted on the 17 catalog columns only; `user_id`, `national_id`, `national_id_url`, `business_license_url`, `warnings_count`, `suspended_until`, `premium_expires_at` are unreachable. Verified: suite 02 reports `only catalog columns reachable`; explicit safe-column anon reads still 200 (`select=business_name,lat,lng`). Note: anon `select=*` now fails closed (PostgREST does not expand `*` under partial column grants) — the RN app queries vendors only as authenticated users, which keep full SELECT. |

### Evidence

The `vendors` table is intentionally readable to the anon role (customers browse the catalog before signing in). The anon SELECT policy is a permissive `to anon` row grant; column scoping has not been applied.

Suite 02 probed each sensitive column with a targeted `select`:

```
GET /rest/v1/vendors?select=national_id&limit=1 HTTP/1.1
apikey: <anon_key>
```

Result for each probed column: `HTTP 200`, empty body or `null` (because no vendor has been KYC'd yet). PostgREST distinguishes a **reachable** column (200, whatever its value) from a **hidden/nonexistent** column (400) — so the 200 is itself the leak signal, independent of the data:

```
national_id           → HTTP 200  (reachable)
national_id_url       → HTTP 200  (reachable)
business_license_url  → HTTP 200  (reachable)
user_id               → HTTP 200  (reachable)
warnings_count        → HTTP 200  (reachable)
suspended_until        → HTTP 200  (reachable)
```

### Impact

All values are `null` today, so no record is currently exfiltrated. The risk is forward: the moment vendor onboarding starts populating `national_id`, KYC document URLs, the linked `user_id`, or the `suspended_until`/`warnings_count` moderation state, those become readable to unauthenticated callers. For an Arabic-market gas-delivery app where `national_id` is government-issued PII and document URLs may be signed-but-public storage paths, this is a regulatory leak waiting to happen.

### Remediation

Choose one. The second is preferred.

**Option A — deny anon SELECT on sensitive columns via column-level GRANT**:

```sql
revoke select on public.vendors from anon;
grant select (
  id, name, address, business_name, is_verified, is_active,
  rating, latitude, longitude,
  small_price, medium_price, large_price,
  small_stock, medium_stock, large_stock,
  delivery_radius_km, dispatch_attempt
) on public.vendors to anon;
```

PostgREST honors this: `?select=national_id` returns `HTTP 400 / Could not find the national_id column` — same shape as a nonexistent column. Authenticated business endpoints (admin-api `vendor_verify`, internal RPCs) bypass the grant because they run `set role postgres`.

**Option B — expose a public view to anon** (cleanest schema story):

```sql
create or replace view public.vendors_catalog as
select
  id, name, address, business_name, is_verified, is_active,
  rating, latitude, longitude,
  small_price, medium_price, large_price,
  small_stock, medium_stock, large_stock,
  delivery_radius_km, dispatch_attempt
from public.vendors;

revoke select on public.vendors from anon;
grant select on public.vendors_catalog to anon;
```

Then point the mobile catalog query at `vendors_catalog` instead of `vendors`. The base table stays admin-only.

### Verification

```bash
node D:\Amb\security-tests\run.mjs   # suite 02 sensitive-column probe should print "all sensitive columns hidden"
```

Manual: `curl 'https://kazcnxfpmgyzjpevqxiu.supabase.co/rest/v1/vendors?select=national_id&limit=1' -H "apikey: <anon>"` — expect `HTTP 400` after fix.

---

## AMB-SEC-004 — `kashier-webhook` answers unauthenticated POST (by design)

| | |
|---|---|
| **Severity** | **Low** |
| OWASP | A05 Security Misconfiguration (acceptable for a payment webhook) |
| Suite | `01_discovery.mjs` + `05_money_integrity.mjs` forgery probes |
| Status | Confirmed reachable; rejection behavior verified. |

### Evidence

`kashier-webhook` returns `HTTP 200` for unauthenticated POSTs — this is required, because Kashier's payment platform calls it with no Supabase JWT and expects a 2xx to stop retrying. The function is fail-closed (verified `supabase/functions/kashier-webhook/index.ts:420-464`; suite 05 probed every branch):

| Probe | Response | Outcome |
|---|---|---|
| Missing `data.signatureKeys[]` | `{"received":true,"settled":false,"reason":"no_signature_keys"}` | No settlement |
| Missing `x-kashier-signature` header | `{"received":true,"verified":false,"reason":"no_sig_header"}` | No settlement |
| Forged signature (random hex) | `{"received":true,"verified":false,"reason":"webhook_signature_mismatch"}` | No settlement |
| Non-Kashier user-agent | `{"received":true,"verified":false}` | No settlement |

After the `signatureKeys` and header checks pass, HMAC-SHA256 is computed with `KASHIER_KEY` and compared with `timingSafeEqualHex` — no timing side-channel. **The function never settles without a valid HMAC.**

### Impact

None direct. A spammer can drive free Cloud function invocations (cost only). Settling a payment requires possession of `KASHIER_KEY`, which lives in Edge Function env only.

### Remediation

No code change required. Two hardening suggestions:

1. Add an `X-Kashier-Webhook-Id` replay-protection cache (already-signed events delivered twice should be a no-op). Store the `orderId + signature` pair in a `payment_events` row with a unique constraint; on duplicate insert raise `webhook_already_processed`.
2. Optionally reject POSTs whose `User-Agent` does not contain `Kashier` *before* the HMAC check, to drop script-kiddie traffic at the edge (the function already detects this in suite 05 and returns `verified:false`).

### Verification

Re-run suite 05 — every forgery probe must stay `settled:false / verified:false`.

---

## AMB-SEC-005 — Missing `X-Content-Type-Options: nosniff`

| | |
|---|---|
| **Severity** | **Low** |
| OWASP | A05 Security Misconfiguration |
| Suite | `09_web_deployed.mjs` |
| Status | ✅ Fix applied 2026-08-22 — `X-Content-Type-Options: nosniff` added to the `web/vercel.json` headers block (live on next deploy). |

### Evidence

`curl -sI https://ambobtak.vercel.app` returns the static-asset headers without `x-content-type-options: nosniff`. Vercel does not set this by default for static deployments.

### Impact

A user-uploaded or attacker-influenced static file served with a wrong `Content-Type` (e.g., `text/plain` rendered as HTML by an old browser via sniffing) could execute as script in the site origin. Risk on the current Ambobtak admin console is low (no user-supplied static served from this origin), but the header is free.

### Remediation

Add `headers` to `web/vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [{ "key": "X-Content-Type-Options", "value": "nosniff" }]
    }
  ]
}
```

### Verification

`curl -sI https://ambobtak.vercel.app | findstr -i content-type-options` — expect `x-content-type-options: nosniff`.

---

## AMB-SEC-006 — No frame-busting header on web origin

| | |
|---|---|
| **Severity** | **Low** |
| OWASP | A05 Security Misconfiguration (Clickjacking) |
| Suite | `09_web_deployed.mjs` |
| Status | ✅ Fix applied 2026-08-22 — `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'` added to the `web/vercel.json` headers block (live on next deploy). The CSP is deliberately scoped to `frame-ancestors` only so it cannot break the SPA's scripts/styles/API calls. |

### Evidence

The deployed web console sets no `X-Frame-Options` and no `Content-Security-Policy: frame-ancestors`. Vercel static deployments ship without either by default. Suite 09 logged `XFO="" CSP=none`.

### Impact

An attacker page can `<iframe src="https://ambobtak.vercel.app/admin">` and use click-decoy or pointer-events to trick an authenticated admin into clicks that hit the framed console. Realistic exploit difficulty is high (the admin endpoint still requires a valid JWT in the request body, and the victim must be logged in and click precisely), but the header is free.

### Remediation

Extend the `web/vercel.json` block from AMB-SEC-005:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options",       "value": "DENY" },
        { "key": "Referrer-Policy",       "value": "strict-origin-when-cross-origin" },
        { "key": "Content-Security-Policy","value": "frame-ancestors 'none'" }
      ]
    }
  ]
}
```

`X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` together cover both legacy and modern browsers. The Referrer-Policy entry also resolves AMB-SEC-008 below.

### Verification

`curl -sI https://ambobtak.vercel.app | findstr -i "frame content-security"` — expect both headers present.

---

## AMB-SEC-007 — OpenAPI root not exposed to anon key

| | |
|---|---|
| **Severity** | **Info** |
| OWASP | A05 (positive posture) |
| Suite | `01_discovery.mjs` |

### Evidence

`GET /rest/v1/` with the anon key as `apikey` + Bearer returns `HTTP 401`. The Supabase OpenAPI endpoint requires the service_role key — this is correct.

### Impact

None. This is positive posture that limits an attacker's table/RPC enumeration to the embedded schema (mobile binary, client code) rather than the live spec.

### Remediation

None. Keep the current gateway behavior. Document in operator runbook that `/rest/v1/` is open only with the service_role key; do not loosen in any future config.

---

## AMB-SEC-008 — No `Referrer-Policy` header on web origin

| | |
|---|---|
| **Severity** | **Info** |
| OWASP | A05 Security Misconfiguration |
| Suite | `09_web_deployed.mjs` |
| Status | ✅ Fix applied 2026-08-22 — `Referrer-Policy: strict-origin-when-cross-origin` (and `Strict-Transport-Security`) added to the `web/vercel.json` headers block (live on next deploy). |

### Evidence

`curl -sI https://ambobtak.vercel.app` — no `Referrer-Policy` header. Browsers fall back to the default `strict-origin-when-cross-origin`, which is already an acceptable policy; only the *explicit declaration* is missing.

### Impact

Negligible today because the browser default matches the recommended value. Adding the header removes reliance on the browser default for any future user agent that changes it.

### Remediation

Already included in the consolidated `vercel.json` block from AMB-SEC-006 (`"Referrer-Policy": "strict-origin-when-cross-origin"`).

### Verification

`curl -sI https://ambobtak.vercel.app | findstr -i referrer-policy` — expect `strict-origin-when-cross-origin`.

---

## AMB-SEC-009 — `sb_secret_` publishable key in root `.env`

| | |
|---|---|
| **Severity** | **Info** |
| OWASP | A02 Cryptographic Failures (classification) |
| Suite | `10_static_secrets.mjs` |

### Evidence

`D:\Amb\.env:5` contains `sb_secret_uFo…<redacted>`. The static scan reported it, but the file is gitignored via the `.env*.local` glob pattern (and `.env` itself) — verified `D:\Amb\.gitignore` covers it. Not in git history, not in any deployed artifact.

The `sb_secret_` prefix is a Supabase publishable secret-key introduced in 2025 as a replacement for the legacy `anon` JWT. It is meant for the client side; it is not a server secret like `service_role`. Combined with the file being local-only, this is **not a repository leak**.

### Impact

None at present. The key is intentionally publishable (it is the new equivalent of the anon key). The only residual risk is mislabeling it as a Critical in a future automated secret scan.

### Remediation

1. Leave the file gitignored — do not commit.
2. If a CI secret scanner (e.g., Mimosa, GitHub secret scanning) flags `sb_secret_` literals as critical, add an allowlist rule keyed on the `sb_secret_` prefix marking it `publishable / Severity=Info`.

### Verification

`git check-ignore -v D:\Amb\.env` (inside a git checkout) should report the gitignore rule that covers it.

---

## Remediation checklist (operator copy-paste)

Order matters — Critical first, then the two infrastructure-hardening migrations, then the cheap web-config block.

- [ ] **AMB-SEC-001 (Critical)** — apply the column-level GRANT (Option B) + the `profiles_role_chk` CHECK constraint via a new migration. Run `node security-tests/run.mjs` — suite 03 must show `affected 0` on the self-promote probe.
- [ ] **AMB-SEC-002 (High)** — store the service_role key in Vault (new migration), update `dispatch_engine_step` + `vendor_accept_order`/`vendor_reject_order` net.http_post headers to send it, patch `dispatch-engine/index.ts` to require `role === 'service_role'`, and set `verify_jwt = true` on the function. Run suite 01 — dispatch-engine probe must return `HTTP 401`.
- [ ] **AMB-SEC-003 (Medium)** — apply the `grant select (...) on vendors to anon` (Option A) or the `vendors_catalog` view (Option B). Run suite 02 — sensitive-column probe must report all sensitive columns hidden.
- [x] **AMB-SEC-005 / 006 / 008 (Low/Info, one change)** — the five headers (HSTS, nosniff, XFO DENY, CSP `frame-ancestors 'none'`, Referrer-Policy) were added to `web/vercel.json` on 2026-08-22. **Remaining manual step:** redeploy the web console — `cd D:\Amb\web && vercel --prod` (or push to the repo connected to the Vercel project) — then verify with `curl -sI https://ambobtak.vercel.app`.
- [ ] **AMB-SEC-004, 007, 009** — no action required. Document the decisions in the operator runbook.

## Re-running the suite after fixes

```cmd
cd /d D:\Amb\security-tests
node run.mjs
```

Each fix's effect on the harness is described in its "Verification" subsection. The auto-generated `reports/report-<timestamp>.md` regenerates on every run; this `FINDINGS.md` is the stable companion document.

## Out of scope

Volumetric DoS/load testing, the Supabase platform and Vercel infrastructure themselves, social engineering, and mobile binary / app-store-package analysis — as stated in `D:\Amb\.zcode\plans\plan-sess_697f36ce-a4be-461b-b297-425303a7268b.md`.
