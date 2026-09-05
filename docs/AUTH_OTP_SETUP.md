# Auth OTP — Server-side setup

This doc covers the two server-side knobs the auth flow depends on:

1. **OTP digit length** — the app's verify screen now renders and validates a
   **6-digit** code (see `app/(auth)/verify.tsx` → `OTP_LENGTH`). The Supabase
   server must be configured to *send* 6-digit codes to match.
2. **Resend rate limit** — the app enforces a **60-second** client-side cooldown
   on the resend button. Supabase must enforce at least the same window
   server-side so the cooldown can't be bypassed by a fresh install / second
   device.

The two project types are configured differently — pick the one that applies.

---

## A. Hosted Supabase project (current setup)

The Ambobtak backend is a hosted Supabase project (ref `kazcnxfpmgyzjpevqxiu`,
region `eu-west-1`, per `.env`). All auth settings for a hosted project are
managed from the Dashboard — there is **no local config file** for these.

### 1. Confirm phone auth + SMS provider

Dashboard → **Authentication → Providers → Phone**

- **Phone Auth** toggle: enabled.
- **SMS Provider** (Twilio / Vonage / MessageBird): configured with valid
  credentials. Without this, no SMS is delivered and the OTP flow can't
  complete in production.

### 2. OTP digit length

For hosted projects the length of the OTP that is *delivered* is governed by
the SMS provider's setup and Supabase's Auth defaults. The Supabase default is
**6 digits** — which matches the client. There's no per-project digit-length
toggle to flip in the hosted Dashboard UI; the default already matches our 6-box
UI. **Verify there is no custom SMS template truncating to 4 digits** in
Authentication → Auth Providers → Phone → SMS template. Leave the `{{ .Token }}`
variable intact — Supabase substitutes the full 6-digit token into it.

### 3. OTP resend rate limit (⏱️ Task #2 server side)

Dashboard → **Authentication → Rate Limits**

Verify (or set) the following:

| Setting | Recommended | Notes |
|---|---|---|
| OTP send window | **60 seconds** | Mirrors the client cooldown. Server rejects re-sends inside this window with a `rate_limit` error, which the app surfaces as "تم إرسال كود مؤخرًا. انتظر دقيقة وحاول مجددًا." |
| OTPs per hour | 360 (default) | Global cap. Lower if you want stricter abuse control. |

These are the defaults on a fresh project — confirm they're still set, since
an older project may have been adjusted at some point.

### 4. Verify with a test send

```sh
# trivial test: request an OTP from your client (login screen),
# confirm the SMS you receive is 6 digits, then submit it on the verify screen.
```

If the SMS you receive is shorter than 6 digits, the SMS template or provider
config is truncating it — fix it in Authentication → Auth Providers → Phone,
not in the app.

---

## B. Self-hosted Supabase (Docker) — for future migration

If/when the project moves to a self-hosted Supabase instance configured via
Docker Compose, these settings move into `.env` + `docker-compose.yml`. The
relevant env vars are documented in the Supabase guide
(https://supabase.com/docs/guides/self-hosting/self-hosted-phone-mfa).

### 1. `.env`

```sh
# --- Phone OTP ---
# SMS provider to use (twilio | vonage | messagebird | ...)
SMS_PROVIDER=twilio
# Length of the generated OTP (default 6, range 6–10). Matches the 6-box UI.
SMS_OTP_LENGTH=6
# Minimum interval between sends to the same phone (default 60s). Matches the
# client resend cooldown so the app can't be abused by reinstalling.
SMS_MAX_FREQUENCY=60s
# OTP expiry. The Supabase default of 60s is *too short* for real users —
# increase to 5 minutes (300s) so users have time to type the code.
SMS_OTP_EXP=300
# SMS body — {{ .Code }} is replaced with the actual token.
SMS_TEMPLATE=كود التحقق الخاص بك في أمبوبتك هو {{ .Code }}

## Twilio credentials (or the equivalent block for your provider)
SMS_TWILIO_ACCOUNT_SID=your-account-sid
SMS_TWILIO_AUTH_TOKEN=your-auth-token
SMS_TWILIO_MESSAGE_SERVICE_SID=your-message-service-sid
```

### 2. `docker-compose.yml` — pass-throughs under `auth.environment`

Uncomment / add these so the `.env` vars reach the auth container:

```yaml
auth:
  environment:
    # ... existing vars ...
    GOTRUE_SMS_PROVIDER: ${SMS_PROVIDER}
    GOTRUE_SMS_OTP_EXP: ${SMS_OTP_EXP}
    GOTRUE_SMS_OTP_LENGTH: ${SMS_OTP_LENGTH}
    GOTRUE_SMS_MAX_FREQUENCY: ${SMS_MAX_FREQUENCY}
    GOTRUE_SMS_TEMPLATE: ${SMS_TEMPLATE}
    GOTRUE_SMS_TWILIO_ACCOUNT_SID: ${SMS_TWILIO_ACCOUNT_SID}
    GOTRUE_SMS_TWILIO_AUTH_TOKEN: ${SMS_TWILIO_AUTH_TOKEN}
    GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID: ${SMS_TWILIO_MESSAGE_SERVICE_SID}
```

> ⚠️ Variables in `.env` are NOT automatically available inside the container
> unless there is a matching passthrough line in `docker-compose.yml`. The
> classic failure mode is "I set `SMS_OTP_LENGTH` but my codes are still the
> old length" — the passthrough line is missing.

### 3. Recreate the auth container

```sh
docker compose up -d --force-recreate --no-deps auth
```

### 4. Verify settings reached the container

```sh
docker compose exec auth env | grep -E 'GOTRUE_SMS'
```

Confirm `GOTRUE_SMS_OTP_LENGTH=6`, `GOTRUE_SMS_MAX_FREQUENCY=60s`, provider
credentials present.

### 5. Test OTPs for development only

```sh
# Map specific phone numbers to fixed 6-digit codes so dev doesn't burn real SMS.
SMS_TEST_OTP=201000000000:123456,201111111111:654321
# uncomment GOTRUE_SMS_TEST_OTP: ${SMS_TEST_OTP} in docker-compose.yml
```

> ⚠️ Remove `SMS_TEST_OTP` before production. Optionally set an expiry with
> `SMS_TEST_OTP_VALID_UNTIL=2026-12-31T23:59:59Z` (ISO 8601) so it stops
> working automatically.

---

## App-side constants of record

These live in the codebase and must stay aligned with the server settings above:

| Constant | File | Default | Must match |
|---|---|---|---|
| `OTP_LENGTH` | `app/(auth)/verify.tsx` | `6` | hosted `SMS_OTP_LENGTH` (default 6) / self-hosted `SMS_OTP_LENGTH` env |
| `RESEND_COOLDOWN_SECONDS` | `app/(auth)/verify.tsx` | `60` | Supabase OTP send window / `SMS_MAX_FREQUENCY` |

If you change either on the server, update both constants here too (and
re-test the verify screen on a small viewport if you bump `OTP_LENGTH` above 6).
