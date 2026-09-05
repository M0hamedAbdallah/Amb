-- ──────────────────────────────────────────────────────────────────────────
-- 0015_function_vendor_order_actions.sql — Vendor accept/depart/reject (SEC DEFINER)
-- ──────────────────────────────────────────────────────────────────────────
-- Background (Phase 4):
--   Migration 0003 deliberately left the `orders` UPDATE policy open during
--   the Phase-3 transition window so vendor accept/on_way/reject could keep
--   flowing through client writes. Migration 0016 (sibling) closes that
--   window by dropping the policy. For vendor status transitions to keep
--   working after 0016, they MUST be server-side — this migration.
--
-- Three SECURITY DEFINER functions, all bound to `auth.uid() ===
-- vendors.user_id` for the order's assigned vendor:
--
--   1. vendor_accept_order(p_order_id)
--      Status pending → accepted. Sets accepted_at=now(). The
--      `AFTER UPDATE OF status` trigger (migration 0011) then fires
--      send-notification automatically.
--
--   2. vendor_depart_order(p_order_id)
--      Status accepted → on_way. Sets departed_at=now().
--
--   3. vendor_reject_order(p_order_id, p_reason)
--      Status pending|accepted → pending (reset), vendor_id=null,
--      accepted_at=null, departed_at=null. Records a row in
--      `order_rejections(order_id, vendor_id)` so dispatch-engine
--      excludes this vendor on subsequent attempts. Then fires
--      `dispatch_engine_step(order_id)` via pg_net so dispatch-engine
--      immediately picks the next-nearest candidate (otherwise the order
--      would wait up to 60s for the cron poll).
--
-- Authorisation model:
--   • Caller must be authenticated (auth.uid() not null).
--   • Caller must be the vendor's user_id for the order's assigned
--     vendor. We do this by joining orders → vendors → user_id and
--     comparing to auth.uid(). A vendor cannot accept/reject an order
--     that wasn't assigned to them.
--   • For reject, the order must currently be assigned to the caller
--     (subquery-or-FOR-UPDATE on orders). The order may legitimately
--     have been unassigned by an upstream re-dispatch (cron-driven
--     dispatch-engine), in which case we return `order_not_assigned`
--     rather than error (idempotent-ish — the caller already had their
--     effect).
--
-- Idempotency:
--   • vendor_accept_order accepts an `accepted` order as soft success.
--   • vendor_depart_order rejects an `accepted` order only (not on_way).
--   • vendor_reject_order on an already-reset order is a no-op success.
--
-- Pricing / stock:
--   These are NOT money-moving functions; commission + wallet settlement
--   happens in `verify_delivery` (migration 0006). Stock was already
--   decremented in `create_order` (migration 0005). No stock mutation
--   here — reject does NOT restore stock (the dispatch-engine will
--   re-select a DIFFERENT vendor and decrement that vendor's stock; the
--   originally-decremented stock stays at the rejecting vendor since the
--   cylinder was reserved for them and is now available for the next
--   order they accept).
--
-- Trade-offs:
--   We chose three granular functions over one `vendor_order_action`
--   function-with-dispatch parameter. Granular is easier to typecheck
--   against `supabase.rpc('vendor_accept_order', ...)`, simpler at the
--   DB layer (no validation of an action enum), and the trigger filter
--   on `AFTER UPDATE OF status` works regardless of which function
--   advanced the status.
-- ──────────────────────────────────────────────────────────────────────────

