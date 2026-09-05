-- ──────────────────────────────────────────────────────────────────────────
-- 0016_revoke_remaining_client_money_writes.sql  —  Close the transition window
-- ──────────────────────────────────────────────────────────────────────────
-- Phase 3 left the following client-write RLS policies OPEN, intentionally,
-- as a "transition window" so the existing client-side writes kept working
-- during the Phase-3 rollout (comment in 0003 lines 12-13):
--
--   • `orders` INSERT policy "Customers can create orders"
--   • `promo_usages` INSERT policy "Users can record own promo usage"
--   • `referral_credits` INSERT policy "Users can insert own referral credits"
--   • `profiles` UPDATE policy "Users can update own profile"
--     (which lets the client write wallet_balance directly — the money-movement
--      violation that request_withdrawal, verify_delivery, cancel_order and
--      resolve_complaint are now the only authorized paths for)
--
-- Phase 4 replaces every client write to those tables with a SECURITY
-- DEFINER RPC (create_order, request_withdrawal, apply_referral,
-- verify_delivery, cancel_order, resolve_complaint). With the RPCs in
-- place and the RN services refactored to call them, the permissive
-- policies become dead-letter — except that a malicious/compromised
-- client could STILL bypass the rules by writing the table directly.
--
-- This migration closes that loophole. It is the final, irreversible
-- step that makes the spec hard-rule "all money movement happens
-- server-side only" ENFORCED BY THE DATABASE, not just by client
-- behavior.
--
-- Per Phase 4 decision, scope is partial (money tables only):
--   ✓ orders INSERT     dropped (create_order is the only path now)
--   ✓ profiles UPDATE   restricted to all columns EXCEPT wallet_balance
--   ✓ promo_usages INSERT dropped (consumed inside create_order only)
--   ✓ referral_credits INSERT dropped (applied via verify_delivery only)
--
-- What we deliberately KEEP open:
--   • complaints INSERT (filed by the customer; cheap, no money)
--   • order_ratings INSERT (rateOrder pure-INSERT; vendor aggregate is the
--     server trigger's job — the side-effect of writing vendors.rating
--     client-side was removed in Phase 4 service refactor, so letting the
--     client rate doesn't move money)
--   • profile SELECTs (every authenticated user can read their own row, so
--     getProfile / referralService.getMyCode / getMyStats keep working)
--
-- Profiles UPDATE column restriction:
--   Postgres row-level-security USING / WITH CHECK clauses can't column-
--   restrict at the policy level. We instead DROP the broad policy and
--   CREATE a new policy that allows UPDATE but where the WITH CHECK clause
--   rejects any UPDATE that TOUCHES `wallet_balance`:
--
--     create policy "Users can update own profile (no wallet_balance)"
--       on public.profiles for update to authenticated
--       using (id = auth.uid())
--       with check (
--         id = auth.uid()
--         AND wallet_balance = (select p.wallet_balance from public.profiles p where p.id = auth.uid())
--       );
--
--   The subquery in WITH CHECK references the row AS STORED on disk before
--   the update (the row that satisfied USING), so any attempt to change
--   wallet_balance makes the check fail with `new row violates row-level
--   security policy` — even from the owner. A client can still update
--   expo_push_token / name / phone / etc. as before (registerForPush,
--   profile-edit UIs). The SECURITY DEFINER RPCs (request_withdrawal,
--   verify_delivery, cancel_order, resolve_complaint) run with `set role`
--   to postgres and bypass the policy, so they update wallet_balance
--   freely.
-- ──────────────────────────────────────────────────────────────────────────

-- ─── 1. orders INSERT (no more direct client inserts) ─────────────────────
drop policy if exists "Customers can create orders" on public.orders;

-- ─── 2. promo_usages INSERT (consumed inside create_order only) ───────────
drop policy if exists "Users can record own promo usage" on public.promo_usages;

-- ─── 3. referral_credits INSERT (applied inside verify_delivery only) ──────
drop policy if exists "Users can insert own referral credits" on public.referral_credits;

-- ─── 4. profiles UPDATE — column-restrict to everything except wallet_balance ─
drop policy if exists "Users can update own profile" on public.profiles;

create policy "Users can update own profile (no wallet_balance)"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    -- Refuse the update if the proposed new wallet_balance differs from
    -- the value actually stored on disk BEFORE this update. The subquery
    -- reads the existing row (matching USING); a security-definer function
    -- bypasses this policy and is unaffected.
    AND wallet_balance = (
      select old_p.wallet_balance
      from public.profiles old_p
      where old_p.id = auth.uid()
    )
  );

-- Same self-row UPDATE access for the owner for everything EXCEPT wallet
-- balance: keep the public anon role off the UPDATE entirely.
-- (We do not grant anon; previously the policy was implicitly
-- `to public` via role inheritance. The new explicit `to authenticated` is
-- strictly more restrictive.)
--
comment on policy "Users can update own profile (no wallet_balance)" on public.profiles is
  'Phase 4 — owner may update any profile column EXCEPT wallet_balance. '
  'The WITH CHECK subquery pins wallet_balance to its on-disk pre-update '
  'value, so a client attempt to change it is rejected by RLS. Money '
  'mutations go exclusively through SECURITY DEFINER RPCs (verify_delivery, '
  'request_withdrawal, cancel_order, resolve_complaint), which bypass '
  'this policy via set role to postgres.';

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select tablename, policyname, cmd
--   from pg_policies
--   where schemaname='public'
--     and tablename in ('orders','profiles','promo_usages','referral_credits')
--   order by tablename, policyname;
-- Expected:
--   orders          | Users can view own orders         | SELECT
--   profiles        | Users can insert own profile      | INSERT
--   profiles        | Users can update own profile (no wallet_balance) | UPDATE
--   profiles        | Users can view own profile        | SELECT
--   promo_usages    | Users can view own promo usage    | SELECT
--   referral_credits| Users can view referral credits involving them | SELECT
--
-- Bonus: confirm wallet_balance can't be moved by the owner directly.
-- As the customer (anon-key RPC path), try:
--   update public.profiles set wallet_balance = wallet_balance + 1000
--   where id = '<your_uid>';
-- Expected: ERROR: new row violates row-level security policy for table "profiles"
-- ──────────────────────────────────────────────────────────────────────────
