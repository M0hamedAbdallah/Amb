// ──────────────────────────────────────────────────────────────────────────
// kashier-checkout  —  Creates a Kashier Payment Session and returns the
//                      checkout URL the RN WebView should open.
// ──────────────────────────────────────────────────────────────────────────
// Invoked by:
//   • The RN customer (authenticated via Supabase auth) calling:
//       supabase.functions.invoke('kashier-checkout', { body: { order_id } }).
//
// Flow:
//   1. Authorize the caller — the order must belong to auth.uid() and be in
//      status='awaiting_payment'.
//   2. POST to the Kashier Payment Sessions API (v3) with two auth headers
//      AND the body fields Kashier requires. Returns a session response. The
//      body's `serverWebhook` field points Kashier at the kashier-webhook
//      Edge Function — that's how the post-payment result gets back to us.
//      IMPORTANT: serverWebhook is set PER REQUEST, so we do NOT need to
//      register the webhook URL in the Kashier dashboard — the value we pass
//      here overrides any dashboard setting for that session.
//   3. Read the checkout URL out of `response.sessionUrl` (per the confirmed
//      Get-Payment-Session docs: the field is literally `sessionUrl`,
//      format https://payments.kashier.io/session/<id>?mode=test) and return
//      it to the RN client, which opens it in <WebView>.
//
//   4. After the user pays, Kashier redirects the in-app WebView to our
//      `merchantRedirect` URL. Kashier rejects custom app schemes in that
//      field, so we point it at the `payment-redirect` Edge Function (an
//      https:// URL Kashier accepts), which renders an HTML page that
//      immediately navigates to `ambobtak://payment/success?order_id=<id>`.
//      PaymentWebView's onShouldStartLoadWithRequest intercepts that deeplink
//      and routes to the tracking screen (which polls checkout-status). The
//      kashier-webhook → settle_kashier_payment flow is the actual source of
//      truth for "money moved"; the deeplink is purely a UX cue to close the
//      WebView.
//
// ─── API contract (confirmed) ───────────────────────────────────────────────
//   • TEST:   POST https://test-api.kashier.io/v3/payment/sessions
//   • LIVE:   POST https://api.kashier.io/v3/payment/sessions
//   • Headers (BOTH required):
//       Authorization: <secret_key>     ← [VERIFY] secret vs api_key identity
//       api-key:        <api_key>
//       Content-Type:   application/json
//   • Response field for the checkout URL: `sessionUrl` (confirmed).
//   • merchantRedirect MUST be an http(s):// URL — custom schemes rejected
//     with HTTP 400 "merchantRedirect must be a valid URL" (live, 2026-08-09).
//
// Stock implications:
//   Creating a session does NOT decrement vendor stock — that's deferred to
//   settle_kashier_payment after the webhook confirms PAID.
// ──────────────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ─── Inline CORS helpers ────────────────────────────────────────────────────
// We inline the helpers (rather than `import '../_shared/cors.ts'`) so this
// Edge Function bundles as a single file. Supabase's deploy bundler has
// intermittently failed to resolve `../_shared/cors.ts` from a Resident
// project on update redeploy (the path it emits is
// `file:///tmp/user_fn_..._<n>/_shared/cors.ts` and it reports "Module not
// found" even when the file is supplied with that exact name — observed live
// on 2026-08-09 during the merchantRedirect fix redeploy). Inlining the
// ~30-line helper eliminates that class of failure entirely and keeps the
// local + deployed byte streams identical. The shared module in
// `_shared/cors.ts` is still used by kashier-webhook + kashier-checkout-status;
// kashier-checkout alone needs the inline copy.
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
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

