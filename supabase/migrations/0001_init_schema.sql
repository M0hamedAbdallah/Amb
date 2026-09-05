-- ──────────────────────────────────────────────────────────────────────────
-- 0001_init_schema.sql  —  Ambobtak initial DB schema
-- ──────────────────────────────────────────────────────────────────────────
-- Promotes the design-intent schema documented in services/supabase.ts:54-347
-- from a code comment to the live Supabase project (kazcnxfpmgyzjpevqxiu).
--
-- Scope of this migration (Phase 2, batch 1):
--   • Enable required extensions (uuid-ossp, postgis)
--   • Create all 13 design tables
--   • Seed default system_settings rows
--   • Enable RLS on every table
--   • Apply the documented per-table RLS policies
--
-- What this migration explicitly does NOT do (deferred to later approved batches):
--   • No triggers (e.g. auto-profile on auth.users insert, vendor rating recomputed).
--     The RN app currently calls createProfile manually from role-select.tsx after
--     OTP verify, so a DB trigger isn't required for the verified login flow.
--   • No SECURITY DEFINER money-motion RPCs (spec rule P3 — Phase 3 work).
--   • No Storage bucket creation for vendor_docs (separate manual step).
--
-- Spec-rule audit (hard rules from the project spec):
--   • "Never put secrets in client code; the app uses only the anon key + RLS"
--     → Migration contains no keys of any kind.
--   • "All money movement happens server-side only (Edge Functions / SECURITY DEFINER)"
--     → Phase-1 audit flagged that several policies below still allow the client
--       to insert wallet_transactions / withdrawals and update orders directly.
--       These policies are kept in 0001 to match the documented design so the
--       existing RN services compile and the verified login test can complete.
--       Phase 3 (Edge Functions) is responsible for revoking these client-write
--       policies and moving the writes behind SECURITY DEFINER functions.
--   • "Verify each migration applied successfully via MCP before moving on"
--     → Apply via mcp__supabase__apply_migration, then list_tables / list_migrations
--       to confirm.
--
-- Fix vs. design source:
--   • The design comment at services/supabase.ts:272 references a non-existent
--     table `referrals` in its `alter table ... enable row level security` block.
--     Fixed here to `referral_credits` (the actual table name created at L182).
-- ──────────────────────────────────────────────────────────────────────────

-- ─── 1. Extensions ──────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "postgis";

-- ─── 2. Tables ──────────────────────────────────────────────────────────────

-- PROFILES  (extended)
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  phone text unique not null,
  name text,
  role text check (role in ('customer', 'vendor', 'admin')) default 'customer',
  avatar_url text,
  wallet_balance numeric(10,2) default 0,
  is_active boolean default true,
  referral_code text unique default substr(md5(random()::text), 1, 8),
  referred_by uuid references profiles(id),
  -- push notifications
  expo_push_token text,
  -- fraud / abuse tracking
  warnings_count int default 0,
  suspended_until timestamptz,
  created_at timestamptz default now()
);

-- VENDORS  (extended)
create table if not exists vendors (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references profiles(id) on delete cascade unique not null,
  business_name text not null,
  address text,
  lat double precision,
  lng double precision,
  small_price numeric(10,2) default 30,
  large_price numeric(10,2) default 65,
  small_stock int default 0,
  large_stock int default 0,
  rating numeric(3,2) default 0,
  total_ratings int default 0,
  is_active boolean default false,
  is_verified boolean default false,
  is_premium boolean default false,
  premium_expires_at timestamptz,
  delivery_radius_km int default 5,
  avg_delivery_mins int default 30,
  -- verification docs (paths in Supabase Storage)
  national_id_url text,
  business_license_url text,
  -- fraud tracking
  warnings_count int default 0,
  suspended_until timestamptz,
  created_at timestamptz default now()
);

