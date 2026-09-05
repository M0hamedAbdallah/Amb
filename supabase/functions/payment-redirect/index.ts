// ──────────────────────────────────────────────────────────────────────────
// payment-redirect  —  Kashier success-redirect bridge to the app deeplink.
// ──────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//   Kashier's `merchantRedirect` field is validated as a URL and ALSO requires
//   an http(s):// scheme — it rejects custom app schemes like `ambobtak://`
//   with HTTP 400 "merchantRedirect must be a valid URL" (we hit exactly that
//   in the live sandbox — see git history of kashier-checkout/index.ts).
//
//   But the RN `<WebView>` in components/PaymentWebView.tsx intercepts every
//   navigation event and routes to the tracking screen ONLY when it sees a
//   navigation to `ambobtak://payment/<state>`. So we still need the user's
//   browser to actually try to load `ambobtak://payment/success?order_id=...`
//   after a successful payment.
//
//   This Edge Function is the bridge: Kashier 302/200-HTML-redirects the user
//   here (an https:// URL Kashier is happy with), and the page we serve
//   immediately tries to navigate to `ambobtak://payment/success?order_id=...`,
//   which fires the WebView's onShouldStartLoadWithRequest → onResult(). The
//   server-side webhook (kashier-webhook → settle_kashier_payment) remains
//   the source of truth for "money actually moved"; this redirect is purely a
//   UX cue so the WebView closes and the user lands on tracking.
//
// URL CONTRACT
//   https://<project>.supabase.co/functions/v1/payment-redirect
//       ?order_id=<uuid>[&state=<success|failed>]
//
//   query params (all optional with sensible defaults):
//     order_id — the Ambobtak orders.id (uuid). Required to route the user
//                back to the right tracking screen.
//     state    — 'success' (default) or 'failed'. Mirrors the in-app deeplink
//                path so PaymentWebView's interceptor can distinguish them
//                without parsing additional fields. (Today kashier-checkout
//                always points here with the success path because Kashier is
//                configured with failureRedirect=false — the customer stays
//                inside Kashier's UI on decline, and our webhook records
//                failure server-side. We still honour state=failed here so a
//                future switch to failureRedirect=true needs no redeploy.)
//
// SECURITY
//   • verify_jwt=false: this endpoint is hit by Kashier's server-initiated
//     302/refresh inside the in-app WebView — there is no Supabase session
//     token on that request, by design. The function only echoes back the
//     order_id it was given (a uuid) and never touches the DB or secrets, so
//     unauthenticated access is safe.
//   • No PII is logged. We only log order_id + state for retry diagnostics.
//   • The app scheme is hard-coded to 'ambobtak' to match app.json `scheme`.
//     EXPO_PUBLIC_APP_SCHEME overrides it if you ever rebrand.
// ──────────────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const APP_SCHEME = Deno.env.get('EXPO_PUBLIC_APP_SCHEME') ?? 'ambobtak';

const ALLOWED_STATES = new Set(['success', 'failed']);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g,  '&')
    .replace(/</g,  '<')
    .replace(/>/g,  '>')
    .replace(/"/g, '"')
    .replace(/'/g,  '&#39;');
}

Deno.serve(async (req: Request) => {
  // No CORS preflight needed — this is a top-level browser navigation, not an
  // XHR. But respond politely to OPTIONS so direct curl probes don't 405.
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
      },
    });
  }

  // We accept GET only — this is a browser redirect target.
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse order_id + state from the query string. Anything missing/invalid
  // → still render a page, but route to the scheme root so the WebView at
  // least closes (PaymentWebView's interceptor looks for
  // `${APP_SCHEME}://payment/...`; a bare `${APP_SCHEME}://` won't match, so
  // the WebView stays put — which is the right outcome for a malformed
  // redirect: don't pretend the payment succeeded).
  const url = new URL(req.url);
  const orderIdRaw = (url.searchParams.get('order_id') ?? '').trim();
  const stateRaw   = (url.searchParams.get('state') ?? 'success').trim().toLowerCase();

  // Conservative validation: order_id must look like a uuid (36 chars: 8-4-4-4-12
  // hex). If a probe sends garbage, we render the bridge page with whatever
  // app-root URL we can build — never throw, never reveal internals.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const orderOk = UUID_RE.test(orderIdRaw);
  const state   = ALLOWED_STATES.has(stateRaw) ? stateRaw : 'success';
  // Build the deeplink even if order_id looks off — the in-app interceptor will
  // simply not match a non-uuid path and the WebView will stay on Kashier's
  // page (which is better than closing on a malformed redirect).
  const deeplink = orderOk
    ? `${APP_SCHEME}://payment/${state}?order_id=${encodeURIComponent(orderIdRaw)}`
    : `${APP_SCHEME}://payment/${state}`;

  console.log(JSON.stringify({
    evt: 'payment_redirect_served',
    order_id: orderOk ? orderIdRaw : null,
    state,
    deeplink_built: deeplink,
  }));

  // ─── Render the redirect page ──────────────────────────────────────────
  // Two independent redirect mechanisms for resilience:
  //   1. <meta http-equiv="refresh" content="0;url=..."> — fires even when
  //      the WebView has JavaScript disabled.
  //   2. <script>window.location.replace(...)</script> — preferred when JS is
  //      on, because replace() drops this page from the history stack so the
  //      back button doesn't bounce back into the redirect loop.
  //
  // We also render a manual "Open the app" link as the last fallback so a
  // user stranded on the page (e.g. their WebView blocked auto-redirect)
  // can self-recover. The link's href is the deeplink itself; on a real
  // mobile device that triggers the OS app chooser.
  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <meta http-equiv="refresh" content="0; url=${escapeHtml(deeplink)}">
  <title>جارٍ العودة إلى أمببتك…</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #f7f7f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #1f2937; text-align: center; }
    .wrap { display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100%; padding: 24px; box-sizing: border-box; }
    .spinner { width: 42px; height: 42px; border: 4px solid #e5e7eb;
      border-top-color: #2563eb; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 18px; margin: 18px 0 8px; }
    p  { font-size: 14px; color: #6b7280; margin: 0 0 18px; }
    a.btn { display: inline-block; padding: 10px 18px; background: #2563eb;
      color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; }
    .hint  { font-size: 12px; color: #9ca3af; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="spinner" aria-hidden="true"></div>
    <h1>جارٍ العودة إلى التطبيق…</h1>
    <p>إذا لم يُنقلك تلقائيًا خلال لحظات، اضغط الزر أدناه.</p>
    <a class="btn" href="${escapeHtml(deeplink)}">فتح أمببتك</a>
    <p class="hint">يمكنك إغلاق هذه الصفحة بأمان بعد العودة للتطبيق.</p>
  </div>
  <script>
    try {
      // replace() keeps this redirect page out of the WebView history so the
      // hardware back button skips it and returns the user to the Kashier
      // checkout (or closes the WebView), not back into the redirect loop.
      window.location.replace(${JSON.stringify(deeplink)});
    } catch (_) { /* meta refresh will catch it */ }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      // text/html + utf-8 so the Arabic renders correctly.
      'Content-Type': 'text/html; charset=utf-8',
      // Don't let any CDN cache this — the deeplink encodes a per-order id.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      // Open CORS — the page is fetched via top-level navigation, not XHR,
      // but being permissive here keeps probes from 4xx'ing.
      'Access-Control-Allow-Origin': '*',
    },
  });
});
