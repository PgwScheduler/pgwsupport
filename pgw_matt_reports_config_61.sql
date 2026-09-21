-- =====================================================================
-- PGW Support Portal — Matt's reports, Phase 1: configuration
-- Run AFTER pgw_directory_contact_photos_60.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- The brief: produce every report in Matts_Reporting_Jumbo_File.xlsx from
-- portal data, on screen and as an Excel export, so Matt stops keying
-- Horizon numbers. Step 0 audit: "Matt's Reporting — Step 0 Audit" doc.
-- Phase 1 = Report 1 (Daily Scorecard), Report 2 (Market Summary),
-- Report 5 (Tire Contest) and the five presets built on them.
--
-- PRINCIPLE: CONFIG IS DATA. Matt's workbook types budgets, goals, tier
-- percentages and store groupings into cells and formulas, and most of
-- its defects are one of those drifting. Everything here is a row.
--
-- WHAT ALREADY HAD A HOME AND IS REUSED, NOT COPIED
--   * days open, GP budget and sales budget per store per month:
--     bonus_monthly_targets (they agree with Matt's file to within his
--     whole-dollar rounding for 35 of 36 stores; Two Notch is open with
--     BDC). Daily budget = monthly / days open.
--   * 2025 monthly sales, GP and cars: prior_year_actuals.
--   * every daily number (cars, sales, GP, declined work, tire /
--     alignment / battery units): the tic sheet, read through
--     report_build(), so there is ONE definition of sales and GP.
--
-- WHAT THIS ADDS
--   1. markets -- Matt's six groups. NOT the districts: SpeeDee
--      Lexington is its own market in his file, and it sits inside the
--      portal's Columbia West district. Florida includes #2320 Semoran
--      and #2322 Oviedo (the user, 2026-09-21), so it has 8 stores to
--      Matt's Jacksonville 6. Store count is always count(*) of members.
--   2. store_report_profile -- per store: market, report row order,
--      Matt's display name, and a name-fill override for the stores
--      whose colour differs from their market's.
--   3. store_report_config -- per store, EFFECTIVE BY MONTH: weekly
--      sales goal, tire goal per day, tire payout minimum, bronze floor.
--      A report uses the latest row on or before its month, so a value
--      is entered once and carries forward until someone changes it.
--   4. report_settings -- the global numbers: tier percentages, colour
--      bands, tire payouts. Named keys, one value each.
--   5. market_bonus_brackets -- market manager bonus as a % of salary.
--      Compensation, so ADMIN/MASTER ONLY to read as well as write.
--   6. prior_year_actuals.tires -- 2025 tires sold, which Report 5
--      compares against. Seeded for September 2025 from Matt's file;
--      other months are null until someone supplies them.
--   7. 2025 holidays -- the holidays table started at 2026, so every
--      2025 month counted Labor Day as open. Matt's 2025 cars per day
--      assumes 25 open days in September 2025; without these rows the
--      portal would divide by 26 and understate every "vs 2025".
--   8. open_days_between() and report_default_date() -- the report's
--      calendar: Mon–Sat less holidays, and "yesterday" = the last open
--      business day before today.
--
-- Seeds come from the workbook's own cells (September 2026), generated
-- by script rather than retyped.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 2025 HOLIDAYS
-- ---------------------------------------------------------------------
insert into public.holidays (holiday_date, name) values
  ('2025-01-01', 'New Year''s Day'), ('2025-07-04', 'Independence Day'),
  ('2025-09-01', 'Labor Day'),       ('2025-11-27', 'Thanksgiving'),
  ('2025-12-25', 'Christmas')
on conflict (holiday_date) do nothing;


