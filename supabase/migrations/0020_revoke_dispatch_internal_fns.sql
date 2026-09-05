-- ============================================================================
-- 0020_revoke_dispatch_internal_fns.sql - Defense in depth: lock down the two
-- dispatch/notification trigger+cron entry-point functions so they cannot be
-- invoked directly via /rest/v1/rpc/... by anon or authenticated users.
-- ============================================================================
-- These two functions are internal plumbing:
--   * dispatch_engine_step(uuid)          - called by the AFTER INSERT trigger
--                                            on orders (via notify_dispatch_on
--                                            _order_insert) and by the pg_cron
--                                            schedule 'dispatch-stuck-orders'
--                                            every minute.
--   * notify_dispatch_on_order_insert()   - the AFTER INSERT trigger function
--                                            itself.
-- Both run as SECURITY DEFINER and POST to the dispatch-engine / send-
-- notification Edge Functions via net.http_post with an embedded anon key.
-- They were never meant to be user-callable: a malicious client could call
-- dispatch_engine_step at will to spam the dispatch-engine Edge Function, or
-- worse, call notify_dispatch_on_order_insert() outside its trigger context
-- (it does nothing harmful there because it references NEW.* — but exposing
-- it still gives callers a way to hammer the network egress).
--
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default, so without
-- an explicit REVOKE these were reachable. The Supabase security advisor
-- (lint 0028/0029) flags this for exactly that reason.
--
-- We revoke from anon + authenticated. We do NOT revoke from service_role —
-- cron jobs run as the postgres superuser and so bypass grants anyway, but
-- keeping service_role able to call them (in case a future edge function needs
-- to nudge dispatch) does no harm. Triggers always run with the privileges of
-- the function owner (SECURITY DEFINER), independent of the caller's grants,
-- so revoking the caller's EXECUTE does not break the trigger path.
-- ============================================================================

revoke execute on function public.dispatch_engine_step(uuid) from anon;
revoke execute on function public.dispatch_engine_step(uuid) from authenticated;
revoke execute on function public.dispatch_engine_step(uuid) from public;

revoke execute on function public.notify_dispatch_on_order_insert() from anon;
revoke execute on function public.notify_dispatch_on_order_insert() from authenticated;
revoke execute on function public.notify_dispatch_on_order_insert() from public;

comment on function public.dispatch_engine_step(uuid) is
  'Internal dispatch plumbing. Called by the AFTER INSERT trigger on orders '
  '(via notify_dispatch_on_order_insert) and by the pg_cron schedule '
  '''dispatch-stuck-orders'' every minute. NOT callable via the REST API '
  '(EXECUTE revoked from anon/authenticated/public).';

comment on function public.notify_dispatch_on_order_insert() is
  'AFTER INSERT trigger function on orders that calls dispatch_engine_step for '
  'new pending orders. NOT callable via the REST API (EXECUTE revoked from '
  'anon/authenticated/public).';

-- ============================================================================
-- Verification (run after applying):
--   select
--     has_function_privilege('anon','dispatch_engine_step(uuid)','execute') as anon_dispatch,
--     has_function_privilege('authenticated','dispatch_engine_step(uuid)','execute') as authed_dispatch,
--     has_function_privilege('anon','notify_dispatch_on_order_insert()','execute') as anon_notify,
--     has_function_privilege('authenticated','notify_dispatch_on_order_insert()','execute') as authed_notify;
-- Expected: all four = false (no caller-role EXECUTE).
-- Trigger/cron paths are unaffected: SECURITY DEFINER runs as the owner.
-- ============================================================================
