-- ============================================================================
-- 0019_complaint_auto_suspend_threshold.sql - Automatic suspension escalation
-- ============================================================================
-- Prior to this migration, suspending a vendor or customer was a purely
-- manual admin action: every upheld complaint required an admin to pick
-- 'ban_temp' / 'ban_perm' in resolve_complaint. A repeat-offender could
-- accumulate many upheld complaints without ever being blocked because the
-- admin had to escalate each one by hand.
--
-- This migration adds server-side automatic escalation:
--   1. Seeds system_settings.complaint_suspend_threshold (default '3').
--      Admin-adjustable like every other system setting (config screen).
--   2. Adds SECURITY DEFINER helper maybe_auto_suspend(p_subject_kind,
--      p_subject_id) that counts UPHELD (resolved + action_taken in
--      warn/ban_temp/ban_perm/refund) complaints against the subject and
--      permanently suspends them once count >= threshold while still active.
--      Idempotent (guarded re-entry). NOT callable via REST API.
--   3. Hooks the helper into resolve_complaint after the manual admin action
--      so escalation is atomic with closure. ban_perm/ban_temp already
--      deactivate, so the call is a harmless no-op there; warn/refund is
--      where the auto-suspend actually fires when the threshold is crossed.
-- ============================================================================

-- --- 1. Seed the threshold setting (admin-adjustable) -----------------------
insert into system_settings (key, value)
values ('complaint_suspend_threshold', '3')
on conflict (key) do nothing;