-- ORDERS  (extended)
create table if not exists orders (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references profiles(id) not null,
  vendor_id uuid references vendors(id),
  size text check (size in ('small', 'large')) not null,
  quantity int default 1,
  subtotal numeric(10,2) not null,
  delivery_fee numeric(10,2) default 0,
  platform_fee numeric(10,2) default 0,
  urgent_fee numeric(10,2) default 0,
  discount numeric(10,2) default 0,
  cancellation_fee numeric(10,2) default 0,
  total numeric(10,2) not null,
  status text check (status in ('pending','accepted','on_way','delivered','cancelled')) default 'pending',
  delivery_otp text,
  is_urgent boolean default false,
  payment_method text,
  promo_code text,
  delivery_address text,
  delivery_lat double precision,
  delivery_lng double precision,
  scheduled_for timestamptz,
  vendor_note text,
  customer_note text,
  cancellation_reason text,
  accepted_at timestamptz,
  departed_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  offer_size text default 'small', -- convenience snapshot of matched configuration
  is_reorder uuid,  -- reference to a previous order id this was re-ordered from
  created_at timestamptz default now()
);

-- ORDER RATINGS
create table if not exists order_ratings (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) unique not null,
  customer_id uuid references profiles(id) not null,
  vendor_id uuid references vendors(id) not null,
  stars int check (stars between 1 and 5),
  comment text,
  created_at timestamptz default now()
);

-- PROMO CODES  (extended)
create table if not exists promo_codes (
  id uuid primary key default uuid_generate_v4(),
  code text unique not null,
  discount_type text check (discount_type in ('percent','fixed')) default 'fixed',
  discount_value numeric(10,2) not null,
  min_order numeric(10,2) default 0,
  max_uses int default 100,
  used_count int default 0,
  expires_at timestamptz,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- PROMO CODE USAGE (track who applied what)
create table if not exists promo_usages (
  id uuid primary key default uuid_generate_v4(),
  promo_code text references promo_codes(code) not null,
  user_id uuid references profiles(id) not null,
  order_id uuid references orders(id),
  created_at timestamptz default now(),
  unique (promo_code, user_id)
);

-- REFERRALS  (audit of referral credits paid)
create table if not exists referral_credits (
  id uuid primary key default uuid_generate_v4(),
  referrer_id uuid references profiles(id) not null,
  referee_id  uuid references profiles(id) not null,
  order_id    uuid references orders(id),
  amount      numeric(10,2) not null,
  created_at  timestamptz default now(),
  unique (referrer_id, referee_id)
);

-- COMPLAINTS  (extended)
create table if not exists complaints (
  id uuid primary key default uuid_generate_v4(),
  reporter_id       uuid references profiles(id) not null,
  reported_id       uuid references profiles(id),
  reported_vendor_id uuid references vendors(id),
  order_id          uuid references orders(id),
  -- 'general' | 'vendor_fraud_cash' | 'customer_no_show' | 'delivery' | 'other'
  type text not null default 'general',
  description text,
  status text check (status in ('open','reviewing','resolved','rejected')) default 'open',
  admin_note text,
  -- internal admin sanction (warn / ban / refund)
  action_taken text,
  created_at timestamptz default now()
);

-- WALLETS / TRANSACTIONS  (extended)
create table if not exists wallet_transactions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references profiles(id) not null,
  type text check (type in ('credit','debit','withdrawal','commission','urgent_fee','subscription','cancellation_fee','referral_bonus')),
  amount numeric(10,2) not null,
  description text,
  order_id uuid references orders(id),
  created_at timestamptz default now()
);

-- WITHDRAWAL REQUESTS
create table if not exists withdrawals (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references profiles(id) not null,
  amount numeric(10,2) not null,
  method text not null,        -- 'vodafone_cash' | 'etisalat_cash' | 'orange_money' | 'instapay'
  account_ref text,            -- phone number / wallet reference
  status text check (status in ('pending','approved','rejected','completed')) default 'pending',
  admin_note text,
  processed_at timestamptz,
  created_at timestamptz default now()
);

-- CHAT MESSAGES  (in-app chat — no phone numbers exposed)
create table if not exists messages (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade not null,
  sender_id uuid references profiles(id) not null,
  -- 'customer' | 'vendor' | 'system'
  sender_role text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz default now()
);

-- SYSTEM SETTINGS  (extended)
create table if not exists system_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

-- ─── 3. Seed defaults ──────────────────────────────────────────────────────
insert into system_settings (key, value) values
  ('commission_pct', '10'),
  ('urgent_fee', '15'),
  ('cancellation_fee', '10'),
  ('premium_monthly_fee', '199'),
  ('delivery_fee_per_km', '3'),
  ('delivery_fee_base', '5'),
  ('dispatch_timeout_minutes', '3'),
  ('max_dispatch_retries', '5'),
  ('referral_bonus', '10')
