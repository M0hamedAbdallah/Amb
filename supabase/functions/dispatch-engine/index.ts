// ──────────────────────────────────────────────────────────────────────────
// dispatch-engine  —  Post-order vendor selection (Supabase Edge Function)
// ──────────────────────────────────────────────────────────────────────────
// Invoked by:
//   • `pg_net.http_post` from the AFTER-INSERT trigger on `orders` (when a
//     new order has just been created with status='pending' and vendor_id
//     now needs assignment), and
//   • `pg_cron` once a minute via the `cron.schedule` job
//     `dispatch-stuck-orders` (catches any order whose
//     `dispatch_attempt` has stalled — vendor didn't accept in time).
//
// Request body: { order_id: string|null, attempt?: number }
//   - When order_id is null we scan for any pending order with
//     `vendor_id IS NULL AND created_at < now() - interval '30 seconds'`
//     and dispatch each one.
//
// Atomicity: the function performs all DB writes via guarded REST calls
// anchored by `WHERE status='pending' AND vendor_id IS NULL` so concurrent
// invocations don't double-assign.
//
// Critical idempotency contract:
//   • The order's `dispatch_attempt` is incremented on every invocation
//     that doesn't successfully assign a vendor. This guarantees the
//     `dispatch_attempt + 1 >= max_retries` cancellation guard in the cron
//     poller eventually fires for orders with no candidates — without this
//     bump, a no-vendor order would stay dispatch_attempt=0 forever and
//     never get cancelled.
//
// Authorisation (AMB-SEC-002 remediation, 2026-08-22):
//   • EVERY caller must present the service credential — either
//     `Authorization: Bearer <service-role-key>` or
//     `apikey: <service-role-key>` — matched constant-time against the
//     platform-injected SUPABASE_SERVICE_ROLE_KEY env var.
//   • Trigger path: since migration 0030 the pg_net callers
//     (dispatch_engine_step, cancel_order, vendor_reject_order) send the
//     service key stored in Supabase Vault (secret: amb_edge_service_key).
//   • Anyone else (anon key, user JWTs, no key) gets HTTP 401 before any
//     DB access happens.
// ──────────────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonResponse, CORS_HEADERS } from '../_shared/cors.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const MAX_RETRIES_DEFAULT = 5;

/** Constant-time compare — the service key must not leak via timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const xa = enc.encode(a);
  const xb = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ xb[i];
  return diff === 0;
}

/** True only when the request carries the service credential in a header. */
function isServiceRequest(req: Request): boolean {
  if (!SERVICE_ROLE) return false;
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const apiKey = req.headers.get('apikey') ?? '';
  return (bearer !== '' && safeEqual(bearer, SERVICE_ROLE)) ||
         (apiKey !== '' && safeEqual(apiKey, SERVICE_ROLE));
}

interface Order {
  id: string;
  customer_id: string;
  vendor_id: string | null;
  size: 'small' | 'large';
  quantity: number;
  is_urgent: boolean;
  delivery_lat: number;
  delivery_lng: number;
  status: string;
  dispatch_attempt: number;
}

interface VendorRow {
  id: string;
  user_id: string;
  business_name: string;
  lat: number;
  lng: number;
  small_stock: number;
  large_stock: number;
  small_price: number;
  large_price: number;
  rating: number;
  delivery_radius_km: number | null;
  avg_delivery_mins: number;
  is_premium: boolean;
}

interface RejectionRow { vendor_id: string; }

/** Haversine great-circle distance (km). */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Blended-vendorService score (smaller = better). Mirrors vendorService.ts */
function vendorServiceScore(
  v: VendorRow,
  size: 'small' | 'large',
  worstDist: number,
  worstPrice: number,
  bestPrice: number,
  dist: number,
): number {
  const priceFor = size === 'small' ? v.small_price : v.large_price;
  const priceScore = worstPrice > bestPrice
    ? (priceFor - bestPrice) / (worstPrice - bestPrice)
    : 0;
  const distScore = dist / worstDist;
  const ratingScore = 1 - (v.rating || 0) / 5;
  return 0.6 * distScore + 0.25 * ratingScore + 0.15 * priceScore;
}