-- ---------------------------------------------------------------------
-- 1. THE REPORT CALENDAR
-- ---------------------------------------------------------------------
-- Open days (Mon–Sat, not a holiday) in [d_from, d_to], inclusive.
-- derived_days_open() is this over a whole month; they agree.
create or replace function public.open_days_between(d_from date, d_to date)
returns int language sql stable set search_path = '' as $$
  select count(*)::int
    from generate_series(d_from, d_to, interval '1 day') d
   where d_to >= d_from
     and extract(dow from d) <> 0
     and not exists (select 1 from public.holidays h where h.holiday_date = d::date);
$$;
grant execute on function public.open_days_between(date, date) to authenticated;

-- "Yesterday": the last open business day strictly before p_today. On a
-- Monday that is Saturday; after a holiday, the day before it.
create or replace function public.report_default_date(p_today date)
returns date language sql stable set search_path = '' as $$
  select max(d)::date
    from generate_series(p_today - 14, p_today - 1, interval '1 day') d
   where extract(dow from d) <> 0
     and not exists (select 1 from public.holidays h where h.holiday_date = d::date);
$$;
grant execute on function public.report_default_date(date) to authenticated;


-- ---------------------------------------------------------------------
-- 2. MARKETS
-- ---------------------------------------------------------------------
create table if not exists public.markets (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  name               text not null,
  sort_order         int  not null,
  display_color      text not null,   -- ARGB hex without '#', e.g. 'ED7D31'
  display_font_color text not null default '000000',
  constraint markets_code_shape check (code ~ '^[a-z0-9_]+$'),
  constraint markets_colors_hex check (display_color ~ '^[0-9A-F]{6}$' and display_font_color ~ '^[0-9A-F]{6}$')
);

comment on table public.markets is
  'Matt''s reporting markets. Not the districts: SpeeDee Lexington is its own market here. Store count = count(*) of store_report_profile rows pointing at it, never a typed number.';

insert into public.markets (code, name, sort_order, display_color, display_font_color) values
  ('north',       'North',                1, 'ED7D31', '000000'),
  ('col_east',    'Columbia Midas East',  2, 'FFF2CC', '4472C4'),
  ('col_west',    'Columbia Midas West',  3, 'FFF2CC', '000000'),
  ('charleston',  'Charleston',           4, 'FFCC00', '000000'),
  ('speedee_lex', 'SpeeDee Lexington',    5, 'B4C7E7', '000000'),
  ('florida',     'Florida',              6, '99FF66', '000000')
on conflict (code) do update
  set name = excluded.name, sort_order = excluded.sort_order,
      display_color = excluded.display_color, display_font_color = excluded.display_font_color;


-- ---------------------------------------------------------------------
-- 3. PER-STORE REPORT PROFILE
-- ---------------------------------------------------------------------
create table if not exists public.store_report_profile (
  location_id        uuid primary key references public.locations (id) on delete cascade,
  market_id          uuid not null references public.markets (id),
  report_sort_order  int  not null,
  report_display_name text not null,
  name_fill_override text null,   -- the two Charleston yellows and the Charleston SpeeDees
  constraint store_report_profile_fill_hex check (name_fill_override is null or name_fill_override ~ '^[0-9A-F]{6}$')
);

comment on table public.store_report_profile is
  'Where a store sits in Matt''s reports: its market, its row, the name he uses for it, and a name-cell fill when it differs from the market''s. Every report joins by location_id, never by name -- the workbook spells the same store differently from tab to tab.';

