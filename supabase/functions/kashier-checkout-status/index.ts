// ──────────────────────────────────────────────────────────────────────────
// kashier-checkout-status  —  Read-only payment-status poller (Edge Function)
// ──────────────────────────────────────────────────────────────────────────
// Invoked by:
//   • The RN customer (authenticated via Supabase auth) after returning from
//     the Kashier WebView. Polls every ~3s for up to 5 min as a safety net
//     in case the webhook hasn't arrived yet (Kashier can delay retries).
//
// Returns:
//   { order_id, status, payment_status, paid_at|null, settled: boolean }
//
// ─── CRITICAL: this function is READ-ONLY. It never marks an order PAID. ───
// It can't — it has no service-role write path here, and even if it did, we
// would never trust a client poll to settle an order. Only the
// kashier-webhook Edge Function, after HMAC verification, is allowed to call
// settle_kashier_payment. This poller exists purely to let the RN UI render
// "we're waiting for the gateway" / "your payment has been confirmed" without
// the customer pretending "I paid" themselves.
//
// Authorisation:
//   • Bearer access token (the user's auth.uid()). We verify the order
//     belongs to the caller before returning any payment detail.
//
// No [VERIFY] block — this function reads only our own DB; it doesn't touch
// Kashier's API. The hostnames and webhook specifics are owned by the other
// two functions.
// ──────────────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonResponse, CORS_HEADERS } from '../_shared/cors.ts';

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';

interface OrderRow {
  id: string;
  customer_id: string;
  status: string;
  payment_status: string | null;
  paid_at: string | null;
  kashier_order_ref: string | null;
  total: number;
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

async function loadOrder(orderId: string): Promise<OrderRow | null> {
  const qs = new URLSearchParams({
    select: 'id,customer_id,status,payment_status,paid_at,kashier_order_ref,total',
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
  if (!res.ok) return null;
  const rows = await res.json() as OrderRow[];
  return rows[0] ?? null;
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  // Order id can come from a query string (GET) or JSON body (POST).
  let orderId: string | null = null;
  if (req.method === 'GET') {
    const url = new URL(req.url);
    orderId = url.searchParams.get('order_id');
  } else {
    try {
      const b = await req.json() as { order_id?: string };
      orderId = b.order_id ?? null;
    } catch {
      return jsonResponse({ error: 'invalid_json' }, { status: 400 });
    }
  }
  if (!orderId) {
    return jsonResponse({ error: 'missing_order_id' }, { status: 400 });
  }

  const caller = callerUserId(req);
  if (!caller) {
    return jsonResponse({ error: 'auth_required' }, { status: 401 });
  }

  const order = await loadOrder(orderId);
  if (!order) {
    return jsonResponse({ error: 'order_not_found' }, { status: 404 });
  }
  if (order.customer_id !== caller) {
    return jsonResponse({ error: 'not_your_order' }, { status: 403 });
  }

  // `settled` here means "the webhook already moved us out of awaiting_payment"
  // — it includes both the success case (status=pending) and the failure case
  // (status=cancelled). The RN UI branches on `status` / `payment_status` to
  // render the correct messaging.
  const settled = order.status !== 'awaiting_payment';

  return jsonResponse({
    order_id: order.id,
    status: order.status,
    payment_status: order.payment_status,
    paid_at: order.paid_at,
    settled,
    kashier_order_ref: order.kashier_order_ref,
    total: order.total,
  }, { status: 200, headers: CORS_HEADERS });
});
