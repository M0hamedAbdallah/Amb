import { supabase } from './supabase';

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Phase 4 — orderService is now a THIN CALLER of server SECURITY DEFINER
 *  RPCs only. No client-side writes to money-movement tables. See:
 *    • 0005_function_create_order.sql        — create_order
 *    • 0006_function_verify_delivery.sql     — verify_delivery
 *    • 0008_function_validate_promo.sql      — preview_promo (read-only)
 *    • 0014_function_cancel_order.sql        — cancel_order            (Phase 4)
 *    • 0015_function_vendor_order_actions.sql — vendor_accept_order /
 *                                                vendor_depart_order /
 *                                                vendor_reject_order     (Phase 4)
 *
 *  Stock decrement, OTP generation, pricing, commission, urgent-fee routing,
 *  referral crediting, promo consumption and vendor-wallet crediting are all
 *  performed atomically server-side. The mobile client only supplies primitive
 *  inputs and surfaces structured errors to the user.
 *
 *  Aggregate vendor-rating recompute and order-status push notifications are
 *  driven by DB triggers, NOT by this service — see migrations 0011_triggers.
 * ──────────────────────────────────────────────────────────────────────────
 */

export interface Order {
  id: string;
  customer_id: string;
  vendor_id: string | null;
  size: 'small' | 'large';
  quantity: number;
  subtotal: number;
  delivery_fee: number;
  platform_fee: number;
  urgent_fee: number;
  discount: number;
  cancellation_fee: number;
  total: number;
  status: 'awaiting_payment' | 'pending' | 'accepted' | 'on_way' | 'delivered' | 'cancelled';
  delivery_otp: string | null;
  is_urgent: boolean;
  payment_method: string;
  promo_code: string | null;
  delivery_address: string;
  delivery_lat: number;
  delivery_lng: number;
  scheduled_for: string | null;
  customer_note: string | null;
  cancellation_reason: string | null;
  is_reorder: string | null;
  created_at: string;
  accepted_at: string | null;
  departed_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  // ─── Kashier payment fields (migrations 0022/0023) ───
  // kashier_order_ref is the merchant-facing orderId sent to Kashier
  // ('AMB-<uuid>'); null for cash orders and pre-0022 rows.
  kashier_order_ref?: string | null;
  kashier_payment_ref?: string | null;
  payment_status?: 'unpaid' | 'paid' | 'failed' | 'cancelled' | 'refunded' | null;
  paid_at?: string | null;
  vendor?: any;
  customer?: any;
}

export interface ReorderPreset {
  vendor_id: string;
  size: 'small' | 'large';
  quantity: number;
  delivery_address?: string;
  delivery_lat?: number;
  delivery_lng?: number;
}

/** Arabic, user-facing messages for structured RPC error codes. */
const ERROR_MESSAGES: Record<string, string> = {
  auth_required: 'يجب تسجيل الدخول',
  invalid_size: 'حجم الاسطوانة غير صالح',
  invalid_quantity: 'الكمية غير صحيحة',
  vendor_not_found: 'البائع غير موجود',
  vendor_not_eligible: 'البائع غير متاح حاليًا',
  vendor_suspended: 'البائع موقوف مؤقتًا',
  out_of_stock: 'الكمية المطلوبة غير متوفرة حاليًا',
  out_of_delivery_area: 'عنوان التوصيل خارج نطاق البائع',
  promo_invalid: 'كود الخصم غير صالح',
  not_on_way: 'لا يمكن تأكيد التسليم في هذا الوقت',
  no_vendor_assigned: 'لا يوجد بائع مُعيّن لهذا الطلب',
  not_vendor_of_this_order: 'لا يمكنك تأكيد تسليم طلب غير مُسند إليك',
  otp_required: 'أدخل كود التأكيد',
  otp_mismatch: 'الكود غير صحيح — تحقق من العميل وحاول مجددًا',
  already_delivered: 'تم تأكيد تسليم هذا الطلب من قبل',
  order_not_found: 'الطلب غير موجود',
  insufficient_balance: 'الرصيد غير كافٍ',
  invalid_amount: 'المبلغ غير صحيح',
  invalid_method: 'طريقة السحب غير صحيحة',
  idempotency_key_required: 'مفتاح التكرار مطلوب',
  cancellation_too_late: 'لا يمكن إلغاء الطلب بعد بدء التوصيل',
  not_your_order: 'هذا الطلب ليس لك',
  invalid_code: 'كود الدعوة غير صالح',
  self_referral: 'لا يمكنك استخدام كود الدعوة الخاص بك',
  already_referred: 'لديك كود دعوة مُطبق بالفعل',
};

