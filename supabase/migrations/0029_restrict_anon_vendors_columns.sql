-- ──────────────────────────────────────────────────────────────────────────
-- 0029_restrict_anon_vendors_columns.sql — AMB-SEC-003 remediation (Medium)
-- ──────────────────────────────────────────────────────────────────────────
-- Finding (2026-08-22 audit): the anon key could SELECT every `vendors`
-- column, including PII / KYC columns (national_id, national_id_url,
-- business_license_url, user_id) and moderation columns (warnings_count,
-- suspended_until, premium_expires_at). The customer-facing catalog is
-- public by design — but only the catalog columns are.
--
-- Fix: column-level SELECT grants for anon. `select=*` expands to the
-- catalog subset only; explicitly selecting a hidden column fails with a
-- 4xx. The authenticated role keeps full-table SELECT (its RLS policies
-- already scope vendor rows); this narrows only the unauthenticated key.
-- ──────────────────────────────────────────────────────────────────────────

revoke select on public.vendors from anon;
grant select (
  id, business_name, address, lat, lng,
  small_price, large_price, small_stock, large_stock,
  rating, total_ratings, is_active, is_verified, is_premium,
  delivery_radius_km, avg_delivery_mins, created_at
) on public.vendors to anon;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select column_name,
--          has_column_privilege('anon','public.vendors',column_name,'SELECT') as sel
--   from information_schema.columns
--   where table_schema='public' and table_name='vendors'
--   order by ordinal_position;
--   -- expect sel=false for: user_id, national_id, national_id_url,
--   -- business_license_url, warnings_count, suspended_until, premium_expires_at
--
--   -- anon catalog read still works and returns only safe columns:
--   -- curl "$URL/rest/v1/vendors?select=*&limit=1" with anon key → 200
--   -- curl "$URL/rest/v1/vendors?select=national_id" with anon key → 4xx
-- ──────────────────────────────────────────────────────────────────────────
