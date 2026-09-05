import { supabase } from './supabase';

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Phase 4 — walletService.request_withdrawal is now a thin caller of the
 *  `request_withdrawal` SECURITY DEFINER RPC (migration 0007). The atomic
 *  debit + withdrawals-row + wallet_transactions-row happens server-side;
 *  the client cannot drive the balance negative. Idempotency is enforced
 *  by a per-call UUIDv4 idempotency key.
 *
 *  The DEMO_BALANCE / DEMO_TXS seed display is removed — the vendor wallet
 *  now shows the real DB balance (0 EGP until their first order settles).
 * ──────────────────────────────────────────────────────────────────────────
 */

export interface WalletTransaction {
  id: string;
  user_id: string;
  type: 'credit' | 'debit' | 'withdrawal' | 'commission' | 'referral_bonus' | 'cancellation_fee' | 'urgent_fee';
  amount: number;
  description: string;
  order_id: string | null;
  status?: 'pending' | 'completed' | 'failed';
  created_at: string;
}

export interface WeeklyStats {
  orders: number;
  gross: number;
  commission: number;
  net: number;
}

const METHOD_LABELS: Record<string, string> = {
  vodafone_cash: 'فودافون كاش',
  etisalat_cash: 'اتصالات كاش',
  orange_money: 'أورانج موني',
  instapay: 'إنستاباي',
};

/**
 * Generate a RFC4122 v4 UUID without external deps (crypto.randomUUID on RN).
 *
 * Exported so the wallet screen can mint an idempotency key ONCE per intended
 * withdrawal (e.g. when the bottom sheet opens) and reuse the SAME key across
 * retries — this is what lets migration 0018's server-side idempotency guard
 * actually dedup a transient-failure retry instead of letting each tap mint a
 * fresh key. See `requestWithdrawal`'s `idempotencyKey` parameter.
 */
export function uuid(): string {
  try {
    // React Native 0.79 ships crypto.getRandomValues via expo-crypto; fall
    // back to Math.random if unavailable (the unique index still protects
    // us even on a low-quality key; double-tap protection is the main goal).
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return (globalThis.crypto as Crypto).randomUUID();
    }
  } catch { /* fall through */ }
  const s = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${s(8)}-${s(4)}-4${s(3)}-a${s(3)}-${s(12)}`;
}

function applyFilter(txs: WalletTransaction[], filter: string): WalletTransaction[] {
  if (!filter || filter === 'all') return txs;
  return txs.filter((t) => t.type === filter);
}

export const walletService = {
  /** Fetch wallet balance from profiles table. Returns 0 (no demo) if the lookup fails. */
  async getBalance(userId: string): Promise<{ balance: number; error: Error | null }> {
    if (!userId) return { balance: 0, error: null };
    const { data, error } = await supabase
      .from('profiles')
      .select('wallet_balance')
      .eq('id', userId)
      .maybeSingle();
    if (error) return { balance: 0, error: error as Error };
    return { balance: Number((data as any)?.wallet_balance) || 0, error: null };
  },

  /** Fetch paginated transactions, optionally filtered by type. Empty array if no userId / no data. */
  async getTransactions(
    userId: string,
    filter: string = 'all'
  ): Promise<{ transactions: WalletTransaction[]; error: Error | null }> {
    if (!userId) return { transactions: [], error: null };
    let query = supabase
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (filter !== 'all') query = query.eq('type', filter);
    const { data, error } = await query;
    if (error) return { transactions: [], error: error as Error };
    return { transactions: (data || []) as WalletTransaction[], error: null };
  },

  /** Calculate this week's earnings summary. Returns zeros (no demo fallback) when empty. */
  async getWeeklyStats(userId: string): Promise<{ stats: WeeklyStats; error: Error | null }> {
    if (!userId) return { stats: { orders: 0, gross: 0, commission: 0, net: 0 }, error: null };
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('wallet_transactions')
      .select('type, amount')
      .eq('user_id', userId)
      .gte('created_at', weekAgo);
    if (error) return { stats: { orders: 0, gross: 0, commission: 0, net: 0 }, error: error as Error };
    const rows = (data || []) as { type: string; amount: number }[];
    const credits = rows.filter((t) => t.type === 'credit');
    const commissions = rows.filter((t) => t.type === 'commission');
    const gross = credits.reduce((s, t) => s + Number(t.amount), 0);
    const commission = commissions.reduce((s, t) => s + Number(t.amount), 0);
    return {
      stats: { orders: credits.length, gross, commission, net: gross - commission },
      error: null,
    };
  },

  /**
   * Submit a withdrawal request via the SECURITY DEFINER RPC.
   *
   * The RPC performs an atomic guarded debit (`WHERE wallet_balance >= p_amount`),
   * inserts a `withdrawals` row + a `wallet_transactions` row keyed by an
   * idempotency UUID, and returns the new balance.
   *
   * Idempotency: the server (migration 0018) deduplicates by `idempotency_key`
   * — a second call with the SAME key returns the original outcome without
   * re-debiting. For that guard to actually protect a transient-failure retry,
   * the CALLER must mint the key ONCE per intended withdrawal (e.g. when the
   * bottom sheet opens) and reuse it on retry — passing that key here via
   * `idempotencyKey`. If `idempotencyKey` is omitted, a fresh one is minted
   * internally (backward-compat for callers that don't care about retry-dedup;
   * in that case the only double-tap protection is the caller's own
   * button-disable, since each call gets a new key).
   *
   * Returns the new balance on success so screens can refresh without a
   * follow-up `getBalance` round-trip.
   */
  async requestWithdrawal(
    userId: string,
    amount: number,
    method: string,
    accountRef?: string,
    idempotencyKey?: string
  ): Promise<{ error: Error | null; newBalance?: number }> {
    if (!userId) return { error: null, newBalance: 0 };

    const { data, error } = await supabase.rpc('request_withdrawal', {
      p_amount: amount,
      p_method: method,
      p_account_ref: accountRef ?? null,
      // Caller-supplied key reused across retries triggers 0018's replay path;
      // omitted → fresh key (no retry dedup, but still a valid one-shot call).
      p_idempotency_key: idempotencyKey ?? uuid(),
    });
    if (error) return { error: error as Error };
    const payload = (data ?? {}) as {
      withdrawal?: { id?: string; status?: string; replay?: boolean };
      new_balance?: number;
      error?: string;
      message?: string;
    };
    if (payload.error) return { error: new Error(payload.message ?? payload.error) };
    return { error: null, newBalance: Number(payload.new_balance ?? 0) };
  },

  /** Get this user's pending/completed withdrawals (for the wallet screen). */
  async myWithdrawals(userId: string) {
    if (!userId) return { withdrawals: [], error: null };
    const { data, error } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    return { withdrawals: (data || []) as any[], error: error as Error | null };
  },
};

// `applyFilter` and `METHOD_LABELS` retained for backward-compat with any
// direct callers; no longer used internally by the refactored read paths.
export { applyFilter, METHOD_LABELS };
