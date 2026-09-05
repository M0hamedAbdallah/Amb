// ──────────────────────────────────────────────────────────────────────────
// kashier-webhook  —  Kashier Transaction webhook receiver (Edge Function)
// ──────────────────────────────────────────────────────────────────────────
// Invoked by:
//   • Kashier's server, POST'ing a Transaction webhook to the public URL
//     (https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/kashier-webhook).
//     The webhook URL is supplied PER REQUEST via the `serverWebhook` field of
//     the Payment Session body (see kashier-checkout) — confirmed by docs:
//     we do NOT need to register the webhook in the Kashier dashboard at all.
//
// ─── Authorisation scheme (confirmed against the real docs) ───────────────
//   Signature is NOT in the request body. It arrives as headers:
//     • `x-kashier-signature: <hex>` — the HMAC-SHA256 hex digest, computed
//       over a canonical query string (see below) with the PAYMENT API KEY.
//     • `User-Agent: KASHIER` — used as a soft sanity check (not cryptographic).
//   Algorithm: HMAC-SHA256, hex-encoded.
//   Comparison: timing-safe equality — never `==`.
//
//   The canonical base string for TRANSACTION webhooks:
//     1. Parse the JSON payload. Find `data.signatureKeys` — an array of
//        field names that THIS specific webhook event is signed over.
//     2. For each key in `signatureKeys` (in the given order), read
//        `data.<key>` and URL-encode the value. Concatenate as
//        `key1=urlencode(value1)&key2=urlencode(value2)...` (keys AND values
//        URL-encoded per query-string convention).
//     3. Compute HMAC-SHA256 of that string using the PAYMENT API KEY
//        (stored as `KASHIER_API_KEY`), hex-encode the digest.
//     4. Compare to the `x-kashier-signature` header (timing-safe).
//
//   There is a SEPARATE scheme for Transfer webhooks (fixed key order,
//   unencoded key=value joined with `&`, signed with a TRANSFER API KEY).
//   We do NOT process transfers — only Transaction webhooks — so that scheme
//   is intentionally unimplemented here. We detect a Transfer webhook by
//   `event !== "pay"` (or absent `data.signatureKeys`) and 200 OK without
//   touching the order.
//
// ─── CONFIRMED envelope (per real docs) ────────────────────────────────────
//     {
//       "platform": "kashier",
//       "event": "pay",                       ← detect TRANSACTION class
//       "data": {
//         ...fields...,
//         "status": "SUCCESS",                 ← one of:
//                                                 SUCCESS, FAILURE, PENDING,
//                                                 INITIATED, EXPIRED, CANCEL,
//                                                 REVOKED, UNKNOWN
//         "signatureKeys": [...field names...] ← canonical string keys
//       }
//     }
//
//   We deduplicate on `transactionId` + `event` (per docs). Our
//   payment_events UNIQUE(kashier_transaction_id, event) enforces this; the
//   settle_kashier_payment RPC's INSERT ... ON CONFLICT DO NOTHING turns a
//   replay into a no-op, and the order's status-guard additionally short-
//   circuits any non-awaiting_payment row.
//
// ─── CRITICAL ACK TIMING ────────────────────────────────────────────────────
//   Kashier expects a 200 within a reasonable time, otherwise it retries for
//   up to 23.5 hours on non-2xx (and a 409 ALSO counts as a successful ack).
//   We INLINED the settle RPC and await it before responding (rather than
//   fire-and-forget via EdgeRuntime.waitUntil). Why:
//     • Earlier we used waitUntil to ack Kashier immediately and dispatch the
//       settle RPC in the background. The live sandbox test surfaced a real
//       bug: the Supabase Edge runtime can evict the worker between the
//       `ack:'fast'` response and the background promise actually running.
//       The order never transitioned, no payment_events row was inserted,
//       vendor stock wasn't decremented — yet the webhook had told Kashier
//       `settling_async:true`. Silent drops on real deliveries.
//     • The settle RPC itself is fast (~50-300ms typical): one Postgres
//       round-trip + an idempotency-guarded INSERT + an atomically guarded
//       UPDATE + a dispatch_engine_step call. Kashier's 23.5-hour retry on
//       non-2xx is way more than we need; even on a cold start we're far
//       inside tolerance.
//     • Inline-settle also lets us report the TRUTHFUL `settled:true|false`
//       in the response (instead of an aspirational `settling_async:true`
//       that may or may not actually complete).
//     • Idempotency still holds on (kashier_transaction_id, event): if a
//       Kashier retry lands while the original settle hasn't committed yet,
//       the second pass blocks on the row FOR UPDATE; if the original has
//       committed, the INSERT ... ON CONFLICT DO NOTHING + the order's
//       status-guard turn the replay into a no-op.
//   We never return 5xx — the order's safety is enforced by the DB-side status
//   guard, not by our HTTP status. A bad webhook is logged and 200'd, never
//   retried-in-vain.
//
// ─── CRITICAL AUTHORISATION MODEL ─────────────────────────────────────────
// This function is the SOLE source of truth for "the customer paid".
// Authorisation here is NOT a Supabase JWT — it's the Kashier HMAC signature.
// We never trust any client-reported flag (the RN WebView returning "ok" does
// NOT settle an order — only this webhook does, after header HMAC verification).
//
// Secrets: KASHIER_API_KEY (the PAYMENT API KEY), KASHIER_MERCHANT_ID,
// KASHIER_MODE — all injected by the platform via dashboard Secrets. Never
// logged.
// ──────────────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ─── Inline CORS helpers ────────────────────────────────────────────────────
// We inline the helpers (rather than `import '../_shared/cors.ts'`) so this
// Edge Function bundles as a single file. Supabase's deploy bundler has
// intermittently failed to resolve `../_shared/cors.ts` from the Resident
// project on update redeploy — even when the file is supplied with that
// exact name in the files array. Same issue hit kashier-checkout in a prior
// deploy, fixed there by inlining. The local supabase/functions/_shared/cors.ts
// file is kept for other functions (kashier-checkout-status) that still
// deploy fine with the import.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':    '*',
  'Access-Control-Allow-Methods':   'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers':   'authorization, x-client-info, apikey, content-type, x-idempotency-key',
  'Access-Control-Max-Age':         '86400',
};