function msgFor(code: string, fallback?: string): Error {
  return new Error(ERROR_MESSAGES[code] || fallback || code || 'تعذر إتمام العملية');
}

export const orderService = {
  // ─── Create new order ───────────────────────────────────────────────────
  //
  // Pricing, stock, delivery radius, promo consumption and OTP generation
  // are computed atomically inside the `create_order` SECURITY DEFINER RPC.
  // The client sends primitive inputs only; client-supplied price fields in
  // `orderData` are IGNORED (the order screen computes them locally for live
  // UI preview, but they never reach the insert — server truth wins).
  async createOrder(orderData: Partial<Order>): Promise<{ order: Order | null; error: Error | null }> {
    const { data, error } = await supabase.rpc('create_order', {
      p_vendor_id: orderData.vendor_id ?? null,
      p_size: orderData.size ?? 'small',
      p_quantity: orderData.quantity ?? 1,
      p_is_urgent: orderData.is_urgent ?? false,
      p_payment_method: orderData.payment_method ?? 'cash',
      p_delivery_address: orderData.delivery_address ?? '',
      p_delivery_lat: orderData.delivery_lat ?? 30.0444,
      p_delivery_lng: orderData.delivery_lng ?? 31.2357,
      p_promo_code: orderData.promo_code ?? null,
      p_customer_note: orderData.customer_note ?? null,
      p_scheduled_for: orderData.scheduled_for ?? null,
    });

    if (error) return { order: null, error: error as Error };
    const payload = (data ?? {}) as { order?: Order; error?: string; message?: string };
    if (payload.error) return { order: null, error: msgFor(payload.error, payload.message) };
    return { order: (payload.order as Order) ?? null, error: null };
  },

  // ─── Confirm delivery (vendor OTP → atomic settlement) ─────────────────────
  //
  // Replaces the old 3-call client chain: verifyDeliveryOTP →
  // updateOrderStatus('delivered') → creditVendorWallet (with fire-and-forget
  // referral bonus). All four effects now collapse into a single
  // `verify_delivery` transaction guarded by `WHERE status='on_way'`, so a
  // repeat call cannot double-pay, and a crash between phases is impossible.
  //
  // Returns `{ valid:true, earning }` on success; `{ valid:false, error }`
  // on OTP mismatch / wrong vendor / wrong status.
  async confirmDelivery(
    orderId: string,
    otp: string
  ): Promise<{ valid: boolean; earning: number; commission: number; error: Error | null }> {
    const { data, error } = await supabase.rpc('verify_delivery', {
      p_order_id: orderId,
      p_otp: otp,
    });
    if (error) return { valid: false, earning: 0, commission: 0, error: error as Error };
    const payload = (data ?? {}) as {
      order?: Order;
      earning?: number;
      commission?: number;
      referral_paid?: boolean;
      error?: string;
      message?: string;
      current_status?: string;
    };
    if (payload.error) {
      return {
        valid: false,
        earning: 0,
        commission: 0,
        error: msgFor(payload.error, payload.message),
      };
    }
    return {
      valid: true,
      earning: Number(payload.earning ?? 0),
      commission: Number(payload.commission ?? 0),
      error: null,
    };
  },

  // ─── Pre-check delivery OTP without settling ──────────────────────────────
  //
  // Kept for screens that want a soft "valid?" probe before showing the
  // success animation. The authoritative settlement is `confirmDelivery`
  // above — calling it without probing is also fine. We do NOT call
  // verify_delivery here (it would settle); instead we just compare the OTP
  // the caller already has on-hand against the order row. Read-only.
  async verifyDeliveryOTP(orderId: string, otp: string): Promise<{ valid: boolean; error: Error | null }> {
    const { data, error } = await supabase
      .from('orders')
      .select('delivery_otp, status')
      .eq('id', orderId)
      .maybeSingle();
    if (error) return { valid: false, error: error as Error };
    if (!data) return { valid: false, error: new Error('الطلب غير موجود') };
    if ((data as any).status === 'delivered') return { valid: false, error: new Error('تم تأكيد التسليم مسبقًا') };
    return { valid: (data as any).delivery_otp === otp, error: null };
  },

  // ─── Status transitions (vendor accept / depart) ──────────────────────────
  //
  // Routed to vendor_accept_order / vendor_depart_order RPCs introduced in
  // migration 0015. We fall back to a direct orders UPDATE only when the RPC
  // is not yet available (during the transition window before 0016 revokes
  // the client UPDATE policy). Once 0016 lands, the fallback path is dead
  // because the policy drop makes the direct update fail — but the RPC call
  // succeeds first, so the fallback never runs in practice.
  async updateOrderStatus(
    orderId: string,
    status: 'accepted' | 'on_way' | string,
    extra?: Record<string, any>
  ): Promise<{ error: Error | null }> {
    if (status === 'accepted') {
      const { error } = await supabase.rpc('vendor_accept_order', { p_order_id: orderId });
      if (!error) return { error: null };
      // RPC not deployed yet (pre-0015) — fall back to direct update.
      if ((error as any)?.code === 'PGRST202' || /Could not find the function/.test(error.message)) {
        return this._directUpdate(orderId, status, { accepted_at: new Date().toISOString(), ...extra });
      }
      return { error: error as Error };
    }

    if (status === 'on_way') {
      const { error } = await supabase.rpc('vendor_depart_order', { p_order_id: orderId });
      if (!error) return { error: null };
      if ((error as any)?.code === 'PGRST202' || /Could not find the function/.test(error.message)) {
        return this._directUpdate(orderId, status, { departed_at: new Date().toISOString(), ...extra });
      }
      return { error: error as Error };
    }

    // Other status values (e.g. 'delivered','cancelled') are no longer
    // written through this method. Provide a defensive fallback so any
    // latent call doesn't 500 — but log so the operator sees it.
    console.warn('[orderService] updateOrderStatus called with unhandled status:', status);
    return this._directUpdate(orderId, status, extra);
  },

  /** Internal: direct orders UPDATE (only used during the 0015 transition window). */
  async _directUpdate(orderId: string, status: string, extra?: Record<string, any>): Promise<{ error: Error | null }> {
    const updates: Record<string, any> = { status, ...extra };
    if (status === 'accepted') updates.accepted_at ??= new Date().toISOString();
    if (status === 'on_way') updates.departed_at ??= new Date().toISOString();
    if (status === 'delivered') updates.delivered_at ??= new Date().toISOString();
    if (status === 'cancelled') updates.cancelled_at ??= new Date().toISOString();
    const { error } = await supabase.from('orders').update(updates).eq('id', orderId);
    return { error: error as Error | null };
  },

  // ─── Customer cancellation ───────────────────────────────────────────────
  //
  // Atomic server-side: stock restore, status flip, optional cancellation
  // fee (debit customer wallet, credit vendor for fuel/time), and
  // dispatch-engine cancel. See 0014_function_cancel_order.sql.
  // Idempotent: repeat calls return `{ already_cancelled: true }` with no
  // double-fee.
  async customerCancel(
    orderId: string,
    _customerId: string,
    reason = 'ألغى العميل الطلب'
  ): Promise<{ chargedFee: number; error: Error | null }> {
    const { data, error } = await supabase.rpc('cancel_order', {
      p_order_id: orderId,
      p_reason: reason,
    });
    if (error) return { chargedFee: 0, error: error as Error };
    const payload = (data ?? {}) as {
      charged_fee?: number;
      already_cancelled?: boolean;
      error?: string;
      message?: string;
    };
    if (payload.error) return { chargedFee: 0, error: msgFor(payload.error, payload.message) };
    return { chargedFee: Number(payload.charged_fee ?? 0), error: null };
  },

  // ─── Vendor reject — frees the order back to dispatch ────────────────────
  //
  // Resets the order to `pending` with `vendor_id=null`, records the
  // rejection in `order_rejections`, and fires dispatch-engine so the next
  // nearest vendor is picked immediately. Server-side via
  // vendor_reject_order (migration 0015). The status transitions themselves
  // trigger send-notification via the AFTER UPDATE OF status trigger.
  async vendorReject(orderId: string, reason = 'رفض البائع'): Promise<{ error: Error | null }> {
    const { error } = await supabase.rpc('vendor_reject_order', {
      p_order_id: orderId,
      p_reason: reason,
    });
    if (!error) return { error: null };
    // Pre-0015 fallback: reset via direct update (legal during transition window).
    if ((error as any)?.code === 'PGRST202' || /Could not find the function/.test((error as Error).message)) {
      const { error: fbErr } = await supabase
        .from('orders')
        .update({ status: 'pending', vendor_id: null, accepted_at: null, departed_at: null })
        .eq('id', orderId)
        .in('status', ['pending', 'accepted']);
      return { error: fbErr as Error | null };
    }
    return { error: error as Error };
  },

  // ─── Rating ───────────────────────────────────────────────────────────────
  //
  // Pure INSERT into order_ratings. The aggregate recompute of
  // `vendors.rating` + `vendors.total_ratings` is performed atomically by
  // the AFTER INSERT trigger `trg_order_ratings_recompute` (migration 0011)
  // — the client no longer touches the vendors row.
  async rateOrder(rating: {
    order_id: string;
    customer_id: string;
    vendor_id: string;
    stars: number;
    comment?: string;
  }): Promise<{ error: Error | null }> {
    const { error } = await supabase.from('order_ratings').insert(rating);
    return { error: error as Error | null };
  },

  // ─── Reads ──────────────────────────────────────────────────────────────

  async getCustomerOrders(customerId: string): Promise<{ orders: Order[]; error: Error | null }> {
    const { data, error } = await supabase
      .from('orders')
      .select('*, vendor:vendors(business_name, rating, avg_delivery_mins)')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false });
    return { orders: (data || []) as Order[], error: error as Error | null };
  },

  async getVendorOrders(vendorId: string, status?: string): Promise<{ orders: Order[]; error: Error | null }> {
    let query = supabase
      .from('orders')
      .select('*, customer:profiles(name)') // NOTE: no phone — privacy
      .eq('vendor_id', vendorId)
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    return { orders: (data || []) as Order[], error: error as Error | null };
  },

  async getAllOrders(limit = 50): Promise<{ orders: Order[]; error: Error | null }> {
    const { data, error } = await supabase
      .from('orders')
      .select('*, vendor:vendors(business_name), customer:profiles(name, phone)')
      .order('created_at', { ascending: false })
      .limit(limit);
    return { orders: (data || []) as Order[], error: error as Error | null };
  },

  /** Load a single order by id (used by tracking/chat). */
  async getOrder(orderId: string): Promise<{ order: Order | null; error: Error | null }> {
    const { data, error } = await supabase
      .from('orders')
      .select('*, vendor:vendors(business_name, lat, lng, rating, avg_delivery_mins, user_id)')
      .eq('id', orderId)
      .maybeSingle();
    return { order: data as Order | null, error: error as Error | null };
  },

  async getActiveOrder(customerId: string): Promise<{ order: Order | null; error: Error | null }> {
    const { data, error } = await supabase
      .from('orders')
      .select('*, vendor:vendors(business_name, lat, lng, rating, avg_delivery_mins)')
      .eq('customer_id', customerId)
      // Include 'awaiting_payment' so an e-wallet order placed via Kashier
      // counts as "active" while the gateway is still settling. The customer
      // can retry checkout from the tracking screen or cancel free of charge
      // (cancel_awaiting_payment) before the webhook settles.
      .in('status', ['awaiting_payment', 'pending', 'accepted', 'on_way'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return { order: data as Order | null, error: error as Error | null };
  },

  // ─── Realtime subscriptions ──────────────────────────────────────────────

  subscribeToOrder(
    orderId: string,
    onStatusChange: (order: Partial<Order>) => void
  ) {
    const channel = supabase
      .channel(`order:${orderId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
          filter: `id=eq.${orderId}`,
        },
        (payload) => onStatusChange(payload.new as Partial<Order>)
      )
      .subscribe();
    return channel;
  },

  /** Subscribe to ALL orders assigned to a vendor (NEW orders + status changes). */
  subscribeToVendorOrders(
    vendorId: string,
    onChange: (order: Partial<Order>) => void,
    onNew?: (order: Partial<Order>) => void
  ) {
    const channel = supabase
      .channel(`vendor_orders:${vendorId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'orders',
          filter: `vendor_id=eq.${vendorId}`,
        },
        (payload) => {
          if (onNew) onNew(payload.new as Partial<Order>);
          else onChange(payload.new as Partial<Order>);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
          filter: `vendor_id=eq.${vendorId}`,
        },
        (payload) => onChange(payload.new as Partial<Order>)
      )
      .subscribe();
    return channel;
  },

  subscribeToVendorLocation(
    vendorId: string,
    onLocation: (lat: number, lng: number) => void
  ) {
    const channel = supabase
      .channel(`vendor_location:${vendorId}`)
      .on('broadcast', { event: 'location' }, (payload) => {
        const { lat, lng } = payload.payload as { lat: number; lng: number };
        if (lat && lng) onLocation(lat, lng);
      })
      .subscribe();
    return channel;
  },

  async broadcastVendorLocation(vendorId: string, lat: number, lng: number) {
    const channel = supabase.channel(`vendor_location:${vendorId}`);
    await channel.send({
      type: 'broadcast',
      event: 'location',
      payload: { lat, lng },
    });
  },

  // ─── Promo preview (read-only) ────────────────────────────────────────────
  //
  // Returns the discount that *would* apply if the order were placed now.
  // No state mutation. The actual consumption of a promo code happens
  // atomically inside create_order when the order commits — see migration
  // 0005. The screen passes this value into createOrder as `promo_code`;
  // `create_order` re-validates and re-consumes it server-side, so any
  // race between preview and submit is self-correcting.
  async validatePromoCode(
    code: string,
    orderTotal: number,
    _userId?: string
  ): Promise<{ discount: number; error: string | null }> {
    const { data, error } = await supabase.rpc('preview_promo', {
      p_code: code,
      p_cart_total: orderTotal,
    });
    if (error) return { discount: 0, error: 'تعذر التحقق من الكود' };
    const payload = (data ?? {}) as {
      valid?: boolean;
      discount?: number;
      error?: string;
      message?: string;
    };
    if (payload.valid) {
      return { discount: Number(payload.discount ?? 0), error: null };
    }
    // payload.error is a structured code; payload.message is the Arabic
    // human message from the RPC (preferred when present).
    return { discount: 0, error: payload.message || ERROR_MESSAGES[payload.error ?? ''] || 'كود الخصم غير صالح' };
  },

  /**
   * @deprecated Promo rollback is now a service-role-only RPC (migration 0008
   * — rollback_promo is granted to service_role only). The client can no
   * longer roll back a consumed promo. create_order is atomic so a failed
   * order insert never leaves a phantom consumed promo. This method is
   * retained as a no-op so the existing call-sites in the order screen keep
   * compiling; safe to delete once those call-sites are removed.
   */
  async rollbackPromoUsage(_code: string, _userId?: string): Promise<void> {
    /* intentionally a no-op */
  },
};
