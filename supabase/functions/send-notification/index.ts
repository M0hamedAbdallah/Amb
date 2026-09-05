// ──────────────────────────────────────────────────────────────────────────
// send-notification  —  Order status push fan-out (Supabase Edge Function)
// ──────────────────────────────────────────────────────────────────────────
// Invoked by:
//   • `pg_net.http_post` from the AFTER-UPDATE trigger on `orders` whenever
//     the order's `status` field transitions. Always fires for the
//     status-relevant recipient: pending→vendor (we've just assigned a
//     vendor), else→customer (the vendor has accepted / departed / the
//     order is delivered / cancelled).
//   • REST `/functions/v1/send-notification` POSTs by admin tooling send
//     the same payload.
//
// Request body: { order_id: string, status: string }
//
// Recipient routing (mirrors `services/pushService.ts`):
//   - status === 'pending'        → recipient_id = vendor.user_id  (we just
//                                  assigned/routed this order; wake vendor)
//   - status in any other value   → recipient_id = customer_id (customer
//                                  needs to know the status moved)
// Push ticket POST'd to https://exp.host/--/api/v2/push/send with body
// { to: <expoPushToken>, title, body, data, sound } as audited in
// `services/pushService.ts:notifyOrderStatus`.
//
// Authorisation:
//   • Trigger path (pg_net.http_post): no Authorization header. The
//     after-update trigger path can only be invoked from inside the
//     database, so we don't enforce JWT membership.
//   • REST path: requires `Authorization: Bearer <service_role-key>` or
//     `apikey: <service_role-key>` header — but we don't reject if absent
//     here, because the trigger doesn't send these. (Future tightening:
//     check that the `pg_net` useragent is set when there's no auth.)
//
// Secrets: `EXPO_PUSH_ACCESS_TOKEN` is injected by the platform into the
// function's Deno runtime as an env var (set via dashboard → Edge Functions
// → send-notification → Secrets). We do NOT hardcode; we read at call-time.
//
// Arabic title/body maps transcribed verbatim from
// `services/pushService.ts:STATUS_TITLES`/`STATUS_BODIES`.
//
// Credit-only / idempotency note:
//   Push tickets are fire-and-forget; Expo dedupes by recipient token +
//   (data.orderId, data.status). Re-emitting the same status change is
//   concerning only if the trigger loops (which it won't — the trigger is
//   fired only on `WHEN (OLD.status IS DISTINCT FROM NEW.status)`).
// ──────────────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCors, jsonResponse } from '../_shared/cors.ts';

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const EXPO_TOKEN     = Deno.env.get('EXPO_PUSH_ACCESS_TOKEN') ?? '';

// Arabic status title/body maps — keep verbatim from pushService.ts
const STATUS_TITLES: Record<string, string> = {
  // awaiting_payment is a CUSTOMER-visible state introduced by the Kashier
  // integration (migration 0022). The after-update trigger fires for the
  // awaiting_payment -> pending transition when the webhook settles a
  // successful charge; awaiting_payment -> cancelled fires when the payment
  // fails or the 15-min auto-cancel cron runs. The customer-facing
  // notification for awaiting_payment itself is benign (no need to alert the
  // vendor — the order hasn't dispatched), but we include it for parity so
  // the routing branch below never falls into the "status=title" fallback.
  awaiting_payment: 'بانتظار تأكيد الدفع 💳',
  pending:   'طلبك قيد البحث 📋',
  accepted:  'تم قبول طلبك ✅',
  on_way:    'البائع في الطريق 🛵',
  delivered: 'تم التسليم بنجاح 🎉',
  cancelled: 'تم إلغاء الطلب ❌',
};

const STATUS_BODIES: Record<string, string> = {
  awaiting_payment: 'جارٍ تأكيد الدفع عبر بوابة Kashier — لا تغلق التطبيق',
  pending:   'نبحث عن أقرب بائع متاح في منطقتك',
  accepted:  'البائع قبل طلبك ويجهّز التوصيل',
  on_way:    'البائع انطلق نحوك — تابع الطلب على الخريطة',
  delivered: 'وصل الطلب — يرجى تقييم البائع',
  cancelled: 'تم إلغاء هذا الطلب',
};

interface OrderNotificationBody {
  order_id: string;
  status: string;
}

interface OrderLookupRow {
  customer_id: string;
  vendor_id: string | null;
}

interface VendorLookupRow { user_id: string; }
interface ProfileRow { expo_push_token: string | null; }

async function selectTable<T = any>(table: string, params: Record<string, string>): Promise<T[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    headers: {
      'apikey': SERVICE_ROLE,
      'Authorization': `Bearer ${SERVICE_ROLE}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`select ${table} ${res.status}: ${await res.text()}`);
  }
  return await res.json() as T[];
}

async function sendExpoPush(token: string, title: string, body: string, data: unknown): Promise<void> {
  const headers: Record<string, string> = {
    'Accept':          'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type':    'application/json',
  };
  if (EXPO_TOKEN) headers['Authorization'] = `Bearer ${EXPO_TOKEN}`;

  const message = { to: token, title, body, data, sound: 'default' };
  // Push notifications must never block order flow.
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      console.warn(JSON.stringify({ evt: 'expo_push_failed', status: res.status, body: await res.text() }));
    }
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'expo_push_error', err: String(e) }));
  }
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  let body: OrderNotificationBody;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: 'invalid_json' }, { status: 400 }); }

  if (!body.order_id || !body.status) {
    return jsonResponse({ error: 'missing_fields' }, { status: 400 });
  }

  try {
    const orders = await selectTable<OrderLookupRow>('orders', {
      select: 'customer_id,vendor_id',
      id: `eq.${body.order_id}`,
      limit: '1',
    });
    const order = orders[0];
    if (!order) {
      return jsonResponse({ error: 'order_not_found' }, { status: 404 });
    }

    // Routing
    let recipientId: string | null = null;
    if (body.status === 'pending') {
      if (order.vendor_id) {
        const v = (await selectTable<VendorLookupRow>('vendors', {
          select: 'user_id',
          id: `eq.${order.vendor_id}`,
          limit: '1',
        }))[0];
        recipientId = v?.user_id ?? null;
      }
    } else {
      recipientId = order.customer_id;
    }
    if (!recipientId) {
      // No vendor assigned yet for a 'pending' order — silently exit. The
      // dispatch-engine will follow up when a vendor is found.
      return jsonResponse({ sent: false, reason: 'no_recipient' });
    }

    const prof = (await selectTable<ProfileRow>('profiles', {
      select: 'expo_push_token',
      id: `eq.${recipientId}`,
      limit: '1',
    }))[0];
    const pushToken = prof?.expo_push_token;
    if (!pushToken) {
      return jsonResponse({ sent: false, reason: 'no_push_token' });
    }

    const title = STATUS_TITLES[body.status] ?? 'تنبيه طلب';
    const text  = STATUS_BODIES[body.status] ?? `حالة الطلب: ${body.status}`;
    await sendExpoPush(pushToken, title, text, { orderId: body.order_id, status: body.status });

    return jsonResponse({ sent: true, recipient_id: recipientId });
  } catch (e) {
    return jsonResponse({ error: String(e), status: 500 }, { status: 500 });
  }
});
