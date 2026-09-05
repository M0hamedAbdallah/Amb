import { supabase } from './supabase';

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Phase 4 — referralService.applyCodeOnSignup is now a thin caller of the
 *  `apply_referral` SECURITY DEFINER RPC (migration 0009). The caller's
 *  user identity is taken from auth.uid() inside the RPC, NOT from a
 *  client-supplied userId parameter (defense against impersonation).
 *  Self-referral and concurrent-application races are hardened server-side.
 *
 *  Bug fix from the Phase-3 audit: `getMyStats` previously queried
 *  `referral_credits.beneficiary_id`, which does NOT exist in the schema.
 *  The correct columns are `referrer_id` / `referee_id`. The referrer earns,
 *  so we now filter on `referrer_id = userId`.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const referralService = {
  /** Look up a referrer by their code (read-only, safe to keep client-side). Returns the referrer's id or null. */
  async resolveReferrerCode(code: string): Promise<{ referrerId: string | null }> {
    if (!code) return { referrerId: null };
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('referral_code', code.toUpperCase())
      .maybeSingle();
    return { referrerId: (data as any)?.id ?? null };
  },

  /**
   * Attach a referral code to the caller. No-op if they already have a
   * referrer. The `userId` parameter is kept for screen-call stability
   * (`verify.tsx` passes `session.user.id`) but is ignored by the RPC —
   * `auth.uid()` is the authoritative identity.
   *
   * The RPC returns written/REASON. Treat 'already_referred', 'no_change',
   * and 'invalid_code' for a code that the user re-typed by mistake as
   * non-fatal (no rejection UI); 'self_referral' is also non-fatal.
   */
  async applyCodeOnSignup(_userId: string, code: string): Promise<void> {
    if (!code) return;
    await supabase.rpc('apply_referral', { p_code: code });
  },

  /** Generate / fetch the user's own shareable referral code. */
  async getMyCode(userId: string): Promise<{ code: string | null }> {
    if (!userId) return { code: null };
    const { data } = await supabase
      .from('profiles')
      .select('referral_code')
      .eq('id', userId)
      .maybeSingle();
    return { code: ((data as any)?.referral_code as string) ?? null };
  },

  /**
   * Stats for the customer "my referrals" card:
   *  - referees: count of profiles that used my code (referred_by = me)
   *  - qualified: of those, how many completed a delivered order
   *    (a referral_credits row exists with me as referrer_id)
   *  - earned: total credit collected from referrals
   *    (sum of referral_credits.amount where referrer_id = me)
   *
   * NOTE: fixed from the original implementation, which queried the
   * non-existent `beneficiary_id` column and always returned 0.
   */
  async getMyStats(userId: string): Promise<{
    referees: number;
    qualified: number;
    earned: number;
  }> {
    if (!userId) return { referees: 0, qualified: 0, earned: 0 };

    const [refsRes, credsRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('referred_by', userId),
      supabase
        .from('referral_credits')
        .select('amount, referrer_id, referee_id')
        .eq('referrer_id', userId),
    ]);

    const referees = refsRes.count || 0;
    const credits = (credsRes.data || []) as { amount: number }[];
    const qualified = credits.length;
    const earned = credits.reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
    return { referees, qualified, earned };
  },
};