insert into public.store_report_profile (location_id, market_id, report_sort_order, report_display_name, name_fill_override)
select l.id, m.id, s.sort_order, s.display_name, s.fill
  from (values
    ('3938', 'charleston', 1, 'Wesmark', 'FFC000'),
    ('3831', 'north', 2, 'Manassas', null),
    ('3726', 'north', 3, 'Fairfax', null),
    ('3598', 'north', 4, 'Rhode Island', null),
    ('3473', 'north', 5, 'Duke', null),
    ('3025', 'charleston', 6, 'James Island', 'B4C7E7'),
    ('3935', 'col_east', 7, 'Two Notch', null),
    ('3296', 'north', 8, 'Temple Hills', null),
    ('3593', 'north', 9, 'Forestville', null),
    ('3923', 'north', 10, 'Clinton', null),
    ('3485', 'north', 11, 'Capitol Heights', null),
    ('3979', 'col_west', 12, 'Lake Murray', null),
    ('3377', 'charleston', 13, 'Florence', 'FFC000'),
    ('3305', 'col_east', 14, 'Greenville', null),
    ('5254', 'col_east', 15, 'Gervais', null),
    ('5253', 'charleston', 16, 'Main St', null),
    ('3182', 'charleston', 17, 'Old Trolley', null),
    ('3936', 'col_west', 18, 'Bush River', null),
    ('3984', 'col_east', 19, 'Decker', null),
    ('3229', 'col_west', 20, 'Harbison', null),
    ('3278', 'col_west', 21, 'Knox', null),
    ('3276', 'col_west', 22, 'Lexington', null),
    ('3303', 'col_east', 23, 'Millwood', null),
    ('3287', 'charleston', 24, 'MP Midas', null),
    ('3385', 'charleston', 25, 'Rivers', null),
    ('3302', 'charleston', 26, 'Sam Ritt', null),
    ('3937', 'col_east', 27, 'Hardscrabble', null),
    ('3111', 'florida', 28, 'Sunbeam Rd', null),
    ('3292', 'florida', 29, 'Orange Park', null),
    ('3136', 'florida', 30, 'Lem Turner', null),
    ('3211', 'florida', 31, 'Gainesville', null),
    ('2321', 'florida', 32, 'Beach Blvd', null),
    ('3548', 'florida', 33, 'Atlantic Blvd', null),
    ('2320', 'florida', 34, 'Semoran', null),
    ('2322', 'florida', 35, 'Oviedo', null),
    ('3029', 'charleston', 36, 'SpeeDee NC', 'B4C7E7'),
    ('3009', 'charleston', 37, 'SpeeDee SV', 'B4C7E7'),
    ('3308', 'speedee_lex', 38, 'SpeeDee Lex', null)
       ) s(store_number, market_code, sort_order, display_name, fill)
  join public.locations l on l.store_number = s.store_number and not l.is_sandbox
  join public.markets m on m.code = s.market_code
on conflict (location_id) do update
  set market_id = excluded.market_id, report_sort_order = excluded.report_sort_order,
      report_display_name = excluded.report_display_name, name_fill_override = excluded.name_fill_override;


-- ---------------------------------------------------------------------
-- 4. PER-STORE REPORT CONFIG (effective by month, carries forward)
-- ---------------------------------------------------------------------
create table if not exists public.store_report_config (
  location_id        uuid not null references public.locations (id) on delete cascade,
  plan_year          int  not null,
  month              int  not null check (month between 1 and 12),
  weekly_sales_goal  numeric(12,2) null check (weekly_sales_goal is null or weekly_sales_goal >= 0),
  tire_goal_per_day  numeric(6,2)  null check (tire_goal_per_day is null or tire_goal_per_day >= 0),
  tire_payout_min    numeric(6,2)  null check (tire_payout_min is null or tire_payout_min >= 0),
  bronze_floor_pct   numeric(5,4)  not null default 0.80 check (bronze_floor_pct > 0 and bronze_floor_pct <= 1),
  updated_at         timestamptz not null default now(),
  primary key (location_id, plan_year, month)
);

comment on table public.store_report_config is
  'Per-store report targets, effective from (plan_year, month): a report for month M uses each store''s latest row at or before M. tire_payout_min is compared with ">" (Matt: tires/day > 4.9). Null = not set, shown as such.';

