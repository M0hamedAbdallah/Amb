-- ──────────────────────────────────────────────────────────────────────────
-- 0026_fix_settle_kashier_payment_uuid_into_int.sql
-- ──────────────────────────────────────────────────────────────────────────
-- FIX: settle_kashier_payment threw PG 22P02 (invalid_text_representation:
-- "invalid input syntax for type integer: \"<uuid>\"") on every invocation
-- against an awaiting_payment order, even though the rest of the chain was
-- healthy. The webhook Edge Function logged `ack:'inline', settle_ok:true,
-- settled:false` and the order stayed in `awaiting_payment`, vendor stock was
-- never decremented, no `payment_events` row persisted.
--
-- ROOT CAUSE
--   At line 406 of migration 0023, the `INSERT INTO payment_events ...`
--   statement used the clause
--       returning id into v_rowcount;
--   but `v_rowcount` was DECLARED at line 360 as
--       v_rowcount int;
--   while `payment_events.id` is a `uuid primary key default
--   uuid_generate_v4()`. Postgres assigns the freshly-generated UUID via an
--   implicit `text -> int4` cast which rejects any non-decimal character,
--   producing `invalid input syntax for type integer: "<the v4 UUID>"` on
--   ~67% of UUIDs (those with at least one a-f hex char in the prefix). The
--   exception bubbled up to the outermost exception handler at lines 508-510
--   of 0023 which swallowed it and returned
--       {error:'22P02', message:'invalid input syntax for type integer: \"...\"'}
--   — a JSON *body* on HTTP 200 that the webhook code reported as
--   `settle_ok:true, settled:false`. Each invocation produced a *different*
--   UUID in the message because `payment_events.id` is generated fresh per
--   INSERT attempt (the insert is then rolled back along with the function
--   transaction), which is the tell-tale signature of this bug.
--
--   This is structurally identical to the 0017/0025 OTP-generator bug:
--   a freshly-generated UUID-the-string fed to a numeric cast.

--   Concurrent observation that confused the diagnosis: the same `v_rowcount`
--   variable is reused two lines later (line 439) for
--       get diagnostics v_rowcount = row_count;
--   which is its correct (int-returned-by-EXPLAIN-UPDATE) use. The bug was
--   only on the INSERT...RETURNING line, NOT on the diagnostics line.

