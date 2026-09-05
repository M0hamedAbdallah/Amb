-- ──────────────────────────────────────────────────────────────────────────
-- 0028_lock_profiles_client_writes.sql — AMB-SEC-001 remediation (Critical)
-- ──────────────────────────────────────────────────────────────────────────
-- Finding (2026-08-22 audit): the profiles UPDATE policy (0016) pinned only
-- wallet_balance; `role` was writable by any authenticated user, allowing
-- self-promotion to admin/support via a direct PATCH. The INSERT policy
-- pinned only ownership (auth.uid() = id), so the same escalation was
-- possible at signup by inserting role='admin' / wallet_balance=<anything>.
--
-- Fix (defence in depth — column grants AND policy):
--   1. Column-level UPDATE grants: authenticated may only ever PATCH the
--      self-service columns (name, phone, avatar_url, expo_push_token).
--      role, wallet_balance, is_active, referral_code, referred_by,
--      warnings_count, suspended_until, created_at are no longer writable
--      through PostgREST by clients at all — money and moderation changes
--      move exclusively to SECURITY DEFINER RPCs / admin-api (service role,
--      which bypasses these grants). anon loses UPDATE entirely (it was
--      already RLS-dead). PostgREST checks column grants BEFORE RLS, so
--      this holds even if a future policy regresses.
--   2. INSERT policy now pins role IN ('customer','vendor') and
--      wallet_balance = 0: onboarding can only create plain accounts;
--      support/admin profiles are created via admin-api (service role).
--
-- App compatibility audit (2026-08-22): the RN client's only live profiles
-- writes are pushService ({expo_push_token}) and the generic
-- authService.updateProfile (name/phone/avatar_url). The web console never
-- touches profiles directly — it goes through the admin-api Edge Function.
-- ──────────────────────────────────────────────────────────────────────────

-- 1) Column-level UPDATE grants
revoke update on public.profiles from anon;
revoke update on public.profiles from authenticated;
grant update (name, phone, avatar_url, expo_push_token)
  on public.profiles to authenticated;

-- 2) Signup values pinned
drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles for insert to public
  with check (
    auth.uid() = id
    and role in ('customer', 'vendor')
    and coalesce(wallet_balance, 0) = 0
  );

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select column_name,
--          has_column_privilege('authenticated','public.profiles',column_name,'UPDATE') as upd
--   from information_schema.columns
--   where table_schema='public' and table_name='profiles'
--   order by ordinal_position;
--   -- expect upd=true ONLY for name, phone, avatar_url, expo_push_token
--
--   select policyname, with_check from pg_policies
--   where schemaname='public' and tablename='profiles' and cmd='INSERT';
--   -- expect role IN ('customer','vendor') AND wallet_balance = 0 in with_check
-- ──────────────────────────────────────────────────────────────────────────
