-- ──────────────────────────────────────────────────────────────────────────
-- 0021_function_get_referral_stats.sql
-- Admin referral-campaign reachability RPC (SECURITY DEFINER).
-- ──────────────────────────────────────────────────────────────────────────
-- Why this RPC exists:
--   The admin needs visibility into the referral programme: who referred whom,
--   how many referees actually qualified (a referral_credits row exists --
--   which means a delivered order was placed through the referral), and the
--   total bonus volume paid to referrers. There is currently no admin-side
--   surface for this (only the per-customer "my referrals" card in
--   referralService.getMyStats).
--
--   RLS forbids cross-user reads on profiles.referred_by, referral_credits,
--   and wallet_transactions (each policy narrows to auth.uid() = own row).
--   An admin cannot read these tables directly with the anon/auth client key.
--   The only safe pattern for an admin query that must span all users is a
--   SECURITY DEFINER RPC that verifies profiles.role='admin' server-side and
--   then runs its aggregates as the function owner, bypassing RLS. This is
--   the same authorisation model used by resolve_complaint (migration 0010).
--
-- Authorisation:
--   The caller (auth.uid()) must have profiles.role='admin'. The Supabase JWT
--   does not carry the role claim, so we look it up inside the function and
--   reject on mismatch. Non-admins get {error: 'admin_only'}.
--
-- Returns jsonb:
--   {
--     "totals":   { "referees": N, "qualified": N, "bonusesPaid": N },
--     "leaderboard": [
--       { "referrerId","name","phone","code","referees","qualified","earned" },
--       ...top 50 by earned desc
--     ],
--     "credits": [
--       { "referrerId","referrerName","refereeId","refereeName",
--         "amount","qualifiedAt","orderId" },
--       ...all referral_credits rows, newest first
--     ]
--   }
-- On error: { "error": "admin_only" | "auth_required" | <sqlstate> }.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.get_referral_stats()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_caller       uuid := auth.uid();
  v_caller_role  text;
  v_totals       jsonb;
  v_leaderboard  jsonb;
  v_credits      jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;

  -- Admin gate. Same model as resolve_complaint (0010): look up the caller's
  -- profiles.role and reject if it is not 'admin'. SECURITY DEFINER bypasses
  -- RLS, so this read works even though profiles RLS would normally scope to
  -- auth.uid() = id (which is also true here, so it works either way).
  select role into v_caller_role from profiles where id = v_caller;
  if v_caller_role is null or v_caller_role <> 'admin' then
    return jsonb_build_object('error', 'admin_only');
  end if;

  -- Totals across the whole programme.
  select jsonb_build_object(
    'referees',    (select count(*) from profiles where referred_by is not null),
    'qualified',   (select count(*) from referral_credits),
    'bonusesPaid', (select coalesce(sum(amount), 0) from wallet_transactions where type = 'referral_bonus')
  ) into v_totals;

  -- Leaderboard: one row per referrer with non-zero referees or credits.
  -- referees  = how many profiles used this referrer's code (referred_by = referrer)
  -- qualified = how many of those actually earned a credit (referral_credits row)
  -- earned     = total credit collected by this referrer
  -- Top 50 by earned desc; ties broken by referees desc then name asc.
  select coalesce(jsonb_agg(jsonb_build_object(
    'referrerId', l.referrer_id,
    'name',       l.name,
    'phone',      l.phone,
    'code',       l.referral_code,
    'referees',   l.referees,
    'qualified',  l.qualified,
    'earned',     l.earned
  ) order by l.earned desc, l.referees desc, l.name asc nulls last), '[]'::jsonb)
  into v_leaderboard
  from (
    select
      p.id                                   as referrer_id,
      p.name                                 as name,
      p.phone                                as phone,
      p.referral_code                        as referral_code,
      (select count(*) from profiles r where r.referred_by = p.id) as referees,
      coalesce((select count(*) from referral_credits c where c.referrer_id = p.id), 0) as qualified,
      coalesce((select sum(c.amount) from referral_credits c where c.referrer_id = p.id), 0) as earned
    from profiles p
    where exists (select 1 from profiles r where r.referred_by = p.id)
       or exists (select 1 from referral_credits c where c.referrer_id = p.id)
  ) l
  limit 50;

  -- Full credit ledger: every referral_credits row, newest first, with both
  -- parties' display name resolved. Capped at 500 rows to keep the payload
  -- small even on a very large programme; the leaderboard above covers totals.
  select coalesce(jsonb_agg(jsonb_build_object(
    'referrerId',   c.referrer_id,
    'referrerName', pr.name,
    'refereeId',    c.referee_id,
    'refereeName',  pe.name,
    'amount',       c.amount,
    'qualifiedAt',  c.created_at,
    'orderId',      c.order_id
  ) order by c.created_at desc), '[]'::jsonb)
  into v_credits
  from referral_credits c
  left join profiles pr on pr.id = c.referrer_id
  left join profiles pe on pe.id = c.referee_id
  limit 500;

  return jsonb_build_object(
    'totals',      v_totals,
    'leaderboard', v_leaderboard,
    'credits',     v_credits
  );
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- Permissions ------------------------------------------------------------
-- SECURITY DEFINER bypasses RLS, but the function enforces role='admin'
-- internally. Granting execute to anon + authenticated is therefore safe --
-- non-admins calling it just get {error: 'admin_only'}.
grant execute on function public.get_referral_stats()
  to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecdef from pg_proc where proname='get_referral_stats';
-- Expected: get_referral_stats | f | true (security definer)
-- ──────────────────────────────────────────────────────────────────────────