insert into public.store_report_config (location_id, plan_year, month, weekly_sales_goal, tire_goal_per_day, tire_payout_min, bronze_floor_pct)
select l.id, 2026, 9, s.weekly::numeric, s.tire_goal::numeric, s.payout_min::numeric, s.bronze::numeric
  from (values
    ('3938', 45000, 8, 7.9, 0.85),
    ('3831', 30000, 4, 4.9, 0.80),
    ('3726', 27000, 4, 4.9, 0.80),
    ('3598', 21000, 4, 4.9, 0.80),
    ('3473', 58000, 4, 4.9, 0.80),
    ('3025', 31000, null, null, 0.80),
    ('3935', 75000, 25, 4.9, 0.80),
    ('3296', 23000, 4, 4.9, 0.80),
    ('3593', 26000, 4, 4.9, 0.80),
    ('3923', 31000, 4, 4.9, 0.80),
    ('3485', 30000, 4, 4.9, 0.80),
    ('3979', 90000, 17, 4.9, 0.80),
    ('3377', 29000, 5, 4.9, 0.80),
    ('3305', 28000, 5, 4.9, 0.80),
    ('5254', 45000, 5, 4.9, 0.80),
    ('5253', 40000, 5, 4.9, 0.80),
    ('3182', 31000, 5, 4.9, 0.80),
    ('3936', 29000, 5, 4.9, 0.80),
    ('3984', 25000, 5, 4.9, 0.80),
    ('3229', 35000, 5, 4.9, 0.80),
    ('3278', 32000, 5, 4.9, 0.80),
    ('3276', 48000, 5, 4.9, 0.80),
    ('3303', 37000, 5, 4.9, 0.80),
    ('3287', 37000, 5, 4.9, 0.80),
    ('3385', 28000, 5, 4.9, 0.80),
    ('3302', 35000, 5, 4.9, 0.80),
    ('3937', 29000, 5, 4.9, 0.80),
    ('3111', 27000, 5, 4.9, 0.80),
    ('3292', 34000, 5, 4.9, 0.80),
    ('3136', 30000, 5, 4.9, 0.80),
    ('3211', 32000, 5, 4.9, 0.80),
    ('2321', 30000, 5, 4.9, 0.80),
    ('3548', 26000, 5, 4.9, 0.80),
    ('3029', 29000, null, null, 0.80),
    ('3009', 36000, null, null, 0.80),
    ('3308', 12000, null, null, 0.80)
       ) s(store_number, weekly, tire_goal, payout_min, bronze)
  join public.locations l on l.store_number = s.store_number and not l.is_sandbox
on conflict (location_id, plan_year, month) do nothing;

-- The latest config row per store at or before a month. Readers go
-- through this so "carries forward" has one definition.
create or replace function public.store_report_config_for(p_year int, p_month int)
returns table (location_id uuid, weekly_sales_goal numeric, tire_goal_per_day numeric,
               tire_payout_min numeric, bronze_floor_pct numeric)
language sql stable set search_path = '' as $$
  select distinct on (c.location_id)
         c.location_id, c.weekly_sales_goal, c.tire_goal_per_day, c.tire_payout_min, c.bronze_floor_pct
    from public.store_report_config c
   where (c.plan_year, c.month) <= (p_year, p_month)
   order by c.location_id, c.plan_year desc, c.month desc;
$$;
grant execute on function public.store_report_config_for(int, int) to authenticated;


-- ---------------------------------------------------------------------
-- 5. GLOBAL REPORT SETTINGS
-- ---------------------------------------------------------------------
create table if not exists public.report_settings (
  key        text primary key,
  value      numeric not null,
  note       text null,
  updated_at timestamptz not null default now(),
  constraint report_settings_key_shape check (key ~ '^[a-z0-9_]+$')
);

comment on table public.report_settings is
  'The numbers Matt''s reports colour and pay by. One row each; change the row, not the code.';

