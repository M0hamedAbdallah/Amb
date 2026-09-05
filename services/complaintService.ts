import { supabase } from './supabase';

// Complaint types — the cash-fraud ones drive platform enforcement.
export type ComplaintType =
  | 'general'
  | 'vendor_fraud_cash'      // vendor tried charging the customer cash outside the app
  | 'vendor_no_show'         // vendor accepted but didn't show up
  | 'customer_no_show'       // customer refused to receive their order
  | 'customer_late_cancel'  // cancelled after vendor departed
  | 'delivery'
  | 'other';

export interface Complaint {
  id: string;
  reporter_id: string;
  reported_id?: string | null;
  reported_vendor_id?: string | null;
  order_id?: string | null;
  type: ComplaintType;
  description: string;
  status: 'open' | 'reviewing' | 'resolved' | 'rejected';
  admin_note?: string | null;
  action_taken?: string | null;
  created_at: string;
}

export interface CreateComplaintInput {
  reporter_id: string;
  reported_id?: string;
  reported_vendor_id?: string;
  order_id?: string;
  type: ComplaintType;
  description: string;
}

export const complaintService = {
  /** File a complaint. Caller MUST pass their own auth uid. */
  async create(input: CreateComplaintInput): Promise<{ complaint: Complaint | null; error: Error | null }> {
    const { data, error } = await supabase
      .from('complaints')
      .insert(input)
      .select()
      .single();
    return { complaint: data as Complaint | null, error: error as Error | null };
  },

  /** My filed complaints (customer/vendor dashboards). */
  async mine(userId: string): Promise<{ complaints: Complaint[]; error: Error | null }> {
    const { data, error } = await supabase
      .from('complaints')
      .select('*')
      .or(`reporter_id.eq.${userId},reported_id.eq.${userId}`)
      .order('created_at', { ascending: false });
    return { complaints: (data || []) as Complaint[], error: error as Error | null };
  },

  /** Admin: paginated list of all complaints. */
  async list(status?: Complaint['status']): Promise<{ complaints: Complaint[]; error: Error | null }> {
    let q = supabase
      .from('complaints')
      .select('*, reporter:profiles!reporter_id(name, phone), order:orders(id, status, total), vendor:vendors!reported_vendor_id(business_name)')
      .order('created_at', { ascending: false });
    if (status) q = (q as any).eq('status', status);
    const { data, error } = await q;
    return { complaints: (data || []) as Complaint[], error: error as Error | null };
  },

  /**
   * Admin: resolve a complaint with an optional sanction. `action` is one of:
   *   'warn'        — add a warning to vendor/customer, no ban
   *   'ban_temp'    — suspend until `suspendUntil`
   *   'ban_perm'    — set is_active=false permanently
   *   'refund'      — reverse vendor credit on the related order, credit the
   *                    customer's wallet (was never implemented client-side
   *                    pre-Phase-4 — now done atomically server-side).
   *   'none'        — close with no action
   *
   * Phase 4: replaced the 5-step client cascade with a single
   * `resolve_complaint` SECURITY DEFINER RPC (migration 0010). The RPC
   * verifies `profiles.role='admin'`, applies the sanction, and closes the
   * complaint atomically — preventing the partial-state windows the old
   * chain had (e.g. warn-updated but complaint-row-not-closed).
   */
  async resolve(
    complaintId: string,
    action: 'warn' | 'ban_temp' | 'ban_perm' | 'refund' | 'none',
    adminNote: string,
    suspendUntil?: string
  ): Promise<{ error: Error | null; refundAmount?: number }> {
    const { data, error } = await supabase.rpc('resolve_complaint', {
      p_complaint_id: complaintId,
      p_action: action,
      p_admin_note: adminNote,
      p_suspend_until: suspendUntil ?? null,
    });
    if (error) return { error: error as Error };
    const payload = (data ?? {}) as {
      complaint_id?: string;
      action_taken?: string;
      refund_amount?: number;
      error?: string;
      message?: string;
    };
    if (payload.error) return { error: new Error(payload.message ?? payload.error) };
    return { error: null, refundAmount: Number(payload.refund_amount ?? 0) };
  },
};
