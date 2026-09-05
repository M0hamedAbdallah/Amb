-- ─────────────────────────────────────────────────────────────────────────────
-- 0003_revoke_client_writes_and_supporting.sql
-- Phase 3 — Step 1: revoke the client-write policies from 0001 that violate
-- the spec hard-rule "all money movement happens server-side only", and add
-- the supporting schema the SECURITY DEFINER RPCs (0005–0010) will rely on.
-- ─────────────────────────────────────────────────────────────────────────────
-- What this migration does:
--   1. DROP the permissive client-write RLS policies that 0001 added on the
--      money-movement tables: orders UPDATE, wallet_transactions INSERT,
--      withdrawals INSERT. SELECT policies stay (clients still read own rows).
--      INSERT policies on `orders` and `order_ratings` remain (the create_order
--      RPC will be the only path soon; but keep for now so we don't lock the
--      existing client insert during the transition window before 0005 lands).
--   2. CREATE the order_rejections table — replaces the `vendor_note='rejected:...'`
--      hack in the client dispatchService. Only service_role writes here.
--   3. ALTER withdrawals add idempotency_key (unique) — for the
--      request_withdrawal RPC's idempotency header check.
--   4. ALTER orders add dispatch_attempt int default 0 — dispatch loop cursor
--      (replaces parsing vendor_note).
--   5. Enable RLS + service_role-only policy on order_rejections.
-- All idempotent (uses IF EXISTS guards / IF NOT EXISTS / DROP POLICY IF EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Revoke client-write policies on money-movement tables ─────────────────
-- Status UPDATE transitions → handled by verify_delivery, customer_cancel (via
-- RPC); vendor_id assignment → handled by the dispatch-engine Edge Function.
drop policy if exists "Customers can update own orders" on public.orders;

-- All wallet_transactions writes → handled by verify_delivery,
-- request_withdrawal, resolve_complaint (refund) RPCs.
drop policy if exists "Users can insert own wallet txns" on public.wallet_transactions;

-- withdrawals INSERT → handled by request_withdrawal RPC.
drop policy if exists "Users can insert own withdrawals" on public.withdrawals;

-- ─── 2. New table: order_rejections (replaces the vendor_note parser) ────────
create table if not exists public.order_rejections (
  order_id    uuid references public.orders(id) on delete cascade,
  vendor_id   uuid references public.vendors(id) on delete cascade,
  rejected_at timestamptz not null default now(),
  primary key (order_id, vendor_id)
);

comment on table public.order_rejections is
  'Dispatch ledger: tracks which vendors the dispatch-engine has already tried '
  'and either got timeout or explicit rejection from. Replaces the '
  'vendor_note=''rejected:'' hack that the client dispatchService used. Only '
  'service_role / SECURITY DEFINER functions write here.';

-- ─── 3. withdrawals.idempotency_key — for request_withdrawal idempotency ────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='withdrawals'
      and column_name='idempotency_key'
  ) then
    alter table public.withdrawals add column idempotency_key text;
  end if;
end $$;

create unique index if not exists withdrawals_idempotency_key_key
  on public.withdrawals (idempotency_key)
  where idempotency_key is not null;

comment on column public.withdrawals.idempotency_key is
  'Client-supplied idempotency key (UUID v4 per request). The request_withdrawal '
  'RPC uses this to deduplicate accidental double-submissions: ON CONFLICT '
  '(idempotency_key) DO NOTHING. NULL for legacy rows.';

-- ─── 4. orders.dispatch_attempt — dispatch loop cursor ──────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='orders'
      and column_name='dispatch_attempt'
  ) then
    alter table public.orders add column dispatch_attempt int not null default 0;
  end if;
end $$;

comment on column public.orders.dispatch_attempt is
  'Number of dispatch attempts that have fired for this order. The '
  'dispatch-engine Edge Function increments this on each step and stops at '
  'max_dispatch_retries (system_settings).';

-- ─── 5. RLS for order_rejections: service_role only ────────────────────────
alter table public.order_rejections enable row level security;

-- Deny all access from anon + authenticated; allow service_role everywhere
-- (bypasses RLS anyway, but explicit for clarity).
create policy "service_role only on order_rejections"
  on public.order_rejections
  for all
  to service_role
  using (true)
  with check (true);

-- No policies for anon / authenticated → they get zero rows by default under RLS.
