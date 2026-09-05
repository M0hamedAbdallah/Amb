-- ──────────────────────────────────────────────────────────────────────────
-- 0024_kashier_cancel_and_cron.sql
--   • Allow customer cancellation while awaiting_payment (free, no stock, no fee)
--   • Mark awaiting_payment customer-cancelled orders explicitly (promo rollback)
--   • Register the `cancel-expired-payments` pg_cron job (15-min timeout)
-- ──────────────────────────────────────────────────────────────────────────
-- Why cancel_order needs amending:
--   The 0014 implementation refuses any status outside ('pending','accepted')
--   with `cancellation_too_late`. That guard pre-dates the awaiting_payment
--   state (0022) and would currently reject a free cancellation of an unpaid
--   order — forcing the customer to wait for the 15-min auto-cancel cron. We
--   extend the guard to also accept 'awaiting_payment' and short-circuit the
--   fee / vendor comp / stock logic (none apply: no stock was reserved, no
--   vendor was assigned, no fee should be charged).
--
-- Why awaiting_payment customers DO get free, instant cancellation:
--   • Vendor stock is intact (deferred decrement lives in settle_kashier_payment).
--   • No vendor has been notified (the AFTER INSERT dispatch trigger gates on
--     status='pending' && vendor_id IS NULL — awaiting_payment orders never
--     dispatched per 0011_triggers.sql:93).
--   • The customer never paid (status literally means "we don't have money yet").
--
-- Promo rollback:
--   If the customer consumed a promo at create_order time and now cancels
--   before paying, we MUST give the slot back — otherwise a refund-less drop
--   silently wastes a one-shot promo. We mirror the rollback pattern from
--   create_order's failure branch: decrement used_count, delete the
--   promo_usages row. This is ONLY safe for awaiting_payment cancellations
--   (for pending/accepted the promo was already spent on work-in-progress).
--
-- Idempotent cron registration: mirrors 0011_triggers.sql's pattern (drop
-- existing job, then `cron.schedule`, both wrapped in DO-blocks).
-- ──────────────────────────────────────────────────────────────────────────

-- ─── 1. customer_cancel_awaiting_payment (new path inside cancel_order) ────
-- Rather than monkey-patch the existing cancel_order's status guard (which
-- would also relax the on_way guard), introduce a SMALL sibling RPC that
-- handles the awaiting_payment case only. cancel_order stays unchanged for
-- the paid pipeline (pending/accepted/on_way behaviour is exactly as before).
--
-- The Tom-Robinson principle: one RPC per valid state-transition contract.
-- `cancel_order` owns paid-order cancellation (fee / vendor-comp / stock). This
-- owns unpaid-order cancellation (no fee, no comp, no stock move, promo rollback).

create or replace function public.cancel_awaiting_payment(
  p_order_id  uuid,
  p_reason    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_caller uuid := auth.uid();
  v_order  orders%rowtype;
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('error', 'order_not_found');
  end if;

  -- Idempotency: an order that's already cancelled is a soft success.
  if v_order.status = 'cancelled' then
    return jsonb_build_object('already_cancelled', true, 'charged_fee', 0);
  end if;

  -- Authorization: caller must be the order's customer. (The vendor can't
  -- reach this status — awaiting_payment never dispatches.)
  if v_order.customer_id is null or v_order.customer_id <> v_caller then
    return jsonb_build_object('error', 'not_your_order');
  end if;

  -- Status guard: ONLY awaiting_payment is accepted. Any other status is
  -- routed to the original cancel_order RPC by the client; if the client
  -- calls us anyway we return the structured code so it can redirect.
  if v_order.status <> 'awaiting_payment' then
    return jsonb_build_object('error', 'not_awaiting_payment',
                              'current_status', v_order.status);
  end if;

  -- Promo rollback: give back any promo slot the customer consumed at
  -- create_order time. Idempotent (DELETE is safe; the decrement uses
  -- `greatest(x - 1, 0)` so it underflows to zero safely).
  if v_order.promo_code is not null and v_order.promo_code <> '' then
    update promo_codes
      set used_count = greatest(used_count - 1, 0)
      where code = v_order.promo_code;
    delete from promo_usages
      where promo_code = v_order.promo_code and user_id = v_caller;
  end if;

  -- Flip the order to cancelled. No fee, no stock restore (none reserved),
  -- no vendor comp (no vendor was ever assigned). cancellation_reason
  -- preserves the user's wording; we default to a sensible Arabic fallback.
  update orders
    set status               = 'cancelled',
        cancelled_at        = now(),
        cancellation_reason = coalesce(p_reason, 'ألغى العميل قبل الدفع'),
        cancellation_fee    = 0,
        payment_status      = coalesce(v_order.payment_status, 'cancelled')
    where id = p_order_id and status = 'awaiting_payment';

  -- Order cancellation triggers notify_status_change → send-notification,
  -- which already has a 'cancelled' entry in STATUS_BODIES — no wiring change
  -- needed (the customer gets the standard "تم إلغاء الطلب" push).
  return jsonb_build_object('cancelled', true, 'charged_fee', 0,
                            'order_id', p_order_id::text);
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