function urgentRank(v: VendorRow): number {
  return ((v.avg_delivery_mins || 30) * -0.5) + ((v.rating || 0) * 8);
}

async function selectTable<T = any>(table: string, params: Record<string, string>): Promise<T[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    headers: {
      'apikey': SERVICE_ROLE,
      'Authorization': `Bearer ${SERVICE_ROLE}`,
      'Accept': 'application/json',
      'Prefer': 'return=representation',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`select ${table} ${res.status}: ${t}`);
  }
  return await res.json() as T[];
}

/** Atomic guard: UPDATE the order row only if still pending. Returns rows affected. */
async function assignVendor(orderId: string, vendorId: string, newAttempt: number): Promise<number> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&status=eq.pending&vendor_id=is.null`,
    {
      method: 'PATCH',
      headers: {
        'apikey': SERVICE_ROLE,
        'Authorization': `Bearer ${SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,count',
      },
      body: JSON.stringify({ vendor_id: vendorId, dispatch_attempt: newAttempt }),
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`assignVendor ${res.status}: ${text}`);
  return parseInt(res.headers.get('Content-Range')?.split('/')[1] ?? '0', 10);
}

/** Bump dispatch_attempt while leaving status and vendor_id untouched. */
async function bumpDispatchAttempt(orderId: string, newAttempt: number): Promise<void> {
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&status=eq.pending&vendor_id=is.null`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SERVICE_ROLE,
          'Authorization': `Bearer ${SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ dispatch_attempt: newAttempt }),
      },
    );
  } catch {
    // Non-fatal — the cron poller will retry on the next tick.
  }
}

async function cancelOrder(orderId: string, reason: string): Promise<number> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&status=eq.pending`,
    {
      method: 'PATCH',
      headers: {
        'apikey': SERVICE_ROLE,
        'Authorization': `Bearer ${SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,count',
      },
      body: JSON.stringify({
        status: 'cancelled',
        cancellation_reason: reason,
        cancelled_at: new Date().toISOString(),
      }),
    },
  );
  await res.text();
  return parseInt(res.headers.get('Content-Range')?.split('/')[1] ?? '0', 10);
}

async function dispatchOrder(order: Order): Promise<{ vendor_id: string | null; reason?: string }> {
  const rejections: RejectionRow[] = await selectTable<RejectionRow>(
    'order_rejections',
    { select: 'vendor_id', 'order_id': `eq.${order.id}` },
  );
  const rejectedIds = new Set(rejections.map((r) => r.vendor_id));

  const sizeCol = order.size === 'small' ? 'small_stock' : 'large_stock';
  const candidates: VendorRow[] = await selectTable<VendorRow>(
    'vendors',
    {
      select: 'id,user_id,business_name,lat,lng,small_stock,large_stock,small_price,large_price,rating,delivery_radius_km,avg_delivery_mins,is_premium',
      is_active: 'eq.true',
      is_verified: 'eq.true',
      [sizeCol]: 'gt.0',
    },
  );

  const viable = candidates.filter((v) => {
    if (rejectedIds.has(v.id)) return false;
    const dist = haversineKm(order.delivery_lat, order.delivery_lng, v.lat, v.lng);
    const radius = v.delivery_radius_km;
    return radius == null || dist <= radius;
  });

  const newAttempt = order.dispatch_attempt + 1;

  if (viable.length === 0) {
    // Critical: bump dispatch_attempt even when no candidates exist, so the
    // cron poller's cancellation guard eventually fires. Without this, a
    // no-vendor order would stay dispatch_attempt=0 forever.
    await bumpDispatchAttempt(order.id, newAttempt);
    return { vendor_id: null, reason: 'no_vendors_available' };
  }

  if (order.is_urgent) {
    viable.sort((a, b) => urgentRank(a) - urgentRank(b));
  } else {
    const prices = viable.map((v) =>
      order.size === 'small' ? (v.small_price || 0) : (v.large_price || 0),
    );
    const worstPrice = Math.max(...prices, 1);
    const bestPrice  = Math.min(...prices) || 0;
    const worstDist  = Math.max(...viable.map((v) =>
      haversineKm(order.delivery_lat, order.delivery_lng, v.lat, v.lng)), 1);
    viable.sort((a, b) => {
      if (a.is_premium && !b.is_premium) return -1;
      if (!a.is_premium && b.is_premium) return 1;
      const sa = vendorServiceScore(a, order.size, worstDist, worstPrice, bestPrice,
        haversineKm(order.delivery_lat, order.delivery_lng, a.lat, a.lng));
      const sb = vendorServiceScore(b, order.size, worstDist, worstPrice, bestPrice,
        haversineKm(order.delivery_lat, order.delivery_lng, b.lat, b.lng));
      return sa - sb;
    });
  }

  let attemptedAssign = false;
  for (const v of viable) {
    try {
      const updated = await assignVendor(order.id, v.id, newAttempt);
      if (updated > 0) return { vendor_id: v.id };
      attemptedAssign = true;
    } catch {
      // Try next candidate — a transient request failure shouldn't kill the
      // whole dispatch loop.
    }
  }
  if (!attemptedAssign) {
    await bumpDispatchAttempt(order.id, newAttempt);
  }
  return { vendor_id: null, reason: 'all_assignments_lost_race' };
}