-- ─── 1. vendor_accept_order ────────────────────────────────────────────────
create or replace function public.vendor_accept_order(
  p_order_id  uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_caller  uuid := auth.uid();
  v_order   orders%rowtype;
  v_vendor_uid uuid;
  v_rowcount int;
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('error', 'order_not_found');
  end if;

  -- Idempotent: already accepted = soft success.
  if v_order.status = 'accepted' then
    return jsonb_build_object('already_accepted', true);
  end if;

  -- Only pending can move to accepted.
  if v_order.status <> 'pending' then
    return jsonb_build_object('error', 'invalid_transition', 'current_status', v_order.status);
  end if;

  -- Vendor must be assigned and the caller must be the vendor's user.
  if v_order.vendor_id is null then
    return jsonb_build_object('error', 'no_vendor_assigned');
  end if;
  select user_id into v_vendor_uid from vendors where id = v_order.vendor_id;
  if v_vendor_uid is null or v_vendor_uid <> v_caller then
    return jsonb_build_object('error', 'not_vendor_of_this_order');
  end if;

  update orders
    set status = 'accepted', accepted_at = now()
    where id = p_order_id and status = 'pending';
  get diagnostics v_rowcount = row_count;
  if v_rowcount = 0 then
    return jsonb_build_object('error', 'invalid_transition', 'current_status', v_order.status);
  end if;

  return jsonb_build_object('order_id', p_order_id, 'status', 'accepted');
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- ─── 2. vendor_depart_order ────────────────────────────────────────────────
create or replace function public.vendor_depart_order(
  p_order_id  uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_caller  uuid := auth.uid();
  v_order   orders%rowtype;
  v_vendor_uid uuid;
  v_rowcount int;
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('error', 'order_not_found');
  end if;

  -- Idempotent: already on_way = soft success.
  if v_order.status = 'on_way' then
    return jsonb_build_object('already_on_way', true);
  end if;

  if v_order.status <> 'accepted' then
    return jsonb_build_object('error', 'invalid_transition', 'current_status', v_order.status);
  end if;

  if v_order.vendor_id is null then
    return jsonb_build_object('error', 'no_vendor_assigned');
  end if;
  select user_id into v_vendor_uid from vendors where id = v_order.vendor_id;
  if v_vendor_uid is null or v_vendor_uid <> v_caller then
    return jsonb_build_object('error', 'not_vendor_of_this_order');
  end if;

  update orders
    set status = 'on_way', departed_at = now()
    where id = p_order_id and status = 'accepted';
  get diagnostics v_rowcount = row_count;
  if v_rowcount = 0 then
    return jsonb_build_object('error', 'invalid_transition', 'current_status', v_order.status);
  end if;

  return jsonb_build_object('order_id', p_order_id, 'status', 'on_way');
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- ─── 3. vendor_reject_order ────────────────────────────────────────────────
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
  v_key  text := coalesce(current_setting('app.supabase_anon_key', true),
                         'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthemNueGZwbWd5empwZXZxeGl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3OTQ0MTksImV4cCI6MjEwMDM3MDQxOX0.svOIL78CoNECfblJVxVvTNTHsjm2gwhXS_wcmKPQI4M');
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('error', 'order_not_found');
  end if;

  -- Only pending or accepted orders can be rejected. on_way / delivered /
  -- cancelled are past the rejection window.
  if v_order.status not in ('pending','accepted') then
    return jsonb_build_object('error', 'invalid_transition', 'current_status', v_order.status);
  end if;

  -- Reject is meaningful only when the order is currently assigned to the
  -- caller's vendor.
  if v_order.vendor_id is null then
    -- Already reset by an upstream flow; treat as idempotent success.
    return jsonb_build_object('order_id', p_order_id, 'already_rejected', true);
  end if;
  v_vendor_id := v_order.vendor_id;
  select user_id into v_vendor_uid from vendors where id = v_vendor_id;
  if v_vendor_uid is null or v_vendor_uid <> v_caller then
    return jsonb_build_object('error', 'not_vendor_of_this_order');
  end if;

  -- Record the rejection so dispatch-engine skips us on the next attempt.
  insert into order_rejections (order_id, vendor_id)
  values (p_order_id, v_vendor_id)
  on conflict (order_id, vendor_id) do nothing;

  -- Reset the order to pending + unassign. Guarded by status so a
  -- concurrent accept can't be clobbered.
  update orders
    set status      = 'pending',
        vendor_id   = null,
        accepted_at = null,
        departed_at = null
    where id = p_order_id
      and status in ('pending','accepted')
      and vendor_id = v_vendor_id; -- only the original assigner reverts
  get diagnostics v_rowcount = row_count;

  -- Re-fire dispatch-engine immediately so the next vendor is picked
  -- without waiting for the 1-min cron. Failures here are non-fatal: the
  -- cron will retry within 60s.
  begin
    perform net.http_post(
      url    := v_url,
      body   := jsonb_build_object('order_id', p_order_id),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'apikey',        v_key,
        'Authorization', 'Bearer ' || v_key
      )
    );
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

-- Permissions ─────────────────────────────────────────────────────────────
-- All three granted to anon + authenticated. SECURITY DEFINER bypasses RLS;
-- authorization is enforced internally via the vendor.user_id == auth.uid()
-- check.
grant execute on function public.vendor_accept_order(uuid)
  to anon, authenticated;
grant execute on function public.vendor_depart_order(uuid)
  to anon, authenticated;
grant execute on function public.vendor_reject_order(uuid, text)
  to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecdef from pg_proc
--   where proname in ('vendor_accept_order','vendor_depart_order','vendor_reject_order')
--   order by proname;
-- Expected: 3 rows, each | f | true (security definer)
-- ──────────────────────────────────────────────────────────────────────────
