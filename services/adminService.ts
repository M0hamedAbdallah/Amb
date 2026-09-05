import { supabase } from './supabase';
import { settingsService } from './settingsService';

export const adminService = {
  // ─── Platform stats (commission sourced from live settings) ──────────────
  async getPlatformStats() {
    const [ordersRes, usersRes, vendorsRes, settingsLoad] = await Promise.all([
      supabase.from('orders').select('id, total, urgent_fee, status, created_at'),
      supabase.from('profiles').select('id, role, created_at'),
      supabase.from('vendors').select('id, is_active, is_verified, is_premium'),
      settingsService.load(),
    ]);

    const { commissionPct } = settingsLoad;
    const rate = commissionPct / 100;

    const orders = ordersRes.data || [];
    const users = usersRes.data || [];
    const vendors = vendorsRes.data || [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayOrders = orders.filter((o: any) => new Date(o.created_at) >= today);
    const deliveredOrders = orders.filter((o: any) => o.status === 'delivered');
    const gross = deliveredOrders.reduce((s: number, o: any) => s + (o.total || 0), 0);
    const urgentRevenue = deliveredOrders.reduce((s: number, o: any) => s + (o.urgent_fee || 0), 0);
    const platformCommission = gross * rate;

    return {
      totalOrders: orders.length,
      todayOrders: todayOrders.length,
      totalRevenue: gross,
      platformCommission,
      urgentFeeRevenue: urgentRevenue,
      totalCustomers: users.filter((u: any) => u.role === 'customer').length,
      totalVendors: vendors.length,
      activeVendors: vendors.filter((v: any) => v.is_active).length,
      pendingVerification: vendors.filter((v: any) => !v.is_verified).length,
      premiumVendors: vendors.filter((v: any) => v.is_premium).length,
      commissionPct,
    };
  },

  // ─── Users & vendors management ──────────────────────────────────────────

  async getAllUsers(role?: string) {
    let query = supabase.from('profiles').select('*').order('created_at', { ascending: false });
    if (role) query = query.eq('role', role);
    const { data, error } = await query;
    return { users: data || [], error };
  },

  async getAllVendors() {
    // `national_id_url` and `business_license_url` are uploaded during vendor
    // registration (vendor-register.tsx) into the vendors row directly. The
    // admin doc-review screen reads these to display the submitted documents.
    const { data, error } = await supabase
      .from('vendors')
      .select('*, profile:profiles(name, phone)')
      .order('created_at', { ascending: false });
    return { vendors: (data || []) as any[], error };
  },

  async toggleUserStatus(userId: string, isActive: boolean) {
    const { error } = await supabase
      .from('profiles')
      .update({ is_active: isActive })
      .eq('id', userId);
    return { error };
  },

  /** Verify a vendor — admin approves docs. Sets is_verified + is_active. */
  async verifyVendor(vendorId: string) {
    const { error } = await supabase
      .from('vendors')
      .update({ is_verified: true, is_active: true })
      .eq('id', vendorId);
    return { error };
  },

  /** Reject vendor verification — set is_verified=false + is_active=false. */
  async rejectVendor(vendorId: string, note?: string) {
    const { error } = await supabase
      .from('vendors')
      .update({ is_verified: false, is_active: false })
      .eq('id', vendorId);
    return { error };
  },

  // ─── Withdrawals ─────────────────────────────────────────────────────────

  async getWithdrawals(status?: 'pending' | 'approved' | 'rejected' | 'completed') {
    let q = supabase
      .from('withdrawals')
      .select('*, user:profiles(name, phone)')
      .order('created_at', { ascending: false });
    if (status) q = (q as any).eq('status', status);
    const { data, error } = await q;
    return { withdrawals: (data || []) as any[], error: error as Error | null };
  },

  async approveWithdrawal(withdrawalId: string, note?: string) {
    const { error } = await supabase
      .from('withdrawals')
      .update({
        status: 'approved',
        admin_note: note ?? null,
        processed_at: new Date().toISOString(),
      })
      .eq('id', withdrawalId);
    return { error: error as Error | null };
  },

  async rejectWithdrawal(withdrawalId: string, note: string) {
    // Refund the balance since the withdrawal was already deducted on request.
    const { data: w } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('id', withdrawalId)
      .maybeSingle();
    if ((w as any)?.user_id) {
      const { data: prof } = await supabase
        .from('profiles')
        .select('wallet_balance')
        .eq('id', (w as any).user_id)
        .maybeSingle();
      const bal = ((prof as any)?.wallet_balance as number) || 0;
      await supabase
        .from('profiles')
        .update({ wallet_balance: bal + ((w as any).amount || 0) })
        .eq('id', (w as any).user_id);
    }
    const { error } = await supabase
      .from('withdrawals')
      .update({
        status: 'rejected',
        admin_note: note,
        processed_at: new Date().toISOString(),
      })
      .eq('id', withdrawalId);
    return { error: error as Error | null };
  },

  // ─── Complaints ───────────────────────────────────────────────────────────
  async getComplaints() {
    const { data, error } = await supabase
      .from('complaints')
      .select('*, reporter:profiles!reporter_id(name, phone), vendor:vendors!reported_vendor_id(business_name)')
      .order('created_at', { ascending: false });
    return { complaints: data || [], error };
  },

  async resolveComplaint(
    complaintId: string,
    status: 'reviewing' | 'resolved' | 'rejected',
    note?: string
  ) {
    const { error } = await supabase
      .from('complaints')
      .update({ status, admin_note: note ?? null })
      .eq('id', complaintId);
    return { error };
  },

  // ─── Settings ─────────────────────────────────────────────────────────────
  async getSettings() {
    const { data, error } = await supabase.from('system_settings').select('*');
    const settings: Record<string, string> = {};
    (data || []).forEach((s: any) => {
      settings[s.key] = s.value;
    });
    return { settings, error };
  },

  async updateSetting(key: string, value: string) {
    const { error } = await supabase
      .from('system_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (!error) settingsService.invalidate();
    return { error };
  },

  /** Bulk update many settings at once. */
  async updateSettings(map: Record<string, string>) {
    const rows = Object.entries(map).map(([key, value]) => ({
      key,
      value,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase.from('system_settings').upsert(rows);
    if (!error) settingsService.invalidate();
    return { error };
  },

  // ─── Promo codes ─────────────────────────────────────────────────────────
  async createPromoCode(promo: {
    code: string;
    discount_type: 'percent' | 'fixed';
    discount_value: number;
    max_uses: number;
    expires_at?: string;
    min_order?: number;
  }) {
    const { data, error } = await supabase.from('promo_codes').insert(promo).select().single();
    return { promo: data, error };
  },

  async getPromoCodes() {
    const { data, error } = await supabase
      .from('promo_codes')
      .select('*')
      .order('created_at', { ascending: false });
    return { codes: data || [], error };
  },

  async togglePromoCode(promoId: string, isActive: boolean) {
    const { error } = await supabase.from('promo_codes').update({ is_active: isActive }).eq('id', promoId);
    return { error };
  },

  async deletePromoCode(promoId: string) {
    const { error } = await supabase.from('promo_codes').delete().eq('id', promoId);
    return { error };
  },

  // ─── Referral campaign stats ───────────────────────────────────────────────
  //
  // The admin referral-campaign screen (app/(admin)/referrals.tsx) needs
  // cross-user reach into profiles.referred_by, referral_credits, and the
  // wallet_transactions referral_bonus rows. RLS scopes all three tables to
  // the caller's own rows, so the admin client key cannot read them
  // directly. Instead we call the SECURITY DEFINER RPC `get_referral_stats`
  // (migration 0021), which verifies profiles.role='admin' server-side and
  // runs its aggregates as the function owner, bypassing RLS. Same
  // authorisation model as `resolve_complaint` (migration 0010).

  async getReferralStats(): Promise<{
    totals: { referees: number; qualified: number; bonusesPaid: number };
    leaderboard: {
      referrerId: string;
      name: string | null;
      phone: string | null;
      code: string | null;
      referees: number;
      qualified: number;
      earned: number;
    }[];
    credits: {
      referrerId: string;
      referrerName: string | null;
      refereeId: string;
      refereeName: string | null;
      amount: number;
      qualifiedAt: string;
      orderId: string | null;
    }[];
    error?: string;
  }> {
    const { data, error } = await supabase.rpc('get_referral_stats');
    if (error) return { totals: { referees: 0, qualified: 0, bonusesPaid: 0 }, leaderboard: [], credits: [], error: error.message };
    const payload = (data ?? {}) as {
      totals?: { referees: number; qualified: number; bonusesPaid: number };
      leaderboard?: any[];
      credits?: any[];
      error?: string;
    };
    if (payload.error) {
      return { totals: { referees: 0, qualified: 0, bonusesPaid: 0 }, leaderboard: [], credits: [], error: payload.error };
    }
    return {
      totals: payload.totals ?? { referees: 0, qualified: 0, bonusesPaid: 0 },
      leaderboard: (payload.leaderboard ?? []).map((l: any) => ({
        referrerId: l.referrerId,
        name: l.name ?? null,
        phone: l.phone ?? null,
        code: l.code ?? null,
        referees: Number(l.referees ?? 0),
        qualified: Number(l.qualified ?? 0),
        earned: Number(l.earned ?? 0),
      })),
      credits: (payload.credits ?? []).map((c: any) => ({
        referrerId: c.referrerId,
        referrerName: c.referrerName ?? null,
        refereeId: c.refereeId,
        refereeName: c.refereeName ?? null,
        amount: Number(c.amount ?? 0),
        qualifiedAt: c.qualifiedAt,
        orderId: c.orderId ?? null,
      })),
    };
  },

  // ─── Analytics ────────────────────────────────────────────────────────────

  /**
   * Detailed analytics for the admin Reports screen.
   * Returns recently-active orders, a daily-revenue histogram, revenue
   * breakdown (commission / urgent / subscriptions), and top areas.
   */
  async getAnalytics(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [ordersRes, vendorsRes, subsRes, withdrawRes] = await Promise.all([
      supabase.from('orders').select('id, total, urgent_fee, discount, status, created_at, delivery_address, vendor_id').gte('created_at', since),
      supabase.from('wallet_transactions').select('type, amount, created_at'),
      supabase.from('wallet_transactions').select('amount, created_at').eq('type', 'subscription'),
      supabase.from('withdrawals').select('id, status, amount'),
    ]);

    const orders = (ordersRes.data || []) as any[];
    const txns = (vendorsRes.data || []) as any[];
    const subs = (subsRes.data || []) as any[];
    const withdrawals = (withdrawRes.data || []) as any[];

    const delivered = orders.filter((o) => o.status === 'delivered');
    const dailyRevenue: { date: string; orders: number; revenue: number; commission: number }[] = [];
    const bucket: Record<string, { orders: number; revenue: number; commission: number }> = {};
    delivered.forEach((o) => {
      const d = new Date(o.created_at).toISOString().slice(0, 10);
      bucket[d] ||= { orders: 0, revenue: 0, commission: 0 };
      bucket[d].orders += 1;
      bucket[d].revenue += Number(o.total || 0);
      bucket[d].commission += Number(o.total || 0) * 0.1; // approx (live adjusted at daily refresh)
    });
    Object.entries(bucket)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([date, v]) => dailyRevenue.push({ date, ...v }));

    const totalRevenue = delivered.reduce((s, o) => s + Number(o.total || 0), 0);
    const urgentRevenue = delivered.reduce((s, o) => s + Number(o.urgent_fee || 0), 0);
    const commissionRevenue = txns
      .filter((t) => (t as any).type === 'commission')
      .reduce((s, t) => s + Number(t.amount || 0), 0);
    const subscriptionRevenue = subs.reduce((s, t) => s + Number(t.amount || 0), 0);

    // Top areas (rough: use the saved address text as the bucket).
    const areaBuckets: Record<string, { orders: number; revenue: number }> = {};
    delivered.forEach((o) => {
      const area = (o.delivery_address || 'غير معروف').slice(0, 32);
      areaBuckets[area] ||= { orders: 0, revenue: 0 };
      areaBuckets[area].orders += 1;
      areaBuckets[area].revenue += Number(o.total || 0);
    });
    const topAreas = Object.entries(areaBuckets)
      .map(([area, v]) => ({ area, ...v }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 10);

    // Top vendors by delivered order volume in the window.
    const vendorOrders: Record<string, number> = {};
    delivered.forEach((o) => {
      if (o.vendor_id) vendorOrders[o.vendor_id] = (vendorOrders[o.vendor_id] || 0) + 1;
    });
    const topVendorIds = Object.entries(vendorOrders)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, n]) => ({ id, orders: n }));

    let topVendors: any[] = [];
    if (topVendorIds.length) {
      const { data: vRows } = await supabase
        .from('vendors')
        .select('id, business_name, rating, total_ratings, is_premium')
        .in('id', topVendorIds.map((v) => v.id));
      topVendors = (vRows || []).map((v: any) => ({
        ...v,
        orders: vendorOrders[v.id] || 0,
      }));
    }

    return {
      days,
      totalOrders: orders.length,
      deliveredOrders: delivered.length,
      totalRevenue,
      dailyRevenue,
      revenueBreakdown: {
        commission: commissionRevenue,
        urgent: urgentRevenue,
        subscriptions: subscriptionRevenue,
      },
      pendingWithdrawals: withdrawals.filter((w) => w.status === 'pending').length,
      withdrawalVolume: withdrawals.reduce((s, w) => s + Number(w.amount || 0), 0),
      topAreas,
      topVendors,
    };
  },
};
