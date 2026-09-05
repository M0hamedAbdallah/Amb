-- ──────────────────────────────────────────────────────────────────────────
-- 0011_triggers.sql  —  Wire Edge Functions via triggers + register the cron job
-- ──────────────────────────────────────────────────────────────────────────
-- This is the LAST Phase-3 migration. It glues the live database to the two
-- Edge Functions:
--   • dispatch-engine   (slug: dispatch-engine)
--   • send-notification  (slug: send-notification)
-- using `net.http_post` from inside triggers fired by table mutations.
--
-- Layout:
--   A) Helper SQL function `dispatch_engine_step(uuid)` — entry point for
--      pg_cron's scheduled job. Receives an order id (or NULL); POSTs the
--      Edge Function on the specified order (or scans for stuck pending
--      orders). The cron job calls this every minute.
--
--   B) AFTER INSERT trigger on `orders`:
--      • Calls dispatch_engine_step(NEW.id) — the engine attempts vendor
--        assignment immediately for newly created orders. Returns void.
--
--   C) AFTER UPDATE trigger on `orders`:
--      • WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IS NOT NULL)
--      • Fires send-notification via net.http_post with {order_id, status}.
--
--   D) AFTER INSERT trigger on `order_ratings`:
--      • Recomputes `vendors.rating` + `vendors.total_ratings` for the
--        rated vendor. Atomic single-row UPDATE; idempotent because each
--        order can only be rated once (orders_ratings has UNIQUE(order_id)).
--
--   E) Cron schedule registration — `select cron.schedule(...)` for
--      `dispatch-stuck-orders` every minute.
--
-- URL + anon-key embedding:
--   Supabase blocks `ALTER DATABASE postgres SET app.xxx` for our role.
--   The project URL (`https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/...`)
--   is hardcoded into the trigger function bodies — this is the same URL
--   the RN client already knows, not a real secret.
--   The anon key is embedded as a fallback constant inside the two
--   helper_funcs (`dispatch_engine_step` and `notify_status_change`):
--   `coalesce(current_setting('app.supabase_anon_key', true), '<anon-key>')`.
--   The anon key is also a public, RLS-restricted credential already shipped
--   in the RN app's `.env` (EXPO_PUBLIC_SUPABASE_ANON_KEY), so embedding
--   it here doesn't leak any new secret. The user can override the GUC
--   via Dashboard → Database → Session settings, and the function will
--   pick up the override at next invocation.
--
-- Trigger functions swallow all exceptions and re-raise as NOTICE: the
-- parent INSERT/UPDATE transaction must NEVER fail because of a notification
-- outage. The cron job + pg_net's own retry continue to attempt dispatch
-- until the order lands or max_dispatch_retries is exhausted.
-- ──────────────────────────────────────────────────────────────────────────

-- A) SQL shim that pg_cron calls every minute
create or replace function public.dispatch_engine_step(p_order_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_url    text := 'https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/dispatch-engine';
  v_key    text := coalesce(current_setting('app.supabase_anon_key', true),
                            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthemNueGZwbWd5empwZXZxeGl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3OTQ0MTksImV4cCI6MjEwMDM3MDQxOX0.svOIL78CoNECfblJVxVvTNTHsjm2gwhXS_wcmKPQI4M');
  v_body jsonb;
begin
  if p_order_id is null then
    v_body := jsonb_build_object('order_id', null);
  else
    v_body := jsonb_build_object('order_id', p_order_id);
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

-- B) AFTER INSERT ON orders
create or replace function public.notify_dispatch_on_order_insert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
begin
  if NEW.status = 'pending' and NEW.vendor_id is null then
    perform public.dispatch_engine_step(NEW.id);
  end if;
  return NEW;
exception
  when others then
    raise notice 'notify_dispatch_on_order_insert error: %', sqlerrm;
    return NEW;
end;
$$;

drop trigger if exists trg_orders_dispatch on orders;
create trigger trg_orders_dispatch
  after insert on orders
  for each row
  execute function public.notify_dispatch_on_order_insert();

-- C) AFTER UPDATE OF status ON orders → send-notification
create or replace function public.notify_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_url    text := 'https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/send-notification';
  v_key    text := coalesce(current_setting('app.supabase_anon_key', true),
                            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthemNueGZwbWd5empwZXZxeGl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3OTQ0MTksImV4cCI6MjEwMDM3MDQxOX0.svOIL78CoNECfblJVxVvTNTHsjm2gwhXS_wcmKPQI4M');
  v_body jsonb;
begin
  if NEW.status is null or NEW.status = OLD.status then
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

drop trigger if exists trg_orders_status_change on orders;
create trigger trg_orders_status_change
  after update of status on orders
  for each row
  when (NEW.status IS DISTINCT FROM OLD.status)
  execute function public.notify_status_change();

-- D) AFTER INSERT ON order_ratings
create or replace function public.recompute_vendor_rating()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_avg   numeric(3,2);
  v_count int;
begin
  select round(avg(stars)::numeric, 2), count(*)::int
    into v_avg, v_count
  from order_ratings
    where vendor_id = NEW.vendor_id;

  update vendors
    set rating        = coalesce(v_avg, 0),
        total_ratings = coalesce(v_count, 0)
    where id = NEW.vendor_id;

  return NEW;
exception
  when others then
    raise notice 'recompute_vendor_rating error: %', sqlerrm;
    return NEW;
end;
$$;

drop trigger if exists trg_order_ratings_recompute on order_ratings;
create trigger trg_order_ratings_recompute
  after insert on order_ratings
  for each row
  execute function public.recompute_vendor_rating();

-- E) pg_cron schedule (every-minute fallback dispatch poller)
-- Use distinct dollar-quote tag sets ($_$ for outer DO blocks, $cmd$ for
-- the inner command string) to avoid Postgres dollar-quote collisions.
do $_$
begin
  perform cron.unschedule('dispatch-stuck-orders');
exception when others then null; end $_$;

do $_$
begin
  perform cron.schedule(
    'dispatch-stuck-orders',
    '* * * * *',                                     -- every minute
    $cmd$select public.dispatch_engine_step(NULL);$cmd$
  );
exception
  when others then
    raise notice 'cron.schedule dispatch-stuck-orders error: %', sqlerrm;
end $_$;

-- Verification queries (run after applying):
--   select proname from pg_proc where proname in
--     ('dispatch_engine_step','notify_dispatch_on_order_insert',
--      'notify_status_change','recompute_vendor_rating');
--   select tgname, tgrelid::regclass, pg_get_triggerdef(oid)
--     from pg_trigger where tgname in
--      ('trg_orders_dispatch','trg_orders_status_change','trg_order_ratings_recompute');
--   select jobname, schedule, active, command from cron.job order by jobname;
-- ──────────────────────────────────────────────────────────────────────────
