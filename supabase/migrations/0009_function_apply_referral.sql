-- ──────────────────────────────────────────────────────────────────────────
-- 0009_function_apply_referral.sql — Set referred_by atomically (SEC DEFINER)
-- ──────────────────────────────────────────────────────────────────────────
-- Replaces `referralService.applyCodeOnSignup(userId, code)` which:
--   1. Looked up `profiles` where `referral_code = upper(code)` SELECT-only.
--   2. Read the current user's `referred_by`. If non-null, bailed.
--   3. UPDATE the current user's row to set `referred_by = referrerId`.
--
-- Problems fixed by this RPC:
--   • Atomic. The read-modify-write sequence above had a race: two
--     concurrent calls (e.g. user double-tap on Apply) could both pass the
--     `referred_by IS NULL` check then both proceed to UPDATE — last write
--     wins, but neither verified. `apply_referral` collapses it into a
--     single guarded UPDATE with RETURNING; the `WHERE referred_by IS NULL
--     AND p_referrer <> id` inside the UPDATE means zero rows match if the
--     user already has a referrer (or if they're trying to self-refer).
--   • Self-referral rejection: the client check at line 29 of
--     `referralService.ts` was trust-boundary; a malicious client could
--     bypass it and self-refer repeatedly. Server-side hardening prevents
--     it.
--   • No client-supplied `userId` input. Caller identity = `auth.uid()`.
--     The original client API took `userId` as a parameter and trusted it.
--
-- Idempotency contract:
--   Re-applying the same code (or any other code) after a referrer is set
--   returns `{ updated: false, reason: 'already_referred' }` (or
--   `self_referral` / `invalid_code`). The caller treats any non-error as
--   success — idempotent on repeat.
--
-- Authorisation:
--   • Caller must be authenticated (auth.uid() not null).
--   • Forward references narrowed to the `profiles` table's own columns;
--     no implicit dependency on system_settings.
--
-- Returns: jsonb `{ updated, referred_by?, reason? }` — success marker
-- or structured error.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.apply_referral(
  p_code text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_caller   uuid := auth.uid();
  v_referrer uuid;
  v_updated  boolean := false;
  v_existing uuid;
begin
  if v_caller is null then
    return jsonb_build_object('error', 'auth_required');
  end if;
  if p_code is null or p_code = '' then
    return jsonb_build_object('updated', false, 'reason', 'invalid_code');
  end if;

  -- Resolve the referrer's user_id from the 8-char code.
  select id into v_referrer from profiles
    where upper(referral_code) = upper(p_code)
    limit 1;

  if v_referrer is null then
    return jsonb_build_object('updated', false, 'reason', 'invalid_code');
  end if;

  if v_referrer = v_caller then
    -- Cannot self-refer (audit-finding hardening)
    return jsonb_build_object('updated', false, 'reason', 'self_referral');
  end if;

  -- Single atomic UPDATE: idempotent on retry, race-safe on concurrent calls.
  -- If the user already has a referrer, the WHERE clause matches zero rows
  -- and we treat it as idempotent success without overwriting.
  update profiles
    set referred_by = v_referrer
    where id = v_caller
      and referred_by is null
    returning referred_by into v_existing;
  if v_existing is not null then
    v_updated := true;
  end if;

  if v_updated then
    return jsonb_build_object('updated', true, 'referred_by', v_existing);
  end if;
  -- Either already referred (prior success) or self-referral blocked.
  -- Discern: did we already have one?
  select referred_by into v_existing from profiles where id = v_caller;
  if v_existing is not null then
    return jsonb_build_object('updated', false, 'reason', 'already_referred');
  end if;
  -- Unreachable: if we're here the UPDATE matched zero rows but the user
  -- still has NULL referred_by. Treat as defensive success.
  return jsonb_build_object('updated', false, 'reason', 'no_change');
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

grant execute on function public.apply_referral(text)
  to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecdef from pg_proc where proname='apply_referral';
-- Expected: apply_referral | f | true (security definer)
-- ──────────────────────────────────────────────────────────────────────────