// ============================================================================
// ▓▓ [VERIFY BLOCK] — only the auth-headers identity question remains ▓▓
// ============================================================================
// With the real docs in hand, the previously-[VERIFY] response URL field name
// is now CONFIRMED as `sessionUrl` (Payments page format:
// https://payments.kashier.io/session/<id>?mode=test). The remaining open
// question is whether `Authorization` and `api-key` take TWO different secret
// values (a secret_key AND an api_key from the Kashier dashboard) or both the
// same value. We currently use KASHIER_API_KEY for both, matching the one key
// we have in .env. If the dashboard exposes a separate "Secret Key", add a
// KASHIER_SECRET_KEY env var and switch AUTH_HEADER's value below.
const VERIFY = {
  // API hosts — confirmed (sandbox test host per docs, live host per curl).
  API_HOST_SANDBOX:    'https://test-api.kashier.io',
  API_HOST_PRODUCTION: 'https://api.kashier.io',
  API_PATH:            '/v3/payment/sessions',

  // Auth headers. [VERIFY — only remaining open item]
  // Confirm whether Kashier wants two DIFFERENT secrets (secret_key vs
  // api_key) or whether the same KASHIER_API_KEY can populate both headers.
  // If a distinct secret exists, add KASHIER_SECRET_KEY to .env + dashboard
  // Secrets and use it for AUTH_HEADER. The api-key header remains the
  // KASHIER_API_KEY we already have.
  AUTH_HEADER:       'Authorization',
  AUTH_VALUE_PREFIX: '',   // raw key, no "Bearer " prefix (per curl)
  APIKEY_HEADER:     'api-key',

  // CONFIRMED by the docs: the checkout URL arrives in the response field
  // `sessionUrl`. No more fallback guessing.
  RESPONSE_URL_FIELD:      'sessionUrl',
  RESPONSE_SESSION_ID_FIELD: 'sessionId', // [VERIFY — log correlation only, not load-bearing]

  // Body field names (confirmed by the curl sample).
  BODY_AMOUNT:           'amount',
  BODY_CURRENCY:         'currency',
  BODY_ORDER:            'order',
  BODY_MERCHANT_ID:      'merchantId',
  BODY_MERCHANT_REDIRECT:'merchantRedirect',
  BODY_FAILURE_REDIRECT: 'failureRedirect',
  BODY_SERVER_WEBHOOK:   'serverWebhook',
  BODY_ALLOWED_METHODS:  'allowedMethods',
  BODY_DEFAULT_METHOD:   'defaultMethod',
  BODY_PAYMENT_TYPE:     'paymentType',
  BODY_TYPE:             'type',
  BODY_DISPLAY:          'display',
  BODY_INTERACTION:      'interactionSource',
  BODY_ENABLE_3DS:       'enable3DS',
  BODY_SAVE_CARD:        'saveCard',
  BODY_EXPIRE_AT:        'expireAt',
  BODY_MANUAL_CAPTURE:   'manualCapture',
  BODY_DESCRIPTION:      'description',
  BODY_CUSTOMER:         'customer',
  BODY_CUSTOMER_EMAIL:   'email',
  BODY_CUSTOMER_REFERENCE:'reference',

  // [VERIFY — wallet token strings] The exact Kashier-side tokens for the
  // individual e-wallets (Vodafone Cash / Etisalat Cash / Orange Money /
  // InstaPay). The curl uses `allowedMethods: "card,wallet"` which suggests
  // the wallet methods are grouped under the `wallet` category and the
  // customer picks a specific wallet inside Kashier's UI. If `defaultMethod`
  // can preselect a specific wallet, the strings below are what we pass —
  // confirm them against the "Payment Methods" doc before go-live. Not
  // load-bearing: if Kashier ignores the hint, the customer still sees the
  // full wallet picker, so a wrong token here is a UX nicety, not a blocker.
  ALLOWED_METHODS_DEFAULT: 'card,wallet',
  KASHIER_METHOD_BY_ID: {
    vodafone_cash:  'Vodafone Cash',
    etisalat_cash:  'Etisalat Cash',
    orange_money:   'Orange Money',
    instapay:       'InstaPay',
  } as Record<string, string>,
} as const;
// ▓▓ [VERIFY BLOCK] END ▓▓
// ============================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const KASHIER_KEY   = Deno.env.get('KASHIER_API_KEY') ?? '';
// [VERIFY — only open item] If Kashier demands a separate secret for the
// Authorization header, populate KASHIER_SECRET_KEY in the dashboard and
// this fallback resolves: AUTH_HEADER uses the secret if present, else the
// api key (matching the one-key assumption).
const KASHIER_SECRET = Deno.env.get('KASHIER_SECRET_KEY') ?? KASHIER_KEY;
const KASHIER_MID   = Deno.env.get('KASHIER_MERCHANT_ID') ?? '';
const KASHIER_MODE  = Deno.env.get('KASHIER_MODE') ?? 'sandbox';

const IS_SANDBOX = KASHIER_MODE !== 'production';

function chooseApiHost(): string {
  return IS_SANDBOX ? VERIFY.API_HOST_SANDBOX : VERIFY.API_HOST_PRODUCTION;
}

