-- =====================================================================
-- PGW Support Portal — migration 70: "Who Sold What" report layout + goals
-- Run in the Supabase SQL Editor. Safe to re-run.
-- =====================================================================
-- Asked for by the user 2026-09-25 ("another report option we need to
-- have saved to the portal for Matt"), from Matt's
-- "Who Sold What Template.xlsx": per store, each service sold as a % OF
-- CARS, against a goal, in three sections, each with an average of five
-- services, a rank, and a comparison with last month.
--
-- DECISIONS (user, 2026-09-25):
--   * All 38 stores, grouped by Matt's markets (markets /
--     store_report_profile from migration 61); ranks across every store
--     shown.
--   * A month vs the month before.
--   * Services the tic sheet does not record are LEFT OUT: Starting &
--     Charging, TPMS, Drivetrain, Electrical, Emissions.
--   * Goals are SAVED and ADMIN-EDITABLE, seeded from the template.
--
-- NO NEW NUMBERS. Units come from daily_service_units through
-- report_build()'s cat_units_* measures, cars from ro_count, days from
-- days_with_data -- the same definitions every other report uses. This
-- table only says which service goes in which column, its goal, and
-- whether it is one of the section's "average of 5".
--
-- The template's names -> tic-sheet categories:
--   Prem Oil -> LOF Premium       Diff  -> Gear Box Flush
--   Fuel     -> Fuel Injection Flush   PS -> Power Steering Flush
--   Suspension -> Steering & Suspension   Struts -> Shocks & Struts
--   Air / Cabin -> Air Filter / Cabin Filter   Wipers -> Wiper Blades
--
-- MEASURE (how a cell is shown):
--   pct     units / cars          (goal is a fraction, 0.40 = 40%)
--   per_day units / days entered  (LOF: the template's "min 7/day")
--   count   units, no goal        (the template's plain count columns)
-- The template's averages: section 1 averages Air, Cabin, Wipers,
-- Battery, Lights (NOT Prem Oil, which has its own 40% goal); section 2
-- the five flushes; section 3 Tires, Brakes, Alignment, Struts,
-- Suspension. in_average marks exactly those.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE TABLE
-- ---------------------------------------------------------------------
create table if not exists public.service_penetration_goals (
  service_key  text primary key references public.service_categories (horizon_key),
  section      smallint not null check (section between 1 and 3),
  sort_order   int      not null,
  label        text     not null,
  measure      text     not null check (measure in ('pct', 'per_day', 'count')),
  goal         numeric(8,4) check (goal is null or goal >= 0),
  in_average   boolean  not null default false,
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  -- A count column has no goal; only a % column can be averaged.
  constraint spg_count_has_no_goal check (measure <> 'count' or goal is null),
  constraint spg_average_is_pct    check (not in_average or measure = 'pct')
);

comment on table public.service_penetration_goals is
  'Who Sold What (migration 70): which tic-sheet service sits in which section/column of Matt''s report, its goal, and whether it is one of the section''s average-of-5. Goals editable by admin/master (goal column only); layout changes go through a migration.';

create or replace function public.spg_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
drop trigger if exists spg_touch on public.service_penetration_goals;
create trigger spg_touch before update on public.service_penetration_goals
  for each row execute function public.spg_touch();


-- ---------------------------------------------------------------------
-- 2. ACCESS — everyone reads; admin/master change the GOAL and nothing else
-- ---------------------------------------------------------------------
alter table public.service_penetration_goals enable row level security;

drop policy if exists "spg_select" on public.service_penetration_goals;
create policy "spg_select" on public.service_penetration_goals for select to authenticated
  using (true);

drop policy if exists "spg_update" on public.service_penetration_goals;
create policy "spg_update" on public.service_penetration_goals for update to authenticated
  using (public.current_user_role() in ('admin', 'master'))
  with check (public.current_user_role() in ('admin', 'master'));

-- Column-level: the layout (section, order, measure, average) is not
-- editable from the app; only the goal is. No insert / delete from the app.
revoke insert, update, delete, truncate on public.service_penetration_goals from anon, authenticated;
grant select on public.service_penetration_goals to authenticated;
grant update (goal) on public.service_penetration_goals to authenticated;


-- ---------------------------------------------------------------------
-- 3. THE LAYOUT + TEMPLATE GOALS
--    Re-running resets layout but KEEPS any goal an admin has changed.
-- ---------------------------------------------------------------------
insert into public.service_penetration_goals
  (service_key, section, sort_order, label, measure, goal, in_average) values
  -- Section 1 — Low hanging fruit
  ('kpi_su_ac_heat',               1,  10, 'A/C - Heating', 'count',   null,  false),
  ('kpi_su_lof',                   1,  20, 'LOF / day',     'per_day', 7,     false),
  ('kpi_su_lof_premium',           1,  30, 'Prem Oil',      'pct',     0.40,  false),
  ('kpi_su_air_filter',            1,  40, 'Air',           'pct',     0.10,  true),
  ('kpi_su_cabin_filter',          1,  50, 'Cabin',         'pct',     0.05,  true),
  ('kpi_su_wiper_blades',          1,  60, 'Wipers',        'pct',     0.10,  true),
  ('kpi_su_battery',               1,  70, 'Battery',       'pct',     0.05,  true),
  ('kpi_su_lights',                1,  80, 'Lights',        'pct',     0.08,  true),
  -- Section 2 — Flushes
  ('kpi_su_brake_flush',           2,  10, 'Brake',         'pct',     0.05,  true),
  ('kpi_su_coolant_flush',         2,  20, 'Coolant',       'pct',     0.03,  true),
  ('kpi_su_gear_box_flush',        2,  30, 'Diff',          'pct',     0.03,  true),
  ('kpi_su_fuel_injection_flush',  2,  40, 'Fuel',          'pct',     0.05,  true),
  ('kpi_su_power_steering_flush',  2,  50, 'PS',            'pct',     0.03,  true),
  ('kpi_su_engine_performance',    2,  60, 'Engine Performance', 'count', null, false),
  ('kpi_su_exhaust',               2,  70, 'Exhaust',       'count',   null,  false),
  ('kpi_su_fuel_filter',           2,  80, 'Fuel Filter',   'count',   null,  false),
  -- Section 3 — Tires & big ticket
  ('kpi_su_tires',                 3,  10, 'Tires',         'pct',     0.20,  true),
  ('kpi_su_road_hazard',           3,  20, 'Road Haz',      'pct',     0.20,  false),
  ('kpi_su_wheel_balances',        3,  30, 'Balance',       'count',   null,  false),
  ('kpi_su_brakes',                3,  40, 'Brakes',        'pct',     0.15,  true),
  ('kpi_su_wheel_alignments',      3,  50, 'Alignment',     'pct',     0.10,  true),
  ('kpi_su_shocks_struts',         3,  60, 'Struts',        'pct',     0.03,  true),
  ('kpi_su_steering_suspension',   3,  70, 'Suspension',    'pct',     0.08,  true),
  ('kpi_su_timing_belt',           3,  80, 'Timing Belt',   'pct',     0.08,  false),
  ('kpi_su_tire_rotation',         3,  90, 'Tire Rotation', 'count',   null,  false)
on conflict (service_key) do update set
  section    = excluded.section,
  sort_order = excluded.sort_order,
  label      = excluded.label,
  measure    = excluded.measure,
  in_average = excluded.in_average;


-- ---------------------------------------------------------------------
-- CONFIRMATIONS (run after applying)
-- ---------------------------------------------------------------------
--  1) select section, count(*), count(*) filter (where in_average)
--       from public.service_penetration_goals group by 1 order by 1;
--     Expect 1 | 8 | 5,  2 | 8 | 5,  3 | 9 | 5.
--  2) select label, measure, goal from public.service_penetration_goals
--      order by section, sort_order;
--     Expect the template's goals (Prem Oil 0.40, Tires 0.20, LOF 7 ...).
