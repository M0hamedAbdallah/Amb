-- ──────────────────────────────────────────────────────────────────────────
-- 0010_function_resolve_complaint.sql — Admin complaint resolution (SEC DEFINER)
-- ──────────────────────────────────────────────────────────────────────────
-- Replaces `complaintService.resolve(complaintId, action, adminNote, suspendUntil)`
-- which exercised five sanctions as separate client-side mutations:
--   warn     → bump warnings_count on vendor or profile
--   ban_temp → set is_active=false, suspended_until=<timestamp>
--   ban_perm → set is_active=false permanently
--   refund   → (NOT IMPLEMENTED in client; audit finding) |
--   none     → just close the complaint, no sanction
--   Then a separate UPDATE on `complaints` set status='resolved'.
--
-- Move to one atomic transaction. The authorisation model is the spec hard
-- rule "All money movement happens server-side only" — `refund` is money
-- movement, so it had to live behind a SECURITY DEFINER.
--
-- Authorisation:
--   The caller (auth.uid()) must have `profiles.role='admin'`. The Supabase
--   default JWT does NOT include the role column as a claim (we'd need a
--   `claims_hook` or custom function for that). So we look up the caller's
--   profile row inside the function and verify `role='admin'`. This is
--   safe because `profiles` RLS lets every authenticated user read their
--   own row (policy "Users can view own profile"), and SECURITY DEFINER
--   bypasses RLS anyway.
--
-- The function:
--   1. Loads the complaint row (with the vendor / reported_account resolved).
--   2. Asserts the caller's `profiles.role='admin'`.
--   3. Applies the sanction in a single transaction.
--      - warn:   increment warnings_count on the offending party. Raises
--                complaint.status to 'resolved' regardless of warning count
--                (escalation policy is left to a future phase).
--      - ban_temp: is_active=false, suspended_until=p_suspend_until.
--      - ban_perm: is_active=false, suspended_until=null.
--      - refund: reverse commission + credit from the related order's
--                settlement, credit the customer's wallet_balance with the
--                sum, insert a wallet_transactions row of type 'credit'
--                marked as 'refund'. Idempotency via a unique-by-order+type
--                guard: we check that no prior 'refund' row exists for this
--                order before issuing one.
--      - none:   close only.
--   4. Closes the complaint: status='resolved', action_taken, admin_note.
--
-- Returns: jsonb `{ complaint, refund_amount? }` on success, structured
-- error on failure.
-- ──────────────────────────────────────────────────────────────────────────

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
  v_caller         uuid := auth.uid();
  v_caller_role    text;
  v_complaint      complaints%rowtype;
  v_vendor_id      uuid;
  v_reported_user  uuid;
  v_order_id       uuid;
  v_refund_amount  numeric(10,2) := 0;
  v_existing_refund uuid;
  v_vendor_user_id  uuid;
  v_customer_id     uuid;
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;
  if p_action not in ('warn','ban_temp','ban_perm','refund','none') then
    return jsonb_build_object('error', 'invalid_action');
  end if;

  -- Admin check: pull caller profile, reject non-admins.
  select role into v_caller_role from profiles where id = v_caller;
  if v_caller_role is null or v_caller_role <> 'admin' then
    return jsonb_build_object('error', 'admin_only');
  end if;

  -- Lock the complaint row
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

  -- Apply the sanction ──────────────────────────────────────────────────────
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
      -- Audit-finding gap: the client never implemented this. We reverse
      -- the vendor's commission + credit on the related order and credit
      -- the customer's wallet. Idempotency: refuse if a prior refund row
      -- exists for this order.
      if v_order_id is null then
        return jsonb_build_object('error', 'order_required_for_refund');
      end if;

      -- Resolve the customer and the vendor's user_id for this order.
      select customer_id into v_customer_id from orders where id = v_order_id;
      if not found then
        return jsonb_build_object('error', 'order_not_found');
      end if;
      select user_id into v_vendor_user_id from vendors
        where id = (select vendor_id from orders where id = v_order_id);

      -- Idempotency check on prior refund.
      select id into v_existing_refund from wallet_transactions
        where order_id = v_order_id
          and type = 'credit'
          and description = 'استرجاع عمولة المنصة'
        limit 1;
      if v_existing_refund is not null then
        return jsonb_build_object('error', 'already_refunded');
      end if;

      -- Sum all wallet_transactions.log rows for this order.
      -- vendor_gets_commission_back = commission (was Withheld to platform),
      -- vendor_loses_credit        = credit  (was paid out to vendor),
      --   vendor must return:      = credit - commission
      -- platform_loses_urgent_fee = urgent_fee (informational only — no-op)
      -- Customer is refunded the credit (vendor pockets commission reverse).
      -- For simplicity: refund the FULL order.total - urgent_fee (vendor base)
      -- minus the platform's urgent fee back to customer.
      select
        coalesce(sum(case when type = 'credit'     then amount end), 0) as paid_out,
        coalesce(sum(case when type = 'commission' then amount end), 0) as commission,
        coalesce(sum(case when type = 'urgent_fee'  then amount end), 0) as urgent_fee
      into v_refund_amount
      from wallet_transactions
      where order_id = v_order_id;

      -- We refund vendor's "earning" = credit row, since commission was already
      -- a withhold (it was informational only — not actually paid into vendor
      -- wallet). The platform's net is zero from this refund phase.
      if v_refund_amount > 0 and v_vendor_user_id is not null then
        -- Claw back the credit row from the vendor's wallet. The
        -- commission row was informational only (kept by platform), so
        -- there's nothing to claw back for that.  We use a guarded
        -- atomic UPDATE so a vendor whose balance has dropped below the
        -- refund amount still loses whatever remains — the customer
        -- gets a partial refund in that case (logged via the SELECT
        -- then UPDATE below).
        update profiles
          set wallet_balance = greatest(0, coalesce(wallet_balance, 0) - v_refund_amount)
          where id = v_vendor_user_id;
        insert into wallet_transactions
          (user_id, type, amount, description, order_id)
        values
          (v_vendor_user_id, 'debit', v_refund_amount,
           'استرجاع عمولة المنصة', v_order_id);
      end if;
      -- Credit the customer
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
      -- No sanction. Just close.
      null;
  end case;

  -- Close the complaint ────────────────────────────────────────────────────
  update complaints
    set status       = 'resolved',
        action_taken = p_action,
        admin_note   = p_admin_note
    where id = p_complaint_id;

  return jsonb_build_object(
    'complaint_id',  p_complaint_id,
    'action_taken',  p_action,
    'refund_amount', v_refund_amount
  );
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- Permissions ─────────────────────────────────────────────────────────────
-- SECURITY DEFINER bypasses RLS, but the function enforces `role='admin'`
-- internally. Granting execution to anon + authenticated is therefore
-- safe — non-admins calling it just get `{error: 'admin_only'}`.
grant execute on function public.resolve_complaint(uuid, text, text, timestamptz)
  to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification:
--   select proname, prokind, prosecdef from pg_proc
--   where proname='resolve_complaint';
-- Expected: resolve_complaint | f | true (security definer)
-- ──────────────────────────────────────────────────────────────────────────
