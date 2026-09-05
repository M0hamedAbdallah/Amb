-- ──────────────────────────────────────────────────────────────────────────
-- 0018_fix_request_withdrawal_idempotency_arbiter.sql
-- ──────────────────────────────────────────────────────────────────────────
-- Bug surfaced by the 2026-07-30 live-flow walkthrough (Step 5):
--
--   RPC `public.request_withdrawal` raises the following error for EVERY
--   invocation, blocking all payouts:
--
--     42P10: there is no unique or exclusion constraint matching the ON
--     CONFLICT specification
--
-- Root cause:
--   Migration 0003 declared the dedup arbiter as a PARTIAL unique index:
--
--     create unique index withdrawals_idempotency_key_key
--       on public.withdrawals (idempotency_key)
--       where idempotency_key is not null;
--
--   But the function body in 0007 issues:
--
--     insert into withdrawals (...) values (...)
--     on conflict (idempotency_key) do nothing
--     returning id into v_withdrawal_id;
--
--   Postgres will not infer a partial unique index as the ON CONFLICT arbiter
--   unless the `ON CONFLICT (...) WHERE <partial_predicate>` clause is given
--   verbatim. Since the function only inserts non-NULL `idempotency_key`
--   values (it rejects empty/null keys up-front at line 60-63), we have two
--   safe options:
--
--     A) keep the partial index; append the predicate to the ON CONFLICT.
--     B) drop the partial index, create a full UNIQUE INDEX on the column.
--        PostgreSQL UNIQUE allows multiple NULLs (treats them as distinct),
--        so this is behaviourally equivalent for NULL inserts.
--
--   We pick (A): it leaves migration 0003's index untouched, doesn't widen
--   the dedup scope to legacy NULL-keyed rows (defensive — there shouldn't
--   be any since the RPC rejects them, but a defensive maintainer could have
--   written NULL keyed rows directly via SQL), and is the minimum-blast-radius
--   patch.
--
-- Verification:
--   After applying this migration, the walkthrough's Step 5 should return:
--     Call #1 → {"withdrawal": {"id": "<uuid>", "status": "pending"},
--                 "new_balance": <balance - amount>}
--     Call #2 (SAME key) → {"withdrawal": {"id": "<same uuid>", "replay": true},
--                           "new_balance": <unchanged>}
--   and the `withdrawals` table should hold exactly ONE row for that key.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.request_withdrawal(
  p_amount           numeric,
  p_method           text,
  p_account_ref      text default null,
  p_idempotency_key  text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, cron, net
as $$
declare
  v_user          uuid := auth.uid();
  v_new_balance   numeric(10,2);
  v_withdrawal_id uuid;
  v_existing_id   uuid;
  v_method_label  text;
  v_orig_idem     text := coalesce(p_idempotency_key, '');
  v_method_map    text;
  v_existing_tx   uuid;
begin
  if v_user is null then return jsonb_build_object('error', 'auth_required'); end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('error', 'invalid_amount');
  end if;
  -- Bank/pay-to method validation (mirror the client's MODE enum)
  if p_method not in ('vodafone_cash','etisalat_cash','orange_money','instapay') then
    return jsonb_build_object('error', 'invalid_method');
  end if;
  if v_orig_idem = '' then
    -- Idempotency key is mandatory on this RPC. We refuse to operate without one.
    return jsonb_build_object('error', 'idempotency_key_required');
  end if;
  if p_idempotency_key is not null and length(p_idempotency_key) > 256 then
    return jsonb_build_object('error', 'idempotency_key_too_long');
  end if;

  -- Idempotency check: is there already a successful withdrawal with this key?
  select id into v_existing_id
    from withdrawals
    where idempotency_key = v_orig_idem
    limit 1;
  if v_existing_id is not null then
    -- Re-entrant call: return the original outcome instead of double-debiting.
    select wallet_balance into v_new_balance
      from profiles where id = v_user;
    return jsonb_build_object(
      'withdrawal',  jsonb_build_object('id', v_existing_id, 'replay', true),
      'new_balance', v_new_balance
    );
  end if;

  -- Atomic debit. If the user's balance can't cover p_amount the UPDATE
  -- matches zero rows and RETURNING yields nothing — we exit here, no
  -- withdrawal row created. This is the critical counter-fraud guard.
  update profiles
    set wallet_balance = wallet_balance - p_amount
    where id = v_user
      and wallet_balance >= p_amount
    returning wallet_balance into v_new_balance;

  if not found then
    return jsonb_build_object('error', 'insufficient_balance');
  end if;

  -- Insert the withdrawals row with the idempotency_key. The unique partial
  -- index `withdrawals_idempotency_key_key` from 0003 enforces single-use.
  -- Even if a parallel txn somehow got past the SELECT above, the unique
  -- index catches it here and we return the original outcome without re-debiting.
  --
  -- FIX (0018): the partial-index predicate (`WHERE idempotency_key IS NOT NULL`)
  -- MUST be repeated in the ON CONFLICT clause, or Postgres raises SQLSTATE 42P10
  -- ("no unique or exclusion constraint matching the ON CONFLICT specification")
  -- and refuses to infer the partial index as the dedup arbiter. We asserted
  -- `v_orig_idem <> ''` above, so the value is guaranteed non-NULL here.
  insert into withdrawals (user_id, amount, method, account_ref, status, idempotency_key)
  values (v_user, p_amount, p_method, p_account_ref, 'pending', v_orig_idem)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_withdrawal_id;

  if v_withdrawal_id is null then
    -- Lost the race on the unique key. Roll back the debit so the user's
    -- balance is unchanged, then return the prior outcome.
    update profiles set wallet_balance = wallet_balance + p_amount where id = v_user;
    select wallet_balance into v_new_balance from profiles where id = v_user;
    select id into v_withdrawal_id from withdrawals where idempotency_key = v_orig_idem;
    return jsonb_build_object(
      'withdrawal',  jsonb_build_object('id', v_withdrawal_id, 'replay', true),
      'new_balance', v_new_balance
    );
  end if;

  -- Method labels mirror the client map (Arabic display text)
  v_method_label := case p_method
    when 'vodafone_cash'  then 'فودافون كاش'
    when 'etisalat_cash'  then 'اتصالات كاش'
    when 'orange_money'  then 'أورانج موني'
    when 'instapay'      then 'إنستا باي'
    else p_method
  end;

  insert into wallet_transactions (user_id, type, amount, description, order_id)
  values (v_user, 'withdrawal', p_amount,
    concat('طلب سحب — ', v_method_label), null);

  return jsonb_build_object(
    'withdrawal',  jsonb_build_object('id', v_withdrawal_id, 'status', 'pending'),
    'new_balance', v_new_balance
  );
exception
  when others then
    return jsonb_build_object('error', sqlstate, 'message', sqlerrm);
end;
$$;

-- Re-grant (CREATE OR REPLACE FUNCTION preserves existing grants, but be explicit
-- in case the function signature was dropped/recreated by an admin tool).
grant execute on function public.request_withdrawal(numeric, text, text, text)
  to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecdef from pg_proc
--   where proname='request_withdrawal';
-- Expected: request_withdrawal | f | true (security definer)
--
-- Live-flow check (use any test vendor with non-zero wallet_balance):
--   -- call #1 (idempotency_key='probe-0018-1')
--   -- call #2 (same key)
--   -- assert: call #2 returns { "withdrawal": { "replay": true }, ... }
--   -- and withdrawals has exactly 1 row for 'probe-0018-1'
-- ──────────────────────────────────────────────────────────────────────────
