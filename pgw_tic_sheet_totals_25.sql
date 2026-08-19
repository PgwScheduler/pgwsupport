-- =====================================================================
-- PGW Support Portal — Tic sheet totals, self-correcting goals,
--                      zero dollar tickets   (Task 5)
-- Run AFTER pgw_tech_time_tracker_24.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Brings the month grid to parity with `Maint Tic Sheet` in
-- Millwood_July.xlsm. Four schema changes:
--
--   1. daily_kpi.first_time_customers  ->  daily_kpi.zero_dollar_tickets
--      First Time Customers was never used. Zero Dollar Tickets takes the
--      same position in the grid. It is a DAILY ENTRY field (Summary
--      column F in the source) and it has NO Horizon field, so the upload
--      builder must skip it. Like local_su_15k_critical_sys (migration
--      21) it is proof that not every tracked field maps to a Horizon
--      key -- upload code must never assume a 1:1 mapping.
--
--      Zero dollar tickets do NOT reduce the repair order count. ROs,
--      capture rate and average estimate per car are unaffected.
--
--   2. sales_discounts is signed BOTH ways. Millwood July carries
--      -125.00, -396.53 and +107.00, netting -1,997.91 for the month.
--      No non-negative constraint has ever existed on the column; this
--      drops one defensively in case a database grew one.
--      NOTE: migration 23's blanket `set sales_discounts = -abs(...)`
--      flip is SUPERSEDED and must not be re-run -- a positive discount
--      is legitimate data.
--
--   3. store_tic_goals -- per-store tic-sheet goals that are not
--      per-category. Today that is only the zero dollar ticket
--      percentage (default 10% of repair orders), stored per store so it
--      can vary. The task named this table `store_goals`; the portal
--      already has store_annual_goals / store_monthly_goals, so the name
--      is qualified to keep the three apart.
--
--   4. store_category_goals -- the header band's two ENTERED rows, per
--      store per category:
--        goal_pct_of_cars   penetration goal (Millwood: LOF 35%,
--                           Wheel Bal 35%, LOF Prem 30%, Road Haz 50%,
--                           Brake 20%, Tire 20%, down to 2%)
--        average_sale       per-unit ticket behind the derived
--                           "Actual Sales" row (Brake $328.55,
--                           Shock/Strut $527.55, Blades $15.00)
--      These drive the self-correcting New Goal rows:
--        monthly_goal = goal_pct_of_cars * projected_repair_orders
--      where projected_repair_orders = MTD ROs / days elapsed * days open.
--
--      SOURCE BUG NOT REPLICATED: in the spreadsheet, A/C Refresh,
--      Catalytic Converters and 15K Critical Sys Treatment point their
--      goal formula at an empty cell instead of the projected-RO cell,
--      so their goals read zero forever. Every category here uses the
--      same projected-RO source.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. ZERO DOLLAR TICKETS replaces FIRST TIME CUSTOMERS
-- ---------------------------------------------------------------------
alter table public.daily_kpi
  add column if not exists zero_dollar_tickets int not null default 0;

alter table public.daily_kpi
  drop column if exists first_time_customers;


-- ---------------------------------------------------------------------
-- 2. DISCOUNTS SIGNED BOTH WAYS -- drop any non-negative check
--    constraint (named or not) that mentions sales_discounts.
-- ---------------------------------------------------------------------
alter table public.daily_kpi drop constraint if exists daily_kpi_discounts_check;

do $do$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel     on rel.oid = con.conrelid
    join pg_namespace ns  on ns.oid  = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'daily_kpi'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%sales_discounts%'
  loop
    execute format('alter table public.daily_kpi drop constraint %I', c.conname);
  end loop;
end
$do$;


-- ---------------------------------------------------------------------
-- 3. STORE-LEVEL TIC SHEET GOALS
-- ---------------------------------------------------------------------
create table if not exists public.store_tic_goals (
  location_id             uuid primary key references public.locations (id) on delete cascade,
  zero_dollar_ticket_pct  numeric(5,4) not null default 0.10,
  updated_at              timestamptz  not null default now()
);

-- Every store starts at the 10% default; a re-run never overwrites an
-- edited value.
insert into public.store_tic_goals (location_id)
select id from public.locations
on conflict (location_id) do nothing;


-- ---------------------------------------------------------------------
-- 4. PER-CATEGORY GOALS (goal % of cars + average sale)
-- ---------------------------------------------------------------------
create table if not exists public.store_category_goals (
  location_id          uuid    not null references public.locations (id) on delete cascade,
  service_category_id  bigint  not null references public.service_categories (id) on delete cascade,
  goal_pct_of_cars     numeric(5,4)  not null default 0,
  average_sale         numeric(10,2) not null default 0,
  updated_at           timestamptz   not null default now(),
  primary key (location_id, service_category_id)
);

create index if not exists store_category_goals_location_idx
  on public.store_category_goals (location_id);

