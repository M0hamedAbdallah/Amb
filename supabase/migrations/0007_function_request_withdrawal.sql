-- ──────────────────────────────────────────────────────────────────────────
-- 0007_function_request_withdrawal.sql — Atomic payout debit RPC (SEC DEFINER)
-- ──────────────────────────────────────────────────────────────────────────
-- Replaces `services/walletService.ts → requestWithdrawal`, which:
--   • inserted a pending `withdrawals` row,
--   • inserted a `wallet_transactions` (`type='withdrawal'`) row,
--   • read-modify-wrote `profiles.wallet_balance` with
--       `Math.max(0, current - amount)` — a silent negative-balance bug
--       that lets any fraudulent client spend more than they have,
--   • had no idempotency: a retry / double-tap on the wire inserted two
--       withdrawal rows AND debited twice.
--
-- This RPC performs all three writes inside one transaction guarded by:
--   • `UPDATE profiles SET wallet_balance = wallet_balance - p_amount
--        WHERE id = auth.uid() AND wallet_balance >= p_amount
--        RETURNING wallet_balance`  — atomic debit. Zero rows returned =
--      insufficient funds → entire tx aborts.
--   • `INSERT INTO withdrawals (...) ON CONFLICT (idempotency_key) DO
--      NOTHING RETURNING id` — duplicate calls (same idempotency_key) hit
--      the unique index and return the original row id; we skip everything
--      else on the second hit.
--
-- The `idempotency_key` is required (the client must generate a UUID per
-- user-initiated request, retry with the same key on transient failure).
-- Authorisation is implicit via `auth.uid()` — we never trust a
-- `p_user_id` parameter.
--
-- Returns: jsonb with `{ withdrawal, new_balance }` on success
-- or structued error { error }.
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
  insert into withdrawals (user_id, amount, method, account_ref, status, idempotency_key)
  values (v_user, p_amount, p_method, p_account_ref, 'pending', v_orig_idem)
  on conflict (idempotency_key) do nothing
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

grant execute on function public.request_withdrawal(numeric, text, text, text)
  to anon, authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification (run after applying):
--   select proname, prokind, prosecdef from pg_proc
--   where proname='request_withdrawal';
-- Expected: request_withdrawal | f | true (security definer)
-- ──────────────────────────────────────────────────────────────────────────
