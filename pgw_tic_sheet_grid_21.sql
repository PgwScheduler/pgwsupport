-- =====================================================================
-- PGW Support Portal — Tic sheet month-grid support:
--   category corrections (Midas) + first_time_customers column
-- Run AFTER pgw_store_goals_20.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Part 1 — category corrections (Midas list):
--   * Two display names were wrong (they name different services). These
--     live in the SHARED service_categories table, so the corrected names
--     apply to every brand that uses the horizon_key — which is correct,
--     the name describes the actual service. (SpeeDee's category *list* is
--     a separate task and is NOT touched here.)
--   * One new category, added to service_categories and mapped to MIDAS
--     only, slotted after Fuel Injection Flush / before Gear Box Flush.
--     Its key is local_su_15k_critical_sys — the `local_` prefix marks a
--     category with NO Horizon field (tracked in-store, never uploaded).
--     horizon_key still holds this value (unique, not null); downstream
--     code must not assume every key maps to a Horizon field.
--   Midas becomes 30 categories, display_order renumbered in tens.
--
-- Part 3 — daily_kpi gains first_time_customers (int, default 0).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. NAME CORRECTIONS (shared display_name)
-- ---------------------------------------------------------------------
update public.service_categories set display_name = 'A/C Refresh'
  where horizon_key = 'kpi_su_ac_heat';
update public.service_categories set display_name = 'Catalytic Converters'
  where horizon_key = 'kpi_su_engine_performance';


-- ---------------------------------------------------------------------
-- 2. NEW CATEGORY (local, no Horizon field)
-- ---------------------------------------------------------------------
insert into public.service_categories (horizon_key, display_name) values
  ('local_su_15k_critical_sys', '15K Critical Sys Treatment')
on conflict (horizon_key) do update set display_name = excluded.display_name;


-- ---------------------------------------------------------------------
-- 3. MIDAS BRAND MAPPING — renumber to tens with the new category slotted
--    in after Fuel Injection Flush (130) and before Gear Box Flush (150).
--    Upsert keeps this re-runnable and never renames/duplicates.
-- ---------------------------------------------------------------------
insert into public.brand_service_categories (brand, service_category_id, display_order, active)
select 'midas', sc.id, v.display_order, true
from (values
  ('kpi_su_air_filter',           10),
  ('kpi_su_ac_heat',              20),
  ('kpi_su_belts',                30),
  ('kpi_su_brake_flush',          40),
  ('kpi_su_brakes',               50),
  ('kpi_su_brake_maintenance',    60),
  ('kpi_su_cabin_filter',         70),
  ('kpi_su_engine_performance',   80),
  ('kpi_su_coolant_flush',        90),
  ('kpi_su_diagnosis',           100),
  ('kpi_su_exhaust',             110),
  ('kpi_su_fuel_filter',         120),
  ('kpi_su_fuel_injection_flush',130),
  ('local_su_15k_critical_sys',  140),   -- NEW, Midas only
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
  ('kpi_su_transmission_flush',  250),
  ('kpi_su_wheel_alignments',    260),
  ('kpi_su_wheel_balances',      270),
  ('kpi_su_wiper_blades',        280),
  ('kpi_su_battery',             290),
  ('kpi_su_tires',               300)
) as v(horizon_key, display_order)
join public.service_categories sc on sc.horizon_key = v.horizon_key
on conflict (brand, service_category_id)
  do update set display_order = excluded.display_order, active = true;


-- ---------------------------------------------------------------------
-- 4. PART 3 — new day-summary field
-- ---------------------------------------------------------------------
alter table public.daily_kpi
  add column if not exists first_time_customers int not null default 0;


-- =====================================================================
-- VERIFY
--   1) Midas list is 30, correctly named and ordered:
--        select bsc.display_order, sc.horizon_key, sc.display_name
--          from public.brand_service_categories bsc
--          join public.service_categories sc on sc.id = bsc.service_category_id
--          where bsc.brand = 'midas' and bsc.active
--          order by bsc.display_order;
--        -- 20 -> A/C Refresh, 80 -> Catalytic Converters,
--        -- 130 F/I Flush, 140 15K Critical Sys Treatment, 150 Gear Box Flush
--   2) The new key has the local_ prefix (no Horizon field):
--        select horizon_key, display_name from public.service_categories
--          where horizon_key = 'local_su_15k_critical_sys';
--   3) Column exists:
--        select column_name from information_schema.columns
--          where table_name='daily_kpi' and column_name='first_time_customers';
-- =====================================================================
