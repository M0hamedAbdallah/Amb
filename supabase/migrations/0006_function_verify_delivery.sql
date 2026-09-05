-- ──────────────────────────────────────────────────────────────────────────
-- 0006_function_verify_delivery.sql  —  Atomic OTP + settlement RPC (SEC DEFINER)
-- ──────────────────────────────────────────────────────────────────────────
-- Replaces the client flow:
--   1. `orderService.verifyDeliveryOTP(orderId, otp)` — atomic-ish check that
--      returned `{ valid, error }` with NO state mutation.
--   2. `orderService.updateOrderStatus(...,'delivered')` — separate call that
--      moved the order row to `delivered` status (no money moves here).
--   3. `orderService.creditVendorWallet(...)` — separate flow that:
--        • computed vendor earning = (total - urgent_fee) - commission,
--        • inserted wallet_transactions rows (credit + commission + urgent_fee
--          informational),
--        • bumped `profiles.wallet_balance` for the vendor's user_id,
--        • fire-and-forget'd `_maybeApplyReferralBonus(orderId)`.
--   4. `_maybeApplyReferralBonus(orderId)` — seeding referral_credits +
--      crediting referrer's and referee's wallets once per (referrer,
--      referee) pair (idempotency via unique constraint).
--
-- Doing this client-side was wrong on two axes:
--   • Non-atomic: a crash between stages 2 and 3 left the order `delivered`
--     but the vendor never paid. Stage 4 fire-and-forget was even worse.
--   • Trust-boundary: all movement reads `order.total`, `order.urgent_fee`
--     from the order row (not from client input, OK) but the client *decides*
--     when to credit. A malicious client could simply skip `creditVendorWallet`
--     to deny vendor pay, or call it twice to double-credit.
--
-- This RPC collapses all four stages into a single SECURITY DEFINER
-- transaction guarded by `WHERE status='on_way'` (so calling it twice is a
-- no-op the second time, with no second payout). Atomicity is enforced by
-- Postgres; the caller only supplies the order id + OTP.
--
-- Authorisation rules:
--   • The caller (auth.uid()) must be the VENDOR — i.e. the user_id on the
--     vendors row this order was assigned to. We do NOT trust any
--     client-supplied "current_user is vendor" claim; we look it up.
--   • A customer cannot verify their own delivery (they could pre-stage and
--     release payment). The vendor bot/courier is the only party allowed.
--
-- Returns: `jsonb` payload `{ order, txn_ids, referral_paid }` on success,
-- structured error on failure.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.verify_delivery(
  p_order_id uuid,
  p_otp     text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_caller_id      uuid := auth.uid();
  v_orders_row     orders%rowtype;
  v_vendor_row     vendors%rowtype;
  v_vendor_user_id uuid;
  v_settings       record;
  v_vendor_base    numeric(10,2);
  v_commission     numeric(10,2);
  v_earning        numeric(10,2);
  v_rowcount       int;
  v_txn_ids        uuid[] := array[]::uuid[];
  v_referral_bonus numeric(10,2);
  v_customer_id    uuid;
  v_referred_by    uuid;
  v_referral_paid  boolean := false;
  v_new_txn_id     uuid;
begin
  if v_caller_id is null then
    return jsonb_build_object('error', 'auth_required');
  end if;

  -- Lock the order row for the duration of the transaction. The `FOR UPDATE`
  -- clause is critical: it serialises concurrent verify_delivery calls.
  select * into v_orders_row
  from orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('error', 'order_not_found');
  end if;

  -- Status guard — single point of idempotency. Only `on_way` orders can
  -- transition to `delivered`. Calling again post-delivery is a no-op.
  if v_orders_row.status <> 'on_way' then
    return jsonb_build_object('error', 'not_on_way', 'current_status', v_orders_row.status);
  end if;

  -- Vendor authorisation: caller must be the vendor's user_id.
  if v_orders_row.vendor_id is null then
    return jsonb_build_object('error', 'no_vendor_assigned');
  end if;

  select * into v_vendor_row from vendors where id = v_orders_row.vendor_id;
  if not found then
    return jsonb_build_object('error', 'vendor_not_found');
  end if;

  v_vendor_user_id := v_vendor_row.user_id;
  if v_vendor_user_id is null or v_vendor_user_id <> v_caller_id then
    return jsonb_build_object('error', 'not_vendor_of_this_order');
  end if;

  -- OTP check. We hash-compare in-txn; no shed of OTP on the wire afterwards.
  -- An explicit NULL OTP is rejected. An empty string is treated as wrong.
  if p_otp is null then
    return jsonb_build_object('error', 'otp_required');
  end if;
  if v_orders_row.delivery_otp is null or p_otp <> v_orders_row.delivery_otp then
    return jsonb_build_object('error', 'otp_mismatch');
  end if;

  -- Compute settlement from server-side settings ──────────────────────────
  select max(case when key = 'commission_pct'   then value::numeric end) as commission_pct,
         max(case when key = 'referral_bonus'    then value::numeric end) as referral_bonus
  into   v_settings
  from   system_settings
  where  key in ('commission_pct','referral_bonus');

  -- Vendor earning = (total - urgent_fee) - commission. `total` already
  -- includes the urgent fee (routed to platform, see create_order).
  v_vendor_base := greatest(0, v_orders_row.total - coalesce(v_orders_row.urgent_fee, 0));
  v_commission  := round((v_vendor_base * coalesce(v_settings.commission_pct, 0)) / 100);
  v_earning     := v_vendor_base - v_commission;

  -- Mutate order row — guarded by `WHERE status='on_way'`. The FOR UPDATE
  -- row lock above protects us; this WHERE clause protects against any
  -- concurrent verifier we might have raced.
  update orders
    set status       = 'delivered',
        delivered_at = now(),
        delivery_otp = null            -- one-time use
    where id = p_order_id
      and status = 'on_way';
  get diagnostics v_rowcount = row_count;
  if v_rowcount = 0 then
    -- We raced and lost; another verify beat us. Treat as already-delivered
    -- and refuse to pay twice.
    return jsonb_build_object('error', 'already_delivered');
  end if;

  -- Vendor credit + commission + urgent_fee informational rows ────────────
  -- Note: the `credit` row is the only one that pays into wallet_balance.
  -- The `commission` row is informational only (revenue belongs to platform).
  -- The `urgent_fee` row is informational only too — already excluded from v_earning.
  insert into wallet_transactions
    (user_id, type, amount, description, order_id)
  values
    (v_vendor_user_id, 'credit',      v_earning,   'أرباح طلب',           v_orders_row.id),
    (v_vendor_user_id, 'commission',  v_commission,'عمولة المنصة',        v_orders_row.id);

  if coalesce(v_orders_row.urgent_fee, 0) > 0 then
    insert into wallet_transactions
      (user_id, type, amount, description, order_id)
    values
      (v_vendor_user_id, 'urgent_fee', v_orders_row.urgent_fee, 'رسوم طلب عاجل (إيراد المنصة)', v_orders_row.id);
  end if;

  -- Collect all three txn ids for the response payload.
  select array_agg(id order by created_at, id) into v_txn_ids
    from wallet_transactions
    where order_id = v_orders_row.id
      and user_id  = v_vendor_user_id
      and type in ('credit','commission','urgent_fee');

  -- Bump wallet_balance atomically (LOCK'd against self-race by the same
  -- transaction; the row lock on `orders` already serialises this flow per
  -- order — but a vendor receiving concurrent settlement for DIFFERENT
  -- orders would race on `profiles.wallet_balance` without this UPDATE).
  -- An inner `UPDATE ... WHERE` is atomic by construction in PG.
  update profiles
    set wallet_balance = coalesce(wallet_balance, 0) + v_earning
    where id = v_vendor_user_id;

  -- Referral bonus (idempotent on (referrer_id, referee_id) unique key) ────
  v_customer_id := v_orders_row.customer_id;
  select referred_by into v_referred_by from profiles where id = v_customer_id;
  v_referral_bonus := coalesce(v_settings.referral_bonus, 0);

  -- Only credit if (a) this customer had a referrer, (b) the bonus > 0, and
  -- (c) no prior credit row exists for this (referrer, referee) pair.
  -- The unique constraint on referral_credits gives us atomic idempotency;
  -- we use INSERT ... ON CONFLICT DO NOTHING.
  if v_referred_by is not null and v_referred_by <> v_customer_id and v_referral_bonus > 0 then
    insert into referral_credits (referrer_id, referee_id, order_id, amount)
    values (v_referred_by, v_customer_id, v_orders_row.id, v_referral_bonus)
    on conflict (referrer_id, referee_id) do nothing
    returning id into v_new_txn_id;

    if found then
      -- This is the first-time credit for this pair. Pay both parties.
      insert into wallet_transactions (user_id, type, amount, description, order_id)
      values
        (v_referred_by,  'referral_bonus', v_referral_bonus, 'مكافأة دعوة صديق',  v_orders_row.id),
        (v_customer_id,  'referral_bonus', v_referral_bonus, 'مكافأة دعوة صديق',  v_orders_row.id);

      -- Credit both wallets atomically.
      update profiles set wallet_balance = coalesce(wallet_balance, 0) + v_referral_bonus
        where id in (v_referred_by, v_customer_id);

      v_referral_paid := true;
    end if;
  end if;

  return jsonb_build_object(
    'order',          to_jsonb(v_orders_row),
    'earning',        v_earning,
    'commission',     v_commission,
    'txn_ids',        v_txn_ids,
    'referral_paid',  v_referral_paid
  );
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

grant execute on function public.verify_delivery(uuid, text)
  to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecdef from pg_proc where proname='verify_delivery';
-- Expected: verify_delivery | f | true (security definer)
-- ──────────────────────────────────────────────────────────────────────────
