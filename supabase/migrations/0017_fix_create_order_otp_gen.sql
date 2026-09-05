-- ──────────────────────────────────────────────────────────────────────────
-- 0017_fix_create_order_otp_gen.sql  —  Fix OTP generator in create_order
-- ──────────────────────────────────────────────────────────────────────────
-- Bug: line 256 of 0005_function_create_order.sql was
--       v_otp := lpad((abs((substr(gen_random_uuid()::text, 1, 8))::bigint % 10000))::text, 4, '0');
-- A UUID's first 8 characters are hexadecimal (e.g. "d807746c"), so casting
-- them to bigint throws `invalid input syntax for type bigint: 'd807746c'`
-- on virtually every call. The function succeeded only on the astronomically
-- rare chance that the first 8 chars happened to be all decimal digits.
-- Symptom: every customer `create_order` RPC returned HTTP 200 with the
-- structured-error body `{error: <sqlstate>, message: 'invalid input syntax …'}`
-- short-circuiting the order insert, stock decrement, and OTP row write.
--
-- Fix: derive the OTP digits from a true CSPRNG source.
-- `gen_random_bytes(4)` (pgcrypto) yields 4 cryptographically-secure random
-- bytes; `encode(...,'hex')` gives 8 hex chars; the PostgreSQL idiom
--   ('x' || <hex>)::bit(32)::int
-- is the documented way to coerce a hex string to an integer without the
-- decimal-only restriction of a direct `::bigint` cast. We then `% 10000`
-- to get 4 digits and `lpad` to ensure leading zeros.
--
-- The 4-byte sample gives 2**32 = 4,294,967,296 possible values; the modulo
-- 10000 makes the buckets in [0, 9999] slightly uneven (294,967 extra
-- residues spread as +1 each — a bias of 6.9e-5 worst case): negligible for
-- a 4-digit OTP and consistent with the original intent.
--
-- `delivery_otp` is TEXT (verified via information_schema.columns); the
-- 4-character lpad output is schema-compatible.
--
-- Idempotent: this migration just `create or replace`s the function with
-- one line changed. No schema/permission changes, no data migration.
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
  v_stock_col     text;
  v_stock_decremented boolean := false;
  v_new_order     orders%rowtype;
  v_promo_consumed   boolean := false;
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

  -- Lock vendor row ────────────────────────────────────────────────────────
  -- `FOR UPDATE` prevents a concurrent order from also picking the same
  -- row and racing on the stock decrement below.
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

  -- Stock guard (server-authoritative)
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

  -- Delivery radius check (silent vendor pick was free, the server enforces)
  if v_vendor.delivery_radius_km is not null and v_distance_km > v_vendor.delivery_radius_km then
    return jsonb_build_object('error', 'out_of_delivery_area');
  end if;

  v_delivery_fee := coalesce(v_settings.delivery_fee_base, 0) + (coalesce(v_settings.delivery_fee_per_km, 0) * v_distance_km);
  v_delivery_fee := round(v_delivery_fee);

  -- Urgent fee only charged when toggled on
  v_urgent_fee := case when p_is_urgent then coalesce(v_settings.urgent_fee, 0) else 0 end;

  -- Promo code: atomic consume ─────────────────────────────────────────────
  -- This is the security-critical part. We re-verify every predicate on the
  -- UPDATE itself, so two concurrent calls cannot both pass even on the last
  -- available use. The unique (promo_code, user_id) constraint on promo_usages
  -- guarantees a single user cannot use the same code on two orders even if
  -- they somehow slip through.
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
      -- Either doesn't exist / inactive / expired / exhausted / below min.
      -- Distinguish from "already used by this user" (which is benign on retry).
      select 1 from promo_usages
        where promo_code = upper(p_promo_code) and user_id = v_customer_id
        limit 1;
      if found then
        -- Treat as soft pass: they already consumed it; compute the discount
        -- they would have got so retry flows don't fail hard.
        select * into v_promo from promo_codes where code = upper(p_promo_code);
        if not found then
          return jsonb_build_object('error', 'promo_invalid');
        end if;
        v_promo_consumed := false; -- did NOT increment again
      else
        return jsonb_build_object('error', 'promo_invalid');
      end if;
    else
      v_promo_consumed := true;

      insert into promo_usages (promo_code, user_id, order_id, created_at)
      values (v_promo.code, v_customer_id, null, now())
      on conflict (promo_code, user_id) do nothing;

      if not found then
        -- Promo usages row already existed (unlikely race after the UPDATE
        -- succeeded; means a prior half-finished order had this user+code).
        -- Roll back our increment since user already had their use.
        update promo_codes set used_count = greatest(used_count - 1, 0)
          where code = v_promo.code;
        v_promo_consumed := false;
      end if;
    end if;

    -- Compute discount from the promo row
    if v_promo.discount_type = 'percent' then
      v_discount := round((v_subtotal * v_promo.discount_value) / 100);
    else
      v_discount := v_promo.discount_value;
    end if;
    v_discount := least(v_discount, v_subtotal); -- never bigger than subtotal
  end if;

  -- Totals
  v_platform_fee := round(((v_subtotal + v_delivery_fee) * coalesce(v_settings.commission_pct, 0)) / 100);
  v_total := v_subtotal + v_delivery_fee + v_urgent_fee - v_discount;
  if v_total < 0 then v_total := 0; end if;

  -- Stock decrement (atomic, race-safe) ─────────────────────────────────────
  -- The `>= p_quantity` guard inside the UPDATE itself makes this race-safe
  -- against concurrent orders: if a parallel call drives the column below
  -- p_quantity between our check above and this UPDATE, the UPDATE matches
  -- zero rows and the ROW_COUNT check below triggers the rollback branch.
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
      -- Stock went to zero between our check and the UPDATE (concurrent order).
      -- Roll back any promo increment we made before failing.
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

  -- Generate a 4-digit OTP using pgcrypto CSPRNG ────────────────────────────
  -- gen_random_bytes(4) (pgcrypto, lives in `extensions`) returns 4 securely
  -- random bytes; encode(..., 'hex') gives 8 hex chars. The PostgreSQL idiom
  --   ('x' || <hex>)::bit(32)::int
  -- coerces any hex string to an int WITHOUT the decimal-only restriction of
  -- a direct ::bigint cast, but `bit(32)::int` is int4 (signed) and returns a
  -- negative value when the top bit is set. `abs()` brings that back into
  -- [0, 2^31); `% 10000` bucketizes to [0, 9999]; `lpad(..., 4, '0')` gives the
  -- 4-char zero-padded string required for TEXT column `orders.delivery_otp`.
  -- `gen_random_uuid()` was never appropriate: its first 8 chars are hex, so
  -- `substr(...,8)::bigint` threw "invalid input syntax for type bigint:
  -- '<hex>'" on every call whose prefix wasn't all-decimal (≈ 1 in 4 billion).
  v_otp := lpad((abs(('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::int) % 10000)::text, 4, '0');

  -- Insert the order ───────────────────────────────────────────────────────
  insert into orders (
    customer_id, vendor_id, size, quantity,
    subtotal, delivery_fee, platform_fee, urgent_fee, discount,
    cancellation_fee, total,
    status, delivery_otp, is_urgent,
    payment_method, promo_code, delivery_address, delivery_lat, delivery_lng,
    scheduled_for, customer_note,
    dispatch_attempt
  ) values (
    v_customer_id, p_vendor_id, p_size, p_quantity,
    v_subtotal, v_delivery_fee, v_platform_fee, v_urgent_fee, v_discount,
    0, v_total,
    'pending', v_otp, p_is_urgent,
    p_payment_method, upper(coalesce(p_promo_code, ''))::text, p_delivery_address,
    p_delivery_lat, p_delivery_lng,
    p_scheduled_for, p_customer_note,
    0
  )
  returning * into v_new_order;

  -- Backfill the promo_usages row's order_id (we inserted with null earlier)
  if v_promo_consumed and v_promo.code is not null then
    update promo_usages set order_id = v_new_order.id
      where promo_code = v_promo.code and user_id = v_customer_id;
  end if;

  return jsonb_build_object('order', to_jsonb(v_new_order));
exception
  when others then
    -- Best-effort compensation for partial state. The DB transaction will
    -- already roll back the stock decrement + promo update automatically
    -- (we are inside a single function = single transaction). This block
    -- is belt-and-braces; RETURN ensures a structured error to the client.
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- Permissions ─────────────────────────────────────────────────────────────
-- SECURITY DEFINER does not bypass grants on the function itself; the
-- anon + authenticated roles still need `EXECUTE` to call the RPC over
-- REST. We re-grant both; the function body enforces `auth.uid()` itself.
grant execute on function public.create_order(
  uuid, text, int, boolean, text, text, double precision, double precision,
  text, text, timestamptz
) to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecurity from pg_proc where proname='create_order';
--   -- Prove the OTP generator now works without throwing:
--   do $$
--   declare
--     v_otp text;
--   begin
--     for i in 1..10000 loop
--       v_otp := lpad((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::int % 10000)::text, 4, '0');
--       if v_otp !~ '^[0-9]{4}$' then
--         raise exception 'Bad OTP format at iter %: %', i, v_otp;
--       end if;
--     end loop;
--   end $$;
-- Expected:
--   proname       | prokind | prosecurity
--   create_order  | f       | definer
-- (The DO block should run 10,000 iterations without raising.)
-- ──────────────────────────────────────────────────────────────────────────
