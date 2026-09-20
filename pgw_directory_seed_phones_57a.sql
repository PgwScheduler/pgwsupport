-- =====================================================================
-- PGW Support Portal — Directory v1.1 SEED: store phones + service types
-- Run AFTER pgw_directory_v11_57.sql, in the SQL Editor.
-- Safe to re-run (it restores BDC's values over any later hand edit).
-- =====================================================================
-- Source: Store_Phone_Numbers_Main_and_Marchex.xlsx (BDC, 2026-09-20),
-- as supplied by the user with the draft seed BDC's tool produced.
--
-- THREE CHANGES TO THE DRAFT, ALL DELIBERATE
--
-- 1. 3309 -> 3009. The draft's own comment flags it: the roster has
--    SpeeDee Summerville as #3009 and no store 3309 exists, so that row
--    updated nothing and #3009 would have been the one store left
--    without a phone. Loaded as 3009.
--
-- 2. #3287 Mt Pleasant and #5253 North Main were given the SAME main
--    number, 843-881-6250 (flagged in the draft). They are different
--    towns, so at most one can be right. Their MAIN numbers are NOT
--    loaded; their Marchex numbers are unambiguous and ARE loaded.
--    Both are listed at the bottom of this file for BDC to confirm.
--
-- 3. updated_at is set by the trigger added in migration 57, not by
--    this file.
--
-- STILL OPEN FOR BDC (loaded as supplied, nothing invented): five
-- stores whose Marchex number is identical to their main number --
-- 3303 Millwood, 3935 Two Notch, 3938 Sumter, 3211 Gainesville and
-- 3308 SpeeDee Lexington. A tracking line that equals the shop's own
-- line usually means no Marchex number was recorded.
--
-- Numbers are stored as DIGITS ONLY, as supplied. Display formatting
-- and the tel: link happen in the UI (lib/directory.js).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. MAIN + MARCHEX, for every store whose main number is unambiguous
-- ---------------------------------------------------------------------
with seed (store_number, main_phone, marchex_phone) as (
  values
    ('3229', '8034071911', '8037087220'),  -- Harbison
    ('3276', '8035200134', '8032200852'),  -- North Lake
    ('3278', '8037965794', '8034625602'),  -- Knox Abbott
    ('3303', '8033861938', '8033861938'),  -- Millwood        | main = Marchex in source
    ('3305', '8642423940', '8646404300'),  -- Pleasantburg (Greenville)
    ('3935', '8032547988', '8032547988'),  -- Two Notch       | main = Marchex in source
    ('3936', '8037986494', '8039995138'),  -- Bush River
    ('3937', '8038650679', '8032506797'),  -- Hardscrabble
    ('3979', '8035204444', '8034861080'),  -- Lake Murray
    ('3984', '8037880613', '8032002882'),  -- Decker
    ('5254', '8037562223', '8035675914'),  -- Gervais
    ('3182', '8438210226', '8433765930'),  -- Old Trolley
    ('3302', '8435561523', '8433715176'),  -- Sam Rittenburg
    ('3377', '8436789727', '8437732763'),  -- Florence
    ('3385', '8435721340', '8437907981'),  -- Rivers Ave
    ('3938', '8037782030', '8037782030'),  -- Sumter          | main = Marchex in source
    ('2320', '6892852049', '3212000875'),  -- Semoran
    ('2321', '9049927050', '9045155505'),  -- Beach Blvd
    ('2322', '6893993918', '3212969357'),  -- Oviedo
    ('3111', '9042621331', '9046778795'),  -- Sunbeam
    ('3136', '9047649578', '9045753463'),  -- Lem Turner
    ('3211', '3522318648', '3522318648'),  -- Gainesville     | main = Marchex in source
    ('3292', '9042726560', '9043855562'),  -- Orange Park
    ('3548', '9046413375', '9045154361'),  -- Atlantic Blvd
    ('3296', '3014493320', '2403924402'),  -- Temple Hills
    ('3473', '7037512121', '5714838531'),  -- Duke Street
    ('3485', '3013364747', '3019098766'),  -- Capitol Heights
    ('3593', '3014201171', '3017787886'),  -- Forestville
    ('3598', '2025263400', '2023509755'),  -- Rhode Island
    ('3726', '7032730197', '7035375857'),  -- Fairfax
    ('3831', '7033681175', '7036599339'),  -- Manassas
    ('3923', '3018563000', '2408463512'),  -- Clinton
    ('3308', '8033561327', '8033561327'),  -- SpeeDee Lexington | main = Marchex in source
    ('3009', '8438211162', '8438211122'),  -- SpeeDee Summerville (draft said 3309)
    ('3029', '8437642764', '8437642762'),  -- SpeeDee North Charleston
    ('3025', '8437954600', '8434054262')   -- SpeeDee James Island
)
update public.locations l
   set main_phone    = s.main_phone,
       marchex_phone = s.marchex_phone
  from seed s
 where l.store_number = s.store_number;

-- ---------------------------------------------------------------------
-- 2. The two stores sharing a main number: Marchex only (see note 2)
-- ---------------------------------------------------------------------
with seed (store_number, marchex_phone) as (
  values
    ('3287', '8432849704'),  -- Mt Pleasant
    ('5253', '8439006453')   -- North Main
)
update public.locations l
   set marchex_phone = s.marchex_phone
  from seed s
 where l.store_number = s.store_number;

-- ---------------------------------------------------------------------
-- 3. SERVICE TYPE CATALOGUE (starting set; admins add more in the portal)
--    Labels may be edited afterwards; codes may not.
-- ---------------------------------------------------------------------
insert into public.service_types (code, label, sort_order) values
  ('adas_recalibration',   'ADAS Recalibration',    10),
  ('alignments',           'Alignments',            20),
  ('road_force_balancing', 'Road-Force Balancing',  30),
  ('hvac_1234yf',          'R-1234yf A/C Service',  40),
  ('state_inspection',     'State Inspections',     50),
  ('emissions_inspection', 'Emissions Inspections', 60),
  ('pipe_bender',          'Pipe Bender',           70),
  ('loaner_cars',          'Loaner Cars',           80)
on conflict (code) do nothing;

commit;


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Every non-sandbox store has a Marchex number, and every one
--      except the two held back has a main number (expect 38 / 38 / 36):
--        select count(*) as stores,
--               count(marchex_phone) as with_marchex,
--               count(main_phone)    as with_main
--          from public.locations where not is_sandbox;
--
--  [2] The two waiting on BDC (expect 3287 and 5253):
--        select store_number, name, marchex_phone
--          from public.locations
--         where not is_sandbox and main_phone is null order by store_number;
--
--  [3] No number is stored with punctuation, and none is shared by two
--      stores (expect zero rows each):
--        select store_number, main_phone, marchex_phone from public.locations
--         where not is_sandbox
--           and (main_phone ~ '[^0-9]' or marchex_phone ~ '[^0-9]');
--
--        select main_phone, count(*) from public.locations
--         where not is_sandbox and main_phone is not null
--         group by 1 having count(*) > 1;
--
--  [4] The catalogue (expect 8 rows, all active):
--        select code, label, sort_order, active from public.service_types
--         order by sort_order;
-- =====================================================================
