import { supabase } from './supabase';
import { uuid } from './walletService';

/**
 * Premium vendor subscription. Monthly fee charged to the vendor's wallet and
 * the vendor's row gets `is_premium=true` + `premium_expires_at = +30 days`.
 *
 * Premium placement is enforced by vendorService.getNearbyVendors()
 * (premium vendors float to the top of the sort).
 *
 * Atomicity & idempotency: all four steps (verify balance → debit wallet →
 * record wallet_transactions → flip is_premium + extend expiry) live in a
 * single SECURITY DEFINER RPC `subscribe_premium` (migration 0019). A retry
 * with the SAME idempotency key (the screen mints one per subscribe-attempt
 * and reuses it across retries) replays the original outcome without
 * re-debiting — mirroring migration 0018's `request_withdrawal` contract.
 *
 * `uuid` is re-exported here so the wallet screen can mint an idempotency key
 * ONCE per subscribe-attempt with the same RN crypto fallback used by the
 * withdrawal flow. See `walletService.uuid`.
 */
export const subscriptionService = {
  /** Returns the vendor's current premium status (taking expiry into account). */
  async getStatus(vendorId: string): Promise<{
    isPremium: boolean;
    expiresAt: string | null;
  }> {
    const { data } = await supabase
      .from('vendors')
      .select('is_premium, premium_expires_at')
      .eq('id', vendorId)
      .maybeSingle();
    if (!data) return { isPremium: false, expiresAt: null };
    const v = data as any;
    const valid =
      v.is_premium && (!v.premium_expires_at || new Date(v.premium_expires_at) > new Date());
    return { isPremium: !!valid, expiresAt: v.premium_expires_at };
  },

  /**
   * Subscribe the vendor: charge the wallet, set is_premium=true, and
   * premium_expires_at = max(now, current unexpired expiry) + 30 days.
   *
   * All four steps live atomically inside the SECURITY DEFINER RPC
   * `subscribe_premium` (migration 0019) — a partial failure can no longer
   * leave the vendor debited without premium status.
   *
   * Idempotency: the CALLER must mint an idempotency key ONCE per
   * subscribe-attempt (the screen does this in `handleSubscribe` when the
   * confirm Alert is about to show) and reuse it on retry — a second call
   * with the SAME key returns the original outcome without re-debiting
   * (`subscription.replay:true`), exactly mirroring migration 0018's
   * `request_withdrawal` contract. The key is deduplicated by the partial
   * unique index `wallet_transactions_idempotency_key_key` (0019:A).
   *
   * If `idempotencyKey` is omitted, a fresh one is minted via the shared
   * `uuid()` helper (backward-compat — but in that case there's no retry-
   * dedup; the only double-tap protection is the caller's button-disable).
   */
  async subscribe(
    idempotencyKey?: string
  ): Promise<{ expiresAt: string | null; newBalance?: number; error: Error | null }> {
    const { data, error } = await supabase.rpc('subscribe_premium', {
      p_idempotency_key: idempotencyKey ?? uuid(),
    });
    if (error) return { expiresAt: null, error: error as Error };
    const payload = (data ?? {}) as {
      subscription?: { status?: string; replay?: boolean };
      expires_at?: string | null;
      new_balance?: number;
      error?: string;
      message?: string;
    };
    if (payload.error) {
      // Server-side rejection (auth_required / vendor_not_verified / insufficient_balance / fee_not_configured).
      // Map the well-known codes to the user-facing Arabic copy the old client returned;
      // fall through to the server message for the rest.
      const friendly =
        payload.error === 'insufficient_balance'
          ? 'رصيد المحفظة لا يكفي للاشتراك المميز'
          : payload.error === 'vendor_not_verified'
            ? 'لا يمكن الاشتراك قبل اعتماد حسابك من الإدارة'
            : payload.message ?? payload.error;
      return { expiresAt: null, error: new Error(friendly) };
    }
    // Server-authoritative new balance returned so the screen can refresh the
    // global wallet badge without a follow-up getBalance round-trip.
    return {
      expiresAt: payload.expires_at ?? null,
      newBalance: payload.new_balance,
      error: null,
    };
  },

  /** Admin / cron: expiry sweep — drops is_premium if expired. */
  async sweepExpired(): Promise<void> {
    try {
      await supabase
        .from('vendors')
        .update({ is_premium: false })
        .lt('premium_expires_at', new Date().toISOString());
    } catch {
      /* non-fatal */
    }
  },
};