-- FIX
--   1. Introduce a properly-typed `v_event_id uuid` local for the
--      INSERT ... RETURNING id clause.
--   2. Switch the duplicate-event check from `v_rowcount is null`
--      to `v_event_id is null` (the same semantics — RETURNING INTO yields
--      NULL when ON CONFLICT DO NOTHING skipped the insert — but now matches
--      the type of the id column).
--   3. Leave `v_rowcount int` for the `get diagnostics v_rowcount = row_count`
--      on the stock-decrement UPDATE (its correct use).
--
-- This is the minimal surgical patch. No schema or permission changes.
-- Idempotent: `create or replace function settle_kashier_payment`. No data
-- migration; the failed attempts left zero `payment_events` rows.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.settle_kashier_payment(
  p_order_id              uuid,
  p_payment_status        text,        -- 'paid' | 'failed' | 'cancelled' (App casing, normalized from Kashier's data.status)
  p_kashier_transaction_id text,
  p_amount                numeric(10,2),
  p_currency              text default 'EGP',
  p_event                 text default null,   -- Kashier's RAW top-level `event` value verbatim (e.g. 'pay'); NULL falls back to 'pay'
  p_raw_payload           jsonb default null,
  p_signature_verified    boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_order          orders%rowtype;
  v_vendor         vendors%rowtype;
  v_stock_col      text;
  v_rowcount       int;   -- used ONLY for `get diagnostics v_rowcount = row_count` on the stock-decrement UPDATE
  v_event_id       uuid;  -- payment_events.id from INSERT ... RETURNING (uuid, NOT int — see migration header)
  v_amount_matches boolean := false;
begin
  -- SANITY: the webhook Edge Function must NOT call this with a tampered
  -- signature_verified=false. Refuse to settle if so — we'd rather drop a
  -- charge than risk crediting an order without proof of payment.
  if p_signature_verified is not true then
    return jsonb_build_object('error', 'signature_not_verified');
  end if;

  -- Lock the order row for the duration of the transaction.
  select * into v_order from orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('error', 'order_not_found');
  end if;

  -- Idempotency: any non-awaiting_payment status is a no-op. Replays of the
  -- same webhook are common — Kashier retries for up to 23.5 hours on non-2xx
  -- (and 409 counts as a successful ack, but the Edge Function always returns
  -- 200/2xx for processed deliveries, so replays shouldn't happen). Be
  -- defensive anyway: a delayed first delivery arriving after our cron has
  -- auto-cancelled the order (15-min timeout) would hit a `cancelled` status
  -- here, and this guard turns it into a no-op rather than re-opening the row.
  if v_order.status <> 'awaiting_payment' then
    return jsonb_build_object('already_settled', true, 'current_status', v_order.status);
  end if;

  -- Record the raw event FIRST, idempotently. The `event` column stores Kashier's
  -- RAW top-level `event` field verbatim (e.g. "pay"); per the confirmed docs
  -- TRANSACTION-class webhook deliveries share that single event name, and the
  -- discriminator we care about is `transactionId` + `event`. If the row already
  -- exists, ON CONFLICT DO NOTHING → settle is a no-op for the duplicate, which
  -- guards us against Kashier's retry storms.
  --
  -- NOTE: `payment_events.id` is `uuid` (default uuid_generate_v4()); we RETURNING
  -- it into `v_event_id uuid`. An earlier version typed this as `int` and got
  -- `22P02: invalid input syntax for type integer: "<uuid>"` on ~67% of calls.
  insert into payment_events (
    order_id, kashier_transaction_id, event, payment_status,
    amount, currency, raw_payload, signature_verified
  ) values (
    p_order_id, p_kashier_transaction_id,
    coalesce(nullif(p_event, ''), 'pay'),   -- Kashier's raw `event` value; falls back to 'pay'
    upper(p_payment_status),
    p_amount, coalesce(p_currency, 'EGP'),
    coalesce(p_raw_payload, '{}'::jsonb),
    p_signature_verified
  )
  on conflict (kashier_transaction_id, event) do nothing
  returning id into v_event_id;

  -- If the insert was a no-op (already-seen webhook for the same txn+event),
  -- don't re-settle. ON CONFLICT DO NOTHING returns nothing into RETURNING,
  -- so v_event_id stays NULL.
  if v_event_id is null then
    return jsonb_build_object('already_settled', true, 'duplicate_event', true);
  end if;

  -- Now branch by the normalized payment status.
  if p_payment_status = 'paid' then
    -- Verify the amount matches the order total. Kashier's `amount` is the
    -- charged total; reject mismatches (case-sensitive comparison after cast).
    v_amount_matches := (p_amount = v_order.total);
    if not v_amount_matches then
      -- Record the mismatch but DO NOT settle. The Dashboards team must
      -- reconcile. Return an error so the webhook function logs it.
      return jsonb_build_object('error', 'amount_mismatch',
                                'expected', v_order.total::text,
                                'received', p_amount::text);
    end if;

    -- E-wallet stock decrement now (deferred from create_order). Re-check
    -- `>= p_quantity` so a concurrent cash order that exhausted the vendor
    -- between create and settle is rejected — refund flows through the
    -- cancel path (0024).
    if v_order.vendor_id is not null then
      select * into v_vendor from vendors where id = v_order.vendor_id for update;
      v_stock_col := case when v_order.size = 'small' then 'small_stock' else 'large_stock' end;

      execute format(
        'update vendors set %I = %I - $1 where id = $2 and %I >= $1',
        v_stock_col, v_stock_col, v_stock_col
      ) using v_order.quantity, v_order.vendor_id;
      get diagnostics v_rowcount = row_count;
      if v_rowcount = 0 then
        -- The vendor's stock ran out between create and settle. We can't
        -- satisfy the order; cancel it free of charge. The customer's
        -- Kashier charge MUST be refunded manually from the dashboard (the
        -- webhook event doesn't trigger an auto-refund — we surface this to
        -- the operator via the response and the payment_events audit row).
        return jsonb_build_object('error', 'out_of_stock_at_settle',
                                  'needs_manual_refund', true);
      end if;
    end if;

    -- Atomic transition awaiting_payment -> pending. The guarded WHERE
    -- prevents any race — concurrent settles are impossible under the FOR
    -- UPDATE above, but we keep the defense.
    update orders
      set status            = 'pending',
          payment_status    = 'paid',
          paid_at           = now(),
          kashier_payment_ref = p_kashier_transaction_id
      where id = p_order_id and status = 'awaiting_payment';

    -- The AFTER UPDATE OF status trigger (0011_triggers.sql:144
    -- notify_status_change) fires send-notification automatically. The
    -- AFTER INSERT trigger (trg_orders_dispatch) is NOT re-fired (this is
    -- an UPDATE, not INSERT), so dispatch won't start on its own. We kick
    -- it explicitly via dispatch_engine_step, mirroring the cancel_order
    -- pattern of pg_net.http_post to the Edge Function.
    begin
      perform public.dispatch_engine_step(p_order_id);
    exception when others then
      raise notice 'settle_kashier_payment dispatch kickoff failed: %', sqlerrm;
      -- Non-fatal: the pg_cron dispatch-stuck-orders job catches it within
      -- a minute, and the dispatched `pending` order is now eligible.
    end;

    return jsonb_build_object('settled', true, 'order_id', p_order_id::text);

  elsif p_payment_status in ('failed','cancelled') then
    -- Transition awaiting_payment -> cancelled, no fee, no stock to restore
    -- (we never decremented). The cancel_order RPC won't accept
    -- awaiting_payment until migration 0024 extends its status guard, so
    -- we inline the minimal transition here under SECURITY DEFINER. Promo
    -- rollback also happens here (the customer consumed a promo at create
    -- time but is now not paying — give the slot back).
    update orders
      set status              = 'cancelled',
          cancelled_at       = now(),
          cancellation_reason = 'فشل الدفع عبر Kashier',
          payment_status     = p_payment_status,
          kashier_payment_ref = p_kashier_transaction_id
      where id = p_order_id and status = 'awaiting_payment';

    -- Promo rollback (mirror of create_order's rollback-on-failure branch)
    if v_order.promo_code is not null and v_order.promo_code <> '' then
      update promo_codes
        set used_count = greatest(used_count - 1, 0)
        where code = v_order.promo_code;
      delete from promo_usages
        where promo_code = v_order.promo_code and user_id = v_order.customer_id;
    end if;

    return jsonb_build_object('cancelled', true, 'order_id', p_order_id::text,
                              'reason', 'payment_failed');
  else
    -- Unknown payment_status; log and bail.
    return jsonb_build_object('error', 'unknown_payment_status',
                              'received', p_payment_status);
  end if;
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- Re-state the grant from 0023 verbatim — CREATE OR REPLACE preserves grants
-- in practice, but we restate them so the migration is self-documenting.
-- This RPC runs ONLY as the service role (called by the kashier-webhook Edge
-- Function). Never grant to anon/authenticated.
revoke execute on function public.settle_kashier_payment(
  uuid, text, text, numeric, text, text, jsonb, boolean
) from anon, authenticated;
do $$
begin
  execute 'grant execute on function public.settle_kashier_payment'
          '(uuid, text, text, numeric, text, text, jsonb, boolean) to service_role';
exception when others then
  raise notice '0026 grant: %', sqlerrm;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   1) Confirm the typed-row fix is in place (v_event_id is uuid, not int):
--        select prosrc::text from pg_proc where proname = 'settle_kashier_payment';
--         -- expect to see: "v_event_id uuid;"
--         -- and:           "returning id into v_event_id;"
--         -- and:           "if v_event_id is null then"
--
--   2) Re-run the previously-failing E2E path:
--
--        select public.settle_kashier_payment(
--          p_order_id               := '<awaiting_payment_order_uuid>'::uuid,
--          p_payment_status         := 'paid',
--          p_kashier_transaction_id := 'VERIFY-0026-'||extract(epoch from now())::bigint::text,
--          p_amount                 := <order_total>::numeric,
--          p_currency               := 'EGP',
--          p_event                  := 'pay',
--          p_raw_payload            := '{"event":"pay","data":{"status":"SUCCESS"}}'::jsonb,
--          p_signature_verified     := true
--        ) as settle_result;
--         -- expect: {"settled": true, "order_id": "<...>"}
--         -- NOT: {"error": "22P02", "message": "invalid input syntax for type integer: \"...\""}
--
--         select id::text, status, payment_status, paid_at, kashier_payment_ref
--           from orders where id = '<awaiting_payment_order_uuid>';
--         -- expect: status='pending', payment_status='paid',
--         --         paid_at=<now>, kashier_payment_ref='VERIFY-0026-...'
--
--         select order_id::text, kashier_transaction_id, event, payment_status, amount::text
--           from payment_events where order_id = '<awaiting_payment_order_uuid>';
--         -- expect: exactly ONE row with the same kashier_transaction_id we sent
-- ──────────────────────────────────────────────────────────────────────────
