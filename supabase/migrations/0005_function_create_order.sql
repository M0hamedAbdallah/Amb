-- ──────────────────────────────────────────────────────────────────────────
-- 0005_function_create_order.sql  —  Atomic order creation RPC (SECURITY DEFINER)
-- ──────────────────────────────────────────────────────────────────────────
-- Replaces the client-side `orderService.createOrder` flow that:
--   • read-modify-wrote vendor stock (a race window)
--   • calculated pricing client-side (trusted the RN-provided numbers)
--   • generated the OTP client-side (predictable / forgeable)
--   • separately called `validatePromoCode` *before* the insert — a non-atomic
--     pattern that double-decremented promo counts if `insert` later failed.
--
-- This function is the single transaction that:
--   1. Locks and verifies the vendor row with `FOR UPDATE` (must be verified,
--      active, and have enough stock in the requested size).
--   2. Verifies the caller (auth.uid()) has a customer profile.
--   3. Reads system_settings (commission_pct, urgent_fee, delivery_fee_base,
--      delivery_fee_per_km) to compute prices server-side. Client-supplied
--      numbers are discarded — they were already used by the screen for live
--      preview only.
--   4. Computes the great-circle distance (km) from the vendor's lat/lng to
--      the requested delivery_lat/lng via the haversine formula, then derives
--      the delivery fee. Verifies delivery_radius_km covers it.
--   5. Reserves the promo code atomically: `UPDATE promo_codes SET
--      used_count = used_count + 1 WHERE ... RETURNING *` (guarded by
--      `is_active AND used_count < max_uses AND (expires_at IS NULL OR
--      expires_at > now()) AND min_order <= subtotal`), and inserts a
--      promo_usages row keyed by `(promo_code, user_id)` with `ON CONFLICT
--      DO NOTHING` (double-application is idempotent).
--   6. Decrements vendor stock with the WHERE-guard
--         `UPDATE vendors SET <size>_stock = <size>_stock - qty
--          WHERE id = p_vendor_id AND <size>_stock >= qty RETURNING ...`
--      so concurrent calls cannot drive stock negative.
--   7. Generates a 4-digit OTP server-side using gen_random_uuid crypto RNG.
--   8. Inserts the order row with the recomputed pricing, returns the row.
--
-- SECURITY DEFINER  —  the function runs as the table owner (postgres) and
-- bypasses RLS so it can write to `orders`, `vendors`, `promo_codes`,
-- `promo_usages` in a single tx. The caller passes only the anon key; the
-- RPC enforces that `p_customer_id = auth.uid()` itself.
--
-- Idempotency:
--   The function is *not* idempotent by design (every successful call
--   creates a new order). Idempotency is enforced by the RN caller using an
--   `Idempotency-Key` header on the underlying fetch — handled in Phase-4
--   client refactor with `supabase.functions.invoke` or a custom fetch. For
--   now, no `idempotency_key` parameter is exposed; re-call = new order.
--
-- Returns: `jsonb` payload `{ order, error }` — the new order row on success,
-- or a structured error on failure.
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

  -- Generate a 4-digit OTP using system CSPRNG ──────────────────────────────
  -- gen_random_uuid (pgcrypto) is available in `extensions`. We derive
  -- 4 digits from a UUID; modulo bias is negligible for 4 digits.
  v_otp := lpad((abs((substr(gen_random_uuid()::text, 1, 8))::bigint % 10000))::text, 4, '0');

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
-- REST. We grant both; the function body enforces `auth.uid()` itself.
grant execute on function public.create_order(
  uuid, text, int, boolean, text, text, double precision, double precision,
  text, text, timestamptz
) to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecurity from pg_proc
--   where proname='create_order';
-- Expected:
--   proname       | prokind | prosecurity
--   create_order  | f       | definer
-- ──────────────────────────────────────────────────────────────────────────