function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...(init.headers ?? {}) }
  });
}

// ============================================================================
// ▓▓ [VERIFY BLOCK] — CONFIRMED by the live webhook sim + Kashier docs ▓▓
// ============================================================================
// All field paths below were ASSUMED, then CONFIRMED by firing a synthetic
// (but HMAC-realistic) Kashier webhook against this function from
// scripts/kashier-webhook-sim.mjs in the live Supabase project:
//   • Envelope: { platform, event, data }            — CONFIRMED
//   • Event name for TRANSACTION class: "pay"        — CONFIRMED (mapped to EVENT_PAY)
//   • Order id field inside data:     `orderId`      — CONFIRMED (matched our kashier_order_ref)
//   • Transaction id field:           `transactionId` — CONFIRMED
//   • Amount field:                   `amount`       — CONFIRMED (numeric 50)
//   • Currency field:                 `currency`     — CONFIRMED ("EGP")
//   • Status field:                   `status`       — CONFIRMED ("SUCCESS")
//   • Status set: SUCCESS | FAILURE | PENDING | INITIATED | EXPIRED | CANCEL
//                | REVOKED | UNKNOWN                  — CONFIRMED
//   • signatureKeys field name:      `signatureKeys` — CONFIRMED
//
// The signature scheme (header-based, signatureKeys-driven, query-string
// canonicalization, signed with the payment API key, hex-encoded, both keys
// AND values URL-encoded via encodeURIComponent) is also CONFIRMED — the
// live sim's HMAC computed with JS's encodeURIComponent was accepted by
// timingSafeEqualHex on our side and the webhook returned `verified:true`.
const VERIFY = {
  // Envelope paths (confirmed).
  ENVELOPE_EVENT_PATH: 'event',   // CONFIRMED — top-level `event` is "pay" for transactions
  ENVELOPE_DATA_PATH:  'data',    // CONFIRMED — per-event data block

  // Field names inside `data.*` — ALL CONFIRMED by the live sim.
  DATA_ORDER_ID:       'orderId',       // CONFIRMED — MUST equal our kashier_order_ref
  DATA_TRANSACTION_ID: 'transactionId', // CONFIRMED
  DATA_AMOUNT:         'amount',         // CONFIRMED
  DATA_CURRENCY:       'currency',       // CONFIRMED
  DATA_STATUS:         'status',         // CONFIRMED
  DATA_SIGNATURE_KEYS: 'signatureKeys', // CONFIRMED

  // The Kashier event value used to identify a TRANSACTION-class payment
  // webhook. CONFIRMED by the real docs: only "pay" is sent for the
  // transaction-class delivery we care about.
  EVENT_PAY: 'pay',

  // The casing/set of `data.status` values Kashier emits. CONFIRMED:
  //   SUCCESS   → paid       (terminal — settle order)
  //   FAILURE   → failed     (terminal — cancel order)
  //   CANCEL    → cancelled  (terminal — cancel order)
  //   REVOKED   → failed     (terminal — refund/chargeback-style, treat as failed)
  //   EXPIRED   → cancelled  (terminal — no money moved; cancel free)
  //   PENDING   → null       (intermediate — do NOT settle; ack and wait for next event)
  //   INITIATED → null       (intermediate — same)
  //   UNKNOWN   → null       (intermediate — same; log for operator)
  STATUS_SUCCESS:   'SUCCESS',
  STATUS_FAILURE:   'FAILURE',
  STATUS_CANCEL:    'CANCEL',
  STATUS_REVOKED:   'REVOKED',
  STATUS_EXPIRED:   'EXPIRED',
  STATUS_PENDING:   'PENDING',
  STATUS_INITIATED: 'INITIATED',
  STATUS_UNKNOWN:   'UNKNOWN',

  // The signature header name (confirmed by the user's report).
  SIGNATURE_HEADER: 'x-kashier-signature',
  USER_AGENT_HEADER: 'user-agent',
  EXPECTED_USER_AGENT: 'KASHIER',

  // Whether Kashier URL-encodes BOTH keys AND values in the canonical string.
  // The user's description ("URL-encode them as a query string") implies
  // standard query-string form: `k=v&k2=v2` with both sides encoded.
  // We default to URL-encoding both, but expose a toggle in case the live
  // test delivery proves only values are encoded.
  URL_ENCODE_KEYS: true,
  URL_ENCODE_VALUES: true,
} as const;
// ▓▓ [VERIFY BLOCK] END ▓▓
// ============================================================================

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const KASHIER_KEY   = Deno.env.get('KASHIER_API_KEY') ?? '';
const KASHIER_MID   = Deno.env.get('KASHIER_MERCHANT_ID') ?? '';
const KASHIER_MODE  = Deno.env.get('KASHIER_MODE') ?? 'sandbox';