insert into public.report_settings (key, value, note) values
  ('tier_gold_pct',          0.95,  'Gold = budget x this'),
  ('tier_silver_pct',        0.90,  'Silver = budget x this'),
  ('tier_bronze_pct',        0.80,  'Default bronze floor; a store''s store_report_config.bronze_floor_pct overrides'),
  ('aro_red_below',          275,   'ARO: red below, yellow up to aro_green_from'),
  ('aro_green_from',         299,   'ARO: green at or above'),
  ('gp_pct_red_below',       0.58,  'GP%: red below, yellow up to gp_pct_green_from'),
  ('gp_pct_green_from',      0.60,  'GP%: green at or above'),
  ('goal_pct_red_below',     0.899, '% of goal: red below, yellow up to goal_pct_green_above'),
  ('goal_pct_green_above',   0.999, '% of goal: green above'),
  ('align_yellow_from',      2,     'Alignments yesterday: yellow at or above, red below'),
  ('align_green_from',       3,     'Alignments yesterday: green at or above'),
  ('tire_payout_ahead',      500,   'Tire payout when tires/day > payout min and sales projection is ahead of 2025'),
  ('tire_payout_behind',     100,   'Tire payout when tires/day > payout min and sales projection is not ahead of 2025 (exactly level pays this too: the user, 2026-09-21)'),
  ('car_goal_extra_per_day', 2,     'Car goal = 2025 month cars + this x days open'),
  ('weeks_per_month',        4.345, '2025 sales per week = 2025 month sales / this'),
  ('days_per_week',          6,     'A pay week is Mon–Sat')
on conflict (key) do nothing;


-- ---------------------------------------------------------------------
-- 6. MARKET MANAGER BONUS BRACKETS (compensation: admin/master only)
-- ---------------------------------------------------------------------
create table if not exists public.market_bonus_brackets (
  min_pct_to_budget numeric(6,4) primary key,
  payout_pct        numeric(6,4) not null,
  improvement_share numeric(6,4) null,   -- "+5% of improvement" as a NUMBER, never the text "65%+5%"
  updated_at        timestamptz not null default now()
);

comment on table public.market_bonus_brackets is
  'Market manager bonus, % of salary, by % of GP budget reached. One table for every market (Matt''s file gave North a different top rung). Admin/master only.';

insert into public.market_bonus_brackets (min_pct_to_budget, payout_pct, improvement_share) values
  (1.00, 0.65, 0.05),
  (0.95, 0.55, null),
  (0.90, 0.40, null),
  (0.80, 0.25, null)
on conflict (min_pct_to_budget) do nothing;


-- ---------------------------------------------------------------------
-- 7. 2025 TIRES
-- ---------------------------------------------------------------------
alter table public.prior_year_actuals
  add column if not exists tires int null check (tires is null or tires >= 0);

comment on column public.prior_year_actuals.tires is
  'Tires sold that month (Report 5). Seeded for September 2025 from Matt''s workbook (migration 61); null = not supplied.';

update public.prior_year_actuals p
   set tires = s.tires
  from (values
    ('3938', 250),
    ('3831', 50),
    ('3726', 50),
    ('3598', 50),
    ('3473', 50),
    ('3935', 603),
    ('3296', 54),
    ('3593', 46),
    ('3923', 63),
    ('3485', 40),
    ('3979', 556),
    ('3377', 97),
    ('3305', 38),
    ('5254', 143),
    ('5253', 156),
    ('3182', 54),
    ('3936', 94),
    ('3984', 62),
    ('3229', 153),
    ('3278', 156),
    ('3276', 192),
    ('3303', 110),
    ('3287', 128),
    ('3385', 98),
    ('3302', 116),
    ('3937', 52),
    ('3111', 50),
    ('3292', 60),
    ('3136', 49),
    ('3211', 68),
    ('2321', 72),
    ('3548', 8)

       ) s(store_number, tires)
  join public.locations l on l.store_number = s.store_number
 where p.location_id = l.id and p.year = 2025 and p.month = 9 and p.tires is null;

