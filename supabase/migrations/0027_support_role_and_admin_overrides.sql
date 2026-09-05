-- ──────────────────────────────────────────────────────────────────────────
-- 0027_support_role_and_admin_overrides.sql
-- Backing for the web admin console (web/) and its support-team page.
-- ──────────────────────────────────────────────────────────────────────────
-- Context: migrations 0003 / 0016 revoked every direct client write on
-- money-movement tables, and RLS scopes reads to the caller's own rows.
-- The web admin panel therefore goes through the `admin-api` Edge Function
-- (service role) — but money mutations still must not be assembled from
-- multiple REST calls. This migration adds the server-side pieces:
--
--   1. New profile role `support` — members of the support team. The
--      `admin-api` function lets role='support' use ONLY the read-only /
--      support actions (complaint triage, order lookup, chat replies),
--      never money or settings mutations. `resolve_complaint` (0010) and
--      `admin_process_withdrawal` below still hard-require role='admin'.
--   2. `admin_process_withdrawal(p_withdrawal_id, p_action, p_note)` —
--      SECURITY DEFINER RPC, admin-only, atomic:
--        • approve : pending → approved (locked for payout)
--        • reject  : pending → rejected + wallet refund + reversal txn
--        • complete: approved → completed (money left the platform)
--      Replaces the old client-side adminService.approveWithdrawal /
--      rejectWithdrawal pair (which relied on RLS updates that were
--      revoked, and refunded the balance as two separate calls).
--
-- Authorisation model mirrors 0010/0021: the Supabase JWT carries no role
-- claim, so the function looks up profiles.role and rejects non-admins.
-- Idempotent; safe to re-run.
-- ──────────────────────────────────────────────────────────────────────────

-- ─── 1. Extend profiles.role with 'support' ────────────────────────────────
-- 0001 declared the column inline: `role text check (role in (...)) ...`
-- so Postgres named the constraint `profiles_role_check`. Re-create it with
-- the extra value, only if 'support' is not already allowed.
do $$
begin
  if exists (
    select 1 from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'profiles' and con.conname = 'profiles_role_check'
  ) then
    execute 'alter table public.profiles drop constraint profiles_role_check';
  end if;
  execute 'alter table public.profiles add constraint profiles_role_check '
       || 'check (role in (''customer'', ''vendor'', ''admin'', ''support''))';
end $$;

comment on constraint profiles_role_check on public.profiles is
  'Platform roles. support = web support-team console (read + triage + chat), '
  'admin = full web admin console. Enforced server-side in admin-api Edge '
  'Function and the SECURITY DEFINER RPCs.';

-- ─── 2. admin_process_withdrawal ──────────────────────────────────────────
create or replace function public.admin_process_withdrawal(
  p_withdrawal_id uuid,
  p_action        text,
  p_admin_note    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_caller       uuid := auth.uid();
  v_caller_role  text;
  v_w            withdrawals%rowtype;
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;
  if p_action not in ('approve', 'reject', 'complete') then
    return jsonb_build_object('error', 'invalid_action');
  end if;

  select role into v_caller_role from profiles where id = v_caller;
  if v_caller_role is null or v_caller_role <> 'admin' then
    return jsonb_build_object('error', 'admin_only');
  end if;

  select * into v_w from withdrawals where id = p_withdrawal_id for update;
  if not found then
    return jsonb_build_object('error', 'withdrawal_not_found');
  end if;

  if p_action = 'approve' then
    if v_w.status <> 'pending' then
      return jsonb_build_object('error', 'not_pending');
    end if;
    update withdrawals
      set status = 'approved', admin_note = p_admin_note, processed_at = now()
      where id = p_withdrawal_id;

  elsif p_action = 'reject' then
    if v_w.status <> 'pending' then
      return jsonb_build_object('error', 'not_pending');
    end if;
    -- The request_withdrawal RPC (0007) already debited wallet_balance when
    -- the row was created, so a rejection must credit it back exactly once.
    update profiles
      set wallet_balance = coalesce(wallet_balance, 0) + v_w.amount
      where id = v_w.user_id;
    insert into wallet_transactions (user_id, type, amount, description, order_id)
    values (v_w.user_id, 'credit', v_w.amount,
            'إلغاء طلب السحب — استرداد الرصيد', null);
    update withdrawals
      set status = 'rejected', admin_note = p_admin_note, processed_at = now()
      where id = p_withdrawal_id;

  else -- complete
    if v_w.status <> 'approved' then
      return jsonb_build_object('error', 'not_approved');
    end if;
    update withdrawals
      set status = 'completed', admin_note = coalesce(p_admin_note, admin_note),
          processed_at = now()
      where id = p_withdrawal_id;
  end if;

  return jsonb_build_object(
    'withdrawal_id', p_withdrawal_id,
    'action',        p_action,
    'status',        case p_action when 'approve' then 'approved'
                                   when 'reject'  then 'rejected'
                                   else 'completed' end
  );
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

grant execute on function public.admin_process_withdrawal(uuid, text, text)
  to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'profiles_role_check';
--   → CHECK ((role = ANY (ARRAY['customer'::text, 'vendor'::text,
--                               'admin'::text, 'support'::text])))
--
--   select proname, prosecdef from pg_proc where proname = 'admin_process_withdrawal';
--   → admin_process_withdrawal | true
-- ──────────────────────────────────────────────────────────────────────────
