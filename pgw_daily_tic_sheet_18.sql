-- =====================================================================
-- PGW Support Portal — Daily Tic Sheet (Midas end-of-day KPI entry)
-- Run AFTER pgw_employee_schedules_17.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- WHAT THIS DOES: adds the store manager's end-of-day numbers screen.
-- One row per store per business date (daily_kpi) holding the day's
-- summary figures, plus one child row per service category (daily_service
-- _units) holding that day's unit counts.
--
-- SCOPE NOTE: this migration is the DATA + SECURITY layer for daily
-- entry only. Goals, bonuses, technician entry, pay math and external
-- uploads are deliberately NOT here — they are separate, later tasks.
--
-- KEY DEVIATIONS from the drafted spec, using what actually exists:
--   * The stores table is public.locations and its PK is `id uuid`
--     (NOT a bigint `stores` table). So the FK is `location_id uuid`,
--     matching every other table in this schema.
--   * `locations.brand` ALREADY EXISTS (added in pgw_speedee_brand_16.sql,
--     which also set 3009/3025/3029/3308 -> speedee). It is NOT re-added
--     here; a verify query at the bottom confirms it.
--
-- RLS mirrors the cash-drawer/closeout tables exactly:
--   read + insert + update gated by can_access_location(location_id);
--   delete stays master-only. The two reference tables are readable by
--   any authenticated user and writable by master only (like regions /
--   districts). Enforced in Postgres, not by hiding UI.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. REFERENCE TABLES
--    service_categories: the master list of KPI service lines. horizon_key
--    values are an external system's exact field names — DO NOT rename.
--    brand_service_categories: which categories a brand shows, and in what
--    order. display_order uses gaps (10,20,30…) so a category can be
--    inserted between two others later without renumbering the rest.
-- ---------------------------------------------------------------------
create table if not exists public.service_categories (
  id           bigint generated always as identity primary key,
  horizon_key  text not null unique,
  display_name text not null,
  created_at   timestamptz not null default now()
);

create table if not exists public.brand_service_categories (
  brand               text   not null check (brand in ('midas','speedee')),
  service_category_id bigint not null references public.service_categories (id) on delete cascade,
  display_order       int    not null,
  active              boolean not null default true,
  primary key (brand, service_category_id)
);


-- ---------------------------------------------------------------------
-- 2. SEED THE 29 MIDAS CATEGORIES (in order, display_order 10..290)
--    Re-runnable: categories keyed by horizon_key, the brand mapping
--    upserts so a re-run keeps display_order/active in sync.
-- ---------------------------------------------------------------------
insert into public.service_categories (horizon_key, display_name) values
  ('kpi_su_air_filter',          'Air Filter'),
  ('kpi_su_ac_heat',             'A/C - Heating'),
  ('kpi_su_belts',               'Belts'),
  ('kpi_su_brake_flush',         'Brake Flush'),
  ('kpi_su_brakes',              'Brakes'),
  ('kpi_su_brake_maintenance',   'Brake Maintenance'),
  ('kpi_su_cabin_filter',        'Cabin Filter'),
  ('kpi_su_engine_performance',  'Engine Performance'),
  ('kpi_su_coolant_flush',       'Coolant Flush'),
  ('kpi_su_diagnosis',           'Diagnosis'),
  ('kpi_su_exhaust',             'Exhaust'),
  ('kpi_su_fuel_filter',         'Fuel Filter'),
  ('kpi_su_fuel_injection_flush','Fuel Injection Flush'),
  ('kpi_su_gear_box_flush',      'Gear Box Flush'),
  ('kpi_su_hoses',               'Hoses'),
  ('kpi_su_lights',              'Lights'),
  ('kpi_su_lof',                 'LOF'),
  ('kpi_su_lof_premium',         'LOF Premium'),
  ('kpi_su_power_steering_flush','Power Steering Flush'),
  ('kpi_su_road_hazard',         'Road Hazard'),
  ('kpi_su_steering_suspension', 'Steering & Suspension'),
  ('kpi_su_shocks_struts',       'Shocks & Struts'),
  ('kpi_su_timing_belt',         'Timing Belt'),
  ('kpi_su_transmission_flush',  'Transmission Flush'),
  ('kpi_su_wheel_alignments',    'Wheel Alignments'),
  ('kpi_su_wheel_balances',      'Wheel Balances'),
  ('kpi_su_wiper_blades',        'Wiper Blades'),
  ('kpi_su_battery',             'Battery'),
  ('kpi_su_tires',               'Tires')
on conflict (horizon_key) do update set display_name = excluded.display_name;

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
  ('kpi_su_gear_box_flush',      140),
  ('kpi_su_hoses',               150),
  ('kpi_su_lights',              160),
  ('kpi_su_lof',                 170),
  ('kpi_su_lof_premium',         180),
  ('kpi_su_power_steering_flush',190),
  ('kpi_su_road_hazard',         200),
  ('kpi_su_steering_suspension', 210),
  ('kpi_su_shocks_struts',       220),
  ('kpi_su_timing_belt',         230),
  ('kpi_su_transmission_flush',  240),
  ('kpi_su_wheel_alignments',    250),
  ('kpi_su_wheel_balances',      260),
  ('kpi_su_wiper_blades',        270),
  ('kpi_su_battery',             280),
  ('kpi_su_tires',               290)
) as v(horizon_key, display_order)
join public.service_categories sc on sc.horizon_key = v.horizon_key
on conflict (brand, service_category_id)
  do update set display_order = excluded.display_order, active = true;