-- A store with no 2025 September row (four North stores) still needs
-- its tires; give them a row that carries only tires.
insert into public.prior_year_actuals (location_id, year, month, tires)
select l.id, 2025, 9, s.tires
  from (values
    ('3938', 250),
    ('3831', 50),
    ('3726', 50),
    ('3598', 50),
    ('3473', 50),
    ('3935', 603),
    ('3296', 54),
    ('3593', 46),
    ('3923', 63),
    ('3485', 40),
    ('3979', 556),
    ('3377', 97),
    ('3305', 38),
    ('5254', 143),
    ('5253', 156),
    ('3182', 54),
    ('3936', 94),
    ('3984', 62),
    ('3229', 153),
    ('3278', 156),
    ('3276', 192),
    ('3303', 110),
    ('3287', 128),
    ('3385', 98),
    ('3302', 116),
    ('3937', 52),
    ('3111', 50),
    ('3292', 60),
    ('3136', 49),
    ('3211', 68),
    ('2321', 72),
    ('3548', 8)

       ) s(store_number, tires)
  join public.locations l on l.store_number = s.store_number
 where not exists (select 1 from public.prior_year_actuals p
                    where p.location_id = l.id and p.year = 2025 and p.month = 9);


-- ---------------------------------------------------------------------
-- 8. RLS  -- targets are readable by anyone who can open the reports;
--            only admin/master change them; bonus brackets are pay.
-- ---------------------------------------------------------------------
alter table public.markets               enable row level security;
alter table public.store_report_profile  enable row level security;
alter table public.store_report_config   enable row level security;
alter table public.report_settings       enable row level security;
alter table public.market_bonus_brackets enable row level security;

revoke all on public.markets, public.store_report_profile, public.store_report_config,
              public.report_settings, public.market_bonus_brackets from anon;
revoke truncate on public.markets, public.store_report_profile, public.store_report_config,
                   public.report_settings, public.market_bonus_brackets from authenticated;

drop policy if exists "markets_select" on public.markets;
create policy "markets_select" on public.markets for select to authenticated using (true);
drop policy if exists "markets_admin_write" on public.markets;
create policy "markets_admin_write" on public.markets for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "store_report_profile_select" on public.store_report_profile;
create policy "store_report_profile_select" on public.store_report_profile for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "store_report_profile_admin_write" on public.store_report_profile;
create policy "store_report_profile_admin_write" on public.store_report_profile for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "store_report_config_select" on public.store_report_config;
create policy "store_report_config_select" on public.store_report_config for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "store_report_config_admin_write" on public.store_report_config;
create policy "store_report_config_admin_write" on public.store_report_config for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "report_settings_select" on public.report_settings;
create policy "report_settings_select" on public.report_settings for select to authenticated using (true);
drop policy if exists "report_settings_admin_write" on public.report_settings;
create policy "report_settings_admin_write" on public.report_settings for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "market_bonus_brackets_admin_all" on public.market_bonus_brackets;
create policy "market_bonus_brackets_admin_all" on public.market_bonus_brackets for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

-- store_report_config_for() runs as the caller, so its RLS applies.

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Six markets, 38 stores placed, counts 8 / 6 / 5 / 10 / 1 / 8:
--        select m.name, count(p.location_id)
--          from public.markets m left join public.store_report_profile p on p.market_id = m.id
--         group by m.name, m.sort_order order by m.sort_order;
--
--  [2] Report order 1..38 with no gaps or repeats (expect 38, 1, 38):
--        select count(distinct report_sort_order), min(report_sort_order), max(report_sort_order)
--          from public.store_report_profile;
--
--  [3] September 2026 config for 36 stores (Semoran and Oviedo not set):
--        select count(*) from public.store_report_config where plan_year = 2026 and month = 9;
--
--  [4] September 2025 open days = 25 (Labor Day now counted):
--        select public.derived_days_open(2025, 9);
--
--  [5] "Yesterday" on Monday 2026-09-21 is Saturday 2026-09-19:
--        select public.report_default_date('2026-09-21');
-- =====================================================================
