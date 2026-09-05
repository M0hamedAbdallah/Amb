// ──────────────────────────────────────────────────────────────────────────
// admin-api  —  Web admin console / support-team backend (Edge Function)
// ──────────────────────────────────────────────────────────────────────────
// Serves the /admin section of the Ambobtak marketing site (web/). RLS on
// every business table scopes client reads/writes to the caller's own rows
// (migrations 0003 / 0016 revoked the rest on purpose), so the web console
// cannot use the anon key directly. This function is the single privileged
// gateway: it authenticates the caller's Supabase Auth JWT (signature is
// verified server-side by auth.getUser()), checks profiles.role, and only
// then executes the action with the service role — through supabase-js, so
// no request URL or filter string is ever hand-built here.
//
// Authorisation model (mirrors resolve_complaint 0010 / get_referral_stats
// 0021 — the Supabase JWT carries no role claim, so we look it up):
//   • role='admin'   → every action below.
//   • role='support' → ONLY the support console surface: complaint triage
//     (status → reviewing only), user/order lookup, chat transcripts and
//     system replies. Money mutations, settings, vendors, promos, role
//     changes and resolve_complaint stay admin-only (the RPCs additionally
//     enforce role='admin' server-side, so this is defence in depth).
//
// Protocol: POST /functions/v1/admin-api
//   Headers: Authorization: Bearer <user access token>
//   Body: { action: string, ...params }
//   Response: 200 { ok, data } | 4xx/5xx { ok: false, error }
//
// Money actions call SECURITY DEFINER RPCs (never hand-assembled writes),
// honouring the spec hard rule "all money movement happens server-side only":
//   • complaint_resolve  → resolve_complaint()          (0010)
//   • withdrawal_process → admin_process_withdrawal()   (0027)
//   • referrals_stats    → get_referral_stats()         (0021)
// ──────────────────────────────────────────────────────────────────────────

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { handleCors, jsonResponse } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

type Role = 'customer' | 'vendor' | 'admin' | 'support';

/** Actions the support team may call (read + triage + chat only). */
const SUPPORT_ACTIONS = new Set([
  'me',
  'complaints_list',
  'complaint_set_status',   // server-side: support can only set 'reviewing'
  'support_lookup',
  'support_order_messages',
  'support_send_message',
]);

// Service-role client. Every query below goes through the query-builder API
// (table names are compile-time constants, values are bound parameters), so
// nothing caller-supplied can ever shape a request URL or SQL string.
const db: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Input validation ───────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Free-text search term: keep only inert characters (digits, letters,
 *  Arabic, a few separators) so it can never carry filter operators. */
function searchTerm(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const q = v.trim().replace(/[^0-9a-zA-Z\u0600-\u06FF +@.-]/g, '');
  return q.length >= 2 ? q.slice(0, 64) : null;
}

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

function json(data: unknown, status = 200): Response {
  return jsonResponse(
    { ok: status < 400, ...(status < 400 ? { data } : { error: data }) },
    { status },
  );
}

// ── Caller authentication ──────────────────────────────────────────────────

interface Caller { uid: string; role: Role; profile: any; client: SupabaseClient; }

/**
 * Verify the caller's Bearer JWT. The raw Authorization header already
 * carries the full "Bearer <token>" value, so it is forwarded verbatim to
 * Supabase Auth (signature verified server-side via getUser()); we then
 * load profiles.role with the service role. Returns null when
 * unauthenticated or the account is deactivated.
 *
 * The caller-scoped `asCaller` client is kept on the result: the SECURITY
 * DEFINER RPCs below gate on auth.uid(), which is NULL through the
 * service-role client, so they MUST be invoked under the caller's JWT.
 */
async function authenticate(req: Request): Promise<Caller | null> {
  const header = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+$/i.test(header)) return null;
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: header } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user } } = await asCaller.auth.getUser();
  if (!isUuid(user?.id)) return null;

  const { data: profile } = await db.from('profiles')
    .select('id,phone,name,role,is_active,wallet_balance')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || profile.is_active === false) return null;
  return { uid: user.id, role: profile.role as Role, profile, client: asCaller };
}

