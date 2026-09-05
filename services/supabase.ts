import 'react-native-url-polyfill/auto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    // Return a no-op proxy so imports don't crash at module load time
    // All calls will gracefully fail until env vars are configured
    return {
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signInWithOtp: async () => ({ data: {}, error: { message: 'Supabase not configured' } }),
        verifyOtp: async () => ({ data: {}, error: { message: 'Supabase not configured' } }),
        signOut: async () => ({ error: null }),
      },
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }), data: null, error: null }), single: async () => ({ data: null, error: null }), order: () => ({ limit: async () => ({ data: [], error: null }), data: [], error: null }), data: [], error: null }),
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
        update: () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }), data: null, error: null }) }),
        delete: () => ({ eq: async () => ({ data: null, error: null }) }),
        upsert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
      }),
      channel: () => ({ on: () => ({ subscribe: () => {} }) }),
      removeChannel: () => {},
    } as unknown as SupabaseClient;
  }

  _supabase = createClient(url, key, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });

  return _supabase;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabase() as any)[prop];
  },
});

/*
 * =============================================
 * SUPABASE DATABASE SCHEMA — Run in SQL Editor
 * =============================================

-- Enable necessary extensions
create extension if not exists "uuid-ossp";
create extension if not exists "postgis";

-- PROFILES  (extended)
create table profiles (
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
create table vendors (
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
create table orders (
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
create table order_ratings (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) unique not null,
  customer_id uuid references profiles(id) not null,
  vendor_id uuid references vendors(id) not null,
  stars int check (stars between 1 and 5),
  comment text,
  created_at timestamptz default now()
);

-- PROMO CODES  (extended)
create table promo_codes (
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
create table promo_usages (
  id uuid primary key default uuid_generate_v4(),
  promo_code text references promo_codes(code) not null,
  user_id uuid references profiles(id) not null,
  order_id uuid references orders(id),
  created_at timestamptz default now(),
  unique (promo_code, user_id)
);

-- REFERRALS  (audit of referral credits paid)
create table referral_credits (
  id uuid primary key default uuid_generate_v4(),
  referrer_id uuid references profiles(id) not null,
  referee_id  uuid references profiles(id) not null,
  order_id    uuid references orders(id),
  amount      numeric(10,2) not null,
  created_at  timestamptz default now(),
  unique (referrer_id, referee_id)
);

-- COMPLAINTS  (extended)
create table complaints (
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
create table wallet_transactions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references profiles(id) not null,
  type text check (type in ('credit','debit','withdrawal','commission','urgent_fee','subscription','cancellation_fee','referral_bonus')),
  amount numeric(10,2) not null,
  description text,
  order_id uuid references orders(id),
  created_at timestamptz default now()
);

-- WITHDRAWAL REQUESTS
create table withdrawals (
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
create table messages (
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
create table system_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

insert into system_settings values
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

-- ---------- Row Level Security ----------
alter table profiles enable row level security;
alter table vendors enable row level security;
alter table orders enable row level security;
alter table order_ratings enable row level security;
alter table wallet_transactions enable row level security;
alter table promo_codes enable row level security;
alter table promo_usages enable row level security;
alter table referrals enable row level security;
alter table complaints enable row level security;
alter table withdrawals enable row level security;
alter table messages enable row level security;
alter table system_settings enable row level security;

-- Policies
create policy "Users can view own profile"
  on profiles for select using (auth.uid() = id);
create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

-- Vendors visible to authenticated users (for nearby vendor listing);
-- vendors can view/update their own row.
create policy "vendors visible to authenticated"
  on vendors for select using (true);
create policy "vendor updates own row"
  on vendors for update using (auth.uid() = user_id);

create policy "Customers can create orders"
  on orders for insert with check (auth.uid() = customer_id);
create policy "Customers can update own orders"
  on orders for update using (auth.uid() = customer_id);
create policy "Users can view own orders"
  on orders for select
  using (auth.uid() = customer_id or auth.uid() in (select user_id from vendors where id = vendor_id));

create policy "Customer can rate own order"
  on order_ratings for insert with check (auth.uid() = customer_id);
create policy "Order participants can view ratings"
  on order_ratings for select
  using (auth.uid() = customer_id or auth.uid() in (select user_id from vendors where id = vendor_id));

create policy "Users can view own wallet txns"
  on wallet_transactions for select using (auth.uid() = user_id);
create policy "Users can insert own wallet txns"
  on wallet_transactions for insert with check (auth.uid() = user_id);

create policy "Anyone can read active promo codes"
  on promo_codes for select using (is_active = true);
create policy "Users can record own promo usage"
  on promo_usages for insert with check (auth.uid() = user_id);
create policy "Users can view own promo usage"
  on promo_usages for select using (auth.uid() = user_id);

create policy "Users can view referral credits involving them"
  on referral_credits for select using (auth.uid() = referrer_id or auth.uid() = referee_id);

create policy "Users can file own complaints"
  on complaints for insert with check (auth.uid() = reporter_id);
create policy "Users can view own complaints"
  on complaints for select using (auth.uid() = reporter_id or auth.uid() = reported_id);

create policy "Users can view own withdrawals"
  on withdrawals for select using (auth.uid() = user_id);
create policy "Users can insert own withdrawals"
  on withdrawals for insert with check (auth.uid() = user_id);

create policy "Order participants can view messages"
  on messages for select
  using (auth.uid() in (
    select customer_id from orders where id = messages.order_id
    union
    select v.user_id from vendors v, orders o where o.id = messages.order_id and v.id = o.vendor_id
  ));
create policy "Order participants can send messages"
  on messages for insert with check (auth.uid() = sender_id);

create policy "Anyone can read settings"
  on system_settings for select using (true);

-- ---------- Recommended DB triggers ----------
-- (Skipped here for brevity; same logic is mirrored in the TypeScript
--  services so the app remains functional without installer DB triggers.)

*/

export default supabase;
