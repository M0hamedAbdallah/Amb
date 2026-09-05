-- ─────────────────────────────────────────────────────────────────────────
-- 0012_seed_test_vendors.sql  —  TEST DATA ONLY  —  REMOVE BEFORE LAUNCH
-- ─────────────────────────────────────────────────────────────────────────
-- Purpose: Insert 5 fake vendor rows clustered near Downtown Cairo so the
--          RN home screen can exercise `getNearbyVendors`, dispatch, and the
--          full order flow during emulator testing with the verified
--          customer `01014775843`.
--
-- !!! TEST DATA ONLY !!!
--   • user_id values are synthetic UUIDv4 (do NOT correspond to any real
--     auth.users entry; they point only to the synthetic profiles inserted
--     here, which themselves point to synthetic auth.users rows)
--   • business names are obviously fake ("[TEST] …")
--   • `test_seed_markers` makes cleanup unambiguous later
--   • NO row here should ship to production. Cleanup migration is the
--     sibling file `0013_remove_test_seed_vendors.sql` which I do NOT
--     apply until you confirm we're done testing.
--
-- Cluster center: Downtown Cairo (Tahrir Sq) — (30.0444, 31.2357)
-- Vendor offsets and ratings are chosen to exercise the getNearbyVendors
-- sort algorithm (`vendorServiceScore` = 0.6*distScore + 0.25*ratingScore +
-- 0.15*priceScore, premium first):
--   #1 Tahrir     – premium, ★4.9, mid-high price, fastest ETA  -> sort 1
--   #2 Abdeen     – verified,  ★4.7, highest price, fast ETA    -> sort 2
--   #3 Boulaq     – verified,  ★3.9, lowest price, slow ETA     -> sort 4
--   #4 Zamalek    – verified,  ★4.5, mid prices, mid ETA        -> sort 3
--   #5 Old Cairo  – verified,  ★3.5, mid-low prices, widest radius -> sort 5
-- ─────────────────────────────────────────────────────────────────────────

-- Marker table (idempotent — uses IF NOT EXISTS so re-runs are safe).
create table if not exists public.test_seed_markers (
    vendor_id uuid primary key references public.vendors(id) on delete cascade,
    seeded_for text not null,
    seeded_at timestamptz not null default now(),
    note text
);
alter table public.test_seed_markers enable row level security;
do $$ begin
    if not exists (
        select 1 from pg_policies
        where schemaname='public' and tablename='test_seed_markers'
          and policyname='service_role only on test_seed_markers'
    ) then
        create policy "service_role only on test_seed_markers"
            on public.test_seed_markers for all
            using (auth.role() = 'service_role')
            with check (auth.role() = 'service_role');
    end if;
end $$;

-- 5 synthetic auth.users rows (NOT real users — these have password "x" and
-- will never log in; they satisfy the auth.users FK on profiles.id).
insert into auth.users
( id, instance_id, aud, role, email, encrypted_password
, email_confirmed_at, phone, phone_confirmed_at
, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
, is_sso_user, is_anonymous )
select * from (values
 ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'testvendor1@example.invalid', 'x',
  now(), '201000000001', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false, false),
 ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'testvendor2@example.invalid', 'x',
  now(), '201000000002', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false, false),
 ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'testvendor3@example.invalid', 'x',
  now(), '201000000003', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false, false),
 ('44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'testvendor4@example.invalid', 'x',
  now(), '201000000004', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false, false),
 ('55555555-5555-5555-5555-555555555555', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'testvendor5@example.invalid', 'x',
  now(), '201000000005', now(), now(), now(), '{}'::jsonb, '{}'::jsonb, false, false)
) as t(id, instance_id, aud, role, email, encrypted_password,
       email_confirmed_at, phone, phone_confirmed_at,
       created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
       is_sso_user, is_anonymous)
on conflict (id) do nothing;

-- 5 matching synthetic profiles.
insert into public.profiles (id, phone, name, role, wallet_balance, is_active)
select * from (values
 ('11111111-1111-1111-1111-111111111111', '201000000001',
  'Test Vendor — Cairo Premium Water', 'vendor', 0::numeric, true),
 ('22222222-2222-2222-2222-222222222222', '201000000002',
  'Test Vendor — Nile Bouzada', 'vendor', 0::numeric, true),
 ('33333333-3333-3333-3333-333333333333', '201000000003',
  'Test Vendor — El Fool El Sokary', 'vendor', 0::numeric, true),
 ('44444444-4444-4444-4444-444444444444', '201000000004',
  'Test Vendor — Zamalek DropWater', 'vendor', 0::numeric, true),
 ('55555555-5555-5555-5555-555555555555', '201000000005',
  'Test Vendor — Masr El Qadima Water', 'vendor', 0::numeric, true)
) as t(id, phone, name, role, wallet_balance, is_active)
on conflict (id) do nothing;

-- 5 vendor rows clustered around Tahrir Sq (30.0444, 31.2357).
insert into public.vendors (
    user_id, business_name, address, lat, lng,
    small_price, large_price, small_stock, large_stock,
    rating, total_ratings, is_active, is_verified, is_premium,
    delivery_radius_km, avg_delivery_mins, warnings_count, suspended_until
) values
('11111111-1111-1111-1111-111111111111',
 '[TEST] Cairo Premium Water وادي النيل', 'Tahrir Square, Qasr El Nil, Cairo',
 30.0444, 31.2357, 40.00, 75.00, 50, 30, 4.9, 142,
 true, true, true, 12, 25, 0, null),
('22222222-2222-2222-2222-222222222222',
 '[TEST] Nile Bouzada بوزا النيل', '26 July St, Downtown Cairo',
 30.0508, 31.2425, 45.00, 80.00, 25, 20, 4.7, 88,
 true, true, false, 10, 20, 0, null),
('33333333-3333-3333-3333-333333333333',
 '[TEST] El Fool El Sokary فول السكري', 'Boulaq Abul Ela, Cairo',
 30.0606, 31.2273, 30.00, 60.00, 60, 40, 3.9, 51,
 true, true, false, 8, 45, 0, null),
('44444444-4444-4444-4444-444444444444',
 '[TEST] Zamalek DropWater زمزمك', '26th of July Corridor, Zamalek',
 30.0606, 31.2153, 38.00, 68.00, 35, 25, 4.5, 64,
 true, true, false, 10, 35, 0, null),
('55555555-5555-5555-5555-555555555555',
 '[TEST] Masr El Qadima Water ماء مصر القديمة', 'Old Cairo, near Coptic Cairo',
 30.0030, 31.2300, 35.00, 70.00, 40, 30, 3.5, 23,
 true, true, false, 15, 50, 0, null)
on conflict do nothing;

-- Tag each as a test seed for unambiguous cleanup later.
insert into public.test_seed_markers (vendor_id, seeded_for, note)
select v.id, '01014775843_emulator_test',
       'TEST SEED — drop via 0013_remove_test_seed_vendors.sql before launch'
from public.vendors v
where v.user_id in (
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    '55555555-5555-5555-5555-555555555555'
)
on conflict (vendor_id) do nothing;

-- Verification hint:
-- select count(*) from vendors v join test_seed_markers m on m.vendor_id=v.id
-- where m.seeded_for='01014775843_emulator_test';