-- --- 2. maybe_auto_suspend helper (SECURITY DEFINER, not PUBLIC-exec) -------
create or replace function public.maybe_auto_suspend(
  p_subject_kind text,
  p_subject_id    uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_threshold int := 3;
  v_count     int := 0;
  v_suspended boolean := false;
begin
  if p_subject_kind not in ('vendor','user') then
    return jsonb_build_object('error', 'invalid_subject_kind');
  end if;
  if p_subject_id is null then
    return jsonb_build_object('error', 'subject_required');
  end if;

  -- Read the admin-adjustable threshold (default 3 if unset/unparsable).
  begin
    select (value::int) into v_threshold
      from system_settings where key = 'complaint_suspend_threshold';
  exception when others then
    v_threshold := 3;
  end;
  if v_threshold is null or v_threshold < 1 then
    v_threshold := 3;
  end if;

  if p_subject_kind = 'vendor' then
    select count(*) into v_count from complaints
      where reported_vendor_id = p_subject_id
        and status = 'resolved'
        and action_taken in ('warn','ban_temp','ban_perm','refund');
    if v_count >= v_threshold then
      update vendors
        set is_active = false, suspended_until = null
        where id = p_subject_id and is_active = true
        returning true into v_suspended;
      v_suspended := coalesce(v_suspended, false);
    end if;
  else
    select count(*) into v_count from complaints
      where reported_id = p_subject_id
        and status = 'resolved'
        and action_taken in ('warn','ban_temp','ban_perm','refund');
    if v_count >= v_threshold then
      update profiles
        set is_active = false, suspended_until = null
        where id = p_subject_id and is_active = true
        returning true into v_suspended;
      v_suspended := coalesce(v_suspended, false);
    end if;
  end if;

  return jsonb_build_object(
    'auto_suspended', v_suspended,
    'upheld_count',   v_count,
    'threshold',      v_threshold
  );
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- Defense in depth: only resolve_complaint (admin-gated RPC) may call this.
revoke execute on function public.maybe_auto_suspend(text, uuid) from public;
revoke execute on function public.maybe_auto_suspend(text, uuid) from anon;
revoke execute on function public.maybe_auto_suspend(text, uuid) from authenticated;

comment on function public.maybe_auto_suspend(text, uuid) is
  'Internal: invoked by resolve_complaint after an admin resolves an upheld '
  'complaint. Counts upheld (resolved + action_taken in warn/ban_temp/ban_'
  'perm/refund) complaints and permanently suspends the subject if at/above '
  'the complaint_suspend_threshold setting while still active. Idempotent '
  'and NOT callable via the REST API.';

-- --- 3. resolve_complaint with the auto-suspend tail appended ---------------
create or replace function public.resolve_complaint(
  p_complaint_id    uuid,
  p_action          text,
  p_admin_note      text default null,
  p_suspend_until   timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_caller          uuid := auth.uid();
  v_caller_role     text;
  v_complaint       complaints%rowtype;
  v_vendor_id       uuid;
  v_reported_user   uuid;
  v_order_id        uuid;
  v_refund_amount   numeric(10,2) := 0;
  v_existing_refund uuid;
  v_vendor_user_id  uuid;
  v_customer_id     uuid;
  v_subject_kind    text;
  v_subject_id      uuid;
  v_suspend_result  jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;
  if p_action not in ('warn','ban_temp','ban_perm','refund','none') then
    return jsonb_build_object('error', 'invalid_action');
  end if;

  select role into v_caller_role from profiles where id = v_caller;
  if v_caller_role is null or v_caller_role <> 'admin' then
    return jsonb_build_object('error', 'admin_only');
  end if;

  select * into v_complaint from complaints
    where id = p_complaint_id
    for update;
  if not found then
    return jsonb_build_object('error', 'complaint_not_found');
  end if;
  if v_complaint.status = 'resolved' then
    return jsonb_build_object('error', 'already_resolved');
  end if;

  v_vendor_id     := v_complaint.reported_vendor_id;
  v_reported_user := v_complaint.reported_id;
  v_order_id      := v_complaint.order_id;

  case p_action
    when 'warn' then
      if v_vendor_id is not null then
        update vendors set warnings_count = coalesce(warnings_count, 0) + 1
          where id = v_vendor_id;
      elsif v_reported_user is not null then
        update profiles set warnings_count = coalesce(warnings_count, 0) + 1
          where id = v_reported_user;
      end if;

    when 'ban_temp' then
      if p_suspend_until is null then
        return jsonb_build_object('error', 'suspend_until_required');
      end if;
      if v_vendor_id is not null then
        update vendors
          set is_active = false, suspended_until = p_suspend_until
          where id = v_vendor_id;
      elsif v_reported_user is not null then
        update profiles
          set is_active = false, suspended_until = p_suspend_until
          where id = v_reported_user;
      end if;

    when 'ban_perm' then
      if v_vendor_id is not null then
        update vendors
          set is_active = false, suspended_until = null
          where id = v_vendor_id;
      elsif v_reported_user is not null then
        update profiles
          set is_active = false, suspended_until = null
          where id = v_reported_user;
      end if;

    when 'refund' then
      if v_order_id is null then
        return jsonb_build_object('error', 'order_required_for_refund');
      end if;
      select customer_id into v_customer_id from orders where id = v_order_id;
      if not found then
        return jsonb_build_object('error', 'order_not_found');
      end if;
      select user_id into v_vendor_user_id from vendors
        where id = (select vendor_id from orders where id = v_order_id);

      select id into v_existing_refund from wallet_transactions
        where order_id = v_order_id
          and type = 'credit'
          and description = 'استرجاع عمولة المنصة'
        limit 1;
      if v_existing_refund is not null then
        return jsonb_build_object('error', 'already_refunded');
      end if;

      select
        coalesce(sum(case when type = 'credit'     then amount end), 0) as paid_out,
        coalesce(sum(case when type = 'commission' then amount end), 0) as commission,
        coalesce(sum(case when type = 'urgent_fee'  then amount end), 0) as urgent_fee
      into v_refund_amount
      from wallet_transactions
      where order_id = v_order_id;

      if v_refund_amount > 0 and v_vendor_user_id is not null then
        update profiles
          set wallet_balance = greatest(0, coalesce(wallet_balance, 0) - v_refund_amount)
          where id = v_vendor_user_id;
        insert into wallet_transactions
          (user_id, type, amount, description, order_id)
          values
          (v_vendor_user_id, 'debit', v_refund_amount,
           'استرجاع عمولة المنصة', v_order_id);
      end if;
      if v_refund_amount > 0 and v_customer_id is not null then
        update profiles
          set wallet_balance = coalesce(wallet_balance, 0) + v_refund_amount
          where id = v_customer_id;
        insert into wallet_transactions
          (user_id, type, amount, description, order_id)
          values
          (v_customer_id, 'credit', v_refund_amount,
           'استرجاع قيمة الطلب بعد التحقيق', v_order_id);
      end if;

    when 'none' then
      null;
  end case;

  update complaints
    set status       = 'resolved',
        action_taken = p_action,
        admin_note   = p_admin_note
    where id = p_complaint_id;

  -- Automatic threshold escalation. Only for upheld sanctions: an admin
  -- could resolve with 'none' (finding of no fault) and we must not
  -- auto-suspend off that. Prefer the vendor subject when both vendor and
  -- user are reported (vendor_fraud_cash etc.), else the reported user.
  if p_action in ('warn','ban_temp','ban_perm','refund') then
    if v_vendor_id is not null then
      v_subject_kind := 'vendor';
      v_subject_id   := v_vendor_id;
    elsif v_reported_user is not null then
      v_subject_kind := 'user';
      v_subject_id   := v_reported_user;
    end if;
    if v_subject_id is not null then
      -- Swallow escalation errors so a failure here can never roll back the
      -- legitimate complaint closure above.
      begin
        v_suspend_result := public.maybe_auto_suspend(v_subject_kind, v_subject_id);
      exception
        when others then
          v_suspend_result := jsonb_build_object('error', sqlstate, 'message', sqlerrm);
      end;
    end if;
  end if;

  return jsonb_build_object(
    'complaint_id',     p_complaint_id,
    'action_taken',      p_action,
    'refund_amount',     v_refund_amount,
    'auto_suspend',      coalesce(v_suspend_result, null)
  );
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

grant execute on function public.resolve_complaint(uuid, text, text, timestamptz)
  to anon, authenticated;

-- ============================================================================
-- Verification (run after applying):
--   select key, value from system_settings where key='complaint_suspend_threshold';
--   select proname, prosecdef from pg_proc where proname in
--     ('resolve_complaint','maybe_auto_suspend');
--   select has_function_privilege('anon','maybe_auto_suspend(text, uuid)','execute');
--   select has_function_privilege('authenticated','maybe_auto_suspend(text, uuid)','execute');
-- Expected: threshold='3'; both funcs security definer=true;
-- has_function_privilege for both anon/authenticated on maybe_auto_suspend = false.
-- ============================================================================