-- Seed from the company template (the values the Millwood workbook
-- carries), for every store x every category its brand actually shows.
-- `on conflict do nothing` so a store that has since tuned its own goals
-- is never reset by a re-run. The two SpeeDee-only categories (Axels &
-- Shafts, Tire Rotation) have no template value and seed at 0.
insert into public.store_category_goals (location_id, service_category_id, goal_pct_of_cars, average_sale)
select l.id, sc.id, coalesce(v.goal_pct, 0), coalesce(v.avg_sale, 0)
from public.locations l
join public.brand_service_categories bsc
  on bsc.brand = l.brand and bsc.active
join public.service_categories sc
  on sc.id = bsc.service_category_id
left join (values
  ('kpi_su_air_filter',           0.10,  28.98),
  ('kpi_su_ac_heat',              0.10,  29.98),
  ('kpi_su_belts',                0.05, 125.95),
  ('kpi_su_brake_flush',          0.05,  65.00),
  ('kpi_su_brakes',               0.20, 328.55),
  ('kpi_su_brake_maintenance',    0.05,  49.00),
  ('kpi_su_cabin_filter',         0.05,  39.83),
  ('kpi_su_engine_performance',   0.05,  40.83),
  ('kpi_su_coolant_flush',        0.05, 100.00),
  ('kpi_su_diagnosis',            0.05,  50.00),
  ('kpi_su_exhaust',              0.05, 301.15),
  ('kpi_su_fuel_filter',          0.02,  83.16),
  ('kpi_su_fuel_injection_flush', 0.04, 108.00),
  ('local_su_15k_critical_sys',   0.04, 108.00),
  ('kpi_su_gear_box_flush',       0.03, 100.00),
  ('kpi_su_hoses',                0.02, 125.00),
  ('kpi_su_lights',               0.10,  17.00),
  ('kpi_su_lof',                  0.35,  30.00),
  ('kpi_su_lof_premium',          0.30,  57.31),
  ('kpi_su_power_steering_flush', 0.02,  70.00),
  ('kpi_su_road_hazard',          0.50,  15.00),
  ('kpi_su_steering_suspension',  0.08, 207.89),
  ('kpi_su_shocks_struts',        0.07, 527.55),
  ('kpi_su_timing_belt',          0.02, 534.84),
  ('kpi_su_transmission_flush',   0.05, 155.00),
  ('kpi_su_wheel_alignments',     0.10,  94.26),
  ('kpi_su_wheel_balances',       0.35,  11.00),
  ('kpi_su_wiper_blades',         0.10,  15.00),
  ('kpi_su_battery',              0.05, 134.40),
  ('kpi_su_tires',                0.20, 118.05)
) as v(horizon_key, goal_pct, avg_sale)
  on v.horizon_key = sc.horizon_key
on conflict (location_id, service_category_id) do nothing;


-- ---------------------------------------------------------------------
-- 5. RLS -- mirrors store_annual_goals: read via can_access_location,
--    write admin/master only. Goals are set by the company, not by the
--    store being measured against them.
-- ---------------------------------------------------------------------
alter table public.store_tic_goals      enable row level security;
alter table public.store_category_goals enable row level security;

drop policy if exists "store_tic_goals_select" on public.store_tic_goals;
create policy "store_tic_goals_select" on public.store_tic_goals for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "store_tic_goals_write" on public.store_tic_goals;
create policy "store_tic_goals_write" on public.store_tic_goals for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "store_category_goals_select" on public.store_category_goals;
create policy "store_category_goals_select" on public.store_category_goals for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "store_category_goals_write" on public.store_category_goals;
create policy "store_category_goals_write" on public.store_category_goals for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- =====================================================================
-- VERIFY
--   1) Column swap:
--        select column_name from information_schema.columns
--          where table_name = 'daily_kpi'
--            and column_name in ('first_time_customers','zero_dollar_tickets');
--        -- one row: zero_dollar_tickets
--   2) Nothing blocks a positive discount:
--        select conname, pg_get_constraintdef(oid) from pg_constraint
--          where conrelid = 'public.daily_kpi'::regclass and contype = 'c';
--   3) Every store has a zero-dollar goal:
--        select count(*) from public.store_tic_goals;                        -- 36
--        select distinct zero_dollar_ticket_pct from public.store_tic_goals; -- 0.1000
--   4) Millwood's per-category goals, including the three the source
--      spreadsheet leaves at zero:
--        select sc.display_name, g.goal_pct_of_cars, g.average_sale
--          from public.store_category_goals g
--          join public.service_categories sc on sc.id = g.service_category_id
--          where g.location_id = (select id from public.locations where store_number = '3303')
--            and sc.horizon_key in ('kpi_su_ac_heat','kpi_su_engine_performance',
--                                   'local_su_15k_critical_sys','kpi_su_tires');
--        -- A/C Refresh 0.1000, Catalytic Converters 0.0500,
--        -- 15K Critical Sys Treatment 0.0400, Tires 0.2000   (none zero)
--   5) One row per store per category in that store's brand list:
--        select count(*) from public.store_category_goals;   -- 32 midas x 30 + 4 speedee x 31
-- =====================================================================
