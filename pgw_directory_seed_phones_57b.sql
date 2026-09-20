-- =====================================================================
-- PGW Support Portal — Directory: the two held-back main numbers
-- Run AFTER pgw_directory_seed_phones_57a.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- 57a loaded every store's Marchex number but left TWO stores without a
-- main number, because BDC's workbook gave both the same one
-- (843-881-6250) and they are in different towns. The user resolved it
-- 2026-09-20:
--
--   #5253 Midas North Main St  ->  843-900-0727   (its own number)
--   #3287 Midas Mt Pleasant    ->  843-881-6250   (the number the sheet
--                                  repeated onto North Main)
--
-- The user first gave North Main's number as 803.900.0727. 803 is the
-- Columbia area code and #5253 is in Summerville, where every other
-- store -- including its own Marchex line, 843-900-6453 -- is on 843;
-- the user confirmed 843. Recorded here because the digits themselves
-- are unchanged and the difference would otherwise look like a typo in
-- this file rather than a decision.
--
-- After this, all 38 directory stores have both numbers.
-- =====================================================================

begin;

with seed (store_number, main_phone) as (
  values
    ('5253', '8439000727'),  -- North Main St (Summerville)
    ('3287', '8438816250')   -- Mt Pleasant
)
update public.locations l
   set main_phone = s.main_phone
  from seed s
 where l.store_number = s.store_number;

commit;


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Every non-sandbox store now has both numbers (expect 38/38/38):
--        select count(*) as stores, count(main_phone) as with_main,
--               count(marchex_phone) as with_marchex
--          from public.locations where not is_sandbox;
--
--  [2] No main number is shared by two stores any more (expect 0 rows):
--        select main_phone, count(*) from public.locations
--         where not is_sandbox and main_phone is not null
--         group by 1 having count(*) > 1;
--
--  [3] The two stores read as intended:
--        select store_number, name, main_phone, marchex_phone
--          from public.locations where store_number in ('3287', '5253');
-- =====================================================================