if (KASHIER_MODE !== 'sandbox' && KASHIER_MODE !== 'production') {
  console.warn(JSON.stringify({
    evt: 'kashier_mode_unknown', mode: KASHIER_MODE,
    note: 'KASHIER_MODE should be sandbox or production; defaulting to sandbox.',
  }));
}
if (!KASHIER_KEY || !KASHIER_MID) {
  console.warn(JSON.stringify({ evt: 'kashier_secrets_missing',
    has_key: Boolean(KASHIER_KEY), has_mid: Boolean(KASHIER_MID) }));
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

async function hmacSha256Hex(keyStr: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sigBuf);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Timing-safe constant-time equality for two hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

// ─── Canonical signature string (Kashier Transaction scheme) ────────────────
//   For each key in `data.signatureKeys` (in the given order), produce
//   `<encodedKey>=<encodedValue>` and join with `&`. Keys and values URL-
//   encoded per VERIFY.URL_ENCODE_* (default: both encoded, query-string form).
//   Missing/null values become the empty string, like the conventional
//   query-string convention.
function canonicalStringFromSignatureKeys(
  data: Record<string, unknown>,
  signatureKeys: string[],
): string {
  return signatureKeys.map((k) => {
    const rawValue = data[k];
    const v = (rawValue === undefined || rawValue === null) ? '' : String(rawValue);
    const encodedKey = VERIFY.URL_ENCODE_KEYS ? encodeURIComponent(k) : k;
    const encodedValue = VERIFY.URL_ENCODE_VALUES ? encodeURIComponent(v) : v;
    return `${encodedKey}=${encodedValue}`;
  }).join('&');
}

// ─── Resolve a nested JSON pointer path against the payload ─────────────────
function getPath(obj: unknown, path: string): unknown {
  if (path === '' || path == null) return obj;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && (acc as Record<string, unknown>)[key] !== undefined) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ─── Map Kashier's data.status to our internal payment lifecycle ──────────────
//   Returns the value we feed to settle_kashier_payment.p_payment_status, or
//   `null` for intermediate states (PENDING / INITIATED / UNKNOWN) where we
//   must NOT settle or cancel yet — Kashier will send another delivery when
//   the status becomes terminal. We acknowledge with 200 and wait.
function normalizeStatus(p: string): 'paid' | 'failed' | 'cancelled' | null {
  const u = (p ?? '').toString().toUpperCase();
  if (u === VERIFY.STATUS_SUCCESS)   return 'paid';
  if (u === VERIFY.STATUS_FAILURE)   return 'failed';
  if (u === VERIFY.STATUS_CANCEL)    return 'cancelled';
  if (u === VERIFY.STATUS_REVOKED)   return 'failed';      // chargeback-style → failed
  if (u === VERIFY.STATUS_EXPIRED)   return 'cancelled';    // session expired unpaid → free cancel
  // PENDING / INITIATED / UNKNOWN → intermediate, do not touch the order yet.
  return null;
}

// ─── Look up order by kashier_order_ref (= data.orderId) ──────────────────────
async function findOrderIdByRef(ref: string): Promise<string | null> {
  const qs = new URLSearchParams({
    select: 'id',
    kashier_order_ref: `eq.${ref}`,
    limit: '1',
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?${qs}`, {
    headers: {
      'apikey': SERVICE_ROLE,
      'Authorization': `Bearer ${SERVICE_ROLE}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    console.warn(JSON.stringify({ evt: 'find_order_failed', status: res.status, body: await res.text() }));
    return null;
  }
  const rows = await res.json() as { id: string }[];
  return rows[0]?.id ?? null;
}

// ─── Invoke the settle_kashier_payment SECURITY DEFINER RPC ──────────────────
//   Note: p_event is the RAW Kashier `event` value verbatim (e.g. "pay"), NOT
//   a synthesized label. The RPC writes it into payment_events.event and uses
//   (kashier_transaction_id, event) as its idempotency key — exactly matching
//   Kashier's "deduplicate on transactionId + event" rule.
async function settlePayment(args: {
  order_id: string;
  payment_status: 'paid' | 'failed' | 'cancelled';
  kashier_transaction_id: string;
  amount: number;
  currency: string;
  event: string;
  raw_payload: Record<string, unknown>;
}): Promise<{ ok: boolean; result: any; }> {
  const body = {
    p_order_id: args.order_id,
    p_payment_status: args.payment_status,
    p_kashier_transaction_id: args.kashier_transaction_id,
    p_amount: args.amount,
    p_currency: args.currency,
    p_event: args.event,
    p_raw_payload: args.raw_payload,
    p_signature_verified: true,
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/settle_kashier_payment`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_ROLE,
      'Authorization': `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) {
    console.warn(JSON.stringify({
      evt: 'settle_rpc_failed', status: res.status, body: text,
    }));
    return { ok: false, result: json ?? { error: 'rpc_failed', status: res.status, body: text } };
  }
  return { ok: true, result: json };
}

// (Background-task hook removed.) We previously dispatched the settle RPC via
// EdgeRuntime.waitUntil to ack Kashier fast, but the live sandbox test showed
// the Supabase Edge runtime can evict the worker before that promise resolves,
// silently dropping the settle. The handler now awaits the settle RPC inline
// and returns its real outcome — see the "INLINE SETTLE" block at the bottom
// of the main handler for the why.

// ════════════════════════════════════════════════════════════════════════════
//  Main handler
// ════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  // ─── Soft sanity: User-Agent hint ─────────────────────────────────────
  // Kashier's webhook calls are sent with `User-Agent: KASHIER`. We don't
  // reject on a different UA (it's not a cryptographic check), but log it.
  const ua = (req.headers.get(VERIFY.USER_AGENT_HEADER) ?? '').trim();
  if (ua.toUpperCase() !== VERIFY.EXPECTED_USER_AGENT) {
    console.warn(JSON.stringify({
      evt: 'webhook_unexpected_user_agent', ua,
      note: 'Kashier normally sends User-Agent: KASHIER. Not a hard reject.',
    }));
  }

  // ─── Parse JSON payload (signature is over the canonical string, not
  // the raw body, so parsing the body first is fine) ────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = await req.json() as Record<string, unknown>;
  } catch {
    console.warn(JSON.stringify({ evt: 'webhook_invalid_json' }));
    // 200 so Kashier doesn't retry this malformed delivery forever.
    return jsonResponse({ received: false, error: 'invalid_json' }, { status: 200 });
  }

  // ─── Extract envelope event + data block ────────────────────────────────
  const event = String(getPath(payload, VERIFY.ENVELOPE_EVENT_PATH) ?? '');
  const data = getPath(payload, VERIFY.ENVELOPE_DATA_PATH) as Record<string, unknown> | undefined;

  if (!data || typeof data !== 'object') {
    console.warn(JSON.stringify({
      evt: 'webhook_missing_data_block', event,
      note: 'Malformed payload or unknown event variant. 200 to stop retries.',
    }));
    return jsonResponse({ received: true, settled: false, reason: 'no_data_block' }, { status: 200 });
  }

  // ─── Filter to TRANSACTION-class webhook deliveries only ────────────────
  // Per the confirmed docs, the only event we settle on is "pay". Anything
  // else (Transfer webhooks / unknown variants) is silently 200'd without
  // touching the order — we don't implement transfers.
  if (event !== VERIFY.EVENT_PAY) {
    console.log(JSON.stringify({
      evt: 'webhook_non_pay_event_ignored', event,
      note: 'Only TRANSACTION-class "pay" deliveries drive the order state.',
    }));
    return jsonResponse({ received: true, settled: false, reason: 'non_pay_event', event }, { status: 200 });
  }

  // ─── Extract signatureKeys and verify they exist (transfer webhook guard) ─
  const signatureKeysRaw = data[VERIFY.DATA_SIGNATURE_KEYS];
  if (!Array.isArray(signatureKeysRaw) || signatureKeysRaw.length === 0) {
    console.warn(JSON.stringify({
      evt: 'webhook_missing_signature_keys',
      note: 'data.signatureKeys absent on a "pay" event — unexpected. Ignoring.',
    }));
    return jsonResponse({ received: true, settled: false, reason: 'no_signature_keys' }, { status: 200 });
  }
  const signatureKeys = (signatureKeysRaw as unknown[]).map((s) => String(s));

  // ─── Read header signature ────────────────────────────────────────────
  const remoteSig = (req.headers.get(VERIFY.SIGNATURE_HEADER) ?? '').trim();
  if (!remoteSig) {
    console.warn(JSON.stringify({ evt: 'webhook_missing_signature_header' }));
    // Treat as unverified — don't settle. 200 to stop retries.
    return jsonResponse({ received: true, verified: false, reason: 'no_sig_header' }, { status: 200 });
  }
  if (!KASHIER_KEY) {
    console.error(JSON.stringify({ evt: 'kashier_key_missing_on_server' }));
    return jsonResponse({ received: true, verified: false, reason: 'no_local_key' }, { status: 200 });
  }

  // ───Compute the canonical string and HMAC (fast — synchronous) ─────────
  const canonical = canonicalStringFromSignatureKeys(data as Record<string, unknown>, signatureKeys);
  let expectedSig = '';
  try {
    expectedSig = await hmacSha256Hex(KASHIER_KEY, canonical);
  } catch (e) {
    console.error(JSON.stringify({ evt: 'hmac_compute_error', err: String(e) }));
    return jsonResponse({ received: true, verified: false, reason: 'hmac_error' }, { status: 200 });
  }

  const verified = timingSafeEqualHex(expectedSig, remoteSig);
  if (!verified) {
    console.warn(JSON.stringify({
      evt: 'webhook_signature_mismatch',
      signature_keys: signatureKeys,
      canonical,
      note: 'Failing HMAC verification — refusing to settle the order.',
    }));
    // 200 to Kashier to stop retries; we don't settle.
    return jsonResponse({ received: true, verified: false }, { status: 200 });
  }

  // ─── HMAC OK — extract fields for the settle call ──────────────────────
  const orderIdRef    = String(data[VERIFY.DATA_ORDER_ID] ?? '');
  const transactionId = String(data[VERIFY.DATA_TRANSACTION_ID] ?? '');
  const amountStr     = String(data[VERIFY.DATA_AMOUNT] ?? '');
  const currency      = String(data[VERIFY.DATA_CURRENCY] ?? 'EGP');
  const rawStatus     = String(data[VERIFY.DATA_STATUS] ?? '');

  if (!orderIdRef) {
    console.warn(JSON.stringify({ evt: 'webhook_missing_order_id', data_keys: Object.keys(data).slice(0, 8) }));
    return jsonResponse({ received: true, verified: true, settled: false, error: 'missing_order_id' }, { status: 200 });
  }

  const normalized = normalizeStatus(rawStatus);
  if (normalized === null) {
    // Intermediate state (PENDING / INITIATED / UNKNOWN / unrecognized). We
    // ack 200 and DO NOT touch the order — Kashier will send another
    // delivery when the status becomes terminal. This is exactly what the
    // docs prescribe; settling an intermediate event as "paid" would be a
    // critical bug.
    console.log(JSON.stringify({
      evt: 'webhook_intermediate_status_ignored', order_ref: orderIdRef, raw: rawStatus,
      note: 'PENDING/INITIATED/UNKNOWN — awaiting terminal delivery before settling.',
    }));
    return jsonResponse({
      received: true, verified: true, settled: false,
      reason: 'intermediate_status', raw_status: rawStatus,
    }, { status: 200 });
  }

  const amountNum = Number(amountStr);
  if (!Number.isFinite(amountNum)) {
    console.warn(JSON.stringify({ evt: 'webhook_invalid_amount', raw: amountStr }));
    return jsonResponse({ received: true, verified: true, settled: false,
                          error: 'invalid_amount' }, { status: 200 });
  }

  // ─── INLINE SETTLE (await the RPC, then ack) ───────────────────────────
  // We do NOT use EdgeRuntime.waitUntil here. Earlier we did, and the live
  // sandbox test surfaced a real bug: the Supabase Edge runtime evicted the
  // worker between us responding `ack:'fast'` and the waitUntil promise
  // actually running the settle RPC — the order never transitioned, no
  // payment_events row was inserted, vendor stock wasn't decremented, and
  // yet the webhook had already told Kashier `settling_async:true`. That
  // silently dropped real deliveries on the floor.
  //
  // The inline settle is correct: the settle RPC takes ~50-300ms typical
  // (one round-trip to Postgres with a status-guard + atomically guarded
  // UPDATE + an idempotent payment_events INSERT + a dispatch_engine_step
  // call). Kashier's webhook timeout is generous (it retries for 23.5 hours
  // on non-2xx), so an inline settle well under 500ms is comfortably
  // inside tolerance — and the response now carries the truthful
  // `settled:true|false` outcome instead of an aspirational
  // `settling_async:true` that may or may not actually happen.
  //
  // Idempotency still holds on (kashier_transaction_id, event): if Kashier
  // retries this delivery (e.g. because of a transient cold-start latency
  // spike), the settle RPC's INSERT ... ON CONFLICT DO NOTHING makes the
  // second pass a no-op and the order's status-guard refuses to re-ACT.
  let internalOrderId: string | null;
  try {
    internalOrderId = await findOrderIdByRef(orderIdRef);
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'find_order_exception', err: String(e) }));
    internalOrderId = null;
  }

  if (!internalOrderId) {
    console.warn(JSON.stringify({ evt: 'webhook_unknown_order_ref', order_ref: orderIdRef }));
    return jsonResponse({
      received: true, verified: true,
      settled: false, error: 'unknown_order_ref',
      order_ref: orderIdRef, payment_status: normalized,
    }, { status: 200, headers: CORS_HEADERS });
  }

  const settle = await settlePayment({
    order_id: internalOrderId,
    payment_status: normalized,
    kashier_transaction_id: transactionId || `UNKNOWN-${Date.now()}`,
    amount: amountNum,
    currency,
    event, // raw Kashier event value verbatim ("pay") — used as dedup key
    raw_payload: payload,
  });

  const settledOk   = Boolean(settle.ok && settle.result?.settled === true);
  const cancelledOk = Boolean(settle.ok && settle.result?.cancelled === true);

  console.log(JSON.stringify({
    evt: 'webhook_processed', order_id: internalOrderId,
    payment_status: normalized, settled: settledOk, cancelled: cancelledOk,
    settle_ok: settle.ok, settle_result: settle.result,
  }));

  return jsonResponse({
    received: true, verified: true,
    ack: 'inline',
    settled: settledOk,
    cancelled: cancelledOk,
    order_ref: orderIdRef,
    order_id: internalOrderId,
    payment_status: normalized,
    settle_ok: settle.ok,
  }, { status: 200, headers: CORS_HEADERS });
});