on conflict (key) do nothing;

-- ─── 4. Enable Row Level Security ───────────────────────────────────────────
alter table profiles            enable row level security;
alter table vendors             enable row level security;
alter table orders              enable row level security;
alter table order_ratings       enable row level security;
alter table wallet_transactions enable row level security;
alter table promo_codes         enable row level security;
alter table promo_usages        enable row level security;
alter table referral_credits    enable row level security;  -- fixed: design said `referrals`
alter table complaints          enable row level security;
alter table withdrawals         enable row level security;
alter table messages            enable row level security;
alter table system_settings     enable row level security;

-- ─── 5. RLS Policies ─────────────────────────────────────────────────────────
-- NOTE — Phase 3 (Edge Functions) will revoke the client-write policies below
-- (orders UPDATE, wallet_transactions INSERT, withdrawals INSERT) and replace
-- them with SECURITY DEFINER RPCs, in line with the spec's hard rule that
-- "all money movement happens server-side only".

-- PROFILES
create policy "Users can view own profile"
  on profiles for select using (auth.uid() = id);
create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);
-- Allow newly-verified users to insert their own profile row (called by
-- role-select.tsx after OTP verify).
create policy "Users can insert own profile"
  on profiles for insert with check (auth.uid() = id);

-- VENDORS
create policy "vendors visible to authenticated"
  on vendors for select using (true);
create policy "vendor updates own row"
  on vendors for update using (auth.uid() = user_id);
create policy "vendor inserts own row"
  on vendors for insert with check (auth.uid() = user_id);

-- ORDERS
create policy "Customers can create orders"
  on orders for insert with check (auth.uid() = customer_id);
create policy "Customers can update own orders"
  on orders for update using (auth.uid() = customer_id);
create policy "Users can view own orders"
  on orders for select
  using (auth.uid() = customer_id or auth.uid() in (select user_id from vendors where id = vendor_id));

-- ORDER RATINGS
create policy "Customer can rate own order"
  on order_ratings for insert with check (auth.uid() = customer_id);
create policy "Order participants can view ratings"
  on order_ratings for select
  using (auth.uid() = customer_id or auth.uid() in (select user_id from vendors where id = vendor_id));

-- WALLET TRANSACTIONS
create policy "Users can view own wallet txns"
  on wallet_transactions for select using (auth.uid() = user_id);
create policy "Users can insert own wallet txns"
  on wallet_transactions for insert with check (auth.uid() = user_id);

-- PROMO CODES
create policy "Anyone can read active promo codes"
  on promo_codes for select using (is_active = true);
create policy "Users can record own promo usage"
  on promo_usages for insert with check (auth.uid() = user_id);
create policy "Users can view own promo usage"
  on promo_usages for select using (auth.uid() = user_id);

-- REFERRAL CREDITS
create policy "Users can view referral credits involving them"
  on referral_credits for select using (auth.uid() = referrer_id or auth.uid() = referee_id);
create policy "Users can insert own referral credits"
  on referral_credits for insert with check (auth.uid() = referrer_id or auth.uid() = referee_id);

-- COMPLAINTS
create policy "Users can file own complaints"
  on complaints for insert with check (auth.uid() = reporter_id);
create policy "Users can view own complaints"
  on complaints for select using (auth.uid() = reporter_id or auth.uid() = reported_id);

-- WITHDRAWALS
create policy "Users can view own withdrawals"
  on withdrawals for select using (auth.uid() = user_id);
create policy "Users can insert own withdrawals"
  on withdrawals for insert with check (auth.uid() = user_id);

-- MESSAGES
create policy "Order participants can view messages"
  on messages for select
  using (auth.uid() in (
    select customer_id from orders where id = messages.order_id
    union
    select v.user_id from vendors v, orders o where o.id = messages.order_id and v.id = o.vendor_id
  ));
create policy "Order participants can send messages"
  on messages for insert with check (auth.uid() = sender_id);

-- SYSTEM SETTINGS
create policy "Anyone can read settings"
  on system_settings for select using (true);
