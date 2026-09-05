-- ──────────────────────────────────────────────────────────────────────────
-- 0014_function_cancel_order.sql  —  Atomic customer cancellation (SEC DEFINER)
-- ──────────────────────────────────────────────────────────────────────────
-- Replaces the client-side `orderService.customerCancel` flow which:
--   1. Read the order row (status / accepted_at / size / quantity / vendor).
--   2. Computed the cancellation fee client-side from settings (trusted).
--   3. UPDATE orders SET status='cancelled' (orphaned the order row before
--      stock restore completed under failure).
--   4. Wrote _restoreStock (vendor.<size>_stock += qty — read-modify-write
--      race that lost increments if two cancels overlapped).
--   5. Optionally debited customer wallet_balance via read-modify-write
--      (a NEGATIVE-BALANCE bug: `Math.max(0, current - fee)` silently
--      underflowed to 0 instead of refusing the charge).
--   6. Inserted credit to compensate the vendor (+ opc. commission).
--   7. Fire-and-forget'd dispatchService.cancelDispatch — a no-op once the
--      in-app DispatchManager was shipped (already disappearing in 0011's
--      server-side dispatch-engine path).
--
-- That flow was non-atomic AND wrote to money tables (orders, profiles,
-- wallet_transactions) directly from the client — exactly what Phase 4 is
-- forbidding. The transactional heart of `cancel_order` collapses all of
-- the above into one SECURITY DEFINER function guarded by `WHERE status
-- IN ('pending','accepted')` (refusing to cancel an `on_way` order —
-- spec rule: once the vendor has departed, cancellation is by dispute
-- / refund flow only, not by unilateral customer cancel).
--
-- Authorisation:
--   • caller `auth.uid()` MUST equal `orders.customer_id`. The vendor
--     cannot cancel; the admin path is `resolve_complaint` (0010).
--   • The order status must be `pending` or `accepted`. Cancelling an
--     `on_way` order is rejected with `cancellation_too_late` — the
--     user is routed to the complaints flow if they want a refund.
--
-- Money movement inside this function (all atomic):
--   • Restore vendor stock: `vendors.<size>_stock += quantity` (guarded
--     UPDATE; never overshoots because qty was already decremented in
--     `create_order`).
--   • If the status was `accepted` (vendor has started work): charge the
--     configured `cancellation_fee` from `system_settings` to the
--     customer. The debit is guarded:
--       `UPDATE profiles SET wallet_balance = wallet_balance - fee
--        WHERE id = auth.uid() AND wallet_balance >= fee RETURNING ...`
--     If the customer's wallet can't cover, we DO NOT silently allow
--     negative balance — we skip the live debit but still record the fee
--     as an IOU (`wallet_transactions.cancellation_fee` row, no balance
--     change) and proceed with the cancel. The IOU surfaces to the
--     customer in the wallet screen; repayment is handled by the next
--     order's settlement or a manual recharge, configured per spec.
--   • Compensate the vendor for fuel/time: insert a `credit` row of
--     `fee` to the vendor's user_id and bump `wallet_balance` by `fee`.
--     The vendor earned this per spec ("compensating the vendor for fuel
--     and time") — only when they'd begun work (status='accepted').
--   • Insert a `cancellation_fee` row on the customer's wallet ledger.
--   • Flip orders.status='cancelled', cancelled_at=now(),
--     cancellation_reason, cancellation_fee.
--   • Fire-and-forget `dispatch_engine_step(order_id)` via pg_net so the
--     dispatch-engine stops retrying this order.
--
-- Idempotency:
--   Calling cancel_order again after the first success sees
--   `status='cancelled'` and returns `{ already_cancelled: true }` with
--   NO further stock restore / fee / credit movement.
--
-- Returns: jsonb `{ charged_fee, already_cancelled?, error? }` on success,
-- structured error on failure.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.cancel_order(
  p_order_id  uuid,
  p_reason    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_caller      uuid := auth.uid();
  v_order       orders%rowtype;
  v_settings    record;
  v_fee         numeric(10,2) := 0;
  v_rowcount    int;
  v_vendor      vendors%rowtype;
  v_vendor_uid  uuid;
  v_stock_col   text;
  v_debited     boolean := false;
  v_after_acceptance boolean := false;
  v_new_balance numeric(10,2);
  v_url         text := 'https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/dispatch-engine';
  v_key         text := coalesce(current_setting('app.supabase_anon_key', true),
                                 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthemNueGZwbWd5empwZXZxeGl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3OTQ0MTksImV4cCI6MjEwMDM3MDQxOX0.svOIL78CoNECfblJVxVvTNTHsjm2gwhXS_wcmKPQI4M');
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;

  -- Lock the order row for the duration of the transaction.
  select * into v_order
  from orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('error', 'order_not_found');
  end if;

  -- Idempotency: already-cancelled is a soft success.
  if v_order.status = 'cancelled' then
    return jsonb_build_object('already_cancelled', true, 'charged_fee', 0);
  end if;

  -- Authorization: caller must be the order's customer.
  if v_order.customer_id is null or v_order.customer_id <> v_caller then
    return jsonb_build_object('error', 'not_your_order');
  end if;

  -- Status guard: can only cancel before vendor departs.
  if v_order.status not in ('pending','accepted') then
    return jsonb_build_object('error', 'cancellation_too_late',
                              'current_status', v_order.status);
  end if;

  v_after_acceptance := (v_order.status = 'accepted') or (v_order.accepted_at is not null);

  -- Restore vendor stock (atomic guarded UPDATE; never overshoots because
  -- the qty was already decremented inside create_order). We do the stock
  -- restore regardless of v_after_acceptance — the vendor hasn't consumed
  -- the cylinder yet, only reserved it.
  if v_order.vendor_id is not null then
    v_stock_col := case when v_order.size = 'small' then 'small_stock' else 'large_stock' end;
    execute format(
      'update vendors set %I = %I + $1 where id = $2',
      v_stock_col, v_stock_col
    ) using v_order.quantity, v_order.vendor_id;

    select * into v_vendor from vendors where id = v_order.vendor_id;
    v_vendor_uid := v_vendor.user_id;
  end if;

  -- Pull the configured cancellation fee from system_settings.
  select max(case when key = 'cancellation_fee' then value::numeric end) as cancellation_fee
  into   v_settings
  from   system_settings
  where  key = 'cancellation_fee';

  v_fee := case when v_after_acceptance then coalesce(v_settings.cancellation_fee, 0) else 0 end;

  -- Apply the fee: live-debit the customer wallet if covered; else record IOU.
  if v_fee > 0 then
    -- Atomic guard: only debit if the balance covers the fee. We do NOT use
    -- `greatest(0, balance - fee)` (the OLD bug that let negatives through).
    update profiles
      set wallet_balance = wallet_balance - v_fee
      where id = v_caller and wallet_balance >= v_fee
      returning wallet_balance into v_new_balance;

    if found then
      v_debited := true;
      insert into wallet_transactions (user_id, type, amount, description, order_id)
      values (v_caller, 'cancellation_fee', v_fee,
              'رسوم إلغاء بعد قبول الطلب', v_order.id);
    else
      -- IOU path: customer's wallet can't cover. We don't move it to negative
      -- balance, but we DO log the fee so it surfaces in their wallet and
      -- can be reconciled at next order's settlement.
      insert into wallet_transactions (user_id, type, amount, description, order_id)
      values (v_caller, 'cancellation_fee', v_fee,
              concat('رسوم إلغاء معلّقة — رصيد غير كافٍ (', v_fee::text, ' جنيه)'),
              v_order.id);
      -- In this IOU path we DON'T compensate the vendor from the customer's
      -- balance (there's nothing to take). We DO still record the vendor's
      -- credit on the platform's behalf, sourced against the platform via a
      -- future reconciliation — i.e. we skip the wallet_balance bump for the
      -- vendor since no actual fund moved.
    end if;

    -- Compensate the vendor for fuel/time if we successfully debited the
    -- customer (matched the IOU-or-not path above).
    if v_debited and v_vendor_uid is not null then
      insert into wallet_transactions (user_id, type, amount, description, order_id)
      values (v_vendor_uid, 'credit', v_fee,
              'تعويض إلغاء العميل', v_order.id);
      update profiles
        set wallet_balance = coalesce(wallet_balance, 0) + v_fee
        where id = v_vendor_uid;
    end if;
  end if;

  -- Cancel the order atomically (guarded by status to prevent races).
  update orders
    set status              = 'cancelled',
        cancelled_at       = now(),
        cancellation_reason= coalesce(p_reason, 'ألغى العميل الطلب'),
        cancellation_fee   = v_fee
    where id = p_order_id
      and status in ('pending','accepted');
  get diagnostics v_rowcount = row_count;
  if v_rowcount = 0 then
    -- Raced and the order moved (e.g. a vendor accepted concurrently and we
    -- lost on the .accepted check); the function returns the fee but the
    -- status didn't change. The previous debit will be rolled back with the
    -- entire function transaction via exception. Defensive only.
    raise exception 'concurrent_status_change';
  end if;

  -- Tell dispatch-engine to stop retrying this order (fire-and-forget;
  -- failures here must NOT fail the cancel — the order is already cancelled
  -- in the row, and the cron dispatch-stuck-orders skips cancelled orders by
  -- its own status filter).
  begin
    perform net.http_post(
      url    := v_url,
      body   := jsonb_build_object('order_id', v_order.id, 'cancelled', true),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey',       v_key,
        'Authorization','Bearer ' || v_key
      )
    );
  exception when others then
    raise notice 'cancel_order dispatch cancel POST failed: %', sqlerrm;
  end;

  return jsonb_build_object(
    'charged_fee', v_fee,
    'debited',     v_debited
  );
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

grant execute on function public.cancel_order(uuid, text)
  to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecdef from pg_proc where proname='cancel_order';
-- Expected: cancel_order | f | true (security definer)
-- ──────────────────────────────────────────────────────────────────────────
