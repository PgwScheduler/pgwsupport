-- =====================================================================
-- PGW Support Portal — Store goals (2026) : schema + seed + RLS
-- Run AFTER pgw_speedee_service_categories_19.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Shows each store what it is aiming for. Data only — no bonuses, no
-- technician entry, no external upload (those are separate, later tasks).
--
-- The schema, the two day-count functions, the seed data, and the derived
-- view all come from the supplied `step2_goals_seed.sql` and are reproduced
-- here UNCHANGED in shape and values. Additions layered on top:
--   * light idempotency guards (`if not exists`, `on conflict do nothing`)
--     so the migration matches the repo's "safe to re-run" convention;
--   * Row Level Security (Step 3) — absent from the seed file;
--   * `security_invoker = true` on the derived view, so a store user reading
--     it is subject to the same RLS as the base tables (without this, the
--     view would run as its owner and leak every store's targets).
-- Nothing else — the numbers, day counts, and 308-working-day basis are the
-- author's, computed by annual_days_open() (never hardcoded).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. HOLIDAYS — five closures a year (2026 + 2027)
-- ---------------------------------------------------------------------
create table if not exists holidays (
  holiday_date date primary key,
  name         text not null
);

insert into holidays (holiday_date, name) values
  ('2026-01-01','New Year''s Day'), ('2026-07-04','Independence Day'),
  ('2026-09-07','Labor Day'),       ('2026-11-26','Thanksgiving'),
  ('2026-12-25','Christmas'),
  ('2027-01-01','New Year''s Day'), ('2027-07-04','Independence Day'),
  ('2027-09-06','Labor Day'),       ('2027-11-25','Thanksgiving'),
  ('2027-12-25','Christmas')
on conflict (holiday_date) do nothing;


-- ---------------------------------------------------------------------
-- 2. DAY-COUNT FUNCTIONS  (Mon–Sat, minus holidays)
--    annual_days_open(2026) = 308. Never hardcode it — this computes it,
--    so 2027 works with no edit.
-- ---------------------------------------------------------------------
create or replace function derived_days_open(p_year int, p_month int)
returns int language sql stable as $$
  select count(*)::int
  from generate_series(make_date(p_year,p_month,1),
                       (make_date(p_year,p_month,1) + interval '1 month - 1 day')::date,
                       '1 day') d
  where extract(dow from d) <> 0
    and not exists (select 1 from holidays h where h.holiday_date = d::date);
$$;

create or replace function annual_days_open(p_year int)
returns int language sql stable as $$
  select sum(derived_days_open(p_year, m))::int from generate_series(1,12) m;
$$;

grant execute on function derived_days_open(int, int) to authenticated;
grant execute on function annual_days_open(int)      to authenticated;


-- ---------------------------------------------------------------------
-- 3. GOAL TABLES
-- ---------------------------------------------------------------------
create table if not exists store_annual_goals (
  location_id uuid not null references locations(id) on delete cascade,
  goal_year   int  not null,
  gp_target   numeric(14,2) not null,
  updated_at  timestamptz not null default now(),
  primary key (location_id, goal_year)
);

create table if not exists store_monthly_goals (
  location_id        uuid not null references locations(id) on delete cascade,
  goal_year          int  not null,
  goal_month         int  not null check (goal_month between 1 and 12),
  days_open_override int,
  cars_per_day_goal  numeric(5,1),
  updated_at         timestamptz not null default now(),
  primary key (location_id, goal_year, goal_month)
);


-- ---------------------------------------------------------------------
-- 4. SEED — annual gross profit targets, 2026 (36 stores)
-- ---------------------------------------------------------------------
insert into store_annual_goals (location_id, goal_year, gp_target)
select l.id, 2026, v.gp from (values
  ('2321', 878082),
  ('3009', 964809),
  ('3025', 985165),
  ('3029', 762676),
  ('3111', 817732),
  ('3136', 898788),
  ('3182', 934780),
  ('3211', 958832),
  ('3229', 987407),
  ('3276', 1353659),
  ('3278', 986915),
  ('3287', 1072373),
  ('3292', 1118323),
  ('3296', 641654),
  ('3302', 967093),
  ('3303', 1107693),
  ('3305', 808807),
  ('3308', 343298),
  ('3377', 847628),
  ('3385', 805358),
  ('3473', 1837133),
  ('3485', 858368),
  ('3548', 768818),
  ('3593', 736609),
  ('3598', 628627),
  ('3726', 794147),
  ('3831', 964102),
  ('3923', 924015),
  ('3935', 2242461),
  ('3936', 858826),
  ('3937', 864821),
  ('3938', 1100000),
  ('3979', 2422106),
  ('3984', 730100),
  ('5253', 1118726),
  ('5254', 1296207)
) as v(store_number, gp) join locations l on l.store_number = v.store_number
on conflict (location_id, goal_year) do nothing;


-- ---------------------------------------------------------------------
-- 5. SEED — cars-per-day goals (27 stores x 12 months = 324 rows)
--    The nine Model-B stores (3296, 3305, 3485, 3593, 3598, 3726, 3831,
--    3923, 3984) intentionally have NO cars-per-day goal.
-- ---------------------------------------------------------------------
insert into store_monthly_goals (location_id, goal_year, goal_month, cars_per_day_goal)
select l.id, 2026, v.mo, v.cpd from (values
  ('2321',1,15.1), ('2321',2,14.8), ('2321',3,14.0), ('2321',4,14.9), ('2321',5,14.0), ('2321',6,13.8), ('2321',7,13.3), ('2321',8,13.5), ('2321',9,12.5), ('2321',10,11.9), ('2321',11,12.2), ('2321',12,10.8),
  ('3009',1,33.7), ('3009',2,34.5), ('3009',3,35.5), ('3009',4,33.0), ('3009',5,34.7), ('3009',6,34.8), ('3009',7,35.5), ('3009',8,30.7), ('3009',9,33.0), ('3009',10,29.1), ('3009',11,32.0), ('3009',12,28.7),
  ('3025',1,36.5), ('3025',2,36.5), ('3025',3,36.4), ('3025',4,38.0), ('3025',5,35.9), ('3025',6,33.0), ('3025',7,36.5), ('3025',8,37.2), ('3025',9,35.6), ('3025',10,35.6), ('3025',11,34.2), ('3025',12,35.3),
  ('3029',1,25.0), ('3029',2,25.0), ('3029',3,28.4), ('3029',4,26.4), ('3029',5,26.7), ('3029',6,28.3), ('3029',7,27.7), ('3029',8,27.0), ('3029',9,27.5), ('3029',10,25.7), ('3029',11,24.3), ('3029',12,24.9),
  ('3111',1,11.3), ('3111',2,14.2), ('3111',3,13.8), ('3111',4,13.7), ('3111',5,13.9), ('3111',6,13.4), ('3111',7,13.9), ('3111',8,11.8), ('3111',9,13.0), ('3111',10,12.1), ('3111',11,11.6), ('3111',12,10.3),
  ('3136',1,15.7), ('3136',2,17.9), ('3136',3,19.7), ('3136',4,18.0), ('3136',5,18.5), ('3136',6,17.9), ('3136',7,18.8), ('3136',8,18.5), ('3136',9,17.0), ('3136',10,14.1), ('3136',11,13.8), ('3136',12,12.8),
  ('3182',1,15.1), ('3182',2,15.5), ('3182',3,16.9), ('3182',4,16.2), ('3182',5,17.4), ('3182',6,19.3), ('3182',7,21.3), ('3182',8,19.9), ('3182',9,20.3), ('3182',10,17.1), ('3182',11,17.2), ('3182',12,16.4),
  ('3211',1,16.1), ('3211',2,21.0), ('3211',3,21.8), ('3211',4,20.1), ('3211',5,22.4), ('3211',6,24.2), ('3211',7,21.2), ('3211',8,24.1), ('3211',9,22.0), ('3211',10,23.2), ('3211',11,23.0), ('3211',12,19.3),
  ('3229',1,20.2), ('3229',2,20.5), ('3229',3,21.5), ('3229',4,20.8), ('3229',5,22.1), ('3229',6,19.9), ('3229',7,20.6), ('3229',8,21.2), ('3229',9,19.1), ('3229',10,16.6), ('3229',11,19.0), ('3229',12,19.3),
  ('3276',1,21.5), ('3276',2,20.8), ('3276',3,22.8), ('3276',4,23.2), ('3276',5,22.9), ('3276',6,23.8), ('3276',7,24.2), ('3276',8,22.1), ('3276',9,19.8), ('3276',10,21.4), ('3276',11,20.7), ('3276',12,21.7),
  ('3278',1,16.8), ('3278',2,19.2), ('3278',3,20.1), ('3278',4,17.5), ('3278',5,17.5), ('3278',6,19.0), ('3278',7,20.8), ('3278',8,20.9), ('3278',9,19.4), ('3278',10,19.5), ('3278',11,20.0), ('3278',12,18.6),
  ('3287',1,17.3), ('3287',2,17.2), ('3287',3,20.6), ('3287',4,20.6), ('3287',5,20.3), ('3287',6,19.9), ('3287',7,20.7), ('3287',8,19.2), ('3287',9,19.4), ('3287',10,20.8), ('3287',11,20.0), ('3287',12,19.0),
  ('3292',1,14.8), ('3292',2,14.8), ('3292',3,17.2), ('3292',4,16.8), ('3292',5,16.7), ('3292',6,16.2), ('3292',7,15.2), ('3292',8,15.1), ('3292',9,15.0), ('3292',10,13.3), ('3292',11,15.8), ('3292',12,13.5),
  ('3302',1,18.2), ('3302',2,22.1), ('3302',3,23.6), ('3302',4,23.6), ('3302',5,23.4), ('3302',6,25.6), ('3302',7,24.9), ('3302',8,27.2), ('3302',9,23.6), ('3302',10,23.0), ('3302',11,23.9), ('3302',12,22.3),
  ('3303',1,16.1), ('3303',2,18.8), ('3303',3,17.9), ('3303',4,18.6), ('3303',5,19.2), ('3303',6,17.1), ('3303',7,16.7), ('3303',8,17.0), ('3303',9,16.8), ('3303',10,18.4), ('3303',11,17.6), ('3303',12,17.2),
  ('3308',1,10.4), ('3308',2,11.9), ('3308',3,11.5), ('3308',4,10.8), ('3308',5,10.9), ('3308',6,10.8), ('3308',7,10.4), ('3308',8,10.1), ('3308',9,10.8), ('3308',10,10.8), ('3308',11,9.9), ('3308',12,9.2),
  ('3377',1,18.9), ('3377',2,20.8), ('3377',3,21.3), ('3377',4,22.0), ('3377',5,19.7), ('3377',6,21.2), ('3377',7,23.0), ('3377',8,16.8), ('3377',9,18.6), ('3377',10,17.2), ('3377',11,16.0), ('3377',12,12.0),
  ('3385',1,15.3), ('3385',2,18.7), ('3385',3,19.3), ('3385',4,20.2), ('3385',5,18.7), ('3385',6,21.6), ('3385',7,21.2), ('3385',8,20.5), ('3385',9,18.5), ('3385',10,19.0), ('3385',11,17.2), ('3385',12,15.2),
  ('3473',1,18.2), ('3473',2,19.2), ('3473',3,19.8), ('3473',4,18.2), ('3473',5,18.4), ('3473',6,20.2), ('3473',7,18.3), ('3473',8,18.0), ('3473',9,16.9), ('3473',10,17.5), ('3473',11,19.8), ('3473',12,17.8),
  ('3548',1,11.5), ('3548',2,12.8), ('3548',3,12.7), ('3548',4,10.8), ('3548',5,11.5), ('3548',6,11.7), ('3548',7,11.5), ('3548',8,12.1), ('3548',9,11.6), ('3548',10,10.7), ('3548',11,11.3), ('3548',12,9.2),
  ('3935',1,47.1), ('3935',2,49.5), ('3935',3,52.6), ('3935',4,51.7), ('3935',5,48.5), ('3935',6,47.2), ('3935',7,51.3), ('3935',8,48.2), ('3935',9,44.5), ('3935',10,38.3), ('3935',11,34.3), ('3935',12,34.7),
  ('3936',1,13.5), ('3936',2,16.2), ('3936',3,17.3), ('3936',4,18.0), ('3936',5,17.1), ('3936',6,16.6), ('3936',7,15.9), ('3936',8,17.6), ('3936',9,17.3), ('3936',10,15.6), ('3936',11,16.3), ('3936',12,16.6),
  ('3937',1,18.0), ('3937',2,20.0), ('3937',3,20.2), ('3937',4,19.0), ('3937',5,17.8), ('3937',6,18.3), ('3937',7,18.9), ('3937',8,18.7), ('3937',9,16.7), ('3937',10,17.4), ('3937',11,20.9), ('3937',12,19.0),
  ('3938',1,23.0), ('3938',2,22.0), ('3938',3,22.0), ('3938',4,24.0), ('3938',5,22.0), ('3938',6,27.0), ('3938',7,25.0), ('3938',8,27.0), ('3938',9,22.0), ('3938',10,25.0), ('3938',11,24.0), ('3938',12,23.0),
  ('3979',1,36.8), ('3979',2,40.5), ('3979',3,39.3), ('3979',4,41.7), ('3979',5,42.3), ('3979',6,43.8), ('3979',7,44.6), ('3979',8,42.3), ('3979',9,42.7), ('3979',10,38.5), ('3979',11,37.3), ('3979',12,38.5),
  ('5253',1,22.1), ('5253',2,23.7), ('5253',3,25.5), ('5253',4,23.8), ('5253',5,24.9), ('5253',6,27.3), ('5253',7,28.6), ('5253',8,27.4), ('5253',9,24.2), ('5253',10,23.3), ('5253',11,23.5), ('5253',12,21.0),
  ('5254',1,22.2), ('5254',2,25.8), ('5254',3,29.0), ('5254',4,25.5), ('5254',5,26.2), ('5254',6,25.1), ('5254',7,25.4), ('5254',8,24.6), ('5254',9,25.1), ('5254',10,26.6), ('5254',11,24.8), ('5254',12,24.5)
) as v(store_number, mo, cpd) join locations l on l.store_number = v.store_number
on conflict (location_id, goal_year, goal_month) do nothing;


-- ---------------------------------------------------------------------
-- 6. DERIVED VIEW — monthly gross profit target
--    annual / working days in year * working days in that month.
--    security_invoker=true so the store user's RLS on the base tables
--    applies when the view is read (added on top of the supplied seed).
-- ---------------------------------------------------------------------
create or replace view v_store_monthly_gp_target
  with (security_invoker = true) as
select a.location_id, a.goal_year, m.goal_month,
       coalesce(g.days_open_override, derived_days_open(a.goal_year, m.goal_month)) as days_open,
       round(a.gp_target / annual_days_open(a.goal_year)
             * coalesce(g.days_open_override, derived_days_open(a.goal_year, m.goal_month)), 2) as gp_target
from store_annual_goals a
cross join generate_series(1,12) as m(goal_month)
left join store_monthly_goals g
       on g.location_id = a.location_id
      and g.goal_year   = a.goal_year
      and g.goal_month  = m.goal_month;


-- ---------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY  (Step 3 — not in the seed file)
--    goals: read via can_access_location(location_id), write admin/master.
--    holidays: read by all authenticated, write master only.
-- ---------------------------------------------------------------------
alter table store_annual_goals  enable row level security;
alter table store_monthly_goals enable row level security;
alter table holidays            enable row level security;

-- store_annual_goals
drop policy if exists "store_annual_goals_select" on store_annual_goals;
create policy "store_annual_goals_select" on store_annual_goals for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "store_annual_goals_write" on store_annual_goals;
create policy "store_annual_goals_write" on store_annual_goals for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

-- store_monthly_goals
drop policy if exists "store_monthly_goals_select" on store_monthly_goals;
create policy "store_monthly_goals_select" on store_monthly_goals for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "store_monthly_goals_write" on store_monthly_goals;
create policy "store_monthly_goals_write" on store_monthly_goals for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

-- holidays
drop policy if exists "holidays_select" on holidays;
create policy "holidays_select" on holidays for select to authenticated
  using (true);
drop policy if exists "holidays_master_write" on holidays;
create policy "holidays_master_write" on holidays for all to authenticated
  using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');


-- =====================================================================
-- VERIFY
--   1) Seed counts:
--        select count(*) from store_annual_goals;    -- 36
--        select count(*) from store_monthly_goals;   -- 324
--   2) derived_days_open(2026, m) for 1..12 -> 26,24,26,26,26,26,26,26,25,27,24,26 (sum 308):
--        select m, derived_days_open(2026, m) from generate_series(1,12) m;
--        select annual_days_open(2026);               -- 308
--   3) Monthly targets:
--        select gp_target from v_store_monthly_gp_target
--          where location_id = (select id from locations where store_number='3303')
--            and goal_year=2026 and goal_month=7;      -- 93506.55
--        select gp_target from v_store_monthly_gp_target
--          where location_id = (select id from locations where store_number='3009')
--            and goal_year=2026 and goal_month=7;      -- 81444.92
--   4) As a STORE user: select on the goal tables returns only their store;
--      update is denied (admin/master only).
-- =====================================================================
