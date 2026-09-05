-- ──────────────────────────────────────────────────────────────────────────
-- 0004_activate_pg_net_pg_cron.sql  —  Enable HTTP-out + scheduler for triggers
-- ──────────────────────────────────────────────────────────────────────────
-- Enables the two extensions Phase-3 triggers (0011) will rely on:
--
--   • pg_net  (0.20.4) — async HTTP client. Lets an AFTER INSERT / UPDATE
--     trigger on `orders` POST to the `dispatch-engine` and `send-notification`
--     Edge Functions purely from the database, with no client involvement.
--   • pg_cron (1.6.4) — Postgres-native job scheduler. Used to run a fallback
--       `dispatch-stuck-orders`  poller once per minute so that nothing slips
--     through if the after-insert pg_net http_post race loses (e.g. cold
--     start, network blip, transient Edge Function 5xx).
--
-- Both extensions are advertised on this Supabase project but not yet
-- installed (`installed_version` is null). This migration installs them.
--
-- pg_cron on Supabase hard-pins its objects into a dedicated `cron` schema
-- regardless of the `schema` clause passed to `CREATE EXTENSION` (the
-- extension's control file specifies `schema = cron`). Attempting to install
-- it elsewhere is silently ignored — the function symbols `cron.schedule`,
-- `cron.unschedule` and the `cron.job` / `cron.job_run_details` tables all
-- land in schema `cron`. We rely on the `postgres` role's search_path for
-- trigger + cron-worker resolution.
--
-- IMPORTANT — cron job is NOT scheduled here.
--   The schedule call references `public.dispatch_engine_step(uuid)` which is
--   defined as a SQL function inside migration `0011_triggers.sql`. Scheduling
--   here would fail with "function does not exist". The actual
--   `select cron.schedule(...)` call lives in 0011 alongside the function.
--   This file only ensures the extension plumbing is in place.
-- ──────────────────────────────────────────────────────────────────────────

-- pg_net: async HTTP. pg_net ships a `net` schema (its control file pins
-- it there) — symbols `net.http_post` / `net.http_get` are reachable via
-- the postgres search_path. The leading `schema`/`version` clauses are
-- best-effort hints; Supabase's bootstrap ultimately controls placement.
create extension if not exists pg_net
  version '0.20.4';

-- pg_cron: ships a `cron` schema (its control file pins it there). The
-- `schema extensions` clause below is ignored by Postgres due to the
-- control-file declaration, but is left for documentation intent — actual
-- runtime placement is schema `cron` regardless. Keeping `version '1.6.4'`
-- for explicit pinning.
create extension if not exists pg_cron
  schema extensions
  version '1.6.4';

-- Grant the `postgres` role (which runs scheduled jobs and triggers) the
-- ability to use the cron schema. Supabase's bootstrap usually does this
-- already, but re-granting is idempotent and self-documents the dependency.
-- We do NOT grant to anon/authenticated — clients must never schedule jobs.
grant usage on schema extensions to postgres;

-- Mark pg_net functions as reachable. `extensions` is already in the
-- `postgres` role's search_path, so no further grant is needed for triggers
-- running as postgres. Keeping this here as a belt-and-braces note:
--   `net.http_post` and `net.http_get` live in `extensions`.
-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select extname, extversion, n.nspname as schema
--   from pg_extension e join pg_namespace n on n.oid = e.extnamespace
--   where extname in ('pg_net','pg_cron');
--
-- Expected rows:
--   pg_net  | 0.20.4 | extensions
--   pg_cron | 1.6.4  | extensions
-- ──────────────────────────────────────────────────────────────────────────
