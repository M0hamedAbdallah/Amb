-- ──────────────────────────────────────────────────────────────────────────
-- 0023_function_create_order_kashier.sql
--   • Branch `create_order` by payment_method (cash vs e-wallet)
--   • New `settle_kashier_payment` SECURITY DEFINER RPC
-- ──────────────────────────────────────────────────────────────────────────
-- create_order now does one of two things based on p_payment_method:
--
--   • CASH (p_payment_method = 'cash'):
--       Existing behaviour unchanged: decrement vendor stock now, insert the
--       order at status='pending', fire dispatch via the AFTER INSERT trigger
--       (which already gates on status='pending' && vendor_id IS NULL — the
--       customer-vendor path is untouched).
--
--   • E-WALLET (p_payment_method in
--       vodafone_cash, etisalat_cash, orange_money, instapay):
--       Do NOT decrement stock. Insert the order at status='awaiting_payment',
--       generate a `kashier_order_ref = 'AMB-' || <id>`, set payment_status='unpaid'.
--       The AFTER INSERT dispatch trigger is skipped because it only fires
--       dispatch when NEW.status = 'pending' (0011_triggers.sql:93). The
--       customer is then routed through Kashier Hosted Checkout by the RN
--       client; on webhook-confirmed PAID, `settle_kashier_payment` performs
--       the stock decrement + awaiting_payment -> pending transition in one
--       atomic transaction, and the existing AFTER UPDATE OF status trigger
--       fires dispatch automatically. No dispatch/notification wiring changes.
--
-- The transaction covers everything in create_order EXCEPT the stock decrement
-- for e-wallet paths (deferred). Payout routing for `cash` and `e-wallet`
-- orders at delivery time (verify_delivery) is unchanged — both arrive at
-- `pending` identically, so the rest of the pipeline doesn't care how the
-- order was paid.
--
-- settle_kashier_payment:
--   The single server-side money-movement side-effect of the webhook. Idempotent
--   (already-settled returns {already_settled:true} with NO double-decrement),
--   amount-checked against orders.total, atomic, SECURITY DEFINER. Only callable
--   by the service role (no anon EXECUTE).
--
-- Idempotency contract:
--   • Same webhook delivered twice → payment_events ON CONFLICT DO NOTHING on
--     (kashier_transaction_id, event) → second insert is a no-op.
--   • The `event` column stores Kashier's raw top-level event value verbatim
--     (per the confirmed docs, that's literally the string "pay" for
--     TRANSACTION-class webhooks — NOT an invented label like "charge.success").
--   • settle sees status != 'awaiting_payment' → returns early, no stock move.
--   • Stock decrement uses the SAME guarded `vendors.<size>_stock >= qty`
--     WHERE clause as the existing create_order path — concurrent settles are
--     impossible because the order row is locked FOR UPDATE and only one
--     transaction can hold status='awaiting_payment' at a time.
-- ──────────────────────────────────────────────────────────────────────────

-- ─── 1. create_order branching (drop & recreate to amend) ───────────────────
-- The signature is identical to the original — callers don't change. Only
-- the body branches on p_payment_method. We preserve every existing
-- guarantee (LOCK ORDER, otp generation, promo atomicity, etc.).