interface OrderRow {
  id: string;
  customer_id: string;
  total: number;
  status: string;
  kashier_order_ref: string | null;
  payment_method: string | null;
}

async function loadOrder(orderId: string): Promise<OrderRow | null> {
  const qs = new URLSearchParams({
    select: 'id,customer_id,total,status,kashier_order_ref,payment_method',
    id: `eq.${orderId}`,
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
    console.warn(JSON.stringify({ evt: 'load_order_failed', status: res.status, body: await res.text() }));
    return null;
  }
  const rows = await res.json() as OrderRow[];
  return rows[0] ?? null;
}

function callerUserId(req: Request): string | null {
  const auth = req.headers.get('Authorization') ?? req.headers.get('authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    let p = parts[1];
    p = p.replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const json = JSON.parse(atob(p)) as { sub?: string };
    return json.sub ?? null;
  } catch {
    return null;
  }
}

// ─── Build the Payment Session request body ────────────────────────────────
// The curl sample is the source of truth for the body shape. Every field
// we set here is either:
//   • from the confirmed curl payload, or
//   • a [VERIFY]-flagged optional field with a sensible default.
function buildSessionBody(order: OrderRow, requestedMethod: string, customerEmail: string | null, customerReference: string | null, successUrl: string, webhookUrl: string): Record<string, unknown> {
  // Session expires in 15 minutes — same window as our cancel-expired-payments
  // cron, so a session won't outlive the order.
  const expireAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const merchantId = KASHIER_MID;
  const orderRef = order.kashier_order_ref!;
  const amount = order.total.toFixed(2);
  const currency = 'EGP';

  // Try to preselect the wallet the customer tapped; Kashier ignores or
  // overrides this if unsupported. If we have no mapping, leave default empty.
  const methodHint = VERIFY.KASHIER_METHOD_BY_ID[requestedMethod] ?? '';

  const customer: Record<string, unknown> = {};
  if (customerEmail) customer.email = customerEmail;
  if (customerReference) customer.reference = customerReference;

  const body: Record<string, unknown> = {
    [VERIFY.BODY_EXPIRE_AT]:          expireAt,
    [VERIFY.BODY_PAYMENT_TYPE]:       'credit',
    [VERIFY.BODY_AMOUNT]:             amount,
    [VERIFY.BODY_CURRENCY]:           currency,
    [VERIFY.BODY_ORDER]:              orderRef,
    [VERIFY.BODY_MERCHANT_REDIRECT]:  successUrl,
    [VERIFY.BODY_DISPLAY]:            'en',
    [VERIFY.BODY_TYPE]:               'one-time',
    [VERIFY.BODY_ALLOWED_METHODS]:    VERIFY.ALLOWED_METHODS_DEFAULT,
    [VERIFY.BODY_FAILURE_REDIRECT]:    false,
    [VERIFY.BODY_MERCHANT_ID]:        merchantId,
    [VERIFY.BODY_DEFAULT_METHOD]:     methodHint || 'card',
    [VERIFY.BODY_DESCRIPTION]:        `Payment for Ambobtak order ${orderRef}`,
    [VERIFY.BODY_MANUAL_CAPTURE]:     false,
    [VERIFY.BODY_INTERACTION]:        'ECOMMERCE',
    [VERIFY.BODY_ENABLE_3DS]:         true,
    [VERIFY.BODY_SERVER_WEBHOOK]:     webhookUrl,
    [VERIFY.BODY_SAVE_CARD]:          'none',
  };
  if (Object.keys(customer).length > 0) {
    body.customer = customer;
  }
  return body;
}

// ─── Extract the checkout URL from the Sessions API response ────────────────
// CONFIRMED by the Get-Payment-Session docs: the URL is at the top-level
// `sessionUrl` field (format: https://payments.kashier.io/session/<id>?mode=test).
// No more fallback guesses. We still check a nested `response.sessionUrl`
// shape defensively, because Kashier sometimes wraps payloads, but a flat
// top-level field is what the docs show.
function extractCheckoutUrl(sessionResponse: any): string | null {
  if (!sessionResponse || typeof sessionResponse !== 'object') return null;
  const top = sessionResponse[VERIFY.RESPONSE_URL_FIELD];
  if (typeof top === 'string' && top.length > 0) return top;
  // Defensive: try one level nested under a `response` wrapper.
  const nested = sessionResponse.response;
  if (nested && typeof nested === 'object') {
    const v = nested[VERIFY.RESPONSE_URL_FIELD];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  // Secrets paranoid-check.
  if (!KASHIER_KEY || !KASHIER_SECRET || !KASHIER_MID || !SUPABASE_URL || !SERVICE_ROLE) {
    console.error(JSON.stringify({ evt: 'checkout_secrets_missing',
      has_key: Boolean(KASHIER_KEY), has_secret: Boolean(KASHIER_SECRET),
      has_mid: Boolean(KASHIER_MID),
      has_url: Boolean(SUPABASE_URL), has_role: Boolean(SERVICE_ROLE) }));
    return jsonResponse({ error: 'server_misconfigured' }, { status: 503 });
  }

  if (!IS_SANDBOX) {
    console.warn(JSON.stringify({
      evt: 'checkout_live_mode_active',
      note: 'KASHIER_MODE=production — building a LIVE checkout URL. Confirm with the operator.',
    }));
  } else if (!KASHIER_MODE || KASHIER_MODE !== 'sandbox') {
    console.warn(JSON.stringify({
      evt: 'checkout_mode_unspecified',
      note: 'KASHIER_MODE missing/unknown — defaulting to sandbox semantics. Set KASHIER_MODE=sandbox explicitly.',
    }));
  }

  // ─── Parse body + caller ──────────────────────────────────────────────
  let body: { order_id?: string; payment_method?: string };
  try {
    body = await req.json() as { order_id?: string; payment_method?: string };
  } catch {
    return jsonResponse({ error: 'invalid_json' }, { status: 400 });
  }

  const orderId = body.order_id;
  if (!orderId) {
    return jsonResponse({ error: 'missing_order_id' }, { status: 400 });
  }

  const caller = callerUserId(req);
  if (!caller) {
    return jsonResponse({ error: 'auth_required' }, { status: 401 });
  }

  // ─── Load + authorize the order ───────────────────────────────────────
  const order = await loadOrder(orderId);
  if (!order) {
    return jsonResponse({ error: 'order_not_found' }, { status: 404 });
  }
  if (order.customer_id !== caller) {
    return jsonResponse({ error: 'not_your_order' }, { status: 403 });
  }
  if (order.status !== 'awaiting_payment') {
    return jsonResponse({
      error: 'not_awaiting_payment',
      current_status: order.status,
    }, { status: 409 });
  }
  if (!order.kashier_order_ref) {
    // Backfill the deterministic ref (`AMB-<uuid>`) so the webhook can match.
    const ref = `AMB-${order.id}`;
    const upd = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}&status=eq.awaiting_payment`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': `Bearer ${SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ kashier_order_ref: ref }),
      },
    );
    if (!upd.ok) {
      console.warn(JSON.stringify({ evt: 'backfill_ref_failed', status: upd.status, body: await upd.text() }));
      return jsonResponse({ error: 'ref_backfill_failed' }, { status: 500 });
    }
    order.kashier_order_ref = ref;
  }

  // ─── Build the Payment Session request ────────────────────────────────
  // merchantRedirect MUST be an https:// URL — Kashier rejects custom app
  // schemes ('ambobtak://...') with HTTP 400 "merchantRedirect must be a
  // valid URL" (we hit exactly that live on 2026-08-09). So we point
  // Kashier at a small Edge Function (`payment-redirect`) that serves an
  // HTML page which itself redirects the in-app WebView to the deeplink
  // `ambobtak://payment/success?order_id=<id>`. PaymentWebView's navigation
  // interceptor catches that deeplink and routes to the tracking screen.
  // The server-side webhook (kashier-webhook → settle_kashier_payment)
  // remains the source of truth for "money actually moved" — this redirect
  // is purely a UX cue so the WebView closes.
  //
  // failureRedirect=false means Kashier does NOT redirect on failure — the
  // customer gets routed back to step 1 of the Kashier UI to retry, and we
  // still receive the FAILURE webhook which settles the order to `cancelled`
  // server-side regardless of any client-side UI state.
  const successUrl = `${SUPABASE_URL}/functions/v1/payment-redirect?order_id=${encodeURIComponent(order.id)}&state=success`;
  // serverWebhook is set PER-REQUEST — confirmed by docs, this means we do NOT
  // need to register the webhook URL in the Kashier dashboard per-merchant;
  // the value we pass here overrides any dashboard setting for that session.
  const webhookUrl = `${SUPABASE_URL}/functions/v1/kashier-webhook`;
  const requestedMethod = body.payment_method ?? order.payment_method ?? '';

  // (Optional) we don't fetch the user email today — pass null and Kashier
  // will use whatever the dashboard default is. A future iteration can pull
  // the customer's phone/email from `profiles` (RLS-protected, we'd fetch
  // via service role here cautiously — defer until product asks).
  const sessionBody = buildSessionBody(
    order, requestedMethod,
    null /* email */, null /* reference */,
    successUrl, webhookUrl,
  );

  // ─── POST to the Kashier Sessions API ────────────────────────────────
  // Authorization uses KASHIER_SECRET (today: same as KASHIER_API_KEY — see
  // the [VERIFY] block for the secret-vs-key identity question). The api-key
  // header always uses the KASHIER_API_KEY.
  const authValue = VERIFY.AUTH_VALUE_PREFIX
    ? `${VERIFY.AUTH_VALUE_PREFIX} ${KASHIER_SECRET}`
    : KASHIER_SECRET;

  const kashierUrl = `${chooseApiHost()}${VERIFY.API_PATH}`;
  let kashierRes: Response;
  try {
    kashierRes = await fetch(kashierUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [VERIFY.AUTH_HEADER]: authValue,
        [VERIFY.APIKEY_HEADER]: KASHIER_KEY,
      },
      body: JSON.stringify(sessionBody),
    });
  } catch (e) {
    console.error(JSON.stringify({ evt: 'kashier_session_call_error', err: String(e) }));
    return jsonResponse({ error: 'kashier_unreachable' }, { status: 502 });
  }

  const kashierText = await kashierRes.text();
  let kashierJson: any = null;
  try { kashierJson = kashierText ? JSON.parse(kashierText) : null; } catch { /* leave null */ }

  if (!kashierRes.ok) {
    console.warn(JSON.stringify({
      evt: 'kashier_session_rejected', status: kashierRes.status,
      body: kashierText,
    }));
    return jsonResponse({
      error: 'kashier_session_rejected',
      kashier_status: kashierRes.status,
      kashier_detail: kashierJson?.errors ?? kashierJson ?? kashierText,
    }, { status: 502 });
  }

  const checkoutUrl = extractCheckoutUrl(kashierJson);
  if (!checkoutUrl) {
    console.error(JSON.stringify({
      evt: 'kashier_session_no_url',
      note: 'The Sessions response did not contain a sessionUrl field. Echoing received fields for diagnosis.',
      response_sample: JSON.stringify(kashierJson).slice(0, 500),
    }));
    return jsonResponse({
      error: 'kashier_session_no_url',
      received_fields: Object.keys(kashierJson ?? {}),
    }, { status: 502 });
  }

  console.log(JSON.stringify({
    evt: 'checkout_session_created',
    order_id: order.id, kashier_order_ref: order.kashier_order_ref,
    amount: order.total.toFixed(2), currency: 'EGP',
    mode: IS_SANDBOX ? 'sandbox' : 'production',
    session_id: kashierJson?.[VERIFY.RESPONSE_SESSION_ID_FIELD] ?? null,
    method_hint: requestedMethod || null,
    webhook_set_per_request: true,
  }));

  return jsonResponse({
    checkout_url: checkoutUrl,
    order_id: order.id,
    kashier_order_ref: order.kashier_order_ref,
    mode: IS_SANDBOX ? 'sandbox' : 'production',
    amount: order.total.toFixed(2),
    currency: 'EGP',
    success_redirect: successUrl,
    // NOTE: success_redirect is the https://<project>.supabase.co/functions/v1/
    // payment-redirect?order_id=<id> bridge URL we pass to Kashier as
    // merchantRedirect — NOT the in-app deeplink. It's surfaced for
    // observability only; the RN client's PaymentWebView routes to the
    // tracking screen by intercepting the WebView's `onShouldStartLoadWithRequest`
    // for the `ambobtak://payment/...` deeplink (which the payment-redirect
    // page itself emits). The client never compares against or branches on
    // this field — the webhook remains the source of truth for "money moved".
    //
    // failureRedirect=false means Kashier won't redirect on failure — the
    // settle/telemetry happens via the webhook alone. The client treats any
    // WebView closure that's NOT the success redirect as "abandoned"; the
    // webhook is the source of truth for whether money actually moved.
    session_response_summary: {
      session_id: kashierJson?.[VERIFY.RESPONSE_SESSION_ID_FIELD] ?? null,
    },
  }, { status: 200, headers: CORS_HEADERS });
});
