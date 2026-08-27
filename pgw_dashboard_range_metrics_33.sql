-- =====================================================================
-- PGW Support Portal — Dashboard widgets over an arbitrary date range
-- Run AFTER pgw_payroll_daily_sunday_32.sql, in the Supabase SQL Editor.
-- Safe to re-run (drop-then-create throughout).
-- =====================================================================
-- Task 9 Part 3. Five widgets — Sales, Gross profit, Tires per day,
-- Credit apps, Payroll to sales — all driven by one shared date range
-- that can be any span the user picks, including one crossing months and
-- years.
--
-- SCOPING. Every function takes an optional `loc`. When null it
-- aggregates across every location the CALLER can see, which is what
-- makes one dashboard serve a store manager, a district manager, a
-- regional and a master without four code paths. Scoping runs through
-- `can_access_location()` inside the function, so a store user reading
-- an aggregate gets their store and nothing else, and a district user
-- gets their district and no further. The functions are SECURITY
-- DEFINER only because they must read the master-only rate tables to
-- cost labour; they re-check access themselves rather than relying on
-- table policies that a definer context bypasses.
--
-- OVERTIME IS ALWAYS WHOLE-WEEK. The technician pay engine is weekly:
-- overtime, and the guarantee-versus-commission choice, are properties
-- of a whole Sunday–Saturday week, not of whatever slice is on screen.
-- A range that cuts a week in half must not produce half-week overtime.
-- So `_tech_pay_range` evaluates each WHOLE week a range touches, then
-- attributes pay to the range by the share of that week's HOURS that
-- fall inside it. A range covering a whole week gets exactly that week's
-- pay; a range covering half of it gets half the week's pay computed at
-- full-week rates — never a half-week engine run.
--
-- WHICH "SALES". The portal has two, and they differ by Groupon:
--   * the tic sheet's Sales column excludes Groupon (migration 25), and
--     is what payroll_to_sales_wtd divides by (migration 32);
--   * lib/grossProfit.js's Summary model includes it, split 50/50 across
--     labour and parts (Summary R35-R39).
-- These functions use the TIC SHEET definition throughout, because Task
-- 9 names the tic sheet as the source for the Sales widget and Task 8
-- as the source for payroll-to-sales, and one dashboard must not show
-- two numbers both labelled Sales. `groupon` is returned separately so
-- the Summary figure stays one addition away and the difference is
-- never hidden. FLAGGED for BDC: if the dashboard should show the
-- Summary figure instead, it is this one decision, in one place.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TECHNICIAN PAY OVER A RANGE  (internal; per location)
--    Emits per-location labour cost, labour sales and hours for the
--    range, with pay evaluated over whole weeks and attributed by the
--    hours that fall inside the range.
--
--    REVOKED FROM PUBLIC: it reads tech_pay_rates and tech_weekly, both
--    master-only, and a per-slot figure would be an individual's pay.
--    Only the definer functions below may call it, and they return
--    store-level totals.
-- ---------------------------------------------------------------------
create or replace function public._tech_pay_range(d_from date, d_to date, loc uuid default null)
returns table (
  location_id  uuid,
  labor_sales  numeric,
  labor_cost   numeric,
  flag_hours   numeric,
  hours_worked numeric
)
language sql stable security definer set search_path = '' as $$
  with scope as (
    select l.id
      from public.locations l
     where public.can_access_location(l.id)
       and (loc is null or l.id = loc)
  ),
  -- Every day of every WHOLE week the range touches, so the engine sees
  -- complete weeks even when the range does not.
  d as (
    select
      td.location_id                                                as loc_id,
      td.tech_slot_id                                               as slot,
      (td.work_date - (extract(dow from td.work_date)::int))::date  as week_start,
      td.hours_worked                                               as hours,
      td.flag_hours                                                 as flag,
      td.labor_sales                                                as labor,
      td.hours_worked * coalesce(r.guarantee_rate, 0)               as guar_pay,
      td.flag_hours   * coalesce(r.flat_rate, 0)                    as commission,
      coalesce(r.guarantee_rate, 0)                                 as guar_rate,
      (td.work_date >= d_from and td.work_date <= d_to)             as in_range
    from public.tech_daily td
    join scope s on s.id = td.location_id
    left join lateral (
      select pr.flat_rate, pr.guarantee_rate
        from public.tech_pay_rates pr
       where pr.employee_id = td.employee_id
         and pr.effective_date <= td.work_date
       order by pr.effective_date desc
       limit 1
    ) r on true
    -- The WHOLE weeks the range touches: Sunday on-or-before d_from
    -- through Saturday on-or-after d_to.
    where td.work_date >= (d_from - (extract(dow from d_from)::int))
      and td.work_date <= (d_to + (6 - extract(dow from d_to)::int))
  ),
  per_week as (
    select
      d.loc_id, d.slot, d.week_start,
      sum(d.hours)                                          as ht,
      sum(d.guar_pay)                                       as gt,
      sum(d.commission)                                     as ct,
      max(d.guar_rate)                                      as gr,
      sum(d.hours) filter (where d.in_range)                as hours_in_range,
      sum(d.labor) filter (where d.in_range)                as labor_in_range,
      sum(d.flag)  filter (where d.in_range)                as flag_in_range
    from d
    group by d.loc_id, d.slot, d.week_start
  ),
  paid as (
    select
      pw.*,
      coalesce(tw.other_pay, 0) as op,
      -- Whole-week overtime. Below 40 hours there is none, by definition.
      case when pw.ht < 40 then 0
           when pw.gt > pw.ct then (pw.ht - 40) * pw.gr * 0.5
           else (pw.ht - 40) * (pw.ct / nullif(pw.ht, 0)) * 0.5 end as ot
    from per_week pw
    left join public.tech_weekly tw
      on tw.tech_slot_id = pw.slot and tw.week_start = pw.week_start
  ),
  attributed as (
    select
      paid.loc_id,
      coalesce(paid.labor_in_range, 0) as a_labor_sales,
      -- Whole-week pay, pro-rated by the hours inside the range.
      case when paid.ht = 0 then 0
           else (greatest(paid.gt + paid.ot, paid.ct) + paid.op)
                * (coalesce(paid.hours_in_range, 0) / paid.ht)
      end                              as a_labor_cost,
      coalesce(paid.flag_in_range, 0)  as a_flag,
      coalesce(paid.hours_in_range, 0) as a_hours
    from paid
  )
  select attributed.loc_id,
         coalesce(sum(attributed.a_labor_sales), 0),
         coalesce(sum(attributed.a_labor_cost), 0),
         coalesce(sum(attributed.a_flag), 0),
         coalesce(sum(attributed.a_hours), 0)
    from attributed
   group by attributed.loc_id;