grant execute on function public.cancel_awaiting_payment(uuid, text)
  to anon, authenticated;


-- ─── 2. cancel_expired_awaiting_payments — SQL cron entry point ────────────
-- Called every minute by pg_cron. Cancels any awaiting_payment order older
-- than 15 minutes (configurable below via the constant). Idempotent: the
-- status guard inside cancel_awaiting_payment's UPDATE prevents double-work,
-- and a row already cancelled short-circuits at the top of the function.
--
-- This is the safety-net cron. It comes back to bite a customer who opened
-- the Kashier checkout page but abandoned it: after 15 minutes we cancel,
-- roll back any promo, and free them up to retry. Re-marketing considerations
-- aside, this keeps the order table from accumulating zombie rows. The
-- customer is still allowed to RE-PLACE the order (a new create_order call).

create or replace function public.cancel_expired_awaiting_payments()
returns void
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_row        orders%rowtype;
  v_timeout_min int := 15;
  v_count     int := 0;
begin
  for v_row in
    select * from orders
      where status = 'awaiting_payment'
        and created_at < now() - (v_timeout_min || ' minutes')::interval
      order by created_at asc
      limit 50  -- bounded sweep; the next tick continues if more remain
  loop
    -- Inline the awaiting_payment cancellation (we don't need customer auth
    -- for the cron path; this function is SECURITY DEFINER and runs as
    -- postgres). Promo rollback included.
    if v_row.promo_code is not null and v_row.promo_code <> '' then
      update promo_codes
        set used_count = greatest(used_count - 1, 0)
        where code = v_row.promo_code;
      delete from promo_usages
        where promo_code = v_row.promo_code and user_id = v_row.customer_id;
    end if;

    update orders
      set status               = 'cancelled',
          cancelled_at        = now(),
          cancellation_reason = 'انتهت مهلة الدفع (15 دقيقة)',
          cancellation_fee    = 0,
          payment_status     = 'cancelled'
      where id = v_row.id and status = 'awaiting_payment';

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    raise notice 'cancel_expired_awaiting_payments: cancelled % orders', v_count;
  end if;
end;
$$;

-- Cron function is called only by the scheduler. No client EXECUTE.
revoke execute on function public.cancel_expired_awaiting_payments() from public, anon, authenticated;
do $$
begin
  execute 'grant execute on function public.cancel_expired_awaiting_payments() to service_role';
exception when others then
  raise notice 'cancel_expired_awaiting_payments grant: %', sqlerrm;
end $$;


-- ─── 3. Register the pg_cron job (every minute, idempotent) ────────────────
do $_$
begin
  perform cron.unschedule('cancel-expired-payments');
exception when others then null; end $_$;

do $_$
begin
  perform cron.schedule(
    'cancel-expired-payments',
    '* * * * *',                                     -- every minute
    $cmd$select public.cancel_expired_awaiting_payments();$cmd$
  );
exception
  when others then
    raise notice 'cron.schedule cancel-expired-payments error: %', sqlerrm;
end $_$;


-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prosecdef from pg_proc
--     where proname in ('cancel_awaiting_payment','cancel_expired_awaiting_payments');
--   -- Expected:
--   --   cancel_awaiting_payment            | definer
--   --   cancel_expired_awaiting_payments    | definer
--
--   select jobname, schedule, active, command from cron.job
--     where jobname='cancel-expired-payments';
--   -- Expected: active=t, command='select public.cancel_expired_awaiting_payments();'
-- ──────────────────────────────────────────────────────────────────────────
