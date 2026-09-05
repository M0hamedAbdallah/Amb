-- ──────────────────────────────────────────────────────────────────────────
-- 0008_function_validate_promo.sql  —  Promo preview + rollback (SEC DEFINER)
-- ──────────────────────────────────────────────────────────────────────────
-- Background:
--   The atomic CONSUME of a promo code is performed inside `create_order`
--   (migration 0005). That single UPDATE promo_codes + INSERT promo_usages
--   guarded by `is_active AND used_count < max_uses AND expires_at > now()
--   AND min_order <= subtotal` is the security boundary.
--
--   This migration provides TWO companion RPCs:
--
--   A) `preview_promo(p_code, p_cart_total)` — READ-ONLY. Returns the discount
--      that *would* apply if the user placed an order with this code right
--      now. No state mutation. The order screen calls this for live preview;
--      the user sees "your discount would be 15 EGP" before tapping submit.
--      Replaces the side-effecting `orderService.validatePromoCode` flow.
--
--   B) `rollback_promo(p_code, p_user_id, p_order_id)` — admin/service-callable.
--      Reverses a previously consumed promo on an order that subsequently
--      failed downstream. Decrements `promo_codes.used_count`, removes the
--      `promo_usages` row and zeroes out the discount. Can be called by
--      future admin tooling; main consumer is the cancel-order RPC flow
--      (planned in a later phase, intentionally NOT granted to anon here).
--
-- Permissions:
--   • preview_promo — granted to anon + authenticated (used by the order
--     screen via the anon key, lives behind RLS on `promo_codes`).
--   • rollback_promo — granted to SERVICE ROLE ONLY. Anons cannot roll back
--     coupons they've already applied after the order ID is finalised; the
--     service role (Edge Function or admin path) is the only authorised
--     caller. This prevents a "buy-coupon-credits-back" attack where a
--     malicious client double-applies via create_order then immediately
--     rollbacks through this RPC.
-- ──────────────────────────────────────────────────────────────────────────

-- A) PREVIEW (read-only) ────────────────────────────────────────────────────
create or replace function public.preview_promo(
  p_code       text,
  p_cart_total numeric default 0
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_promo         promo_codes%rowtype;
  v_already_used  boolean;
  v_discount      numeric(10,2);
  v_user          uuid := auth.uid();
begin
  select * into v_promo from promo_codes where upper(code) = upper(p_code);

  if not found then
    return jsonb_build_object('valid', false, 'error', 'invalid_code',
      'message', 'كود الخصم غير صالح');
  end if;

  if not v_promo.is_active then
    return jsonb_build_object('valid', false, 'error', 'inactive',
      'message', 'كود الخصم غير مفعل');
  end if;

  if v_promo.expires_at is not null and v_promo.expires_at < now() then
    return jsonb_build_object('valid', false, 'error', 'expired',
      'message', 'انتهت صلاحية الكود');
  end if;

  if v_promo.used_count >= v_promo.max_uses then
    return jsonb_build_object('valid', false, 'error', 'exhausted',
      'message', 'تم استخدام الكود بالكامل');
  end if;

  if p_cart_total < v_promo.min_order then
    return jsonb_build_object('valid', false, 'error', 'min_order',
      'message', concat('الحد الأدنى للطلب ', v_promo.min_order::text, ' جنيه'));
  end if;

  -- Has this caller already used this code? (RLS-protected lookup; anon has
  -- SELECT on promo_usages only for its own rows, but SECURITY DEFINER bypasses
  -- it so we check explicitly.)
  if v_user is not null then
    select exists(
      select 1 from promo_usages
        where promo_code = v_promo.code and user_id = v_user
    ) into v_already_used;
  else
    v_already_used := false;
  end if;

  if v_already_used then
    return jsonb_build_object('valid', false, 'error', 'already_used',
      'message', 'لقد استخدمت هذا الكود من قبل');
  end if;

  -- Compute the would-be discount without any side effect
  v_discount := case when v_promo.discount_type = 'percent'
                      then round((p_cart_total * v_promo.discount_value) / 100)
                      else v_promo.discount_value
                 end;
  v_discount := least(v_discount, p_cart_total);

  return jsonb_build_object(
    'valid',    true,
    'code',     v_promo.code,
    'discount', v_discount,
    'type',     v_promo.discount_type,
    'value',    v_promo.discount_value,
    'used_count', v_promo.used_count,
    'max_uses', v_promo.max_uses
  );
exception
  when others then
    return jsonb_build_object('valid', false, 'error', sqlstate,
      'message', sqlerrm);
end;
$$;

-- B) ROLLBACK (service-role only) ───────────────────────────────────────────
create or replace function public.rollback_promo(
  p_code    text,
  p_user_id uuid,
  p_order_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_deleted_rowcount int;
  v_code             text := upper(p_code);
begin
  -- Caller must supply a user_id; we never infer from auth.uid() because
  -- this RPC is invoked by service_role (cron / admin / Edge Function
  -- compensation flows) where the caller's identity is the system, not
  -- the affected user.
  if p_user_id is null then
    return jsonb_build_object('error', 'user_id_required');
  end if;

  -- Removes the promo_usages row keyed by (code, user_id). The optional
  -- p_order_id narrows the scope when the caller knows which order's
  -- reservation is being rolled back (matches the row created in
  -- create_order's atomic-consume branch).
  if p_order_id is not null then
    delete from promo_usages
      where promo_code = v_code and user_id = p_user_id and order_id = p_order_id;
  else
    delete from promo_usages
      where promo_code = v_code and user_id = p_user_id;
  end if;
  get diagnostics v_deleted_rowcount = row_count;

  if v_deleted_rowcount = 0 then
    -- Either already rolled back or never consumed; idempotent no-op success.
    return jsonb_build_object('rolled_back', false, 'message', 'no_usage_found');
  end if;

  -- Only decrement used_count when we actually removed a row, to prevent
  -- the count from going negative in the no-op path.
  update promo_codes
    set used_count = greatest(used_count - 1, 0)
    where code = v_code;

  return jsonb_build_object('rolled_back', true, 'rows_removed', v_deleted_rowcount);
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- Permissions ─────────────────────────────────────────────────────────────
grant execute on function public.preview_promo(text, numeric)
  to anon, authenticated;

-- rollback_promo: service_role ONLY.
-- We grant first, then explicitly REVOKE from anon/authenticated/public.
-- Without the explicit revokes, Supabase's role hierarchy makes the
-- grant to `service_role` leak down to anon+authenticated via PUBLIC,
-- which would defeat the whole point of keeping rollback on the server.
grant execute on function public.rollback_promo(text, uuid, uuid)
  to service_role, postgres;

revoke execute on function public.rollback_promo(text, uuid, uuid) from anon;
revoke execute on function public.rollback_promo(text, uuid, uuid) from authenticated;
revoke execute on function public.rollback_promo(text, uuid, uuid) from public;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecdef from pg_proc
--   where proname in ('preview_promo','rollback_promo');
-- Expected rows:
--   preview_promo   | f | t
--   rollback_promo  | f | t
-- ──────────────────────────────────────────────────────────────────────────