// ── Aggregate reports (mirror services/adminService.ts from the RN app) ────

async function platformStats(): Promise<unknown> {
  const [settingsRes, ordersRes, usersRes, vendorsRes] = await Promise.all([
    db.from('system_settings').select('key,value'),
    db.from('orders').select('id,total,urgent_fee,status,created_at'),
    db.from('profiles').select('id,role,created_at'),
    db.from('vendors').select('id,is_active,is_verified,is_premium'),
  ]);
  const cfg: Record<string, string> = {};
  (settingsRes.data ?? []).forEach((s: any) => (cfg[s.key] = s.value));
  const rate = num(cfg.commission_pct, 10) / 100;

  const orders = ordersRes.data ?? [];
  const users = usersRes.data ?? [];
  const vendors = vendorsRes.data ?? [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const delivered = orders.filter((o: any) => o.status === 'delivered');
  const gross = delivered.reduce((s: number, o: any) => s + num(o.total, 0), 0);

  return {
    totalOrders: orders.length,
    todayOrders: orders.filter((o: any) => new Date(o.created_at) >= today).length,
    pendingOrders: orders.filter((o: any) =>
      ['pending', 'awaiting_payment', 'accepted', 'on_way'].includes(o.status)).length,
    totalRevenue: gross,
    platformCommission: gross * rate,
    urgentFeeRevenue: delivered.reduce((s: number, o: any) => s + num(o.urgent_fee, 0), 0),
    totalCustomers: users.filter((u: any) => u.role === 'customer').length,
    totalVendors: vendors.length,
    activeVendors: vendors.filter((v: any) => v.is_active).length,
    pendingVerification: vendors.filter((v: any) => !v.is_verified).length,
    premiumVendors: vendors.filter((v: any) => v.is_premium).length,
    commissionPct: num(cfg.commission_pct, 10),
  };
}

async function analytics(days: number): Promise<unknown> {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [ordersRes, txnsRes, withdrawalsRes] = await Promise.all([
    db.from('orders')
      .select('id,total,urgent_fee,status,created_at,delivery_address,vendor_id')
      .gte('created_at', since),
    db.from('wallet_transactions').select('type,amount,created_at'),
    db.from('withdrawals').select('id,status,amount'),
  ]);
  const orders = ordersRes.data ?? [];
  const txns = txnsRes.data ?? [];
  const withdrawals = withdrawalsRes.data ?? [];

  const delivered = orders.filter((o: any) => o.status === 'delivered');
  const bucket: Record<string, { orders: number; revenue: number; commission: number }> = {};
  delivered.forEach((o: any) => {
    const d = new Date(o.created_at).toISOString().slice(0, 10);
    bucket[d] ??= { orders: 0, revenue: 0, commission: 0 };
    bucket[d].orders += 1;
    bucket[d].revenue += num(o.total, 0);
    bucket[d].commission += num(o.total, 0) * 0.1;
  });
  const dailyRevenue = Object.entries(bucket)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));

  const areaBuckets: Record<string, { orders: number; revenue: number }> = {};
  delivered.forEach((o: any) => {
    const area = String(o.delivery_address ?? 'غير معروف').slice(0, 32);
    areaBuckets[area] ??= { orders: 0, revenue: 0 };
    areaBuckets[area].orders += 1;
    areaBuckets[area].revenue += num(o.total, 0);
  });
  const topAreas = Object.entries(areaBuckets)
    .map(([area, v]) => ({ area, ...v }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 10);

  const vendorOrders: Record<string, number> = {};
  delivered.forEach((o: any) => {
    if (isUuid(o.vendor_id)) vendorOrders[o.vendor_id] = (vendorOrders[o.vendor_id] ?? 0) + 1;
  });
  const ids = Object.keys(vendorOrders);
  let topVendors: any[] = [];
  if (ids.length) {
    const { data: rows } = await db.from('vendors')
      .select('id,business_name,rating,total_ratings,is_premium')
      .in('id', ids);
    topVendors = (rows ?? [])
      .map((v: any) => ({ ...v, orders: vendorOrders[v.id] ?? 0 }))
      .sort((a: any, b: any) => b.orders - a.orders)
      .slice(0, 10);
  }

  return {
    days,
    totalOrders: orders.length,
    deliveredOrders: delivered.length,
    totalRevenue: delivered.reduce((s: number, o: any) => s + num(o.total, 0), 0),
    dailyRevenue,
    revenueBreakdown: {
      commission: txns.filter((t: any) => t.type === 'commission').reduce((s: number, t: any) => s + num(t.amount, 0), 0),
      urgent: delivered.reduce((s: number, o: any) => s + num(o.urgent_fee, 0), 0),
      subscriptions: txns.filter((t: any) => t.type === 'subscription').reduce((s: number, t: any) => s + num(t.amount, 0), 0),
    },
    pendingWithdrawals: withdrawals.filter((w: any) => w.status === 'pending').length,
    withdrawalVolume: withdrawals.reduce((s: number, w: any) => s + num(w.amount, 0), 0),
    topAreas,
    topVendors,
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────────
// NOTE: the SECURITY DEFINER RPCs (resolve_complaint 0010, admin_process_
// withdrawal 0027, get_referral_stats 0021) are invoked via caller.client —
// they authorise through auth.uid() + profiles.role, which is NULL under the
// service-role client. caller.client carries the admin's own JWT, so PostgREST
// runs the RPC as the authenticated admin (EXECUTE is granted to
// authenticated); SECURITY DEFINER still bypasses RLS inside. A per-call
// `headers` option on db.rpc() does NOT override the client Authorization.

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return json('method_not_allowed', 405);

  let body: { action?: string; [k: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return json('invalid_json', 400);
  }
  const action = body.action;
  if (typeof action !== 'string' || !/^[a-z_]{2,40}$/.test(action)) {
    return json('missing_action', 400);
  }

  let caller: Caller | null = null;
  try {
    caller = await authenticate(req);
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'auth_error', err: String(e) }));
  }
  if (!caller) return json('unauthorized', 401);
  if (caller.role !== 'admin' && !(caller.role === 'support' && SUPPORT_ACTIONS.has(action))) {
    return json('forbidden', 403);
  }
  const isAdmin = caller.role === 'admin';

  try {
    switch (action) {
      case 'me':
        return json(caller.profile);

      // ── Dashboard / reports ──────────────────────────────────────────
      case 'stats':
        return json(await platformStats());
      case 'analytics':
        return json(await analytics(Math.min(Math.max(num(body.days, 30), 1), 365)));

      // ── Users ────────────────────────────────────────────────────────
      case 'users_list': {
        let q = db.from('profiles').select('*').order('created_at', { ascending: false }).limit(300);
        if (body.role === 'customer' || body.role === 'vendor' || body.role === 'admin' || body.role === 'support') {
          q = q.eq('role', body.role);
        }
        const term = searchTerm(body.q);
        if (term) q = q.or(`phone.ilike.%${term}%,name.ilike.%${term}%`);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return json(data);
      }
      case 'user_set_active': {
        if (!isUuid(body.id) || typeof body.is_active !== 'boolean') return json('bad_params', 400);
        const { error } = await db.from('profiles').update({ is_active: body.is_active }).eq('id', body.id);
        if (error) throw new Error(error.message);
        return json({ updated: true });
      }
      case 'user_set_role': {
        const allowed: Role[] = ['customer', 'vendor', 'admin', 'support'];
        if (!isUuid(body.id) || !allowed.includes(body.role as Role)) return json('bad_params', 400);
        if (body.id === caller.uid) return json('cannot_change_own_role', 400);
        const { error } = await db.from('profiles').update({ role: body.role }).eq('id', body.id);
        if (error) throw new Error(error.message);
        return json({ updated: true });
      }

      // ── Vendors / doc review ─────────────────────────────────────────
      case 'vendors_list': {
        const { data, error } = await db.from('vendors')
          .select('*,profile:profiles!vendors_user_id_fkey(name,phone,is_active)')
          .order('created_at', { ascending: false })
          .limit(300);
        if (error) throw new Error(error.message);
        return json(data);
      }
      case 'vendor_verify': {
        if (!isUuid(body.id)) return json('bad_params', 400);
        const { error } = await db.from('vendors')
          .update({ is_verified: true, is_active: true }).eq('id', body.id);
        if (error) throw new Error(error.message);
        return json({ updated: true });
      }
      case 'vendor_reject': {
        if (!isUuid(body.id)) return json('bad_params', 400);
        const { error } = await db.from('vendors')
          .update({ is_verified: false, is_active: false }).eq('id', body.id);
        if (error) throw new Error(error.message);
        return json({ updated: true });
      }
      case 'vendor_set_active': {
        if (!isUuid(body.id) || typeof body.is_active !== 'boolean') return json('bad_params', 400);
        const { error } = await db.from('vendors')
          .update({ is_active: body.is_active }).eq('id', body.id);
        if (error) throw new Error(error.message);
        return json({ updated: true });
      }
      case 'vendor_set_premium': {
        if (!isUuid(body.id) || typeof body.is_premium !== 'boolean') return json('bad_params', 400);
        const { error } = await db.from('vendors').update({
          is_premium: body.is_premium,
          premium_expires_at: body.is_premium
            ? new Date(Date.now() + 30 * 864e5).toISOString()
            : null,
        }).eq('id', body.id);
        if (error) throw new Error(error.message);
        return json({ updated: true });
      }

      // ── Orders monitor ───────────────────────────────────────────────
      case 'orders_list': {
        let q = db.from('orders')
          .select('*,customer:profiles!orders_customer_id_fkey(name,phone),vendor:vendors!orders_vendor_id_fkey(business_name)')
          .order('created_at', { ascending: false })
          .limit(Math.min(Math.max(num(body.limit, 100), 1), 500));
        if (typeof body.status === 'string' && /^[a-z_]{3,20}$/.test(body.status)) {
          q = q.eq('status', body.status);
        }
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return json(data);
      }
      case 'order_detail': {
        if (!isUuid(body.id)) return json('bad_params', 400);
        const { data: order } = await db.from('orders')
          .select('*,customer:profiles!orders_customer_id_fkey(name,phone,wallet_balance),vendor:vendors!orders_vendor_id_fkey(business_name,profile:profiles!vendors_user_id_fkey(name,phone))')
          .eq('id', body.id)
          .maybeSingle();
        if (!order) return json('order_not_found', 404);
        const [messagesRes, ratingRes, txnsRes] = await Promise.all([
          db.from('messages')
            .select('*,sender:profiles!messages_sender_id_fkey(name,phone)')
            .eq('order_id', body.id)
            .order('created_at', { ascending: true })
            .limit(200),
          db.from('order_ratings').select('*').eq('order_id', body.id).limit(1),
          db.from('wallet_transactions')
            .select('*').eq('order_id', body.id)
            .order('created_at', { ascending: true })
            .limit(50),
        ]);
        return json({
          order,
          messages: messagesRes.data ?? [],
          rating: ratingRes.data?.[0] ?? null,
          transactions: txnsRes.data ?? [],
        });
      }
      case 'order_force_cancel': {
        if (!isAdmin) return json('forbidden', 403);
        if (!isUuid(body.id) || typeof body.reason !== 'string' || !body.reason.trim()) {
          return json('bad_params', 400);
        }
        const { data, error } = await db.from('orders')
          .update({
            status: 'cancelled',
            cancellation_reason: 'إلغاء إداري: ' + body.reason.trim().slice(0, 300),
            cancelled_at: new Date().toISOString(),
          })
          .eq('id', body.id)
          .in('status', ['pending', 'awaiting_payment', 'accepted', 'on_way'])
          .select('id');
        if (error) throw new Error(error.message);
        if (!data?.length) return json('cannot_cancel', 400);
        return json({ cancelled: true });
      }

      // ── Complaints (support triages; only admin resolves/sanctions) ──
      case 'complaints_list': {
        let q = db.from('complaints')
          .select('*,reporter:profiles!complaints_reporter_id_fkey(name,phone),vendor:vendors!complaints_reported_vendor_id_fkey(business_name)')
          .order('created_at', { ascending: false })
          .limit(300);
        if (typeof body.status === 'string' && /^[a-z_]{3,20}$/.test(body.status)) {
          q = q.eq('status', body.status);
        }
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return json(data);
      }
      case 'complaint_set_status': {
        if (!isUuid(body.id)) return json('bad_params', 400);
        const status = body.status as string;
        const allowed: string[] = isAdmin
          ? ['open', 'reviewing', 'resolved', 'rejected']
          : ['reviewing']; // support may only acknowledge/triage
        if (!allowed.includes(status)) return json('forbidden', 403);
        const patch: Record<string, unknown> = { status };
        if (isAdmin && typeof body.note === 'string') patch.admin_note = body.note.slice(0, 500);
        const { error } = await db.from('complaints').update(patch).eq('id', body.id);
        if (error) throw new Error(error.message);
        return json({ updated: true });
      }
      case 'complaint_resolve': {
        if (!isAdmin) return json('forbidden', 403);
        if (!isUuid(body.id)) return json('bad_params', 400);
        const sanction = body.sanction as string;
        if (!['warn', 'ban_temp', 'ban_perm', 'refund', 'none'].includes(sanction)) {
          return json('bad_params', 400);
        }
        const { data: result, error } = await caller.client.rpc('resolve_complaint', {
          p_complaint_id: body.id,
          p_action: sanction,
          p_admin_note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
          p_suspend_until: typeof body.suspend_until === 'string' ? body.suspend_until : null,
        });
        if (error) throw new Error(error.message);
        if (result?.error) return json(result.error, 400);
        return json(result);
      }

      // ── Withdrawals (atomic, via 0027 RPC) ───────────────────────────
      case 'withdrawals_list': {
        let q = db.from('withdrawals')
          .select('*,user:profiles!withdrawals_user_id_fkey(name,phone,wallet_balance)')
          .order('created_at', { ascending: false })
          .limit(300);
        if (typeof body.status === 'string' && /^[a-z_]{3,20}$/.test(body.status)) {
          q = q.eq('status', body.status);
        }
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return json(data);
      }
      case 'withdrawal_process': {
        if (!isAdmin) return json('forbidden', 403);
        if (!isUuid(body.id)) return json('bad_params', 400);
        if (!['approve', 'reject', 'complete'].includes(body.process as string)) return json('bad_params', 400);
        const { data: result, error } = await caller.client.rpc('admin_process_withdrawal', {
          p_withdrawal_id: body.id,
          p_action: body.process,
          p_admin_note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
        });
        if (error) throw new Error(error.message);
        if (result?.error) return json(result.error, 400);
        return json(result);
      }

      // ── Promo codes ──────────────────────────────────────────────────
      case 'promos_list': {
        const { data, error } = await db.from('promo_codes')
          .select('*').order('created_at', { ascending: false }).limit(300);
        if (error) throw new Error(error.message);
        return json(data);
      }
      case 'promo_create': {
        const code = String(body.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
        const promo = {
          code,
          discount_type: body.discount_type === 'percent' ? 'percent' : 'fixed',
          discount_value: num(body.discount_value, 0),
          min_order: num(body.min_order, 0),
          max_uses: num(body.max_uses, 100),
          expires_at: typeof body.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(body.expires_at)
            ? body.expires_at
            : null,
        };
        if (!code || promo.discount_value <= 0) return json('bad_params', 400);
        const { data, error } = await db.from('promo_codes').insert(promo).select().single();
        if (error) throw new Error(error.message);
        return json(data);
      }
      case 'promo_set_active': {
        if (!isUuid(body.id) || typeof body.is_active !== 'boolean') return json('bad_params', 400);
        const { error } = await db.from('promo_codes')
          .update({ is_active: body.is_active }).eq('id', body.id);
        if (error) throw new Error(error.message);
        return json({ updated: true });
      }
      case 'promo_delete': {
        if (!isUuid(body.id)) return json('bad_params', 400);
        const { error } = await db.from('promo_codes').delete().eq('id', body.id);
        if (error) throw new Error(error.message);
        return json({ deleted: true });
      }

      // ── Referrals ────────────────────────────────────────────────────
      case 'referrals_stats': {
        const { data: result, error } = await caller.client.rpc('get_referral_stats');
        if (error) throw new Error(error.message);
        if (result?.error) return json(result.error, 400);
        return json(result);
      }

      // ── Settings ─────────────────────────────────────────────────────
      case 'settings_get': {
        const { data, error } = await db.from('system_settings')
          .select('key,value').order('key', { ascending: true });
        if (error) throw new Error(error.message);
        const cfg: Record<string, string> = {};
        (data ?? []).forEach((r: any) => (cfg[r.key] = r.value));
        return json(cfg);
      }
      case 'settings_update': {
        if (!isAdmin) return json('forbidden', 403);
        const map = body.settings;
        if (!map || typeof map !== 'object' || Array.isArray(map)) return json('bad_params', 400);
        const rows = Object.entries(map as Record<string, unknown>)
          .filter(([k]) => /^[a-z0-9_]{2,64}$/.test(k))
          .map(([key, value]) => ({ key, value: String(value).slice(0, 200), updated_at: new Date().toISOString() }));
        if (!rows.length) return json('bad_params', 400);
        const { error } = await db.from('system_settings').upsert(rows);
        if (error) throw new Error(error.message);
        return json({ updated: rows.length });
      }

      // ── Support console (admin + support) ────────────────────────────
      case 'support_lookup': {
        const term = searchTerm(body.q);
        const raw = typeof body.q === 'string' ? body.q.trim().replace(/^(order|طلب)\s*:?\s*/i, '') : '';
        if (!term && !isUuid(raw)) return json('query_too_short', 400);

        let users: any[] = [];
        if (term) {
          const { data, error } = await db.from('profiles')
            .select('id,name,phone,role,is_active,wallet_balance,warnings_count,suspended_until,created_at')
            .or(`phone.ilike.%${term}%,name.ilike.%${term}%`)
            .limit(20);
          if (error) throw new Error(error.message);
          users = data ?? [];
        }

        let directOrder: any = null;
        if (isUuid(raw)) {
          const { data } = await db.from('orders')
            .select('*,customer:profiles!orders_customer_id_fkey(name,phone),vendor:vendors!orders_vendor_id_fkey(business_name)')
            .eq('id', raw)
            .maybeSingle();
          directOrder = data ?? null;
        }
        const userIds = users.map((u: any) => u.id);
        let recentOrders: any[] = [];
        if (userIds.length) {
          const { data, error } = await db.from('orders')
            .select('id,size,quantity,total,status,created_at,customer_id')
            .in('customer_id', userIds)
            .order('created_at', { ascending: false })
            .limit(100);
          if (error) throw new Error(error.message);
          recentOrders = data ?? [];
        }
        return json({ users, recentOrders, directOrder });
      }
      case 'support_order_messages': {
        if (!isUuid(body.order_id)) return json('bad_params', 400);
        const { data: order } = await db.from('orders')
          .select('id,status,total,size,quantity,created_at,customer:profiles!orders_customer_id_fkey(name,phone),vendor:vendors!orders_vendor_id_fkey(business_name)')
          .eq('id', body.order_id)
          .maybeSingle();
        if (!order) return json('order_not_found', 404);
        const { data: messages, error } = await db.from('messages')
          .select('*,sender:profiles!messages_sender_id_fkey(name,phone)')
          .eq('order_id', body.order_id)
          .order('created_at', { ascending: true })
          .limit(300);
        if (error) throw new Error(error.message);
        return json({ order, messages: messages ?? [] });
      }
      case 'support_send_message': {
        if (!isUuid(body.order_id) || typeof body.body !== 'string' || !body.body.trim()) {
          return json('bad_params', 400);
        }
        const { data: order } = await db.from('orders')
          .select('id').eq('id', body.order_id).maybeSingle();
        if (!order) return json('order_not_found', 404);
        const { data: msg, error } = await db.from('messages').insert({
          order_id: body.order_id,
          sender_id: caller.uid,
          sender_role: 'system',
          body: body.body.trim().slice(0, 2000),
        }).select().single();
        if (error) throw new Error(error.message);
        return json(msg);
      }

      default:
        return json('unknown_action', 400);
    }
  } catch (e) {
    console.error(JSON.stringify({ evt: 'admin_api_error', action, err: String(e) }));
    return json('server_error', 500);
  }
});