-- ---------------------------------------------------------------------
-- 3. DATA TABLES
--    daily_kpi: one row per store per business date. Derived figures are
--    NOT stored — the raw inputs are. submitted_at marks a day as reported
--    but leaves it editable (updated_by/updated_at track later edits).
-- ---------------------------------------------------------------------
create table if not exists public.daily_kpi (
  id              bigint generated always as identity primary key,
  location_id     uuid   not null references public.locations (id) on delete cascade,
  business_date   date   not null,
  ro_count        int           not null default 0,
  sales_labor     numeric(12,2) not null default 0,
  sales_parts     numeric(12,2) not null default 0,
  sales_tires     numeric(12,2) not null default 0,
  sales_discounts numeric(12,2) not null default 0,
  sales_other     numeric(12,2) not null default 0,
  cost_parts      numeric(12,2) not null default 0,
  cost_tires      numeric(12,2) not null default 0,
  declined_sales  numeric(12,2) not null default 0,
  credit_apps     int           not null default 0,
  credit_dollars  numeric(12,2) not null default 0,
  submitted_at    timestamptz,
  entered_by      uuid references auth.users (id),
  entered_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id),
  updated_at      timestamptz not null default now(),
  unique (location_id, business_date)
);
create index if not exists daily_kpi_location_date on public.daily_kpi (location_id, business_date desc);

create table if not exists public.daily_service_units (
  daily_kpi_id        bigint not null references public.daily_kpi (id) on delete cascade,
  service_category_id bigint not null references public.service_categories (id),
  units               int    not null default 0 check (units >= 0),
  primary key (daily_kpi_id, service_category_id)
);


-- ---------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------

-- 4a. service_categories — everyone reads, master writes.
alter table public.service_categories enable row level security;
drop policy if exists "service_categories_select" on public.service_categories;
create policy "service_categories_select" on public.service_categories for select to authenticated
  using (true);
drop policy if exists "service_categories_master_write" on public.service_categories;
create policy "service_categories_master_write" on public.service_categories for all to authenticated
  using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');

-- 4b. brand_service_categories — everyone reads, master writes.
alter table public.brand_service_categories enable row level security;
drop policy if exists "brand_service_categories_select" on public.brand_service_categories;
create policy "brand_service_categories_select" on public.brand_service_categories for select to authenticated
  using (true);
drop policy if exists "brand_service_categories_master_write" on public.brand_service_categories;
create policy "brand_service_categories_master_write" on public.brand_service_categories for all to authenticated
  using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');

-- 4c. daily_kpi — read/insert/update by store-access; delete master-only
--     (identical shape to cash_drawer_closeouts).
alter table public.daily_kpi enable row level security;
drop policy if exists "daily_kpi_select" on public.daily_kpi;
create policy "daily_kpi_select" on public.daily_kpi for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "daily_kpi_insert" on public.daily_kpi;
create policy "daily_kpi_insert" on public.daily_kpi for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "daily_kpi_update" on public.daily_kpi;
create policy "daily_kpi_update" on public.daily_kpi for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
drop policy if exists "daily_kpi_delete" on public.daily_kpi;
create policy "daily_kpi_delete" on public.daily_kpi for delete to authenticated
  using (public.current_user_role() = 'master');

-- 4d. daily_service_units — access resolved through the parent daily_kpi
--     row. Read/insert/update by store-access on the parent's location;
--     delete master-only (parent delete already cascades to these).
alter table public.daily_service_units enable row level security;
drop policy if exists "daily_service_units_select" on public.daily_service_units;
create policy "daily_service_units_select" on public.daily_service_units for select to authenticated
  using (exists (
    select 1 from public.daily_kpi k
    where k.id = daily_service_units.daily_kpi_id
      and public.can_access_location(k.location_id)
  ));
drop policy if exists "daily_service_units_insert" on public.daily_service_units;
create policy "daily_service_units_insert" on public.daily_service_units for insert to authenticated
  with check (exists (
    select 1 from public.daily_kpi k
    where k.id = daily_service_units.daily_kpi_id
      and public.can_access_location(k.location_id)
  ));
drop policy if exists "daily_service_units_update" on public.daily_service_units;
create policy "daily_service_units_update" on public.daily_service_units for update to authenticated
  using (exists (
    select 1 from public.daily_kpi k
    where k.id = daily_service_units.daily_kpi_id
      and public.can_access_location(k.location_id)
  ))
  with check (exists (
    select 1 from public.daily_kpi k
    where k.id = daily_service_units.daily_kpi_id
      and public.can_access_location(k.location_id)
  ));
drop policy if exists "daily_service_units_delete" on public.daily_service_units;
create policy "daily_service_units_delete" on public.daily_service_units for delete to authenticated
  using (public.current_user_role() = 'master');


-- =====================================================================
-- VERIFY
--   1) brand column already present + the four Speedee stores set:
--        select store_number, brand from public.locations
--          where store_number in ('3009','3025','3029','3308');
--   2) A Midas store's category list — must be 29 rows, order 10..290:
--        select bsc.display_order, sc.horizon_key, sc.display_name
--          from public.brand_service_categories bsc
--          join public.service_categories sc on sc.id = bsc.service_category_id
--          where bsc.brand = 'midas' and bsc.active
--          order by bsc.display_order;
--   3) As a STORE user for store A, a daily_kpi row for store B must NOT
--      be selectable (0 rows), and inserting one must be denied by RLS.
--   4) As a STORE user, insert/update into service_categories must fail.
-- =====================================================================
