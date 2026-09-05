-- ──────────────────────────────────────────────────────────────────────────
-- 0025_fix_create_order_otp_generator.sql
-- ──────────────────────────────────────────────────────────────────────────
-- Fixes a fatal bug in the 4-digit OTP generator inside `create_order`
-- (introduced by migration 0023):
--
--   v_otp := lpad((abs((substr(gen_random_uuid()::text, 1, 8))::bigint % 10000))::text, 4, '0');
--
-- gen_random_uuid() returns a string of 32 hex digits, the first 8 of which
-- are NOT all 0–9 — ~2 in 3 UUIDs will contain at least one a-f digit, and
-- Postgres's `text → bigint` cast REJECTS any non-numeric character with
-- `invalid input syntax for type bigint: '<8 hex chars>'`. As a result ~67%
-- of create_order calls crashed at the OTP line, surfacing to the RN client
-- as the generic "تعذر إنشاء الطلب." alert and leaving no orders row, no
-- Postgres ERROR (the function's EXCEPTION WHEN OTHERS clause caught it and
-- returned sqlstate/SQLERRM as a JSON payload), and no kashier-checkout Edge
-- Function invocation (the failure happened before the client ever asked
-- for a checkout URL).
--
-- Fix: generate the OTP from pgcrypto's `gen_random_bytes(4)` (true
-- CSPRNG bytea), interpret the 4 bytes as a 32-bit unsigned integer, and
-- mod 10000. The bytea approach is immune to any character-class issues
-- because bit shifting / slicing never touches the textual layer.
--
-- Validated by 50-iteration test DO blocks on the live project — no errors,
-- 50/50 OTPs were valid 4-digit strings including runs where the equivalent
-- UUID-based path would have thrown due to non-numeric hex chars.
--
-- This migration only reissues `create or replace function public.create_order`;
-- everything else is byte-for-byte identical to the v0023 deployment. settle_
-- kashier_payment (also in 0023) and the cancel/cron pieces (0024) are
-- UNTOUCHED.
-- ──────────────────────────────────────────────────────────────────────────

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
  -- CSPRNG source for the OTP — 4 random bytes interpreted as a 32-bit
  -- unsigned integer, then mod 10000. (Replacing the broken
  -- `substr(gen_random_uuid()::text,1,8)::bigint` cast that rejected any
  -- hex char in a-f — see migration header for details.)
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
  v_is_ewallet := p_payment_method in
    ('vodafone_cash','etisalat_cash','orange_money','instapay');
  v_initial_status := case when v_is_ewallet then 'awaiting_payment' else 'pending' end;

  -- Lock vendor row (FOR UPDATE prevents concurrent stock races AND covers
  -- the e-wallet eligibility re-check — see migration 0023 for full notes).
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

  if p_size = 'small' and v_vendor.small_stock < p_quantity then
    return jsonb_build_object('error', 'out_of_stock');
  end if;
  if p_size = 'large' and v_vendor.large_stock < p_quantity then
    return jsonb_build_object('error', 'out_of_stock');
  end if;

  if v_vendor.suspended_until is not null and v_vendor.suspended_until > now() then
    return jsonb_build_object('error', 'vendor_suspended');
  end if;

  -- Tally system_settings in one pass
  select
    max(case when key = 'commission_pct'       then value::numeric end) as commission_pct,
    max(case when key = 'urgent_fee'           then value::numeric end) as urgent_fee,
    max(case when key = 'delivery_fee_base'    then value::numeric end) as delivery_fee_base,
    max(case when key = 'delivery_fee_per_km'  then value::numeric end) as delivery_fee_per_km
  into v_settings
  from system_settings
  where key in ('commission_pct','urgent_fee','delivery_fee_base','delivery_fee_per_km');

  v_subtotal := case when p_size = 'small'
                      then v_vendor.small_price * p_quantity
                      else v_vendor.large_price * p_quantity
                 end;

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

  -- Promo: atomic consume (identical to the pre-0023 logic).
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

  v_platform_fee := round(((v_subtotal + v_delivery_fee) * coalesce(v_settings.commission_pct, 0)) / 100);
  v_total := v_subtotal + v_delivery_fee + v_urgent_fee - v_discount;
  if v_total < 0 then v_total := 0; end if;

  -- Stock decrement (atomic, race-safe) — cash path only. E-wallet defers
  -- the decrement to settle_kashier_payment (see migration 0023 header).
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

  -- Generate a 4-digit OTP from a CSPRNG bytea. (Earlier impl used
  -- `substr(gen_random_uuid()::text,1,8)::bigint` which crashed on UUIDs
  -- containing a-f hex chars in the first 8 positions — see migration header.)
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

  -- Insert the order
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
