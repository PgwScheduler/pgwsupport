-- =====================================================================
-- PGW Support Portal — SpeeDee service categories for the Daily Tic Sheet
-- Run AFTER pgw_daily_tic_sheet_18.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent). NO SCHEMA CHANGES — data only.
-- =====================================================================
-- WHAT THIS DOES: SpeeDee uses the same 29 categories as Midas plus two
-- new ones (Axels & Shafts, Tire Rotation), in a different, roughly-
-- alphabetical order with the two new lines slotted in rather than
-- appended. This:
--   1. Inserts the two new categories into service_categories.
--   2. Adds 31 brand_service_categories rows for brand = 'speedee', with
--      display_order 10..310 in the required sequence.
-- It does NOT touch any existing Midas brand_service_categories row — the
-- Midas list stays exactly 29 in its original order. The two new
-- categories are mapped to 'speedee' only, so they never appear for Midas.
--
-- The entry screen already filters brand_service_categories by the
-- location's brand (useDailyKpi.js), so SpeeDee stores pick these up with
-- no code change.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE TWO NEW CATEGORIES (shared table; keyed by horizon_key)
-- ---------------------------------------------------------------------
insert into public.service_categories (horizon_key, display_name) values
  ('kpi_su_axels_shafts',  'Axels & Shafts'),
  ('kpi_su_tire_rotation', 'Tire Rotation')
on conflict (horizon_key) do update set display_name = excluded.display_name;


-- ---------------------------------------------------------------------
-- 2. SPEEDEE BRAND MAPPING — 31 rows, display_order 10..310
--    Ordered exactly as specified (not appended). Upserts so a re-run
--    keeps display_order/active in sync; only 'speedee' rows are touched.
-- ---------------------------------------------------------------------
insert into public.brand_service_categories (brand, service_category_id, display_order, active)
select 'speedee', sc.id, v.display_order, true
from (values
  ('kpi_su_ac_heat',              10),
  ('kpi_su_air_filter',           20),
  ('kpi_su_axels_shafts',         30),
  ('kpi_su_belts',                40),
  ('kpi_su_brake_flush',          50),
  ('kpi_su_brakes',               60),
  ('kpi_su_brake_maintenance',    70),
  ('kpi_su_cabin_filter',         80),
  ('kpi_su_coolant_flush',        90),
  ('kpi_su_diagnosis',           100),
  ('kpi_su_engine_performance',  110),
  ('kpi_su_exhaust',             120),
  ('kpi_su_fuel_filter',         130),
  ('kpi_su_fuel_injection_flush',140),
  ('kpi_su_gear_box_flush',      150),
  ('kpi_su_hoses',               160),
  ('kpi_su_lights',              170),
  ('kpi_su_lof',                 180),
  ('kpi_su_lof_premium',         190),
  ('kpi_su_power_steering_flush',200),
  ('kpi_su_road_hazard',         210),
  ('kpi_su_steering_suspension', 220),
  ('kpi_su_shocks_struts',       230),
  ('kpi_su_timing_belt',         240),
  ('kpi_su_tire_rotation',       250),
  ('kpi_su_transmission_flush',  260),
  ('kpi_su_wheel_alignments',    270),
  ('kpi_su_wheel_balances',      280),
  ('kpi_su_wiper_blades',        290),
  ('kpi_su_battery',             300),
  ('kpi_su_tires',               310)
) as v(horizon_key, display_order)
join public.service_categories sc on sc.horizon_key = v.horizon_key
on conflict (brand, service_category_id)
  do update set display_order = excluded.display_order, active = true;


-- =====================================================================
-- VERIFY
--   1) SpeeDee — must be 31 rows, order 10..310:
--        select bsc.display_order, sc.horizon_key, sc.display_name
--          from public.brand_service_categories bsc
--          join public.service_categories sc on sc.id = bsc.service_category_id
--          where bsc.brand = 'speedee' and bsc.active
--          order by bsc.display_order;
--   2) Midas — must still be 29 rows, order 10..290, unchanged:
--        select bsc.display_order, sc.horizon_key, sc.display_name
--          from public.brand_service_categories bsc
--          join public.service_categories sc on sc.id = bsc.service_category_id
--          where bsc.brand = 'midas' and bsc.active
--          order by bsc.display_order;
--   3) The two new categories must NOT be mapped to Midas (0 rows):
--        select 1 from public.brand_service_categories bsc
--          join public.service_categories sc on sc.id = bsc.service_category_id
--          where bsc.brand = 'midas'
--            and sc.horizon_key in ('kpi_su_axels_shafts','kpi_su_tire_rotation');
-- =====================================================================
