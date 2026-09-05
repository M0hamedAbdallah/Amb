import { supabase } from './supabase';

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  paymentService  —  Kashier payment flow client
 * ──────────────────────────────────────────────────────────────────────────
 *  Thin client for the three `kashier-*` Edge Functions and the
 *  `cancel_awaiting_payment` SECURITY DEFINER RPC. Mirrors the Phase-4
 *  pattern of orderService: the RN client passes primitive inputs and
 *  surfaces structured error codes from the server; it never writes to
 *  money-movement tables directly and NEVER marks an order PAID.
 *
 *  Trust model (HARD):
 *    • The client may REQUEST a checkout URL (kashier-checkout).
 *    • The client may POLL the order status (kashier-checkout-status).
 *    • The client may CANCEL an unpaid order (cancel_awaiting_payment).
 *    • The client may NOT mark an order paid. Only the kashier-webhook Edge
 *      Function (server-side, HMAC-verified) can flip an order from
 *      `awaiting_payment` to `pending`. The WebView returning "ok" is purely
 *      cosmetic; the webhook is the source of truth.
 *
 *  See:
 *    • 0022_kashier_orders.sql         — orders.status enum + payment_events
 *    • 0023_function_create_order_kashier.sql — create_order branching +
 *                                                settle_kashier_payment RPC
 *    • 0024_kashier_cancel_and_cron.sql — cancel_awaiting_payment RPC +
 *                                          cancel-expired-payments cron job
 *    • supabase/functions/kashier-{checkout,webhook,checkout-status}/index.ts
 * ──────────────────────────────────────────────────────────────────────────
 */

/** The set of e-wallet labels the order screen offers and `create_order`
 *  recognises. Keep in sync with `constants/config.ts:paymentMethods`. */
export const E_WALLET_METHODS = [
  'vodafone_cash',
  'etisalat_cash',
  'orange_money',
  'instapay',
] as const;
export type EWalletMethod = (typeof E_WALLET_METHODS)[number];

export function isEWalletMethod(id: string | null | undefined): id is EWalletMethod {
  return !!id && (E_WALLET_METHODS as readonly string[]).includes(id);
}

export interface CheckoutUrlResponse {
  checkout_url: string;
  order_id: string;
  kashier_order_ref: string;
  mode: 'sandbox' | 'production';
  amount: string;
  currency: string;
  success_redirect: string;
  failure_redirect: string;
}

export interface CheckoutStatusResponse {
  order_id: string;
  status: 'awaiting_payment' | 'pending' | 'accepted' | 'on_way' | 'delivered' | 'cancelled';
  payment_status: 'unpaid' | 'paid' | 'failed' | 'cancelled' | 'refunded' | null;
  paid_at: string | null;
  settled: boolean;
  kashier_order_ref: string | null;
  total: number;
}

const ERROR_MESSAGES: Record<string, string> = {
  auth_required: 'يجب تسجيل الدخول',
  missing_order_id: 'معرف الطلب مطلوب',
  order_not_found: 'الطلب غير موجود',
  not_your_order: 'هذا الطلب ليس لك',
  not_awaiting_payment: 'حالة الطلب لا تسمح بالدفع الآن',
  not_awaiting_payment_already_paid: 'تم الدفع بالفعل',
  server_misconfigured: 'إعدادات الخادم غير مكتملة (Kashier)',
  invalid_json: 'طلب غير صالح',
  method_not_allowed: 'طريقة الطلب غير صحيحة',
  ref_backfill_failed: 'تعذر تجهيز مرجع الدفع — حاول مجددًا',
  signature_not_verified: 'التوقيع غير صالح',
  unknown_error: 'تعذّر إتمام عملية الدفع',
  cancellation_too_late: 'لا يمكن إلغاء الطلب بعد بدء التوصيل',
  already_cancelled: 'تم إلغاء هذا الطلب من قبل',
};

function mapError(code: string | undefined, fallback = 'تعذّر إتمام العملية'): Error {
  if (!code) return new Error(fallback);
  return new Error(ERROR_MESSAGES[code] ?? code);
}

export const paymentService = {
  /**
   * Request a Kashier Hosted Checkout URL from the `kashier-checkout` Edge
   * Function. The auth user's access token is attached automatically by the
   * Supabase client (`functions.invoke`).
   *
   * Side-effects: none. The function only builds and returns a URL. No status
   * change on the order.
   */
  async getCheckoutUrl(
    orderId: string,
    paymentMethod?: string,
  ): Promise<{ checkout: CheckoutUrlResponse | null; error: Error | null }> {
    const { data, error } = await supabase.functions.invoke('kashier-checkout', {
      body: { order_id: orderId, payment_method: paymentMethod },
    });
    if (error) return { checkout: null, error: error as Error };
    const payload = (data ?? {}) as CheckoutUrlResponse & { error?: string };
    if (payload.error) return { checkout: null, error: mapError(payload.error) };
    return { checkout: payload, error: null };
  },

  /**
   * Poll the `kashier-checkout-status` Edge Function for the current
   * payment/order state. READ-ONLY — never mutates the order.
   *
   * Implementation note: the Edge Function reads `order_id` from the query
   * string on GET (`url.searchParams.get('order_id')`). Supabase's
   * `functions.invoke` with `method: 'GET'` discards any `body` (GET has no
   * body), so we MUST pass the order id via the path's query string instead.
   * Using `path` with a leading `?` keeps the call bound to our function slug
   * while still being a GET.
   */
  async getCheckoutStatus(
    orderId: string,
  ): Promise<{ status: CheckoutStatusResponse | null; error: Error | null }> {
    const { data, error } = await supabase.functions.invoke('kashier-checkout-status', {
      method: 'GET',
      path: `?order_id=${encodeURIComponent(orderId)}`,
    });
    if (error) return { status: null, error: error as Error };
    const payload = (data ?? {}) as CheckoutStatusResponse & { error?: string };
    if (payload.error) return { status: null, error: mapError(payload.error) };
    return { status: payload, error: null };
  },

  /**
   * Cancel an order that's still in `awaiting_payment` (free of charge, no
   * stock or fee). Routes through the new `cancel_awaiting_payment` RPC
   * (migration 0024). For `pending`/`accepted`/etc orders the existing
   * `orderService.customerCancel` is the right call instead.
   */
  async cancelAwaitingPayment(
    orderId: string,
    reason = 'ألغى العميل قبل الدفع',
  ): Promise<{ cancelled: boolean; error: Error | null }> {
    const { data, error } = await supabase.rpc('cancel_awaiting_payment', {
      p_order_id: orderId,
      p_reason: reason,
    });
    if (error) return { cancelled: false, error: error as Error };
    const payload = (data ?? {}) as {
      cancelled?: boolean;
      already_cancelled?: boolean;
      error?: string;
      message?: string;
    };
    if (payload.error) return { cancelled: false, error: mapError(payload.error, payload.message) };
    return { cancelled: Boolean(payload.cancelled || payload.already_cancelled), error: null };
  },
};
