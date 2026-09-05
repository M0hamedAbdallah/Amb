-- ─────────────────────────────────────────────────────────────────────────
-- 0013_remove_test_seed_vendors.sql  —  TEST DATA CLEANUP
-- ─────────────────────────────────────────────────────────────────────────
-- Companion to 0012_seed_test_vendors.sql. Removes only the rows that
-- 0012 inserted (identified unambiguously via test_seed_markers, NOT by
-- matching on business_name — to avoid any risk of deleting a legit vendor).
--
-- !!! DO NOT APPLY YET !!!
--   Apply this only when you confirm we're done testing the home screen /
--   order flow on the emulator. Once applied, the home screen will again
--   show "no vendors available" (or whatever real vendors exist on the
--   platform at that point).
--
-- What gets removed:
--   • the 5 vendors (their FK is ON DELETE CASCADE so test_seed_markers rows
--     referencing them drop automatically)
--   • the 5 synthetic profiles rows
--   • the 5 synthetic auth.users rows
--   • an empty `test_seed_markers` table left in place intentionally, plus
--     the row-level security policy. (Dropping a populated table confuses
--     migration replay; we just leave the marker metadata.)
--     If you want a fully clean slate, run the optional DROP at the bottom.
-- ─────────────────────────────────────────────────────────────────────────

do $$
declare
    v_user_id uuid;
    marker_rec record;
begin
    -- Walk each marked seed vendor and remove related rows in FK order.
    for marker_rec in
        select v.id as vendor_id, v.user_id
        from public.vendors v
        join public.test_seed_markers m on m.vendor_id = v.id
        where m.seeded_for = '01014775843_emulator_test'
    loop
        -- 1. delete vendor row (cascades: test_seed_markers row drops via FK)
        delete from public.vendors where id = marker_rec.vendor_id;

        -- 2. delete synthetic profile row
        delete from public.profiles where id = marker_rec.user_id;

        -- 3. delete synthetic auth.users row
        delete from auth.users where id = marker_rec.user_id;
    end loop;

    -- Sanity: marker table should now be empty.
    raise notice 'test_seed_markers cleanup complete; rows remaining: %',
        (select count(*) from public.test_seed_markers);
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- OPTIONAL fully-clean slate — uncomment to drop the marker table itself.
-- Drop only if you want NO trace of the test-seed mechanism on the live DB.
-- (Usually you'd leave it in place so future test seeds can reuse it.)
-- ─────────────────────────────────────────────────────────────────────────
-- drop table if exists public.test_seed_markers cascade;

-- ─────────────────────────────────────────────────────────────────────────
-- Verification query — should return 0 once cleanup is applied.
-- ─────────────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from public.vendors where business_name like '[TEST]%') as
-- remaining_test_vendors,
--   (select count(*) from public.test_seed_markers) as remaining_markers;