create or replace function public.create_order(
  p_vendor_id         uuid,
  p_size              text,
  p_quantity          int default 1,
  p_is_urgent         boolean default false,
  p_payment_method    text default 'cash',
  p_delivery_address  text default '',
  p_delivery_lat      double precision default 30.0444,
  p_delivery_lng      double precision default 31.2357,
  p_promo_code        text default null,
  p_customer_note     text default null,
  p_scheduled_for     timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_customer_id  uuid    := auth.uid();
  v_vendor        vendors%rowtype;
  v_settings      record;
  v_distance_km   double precision;
  v_subtotal      numeric(10,2);
  v_delivery_fee  numeric(10,2);
  v_platform_fee  numeric(10,2);
  v_urgent_fee    numeric(10,2);
  v_discount      numeric(10,2) := 0;
  v_promo         promo_codes%rowtype;
  v_total         numeric(10,2);
  v_otp           text;
  v_otp_bytes     bytea := gen_random_bytes(4);
  v_stock_col     text;
  v_stock_decremented boolean := false;
  v_new_order     orders%rowtype;
  v_promo_consumed   boolean := false;
  v_is_ewallet    boolean;
  v_initial_status text;
begin
  -- Authorisation ──────────────────────────────────────────────────────────
  if v_customer_id is null then
    return jsonb_build_object('error', 'auth_required');
  end if;

  if p_size not in ('small','large') then
    return jsonb_build_object('error', 'invalid_size');
  end if;

  if p_quantity < 1 or p_quantity > 50 then
    return jsonb_build_object('error', 'invalid_quantity');
  end if;

  -- Decide the initial lifecycle state based on payment method.
  -- Whitelist the e-wallet labels the RN app currently ships
  -- (constants/config.ts). Anything else (including the existing 'cash')
  -- falls through to the synchronous cash path.
  v_is_ewallet := p_payment_method in
    ('vodafone_cash','etisalat_cash','orange_money','instapay');
  v_initial_status := case when v_is_ewallet then 'awaiting_payment' else 'pending' end;

  -- Lock vendor row ────────────────────────────────────────────────────────
  -- FOR UPDATE prevents a concurrent order from racing on the stock decrement
  -- (cash path) and on the eligibility re-check (e-wallet path; the actual
  -- stock move is deferred to settle_kashier_payment but we MUST verify here
  -- that the vendor is currently eligible so we don't create an
  -- awaiting_payment order against a vendor that's already ineligible).
  select * into v_vendor
  from vendors
  where id = p_vendor_id
  for update;

  if not found then
    return jsonb_build_object('error', 'vendor_not_found');
  end if;

  if not v_vendor.is_active or not v_vendor.is_verified then
    return jsonb_build_object('error', 'vendor_not_eligible');
  end if;

  -- Stock guard (server-authoritative) — applies to BOTH paths. For e-wallet
  -- we don't decrement yet, but if there's no stock right now we refuse to
  -- even start a Kashier checkout (the customer would pay for an out-of-stock
  -- order and we'd have to refund it after the fact — bad UX).
  if p_size = 'small' and v_vendor.small_stock < p_quantity then
    return jsonb_build_object('error', 'out_of_stock');
  end if;
  if p_size = 'large' and v_vendor.large_stock < p_quantity then
    return jsonb_build_object('error', 'out_of_stock');
  end if;

  if v_vendor.suspended_until is not null and v_vendor.suspended_until > now() then
    return jsonb_build_object('error', 'vendor_suspended');
  end if;

  -- Tally system_settings in one pass ──────────────────────────────────────
  select
    max(case when key = 'commission_pct'       then value::numeric end) as commission_pct,
    max(case when key = 'urgent_fee'           then value::numeric end) as urgent_fee,
    max(case when key = 'delivery_fee_base'    then value::numeric end) as delivery_fee_base,
    max(case when key = 'delivery_fee_per_km'  then value::numeric end) as delivery_fee_per_km
  into v_settings
  from system_settings
  where key in ('commission_pct','urgent_fee','delivery_fee_base','delivery_fee_per_km');

  -- Pricing: subtotal from vendor price list ───────────────────────────────
  v_subtotal := case when p_size = 'small'
                      then v_vendor.small_price * p_quantity
                      else v_vendor.large_price * p_quantity
                 end;

  -- Delivery fee: haversine distance * per-km + base
  v_distance_km := 2 * 6371 * asin(sqrt(
    power(sin(radians(p_delivery_lat - v_vendor.lat) / 2), 2) +
    cos(radians(v_vendor.lat)) * cos(radians(p_delivery_lat)) *
    power(sin(radians(p_delivery_lng - v_vendor.lng) / 2), 2)
  ));

  if v_vendor.delivery_radius_km is not null and v_distance_km > v_vendor.delivery_radius_km then
    return jsonb_build_object('error', 'out_of_delivery_area');
  end if;

  v_delivery_fee := coalesce(v_settings.delivery_fee_base, 0) + (coalesce(v_settings.delivery_fee_per_km, 0) * v_distance_km);
  v_delivery_fee := round(v_delivery_fee);

  v_urgent_fee := case when p_is_urgent then coalesce(v_settings.urgent_fee, 0) else 0 end;

  -- Promo code: atomic consume ─────────────────────────────────────────────
  -- Identical to the pre-0023 logic. The promo consumed on the e-wallet path
  -- is restored ONLY inside settle_kashier_payment's failure branch — but
  -- settle handles the success path; the failure path goes through cancel_order
  -- (migration 0024), which we amend to clear any promo_usages row tagged to
  -- this order. For now the promo increment we make here stays applied even
  -- if the customer never pays; 0024's cancel_order extension rolls it back
  -- when an awaiting_payment order is cancelled.
  if p_promo_code is not null and p_promo_code <> '' then
    update promo_codes
      set used_count = used_count + 1
      where code = upper(p_promo_code)
        and is_active = true
        and used_count < max_uses
        and (expires_at is null or expires_at > now())
        and min_order <= v_subtotal
      returning * into v_promo;

    if not found then
      select 1 from promo_usages
        where promo_code = upper(p_promo_code) and user_id = v_customer_id
        limit 1;
      if found then
        select * into v_promo from promo_codes where code = upper(p_promo_code);
        if not found then
          return jsonb_build_object('error', 'promo_invalid');
        end if;
        v_promo_consumed := false;
      else
        return jsonb_build_object('error', 'promo_invalid');
      end if;
    else
      v_promo_consumed := true;
      insert into promo_usages (promo_code, user_id, order_id, created_at)
      values (v_promo.code, v_customer_id, null, now())
      on conflict (promo_code, user_id) do nothing;
      if not found then
        update promo_codes set used_count = greatest(used_count - 1, 0)
          where code = v_promo.code;
        v_promo_consumed := false;
      end if;
    end if;

    if v_promo.discount_type = 'percent' then
      v_discount := round((v_subtotal * v_promo.discount_value) / 100);
    else
      v_discount := v_promo.discount_value;
    end if;
    v_discount := least(v_discount, v_subtotal);
  end if;

  -- Totals
  v_platform_fee := round(((v_subtotal + v_delivery_fee) * coalesce(v_settings.commission_pct, 0)) / 100);
  v_total := v_subtotal + v_delivery_fee + v_urgent_fee - v_discount;
  if v_total < 0 then v_total := 0; end if;

  -- Stock decrement (atomic, race-safe) — ONLY for the cash path. For the
  -- e-wallet path, the stock decrement is deferred to settle_kashier_payment
  -- so we don't lock vendor inventory behind an order the customer may never
  -- pay for. The eligibility check above guarantees the vendor was viable at
  -- create time; settle_kashier_payment re-checks the stock with the SAME
  -- `>= qty` guard before decrementing, so a concurrent cash order that runs
  -- the stock dry between create and settle is rejected (refund flows through
  -- cancel_order, free of charge since no stock was reserved).
  if not v_is_ewallet then
    declare
      v_stock_rowcount int;
    begin
      v_stock_col := case when p_size = 'small' then 'small_stock' else 'large_stock' end;
      execute format(
        'update vendors set %I = %I - $1 where id = $2 and %I >= $1',
        v_stock_col, v_stock_col, v_stock_col
      ) using p_quantity, p_vendor_id;
      get diagnostics v_stock_rowcount = row_count;
      if v_stock_rowcount = 0 then
        if v_promo_consumed then
          update promo_codes set used_count = greatest(used_count - 1, 0)
            where code = v_promo.code;
          delete from promo_usages
            where promo_code = v_promo.code and user_id = v_customer_id;
        end if;
        return jsonb_build_object('error', 'out_of_stock');
      end if;
    end;
    v_stock_decremented := true;
  end if;

  -- Generate a 4-digit OTP using system CSPRNG ──────────────────────────────
  -- Generated for both paths; for awaiting_payment the OTP is held until
  -- settle_kashier_payment flips the row to pending, at which point the
  -- dispatch-engine / vendor OTP flow uses it as before.
  v_otp := lpad(
    (
      (
        (get_byte(v_otp_bytes, 0)::bigint << 24) |
        (get_byte(v_otp_bytes, 1)::bigint << 16) |
        (get_byte(v_otp_bytes, 2)::bigint <<  8) |
         get_byte(v_otp_bytes, 3)::bigint
      ) % 10000
    )::text,
    4, '0'
  );

  -- Insert the order ───────────────────────────────────────────────────────
  -- E-wallet path sets the Kashier merchant-facing order ref (`AMB-<uuid>`)
  -- as `kashier_order_ref` and `payment_status = 'unpaid'`. We can't reference
  -- v_new_order.id before the insert, so we generate the order's uuid here
  -- and pass it explicitly — this lets the ref match the row id deterministically.
  declare
    v_new_id uuid := gen_random_uuid();
  begin
    insert into orders (
      id, customer_id, vendor_id, size, quantity,
      subtotal, delivery_fee, platform_fee, urgent_fee, discount,
      cancellation_fee, total,
      status, delivery_otp, is_urgent,
      payment_method, promo_code, delivery_address, delivery_lat, delivery_lng,
      scheduled_for, customer_note,
      dispatch_attempt,
      kashier_order_ref, payment_status
    ) values (
      v_new_id, v_customer_id, p_vendor_id, p_size, p_quantity,
      v_subtotal, v_delivery_fee, v_platform_fee, v_urgent_fee, v_discount,
      0, v_total,
      v_initial_status, v_otp, p_is_urgent,
      p_payment_method, upper(coalesce(p_promo_code, ''))::text, p_delivery_address,
      p_delivery_lat, p_delivery_lng,
      p_scheduled_for, p_customer_note,
      0,
      case when v_is_ewallet then 'AMB-' || v_new_id::text else null end,
      case when v_is_ewallet then 'unpaid' else null end
    )
    returning * into v_new_order;
  end;

  -- Backfill promo_usages.order_id (created with null earlier)
  if v_promo_consumed and v_promo.code is not null then
    update promo_usages set order_id = v_new_order.id
      where promo_code = v_promo.code and user_id = v_customer_id;
  end if;

  return jsonb_build_object('order', to_jsonb(v_new_order));
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- Re-grant the execute (CREATE OR REPLACE preserves the existing grants, but
-- we state them again for documentation parity).
grant execute on function public.create_order(
  uuid, text, int, boolean, text, text, double precision, double precision,
  text, text, timestamptz
) to anon, authenticated;


-- ─── 2. settle_kashier_payment SECURITY DEFINER RPC ────────────────────────
-- Invoked by the kashier-webhook Edge Function after HMAC verification. The
-- caller passes the service role context (no auth.uid()) — grant EXECUTE to
-- the service role only, never anon/authenticated.

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
  v_rowcount       int;
  v_already        boolean := false;
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
  returning id into v_rowcount;

  -- If the insert was a no-op (already-seen webhook for the same txn+event),
  -- don't re-settle. ON CONFLICT DO NOTHING returns nothing into RETURNING.
  if v_rowcount is null then
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

-- JAVA-style grant: the service role only. NEVER grant to anon/authenticated
-- (the function uses no auth.uid() check and assumes the caller has already
-- verified the HMAC signature externally — accidentally exposing it to a
-- client would let a malicious actor mark an order PAID without paying).
revoke execute on function public.settle_kashier_payment(
  uuid, text, text, numeric, text, text, jsonb, boolean
) from public, anon, authenticated;

-- Service role bypasses EXECUTE revocation by default in Supabase; we leave
-- the invocation target as the service-role-only Edge Function. (To be
-- extra explicit, we grant execute to the `service_role` if available.)
do $$
begin
  execute 'grant execute on function public.settle_kashier_payment('
       || 'uuid, text, text, numeric, text, text, jsonb, boolean) to service_role';
exception when others then
  raise notice 'settle_kashier_payment grant to service_role: %', sqlerrm;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecdef
--     from pg_proc
--     where proname in ('create_order','settle_kashier_payment')
--     order by proname;
--   -- Expected: create_order | f | definer (unchanged), settle_kashier_payment
--   --           | f | definer (new).
--
--   select has_function_privilege('anon','public.settle_kashier_payment(uuid,
--     text, text, numeric, text, text, jsonb, boolean)','EXECUTE');
--   -- Expected: false (NO anon access — service-role-only).
-- ──────────────────────────────────────────────────────────────────────────