$$;
revoke all on function public._tech_pay_range(date, date, uuid) from public;


-- ---------------------------------------------------------------------
-- 2. THE FIVE WIDGETS' NUMBERS
--    One call per dashboard load. Returns store-level aggregates only.
--
--    days_with_data counts DISTINCT dates that carry a real tic-sheet
--    row, never calendar days. Dividing tires by calendar days would
--    understate a mid-month view badly — on the 5th of the month it
--    would divide five days of tires by thirty.
--
--    An "entered" day is one whose daily_kpi row has any content. A row
--    is created merely by opening a day's panel, so an empty one must
--    not count as a day the store traded.
-- ---------------------------------------------------------------------
create or replace function public.dashboard_range_metrics(d_from date, d_to date, loc uuid default null)
returns table (
  store_count       int,
  gross_sales       numeric,
  labor_sales       numeric,
  labor_cost        numeric,
  parts_cost        numeric,
  tire_cost         numeric,
  cost_of_sales     numeric,
  gross_profit      numeric,
  gross_profit_pct  numeric,
  groupon           numeric,
  tire_units        numeric,
  days_with_data    int,
  tires_per_day     numeric,
  credit_apps       numeric,
  ro_count          numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  -- BIGINT, not uuid. service_categories and daily_kpi both use
  -- `bigint generated always as identity` (migration 18); only the
  -- location/employee tables are uuid-keyed. Declaring this uuid made
  -- the whole function fail with "invalid input syntax for type uuid".
  v_tire_cat bigint;
begin
  if d_from is null or d_to is null or d_from > d_to then
    raise exception 'invalid range % .. %', d_from, d_to using errcode = '22007';
  end if;
  if loc is not null and not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc using errcode = '42501';
  end if;

  select id into v_tire_cat
    from public.service_categories where horizon_key = 'kpi_su_tires' limit 1;

  return query
  with scope as (
    select l.id from public.locations l
     where public.can_access_location(l.id)
       and (loc is null or l.id = loc)
  ),
  k as (
    select dk.*
      from public.daily_kpi dk
      join scope s on s.id = dk.location_id
     where dk.business_date >= d_from and dk.business_date <= d_to
  ),
  -- A day the store actually traded, not merely a row that exists.
  --
  -- Every column below is QUALIFIED with its table alias on purpose. In
  -- plpgsql an OUT parameter is a variable, and this function has OUT
  -- parameters called ro_count, credit_apps, tire_units and others; a
  -- bare reference matching one of them raises 42702 or, worse, reads
  -- the variable instead of the column. Same trap noted in migration 32.
  entered as (
    select distinct k.business_date
      from k
     where coalesce(k.ro_count, 0) <> 0
        or coalesce(k.sales_parts, 0) <> 0
        or coalesce(k.sales_tires, 0) <> 0
        or coalesce(k.sales_supplies, 0) <> 0
        or coalesce(k.sales_discounts, 0) <> 0
        or coalesce(k.sales_groupon, 0) <> 0
  ),
  kpi as (
    select
      coalesce(sum(k.sales_parts), 0)     as parts,
      coalesce(sum(k.sales_tires), 0)     as tires,
      coalesce(sum(k.sales_supplies), 0)  as supplies,
      coalesce(sum(k.sales_groupon), 0)   as k_groupon,
      coalesce(sum(k.sales_discounts), 0) as discounts,
      coalesce(sum(k.cost_parts), 0)      as k_parts_cost,
      coalesce(sum(k.cost_tires), 0)      as k_tire_cost,
      -- ::numeric is NOT cosmetic. credit_apps, ro_count and units are
      -- int columns, so sum() returns BIGINT. Two things go wrong without
      -- the cast: the row fails to match this function's numeric result
      -- type, and — far worse — `tire_units / days_with_data` below
      -- becomes INTEGER DIVISION. 95 tires over 9 days would silently
      -- report 10 instead of 10.56, and nothing would look broken.
      coalesce(sum(k.credit_apps), 0)::numeric as k_credit_apps,
      coalesce(sum(k.ro_count), 0)::numeric    as k_ro_count
    from k
  ),
  units as (
    select coalesce(sum(dsu.units), 0)::numeric as k_tire_units
      from public.daily_service_units dsu
      join k on k.id = dsu.daily_kpi_id
     where v_tire_cat is not null and dsu.service_category_id = v_tire_cat
  ),
  tech as (
    select coalesce(sum(t.labor_sales), 0) as t_labor_sales,
           coalesce(sum(t.labor_cost), 0)  as t_labor_cost
      from public._tech_pay_range(d_from, d_to, loc) t
  ),
  agg as (
    select
      (select count(*)::int from scope)   as n_stores,
      (select count(*)::int from entered) as n_days,
      kpi.*, units.k_tire_units, tech.t_labor_sales, tech.t_labor_cost
    from kpi, units, tech
  )
  select
    -- EVERY column is cast explicitly. RETURNS TABLE matches by position
    -- AND by type, and the inference here is not obvious: sum() over an
    -- int column yields BIGINT, count() yields bigint, and a CASE whose
    -- first branch is a bare NULL takes its type from the other branch.
    -- Leaving any of it implicit produces "structure of query does not
    -- match function result type" — an error that names no column, so it
    -- tells you nothing about which one is wrong. Casting all fifteen
    -- costs nothing and removes the guessing.
    agg.n_stores::int,
    -- Tic-sheet Sales: labour + parts + tires + supplies + discounts.
    -- Groupon is EXCLUDED (migration 25) and returned separately.
    -- Discounts are stored signed and added algebraically.
    (agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts)::numeric,
    agg.t_labor_sales::numeric,
    agg.t_labor_cost::numeric,
    agg.k_parts_cost::numeric,
    agg.k_tire_cost::numeric,
    (agg.t_labor_cost + agg.k_parts_cost + agg.k_tire_cost)::numeric,
    -- Gross profit INCLUDING technician labour cost. The old pre-labour
    -- figure (migration 22) subtracted only parts and tyres; if this
    -- equals that, it is reading the wrong source.
    ((agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) - (agg.t_labor_cost + agg.k_parts_cost + agg.k_tire_cost))::numeric,
    (case when (agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) = 0 then null
          else ((agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) - (agg.t_labor_cost + agg.k_parts_cost + agg.k_tire_cost)) / (agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) end)::numeric,
    agg.k_groupon::numeric,
    agg.k_tire_units::numeric,
    agg.n_days::int,
    -- UNITS per day WITH DATA, never dollars and never per calendar day.
    -- 90 tires over 9 traded days reads 10.0; the same 90 spread over a
    -- 31-day August would read 2.9 and be useless on the 12th.
    (case when agg.n_days = 0 then null
          else agg.k_tire_units::numeric / agg.n_days::numeric end)::numeric,
    agg.k_credit_apps::numeric,
    agg.k_ro_count::numeric
  from agg;
end;
$$;
grant execute on function public.dashboard_range_metrics(date, date, uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 2b. TECH TRACKER STORE TOTALS OVER A RANGE
--     The range twin of tech_store_month (migration 24). Same columns,
--     same meaning, so the Tech Tracker's store strip reads one shape
--     whether it is showing a calendar month or an arbitrary span.
--
--     Pay comes from _tech_pay_range, so overtime is evaluated over
--     WHOLE Sunday–Saturday weeks and attributed to the range by hours.
--     A range covering half a week therefore shows half that week's pay
--     at full-week rates — never a half-week overtime calculation.
--
--     ELR is deliberately NOT returned, for the same reason as
--     tech_store_month: the official figure is groupon-blended
--     (Summary!R22) and groupon lives in daily_kpi, so it is composed in
--     lib/grossProfit.js where both operands are available. Returning a
--     raw labor/flag ratio here would put a second, different number
--     under the same label.
-- ---------------------------------------------------------------------
create or replace function public.tech_store_range(loc uuid, d_from date, d_to date)
returns table (
  labor_sales               numeric,
  labor_cost                numeric,
  flag_hours                numeric,
  hours_worked              numeric,
  avg_tech_cost_per_sold_hr numeric,
  shop_proficiency          numeric
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc using errcode = '42501';
  end if;

  return query
  with t as (
    select * from public._tech_pay_range(d_from, d_to, loc)
  )
  select
    coalesce(sum(t.labor_sales), 0),
    coalesce(sum(t.labor_cost), 0),
    coalesce(sum(t.flag_hours), 0),
    coalesce(sum(t.hours_worked), 0),
    case when coalesce(sum(t.flag_hours), 0) = 0 then 0
         else sum(t.labor_cost) / sum(t.flag_hours) end,
    case when coalesce(sum(t.hours_worked), 0) = 0 then 0
         else sum(t.flag_hours) / sum(t.hours_worked) end
  from t;
end;
$$;
grant execute on function public.tech_store_range(uuid, date, date) to authenticated;


-- ---------------------------------------------------------------------
-- 3. PAYROLL TO SALES OVER A RANGE
--    The Task 8 metric (migration 32) generalised from one week to any
--    span. Same rules, unchanged:
--      * the store manager is excluded ENTIRELY — not their wages, not
--        their hours, not their days in the window bound;
--      * timesheet_pay.bonus and incentives are never added;
--      * technicians come in at the Tech Tracker engine's figure with
--        tech_weekly.other_pay kept, subject to payroll_config;
--      * both sides cover the IDENTICAL window — the intersection of the
--        days each has data for.
--
--    Overtime is whole-week here too: a non-technician's week is
--    evaluated over its full Sunday–Saturday hours and pro-rated into
--    the range by the hours inside it, so a range cutting a week in half
--    yields half that week's pay at full-week rates, not a half-week
--    overtime calculation.
--
--    Pre-cutover days contribute nothing: hours before the daily cutover
--    exist only as one weekly total per person, and a lump sum cannot be
--    apportioned to days. The window bound reflects that honestly rather
--    than silently treating those days as zero-wage.
-- ---------------------------------------------------------------------
create or replace function public.payroll_to_sales_range(d_from date, d_to date, loc uuid default null)
returns table (
  window_start      date,
  window_end        date,
  hours_thru        date,
  sales_thru        date,
  wages_non_tech    numeric,
  wages_tech        numeric,
  wages_total       numeric,
  gross_sales       numeric,
  payroll_to_sales  numeric,
  techs_included    boolean,
  store_count       int
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_techs  boolean;
  v_cut    date;
  v_start  date;
  v_hours  date;
  v_sales  date;
  v_end    date;
  v_non    numeric := 0;
  v_tech   numeric := 0;
  v_gross  numeric := 0;
begin
  if d_from is null or d_to is null or d_from > d_to then
    raise exception 'invalid range % .. %', d_from, d_to using errcode = '22007';
  end if;
  if loc is not null and not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc using errcode = '42501';
  end if;

  select include_technicians, daily_cutover_date into v_techs, v_cut
    from public.payroll_config where id;

  -- Daily hours begin at the cutover; earlier days cannot contribute.
  v_start := greatest(d_from, v_cut);

  window_start   := v_start;
  techs_included := v_techs;
  select count(*)::int into store_count
    from public.locations l
   where public.can_access_location(l.id) and (loc is null or l.id = loc);

  if v_start > d_to then
    window_end := null; hours_thru := null; sales_thru := null;
    wages_non_tech := null; wages_tech := null; wages_total := null;
    gross_sales := null; payroll_to_sales := null;
    return next; return;
  end if;

  select max(pd.work_date) into v_hours
    from public.payroll_daily pd
    join public.employees e on e.id = pd.employee_id
    join public.locations l on l.id = pd.location_id
   where public.can_access_location(l.id) and (loc is null or l.id = loc)
     and not e.is_store_manager
     and pd.work_date >= v_start and pd.work_date <= d_to
     and (pd.hours_worked + pd.hours_worked_other) > 0;

  select greatest(v_hours, max(td.work_date)) into v_hours
    from public.tech_daily td
    join public.locations l on l.id = td.location_id
   where public.can_access_location(l.id) and (loc is null or l.id = loc)
     and td.employee_id is not null
     and td.work_date >= v_start and td.work_date <= d_to
     and td.hours_worked > 0;

  select max(dk.business_date) into v_sales
    from public.daily_kpi dk
    join public.locations l on l.id = dk.location_id
   where public.can_access_location(l.id) and (loc is null or l.id = loc)
     and dk.business_date >= v_start and dk.business_date <= d_to
     and (coalesce(dk.ro_count, 0) <> 0
          or coalesce(dk.sales_parts, 0) <> 0
          or coalesce(dk.sales_tires, 0) <> 0
          or coalesce(dk.sales_supplies, 0) <> 0
          or coalesce(dk.sales_discounts, 0) <> 0);

  -- NOT least(): SQL's LEAST ignores nulls and would return the other
  -- bound, so a side with no data at all would silently not constrain
  -- the window. If either side is empty there is no overlap.
  if v_hours is null or v_sales is null then
    v_end := null;
  else
    v_end := least(v_hours, v_sales);
  end if;

  window_end := v_end;
  hours_thru := v_hours;
  sales_thru := v_sales;

  if v_end is null or v_end < v_start then
    wages_non_tech := null; wages_tech := null; wages_total := null;
    gross_sales := null; payroll_to_sales := null;
    return next; return;
  end if;

  -- ---- non-technician wages, whole-week overtime, pro-rated ---------
  with scope as (
    select l.id from public.locations l
     where public.can_access_location(l.id) and (loc is null or l.id = loc)
  ),
  wk as (
    select
      pd.employee_id,
      (pd.work_date - (extract(dow from pd.work_date)::int))::date as week_start,
      sum(pd.hours_worked + pd.hours_worked_other)                 as week_hours,
      sum(pd.hours_turned)                                         as week_turned,
      sum((pd.hours_worked + pd.hours_worked_other))
        filter (where pd.work_date >= v_start and pd.work_date <= v_end) as hours_in,
      sum(pd.hours_turned)
        filter (where pd.work_date >= v_start and pd.work_date <= v_end) as turned_in
    from public.payroll_daily pd
    join scope s on s.id = pd.location_id
    join public.employees e on e.id = pd.employee_id
   where not e.is_store_manager
     and pd.work_date >= (v_start - (extract(dow from v_start)::int))
     and pd.work_date <= (v_end + (6 - extract(dow from v_end)::int))
   group by pd.employee_id, (pd.work_date - (extract(dow from pd.work_date)::int))::date
  )
  select coalesce(sum(
    case when wk.week_hours = 0 then 0
         else greatest(
                coalesce(r.hourly_rate, 0) * least(wk.week_hours, 40)
                  + coalesce(r.hourly_rate, 0) * 1.5 * greatest(wk.week_hours - 40, 0),
                coalesce(r.flat_rate_per_hour, 0) * wk.week_turned)
              * (coalesce(wk.hours_in, 0) / wk.week_hours)
    end), 0)
    into v_non
    from wk
    left join public.employee_pay_rates r on r.employee_id = wk.employee_id;

  -- ---- technician wages, from the engine, already whole-week --------
  if v_techs then
    select coalesce(sum(t.labor_cost), 0) into v_tech
      from public._tech_pay_range(v_start, v_end, loc) t;
  else
    v_tech := 0;
  end if;

  -- ---- denominator: the tic sheet's own Sales ------------------------
  select coalesce(sum(
           coalesce(lab.labor, 0) + coalesce(k.sales_parts, 0) + coalesce(k.sales_tires, 0)
           + coalesce(k.sales_supplies, 0) + coalesce(k.sales_discounts, 0)), 0)
    into v_gross
    from public.locations l
    left join public.daily_kpi k
           on k.location_id = l.id and k.business_date >= v_start and k.business_date <= v_end
    left join lateral (
      select sum(td.labor_sales) as labor
        from public.tech_daily td
       where td.location_id = l.id and td.work_date = k.business_date
    ) lab on true
   where public.can_access_location(l.id) and (loc is null or l.id = loc);

  wages_non_tech   := v_non;
  wages_tech       := v_tech;
  wages_total      := v_non + v_tech;
  gross_sales      := v_gross;
  payroll_to_sales := case when v_gross = 0 then null else (v_non + v_tech) / v_gross end;
  return next;
end;
$$;
grant execute on function public.payroll_to_sales_range(date, date, uuid) to authenticated;


-- =====================================================================
-- VERIFY
--
--  1) Scoping. As a STORE user, an unscoped call must return their store
--     only, and naming another store must be refused:
--       select store_count from public.dashboard_range_metrics('2026-07-01','2026-07-31');
--         -> 1
--       select * from public.dashboard_range_metrics('2026-07-01','2026-07-31','OTHER-STORE');
--         -> 42501 not authorized
--     As MASTER the same unscoped call returns 36.
--
--  2) Gross profit must INCLUDE technician labour cost. Against
--     Millwood July it must NOT equal the old pre-labour figure:
--       select gross_sales, labor_cost, gross_profit
--         from public.dashboard_range_metrics('2026-07-01','2026-07-31','MILLWOOD');
--       -- gross_profit = gross_sales - labor_cost - parts_cost - tire_cost,
--       -- and labor_cost must be non-zero (~15,640.19 for Millwood July).
--
--  3) Tires per day divides by days WITH DATA:
--       select tire_units, days_with_data, tires_per_day
--         from public.dashboard_range_metrics('2026-07-01','2026-07-31','MILLWOOD');
--       -- days_with_data is the count of entered days (July 2026 has 27
--       -- traded days, not 31), and tires_per_day = tire_units / that.
--
--  4) Whole-week overtime. Take a range covering the FIRST HALF of a
--     week in which a technician exceeded 40 hours, and confirm the
--     labour cost equals that week's whole-week pay times the share of
--     the week's hours inside the range — never a 40-hour threshold
--     applied to the half:
--       select labor_cost from public._tech_pay_range('2026-07-06','2026-07-08','MILLWOOD');
--
--  5) A range crossing months and years is accepted and returns figures:
--       select * from public.dashboard_range_metrics('2026-05-03','2026-09-17');
-- =====================================================================