async function fetchPendingOrders(): Promise<Order[]> {
  // Outdated pending orders that have no vendor assigned. The 30s window
  // ensures we don't immediately re-dispatch an order whose trigger
  // invocation is still in flight.
  return await selectTable<Order>('orders', {
    select: 'id,customer_id,vendor_id,size,quantity,is_urgent,delivery_lat,delivery_lng,status,dispatch_attempt',
    status: 'eq.pending',
    vendor_id: 'is.null',
    created_at: 'lt.' + new Date(Date.now() - 30 * 1000).toISOString(),
    order: 'created_at.asc',
    limit: '20',
  });
}

async function loadOrder(orderId: string): Promise<Order | null> {
  const rows = await selectTable<Order>('orders', {
    select: 'id,customer_id,vendor_id,size,quantity,is_urgent,delivery_lat,delivery_lng,status,dispatch_attempt',
    id: `eq.${orderId}`,
    limit: '1',
  });
  return rows[0] ?? null;
}

async function loadMaxRetries(): Promise<number> {
  const rows = await selectTable<{ value: string }>('system_settings', {
    select: 'value',
    key: 'eq.max_dispatch_retries',
    limit: '1',
  });
  return parseInt(rows[0]?.value ?? String(MAX_RETRIES_DEFAULT), 10);
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // AMB-SEC-002: reject anything that is not the service credential before
  // touching the database. CORS preflight (no credentials by definition)
  // was already answered above.
  if (!isServiceRequest(req)) {
    return jsonResponse({ error: 'unauthorized' }, { status: 401 });
  }

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

  const results: { order_id: string; vendor_id: string | null; reason?: string }[] = [];
  for (const o of targetOrders) {
    let cancelledFlag = false;
    try {
      const r = await dispatchOrder(o);
      results.push({ order_id: o.id, vendor_id: r.vendor_id, reason: r.reason });
      // Cancel when the just-completed attempt reached max_retries and still
      // has no vendor — cancelling here is faster than waiting for the next
      // poll iteration to notice.
      if (!r.vendor_id && o.dispatch_attempt + 1 >= maxRetries) {
        const reasonText =
          r.reason === 'no_vendors_available'
            ? 'لا يوجد بائع متاح في منطقتك حاليًا. حاول مجددًا لاحقًا'
            : 'لم يتمكن أي بائع من قبول طلبك. حاول مرة أخرى';
        await cancelOrder(o.id, reasonText);
        cancelledFlag = true;
      }
    } catch (e) {
      results.push({ order_id: o.id, vendor_id: null, reason: (e as Error)?.message ?? 'dispatch_error' });
    }
    if (cancelledFlag) {
      console.log(JSON.stringify({ evt: 'order_cancelled', order_id: o.id, ts: new Date().toISOString() }));
    }
  }

  return jsonResponse({
    processed: results.length,
    results,
    max_retries: maxRetries,
  });
});
