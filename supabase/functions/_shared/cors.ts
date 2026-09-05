// ──────────────────────────────────────────────────────────────────────────
// _shared/cors.ts  —  Shared CORS helper for all Ambobtak Edge Functions
// ──────────────────────────────────────────────────────────────────────────
// Why: pg_net.http_post invokes these functions server-to-server with no
// browser involved, so CORS is technically irrelevant for the trigger path.
// But an admin path or future dashboard may POST via fetch from a browser,
// so we pre-flight anyway and reuse a single header set.
//
// Convention: each Edge function's main `Deno.serve` calls `handleCors(req)`
// first. If it returned a Response, that's the preflight reply — return it
// as-is. Otherwise the function continues with the actual request.
// ──────────────────────────────────────────────────────────────────────────

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Allow-Methods':  'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers':  'authorization, x-client-info, apikey, content-type, x-idempotency-key',
  'Access-Control-Max-Age':        '86400',
};

/** If the request is a CORS preflight (OPTIONS), return the 204 outlet. */
export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return null;
}

/** Wrap a JSON body with CORS headers (used for normal HTTP responses). */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}
