-- ──────────────────────────────────────────────────────────────────────────
-- 0030_edge_triggers_service_key.sql — AMB-SEC-002 remediation (part 1/2)
-- ──────────────────────────────────────────────────────────────────────────
-- Finding (2026-08-22 audit): every pg_net caller of the Edge Functions
-- (dispatch_engine_step, notify_status_change, cancel_order,
-- vendor_reject_order) authenticated with the PUBLIC anon key — so the
-- dispatch-engine endpoint could not distinguish trigger traffic from
-- arbitrary internet callers and had to accept the anon key.
--
-- Fix: these four functions now read the service credential from Supabase
-- Vault (secret name: amb_edge_service_key) and send it as both `apikey`
-- and `Authorization: Bearer`. The dispatch-engine handler then REQUIRES it
-- (index.ts patch + redeploy, part 2/2).
--
-- REQUIRED MANUAL STEP (secret material must never live in the repo — run
-- once per environment BEFORE applying this migration):
--   select vault.create_secret('<service-role-key>', 'amb_edge_service_key',
--     'pg_net trigger credential for Edge Function calls (AMB-SEC-002)');
-- If the secret is missing, every function below fails CLOSED (NOTICE +
-- skipped HTTP call); parent transactions are never affected.
-- ──────────────────────────────────────────────────────────────────────────

-- A) pg_cron shim → dispatch-engine (was 0011)
create or replace function public.dispatch_engine_step(p_order_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_url  text := 'https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/dispatch-engine';
  v_key  text := (select decrypted_secret from vault.decrypted_secrets
                  where name = 'amb_edge_service_key');
  v_body jsonb;
begin
  if p_order_id is null then
    v_body := jsonb_build_object('order_id', null);
  else
    v_body := jsonb_build_object('order_id', p_order_id);
  end if;
  if v_key is null then
    raise notice 'dispatch_engine_step: vault secret amb_edge_service_key missing — edge call skipped';
    return;
  end if;
  perform net.http_post(
    url    := v_url,
    body   := v_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey',   v_key,
      'Authorization', 'Bearer ' || v_key
    )
  );
exception
  when others then
    raise notice 'dispatch_engine_step error: %', sqlerrm;
end;
$$;

-- B) AFTER UPDATE OF status ON orders → send-notification (was 0011)
create or replace function public.notify_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_url  text := 'https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/send-notification';
  v_key  text := (select decrypted_secret from vault.decrypted_secrets
                  where name = 'amb_edge_service_key');
  v_body jsonb;
begin
  if NEW.status is null or NEW.status = OLD.status then
    return NEW;
  end if;
  if v_key is null then
    raise notice 'notify_status_change: vault secret amb_edge_service_key missing — notification skipped';
    return NEW;
  end if;
  v_body := jsonb_build_object('order_id', NEW.id, 'status', NEW.status);
  perform net.http_post(
    url    := v_url,
    body   := v_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey',   v_key,
      'Authorization', 'Bearer ' || v_key
    )
  );
  return NEW;
exception
  when others then
    raise notice 'notify_status_change error: %', sqlerrm;
    return NEW;
end;
$$;

-- C) cancel_order → dispatch-engine stop-retry call (was 0014)
--    Only the credential lookup and null-guard change; all money logic
--    (stock restore, guarded fee debit, IOU path, vendor compensation)
--    is carried over verbatim from 0014.
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
  v_key         text := (select decrypted_secret from vault.decrypted_secrets
                         where name = 'amb_edge_service_key');
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
  -- the qty was already decremented inside create_order).
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
      insert into wallet_transactions (user_id, type, amount, description, order_id)
      values (v_caller, 'cancellation_fee', v_fee,
              concat('رسوم إلغاء معلّقة — رصيد غير كافٍ (', v_fee::text, ' جنيه)'),
              v_order.id);
    end if;

    -- Compensate the vendor for fuel/time if we successfully debited the
    -- customer.
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
    raise exception 'concurrent_status_change';
  end if;

  -- Tell dispatch-engine to stop retrying this order (fire-and-forget;
  -- failures here must NOT fail the cancel).
  begin
    if v_key is null then
      raise notice 'cancel_order: vault secret amb_edge_service_key missing — dispatch cancel skipped';
    else
      perform net.http_post(
        url    := v_url,
        body   := jsonb_build_object('order_id', v_order.id, 'cancelled', true),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey',       v_key,
          'Authorization','Bearer ' || v_key
        )
      );
    end if;
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

-- D) vendor_reject_order → dispatch-engine re-dispatch call (was 0015)
--    Only the credential lookup and null-guard change; accept/depart are
--    untouched by this migration (they make no HTTP calls).
create or replace function public.vendor_reject_order(
  p_order_id  uuid,
  p_reason    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_caller  uuid := auth.uid();
  v_order   orders%rowtype;
  v_vendor_uid uuid;
  v_vendor_id  uuid;
  v_rowcount int;
  v_url  text := 'https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/dispatch-engine';
  v_key  text := (select decrypted_secret from vault.decrypted_secrets
                  where name = 'amb_edge_service_key');
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('error', 'order_not_found');
  end if;

  if v_order.status not in ('pending','accepted') then
    return jsonb_build_object('error', 'invalid_transition', 'current_status', v_order.status);
  end if;

  if v_order.vendor_id is null then
    return jsonb_build_object('order_id', p_order_id, 'already_rejected', true);
  end if;
  v_vendor_id := v_order.vendor_id;
  select user_id into v_vendor_uid from vendors where id = v_vendor_id;
  if v_vendor_uid is null or v_vendor_uid <> v_caller then
    return jsonb_build_object('error', 'not_vendor_of_this_order');
  end if;

  insert into order_rejections (order_id, vendor_id)
  values (p_order_id, v_vendor_id)
  on conflict (order_id, vendor_id) do nothing;

  update orders
    set status      = 'pending',
        vendor_id   = null,
        accepted_at = null,
        departed_at = null
    where id = p_order_id
      and status in ('pending','accepted')
      and vendor_id = v_vendor_id;
  get diagnostics v_rowcount = row_count;

  -- Re-fire dispatch-engine immediately so the next vendor is picked
  -- without waiting for the 1-min cron. Failures are non-fatal.
  begin
    if v_key is null then
      raise notice 'vendor_reject_order: vault secret amb_edge_service_key missing — re-dispatch skipped';
    else
      perform net.http_post(
        url    := v_url,
        body   := jsonb_build_object('order_id', p_order_id),
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'apikey',        v_key,
          'Authorization', 'Bearer ' || v_key
        )
      );
    end if;
  exception when others then
    raise notice 'vendor_reject dispatch POST failed: %', sqlerrm;
  end;

  return jsonb_build_object(
    'order_id',  p_order_id,
    'rejected', v_rowcount > 0,
    'reason',   p_reason
  );
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname from pg_proc where proname in
--     ('dispatch_engine_step','notify_status_change','cancel_order',
--      'vendor_reject_order');
--   -- 4 rows; bodies now reference vault.decrypted_secrets.
--   select decrypted_secret is not null as key_present
--   from vault.decrypted_secrets where name = 'amb_edge_service_key';
-- ──────────────────────────────────────────────────────────────────────────
