-- =====================================================================
-- PGW Support Portal — the dashboard's gross profit includes Adjustments
-- Run AFTER pgw_adjustments_48.sql, in the SQL Editor.
-- Safe to re-run (create or replace; same signature and columns).
-- =====================================================================
-- The portal had two gross profits that differed by exactly the
-- Adjustments (formerly Groupon) amount:
--   * lib/grossProfit.js (Summary R35) includes it, split 50/50 across
--     labour and parts. The Bonus Tracker pays on it; the goals strip and
--     the Report Builder show it.
--   * dashboard_range_metrics (migration 33) left it out.
-- DECIDED by the user, 2026-09-17: the figure that includes Adjustments
-- is correct. This migration changes the dashboard to match.
--
-- WHAT CHANGES (two columns):
--   gross_profit      = Sales + Adjustments - (labour + parts + tyre cost)
--   gross_profit_pct  = gross_profit / (Sales + Adjustments)
-- Both now equal report_build()'s gross_profit / gross_profit_pct for
-- the same stores and dates.
--
-- WHAT DOES NOT CHANGE:
--   * gross_sales stays the Tic Sheet's Sales (Adjustments excluded).
--     It feeds the Sales widget; payroll-to-sales has its own function
--     and is untouched.
--   * cost_of_sales, groupon (the Adjustments sum) and every other column.
-- The body below is migration 48's with only those two expressions (and
-- their comments) changed.
-- =====================================================================

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
     where public.can_access_location(l.id) and l.is_sandbox = false
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
        or coalesce(k.sales_adjustments, 0) <> 0
  ),
  kpi as (
    select
      coalesce(sum(k.sales_parts), 0)     as parts,
      coalesce(sum(k.sales_tires), 0)     as tires,
      coalesce(sum(k.sales_supplies), 0)  as supplies,
      coalesce(sum(k.sales_adjustments), 0)   as k_groupon,
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
    -- Adjustments are EXCLUDED from Sales (migration 25) and returned
    -- separately (column `groupon`, name kept in migration 48); gross
    -- profit below adds them back.
    -- Discounts are stored signed and added algebraically.
    (agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts)::numeric,
    agg.t_labor_sales::numeric,
    agg.t_labor_cost::numeric,
    agg.k_parts_cost::numeric,
    agg.k_tire_cost::numeric,
    (agg.t_labor_cost + agg.k_parts_cost + agg.k_tire_cost)::numeric,
    -- Gross profit INCLUDING technician labour cost AND Adjustments
    -- (migration 49: the figure managers are paid on, lib/grossProfit.js,
    -- and the Report Builder's). The old pre-labour figure (migration 22)
    -- subtracted only parts and tyres; if this equals that, it is reading
    -- the wrong source.
    (((agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) + agg.k_groupon) - (agg.t_labor_cost + agg.k_parts_cost + agg.k_tire_cost))::numeric,
    -- GP % is over Sales PLUS Adjustments, as the Report Builder's is, so
    -- the two screens publish one percentage.
    (case when ((agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) + agg.k_groupon) = 0 then null
          else (((agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) + agg.k_groupon) - (agg.t_labor_cost + agg.k_parts_cost + agg.k_tire_cost)) / ((agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) + agg.k_groupon) end)::numeric,
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


-- =====================================================================
-- VERIFY — in the SQL Editor (as a signed-in master this needs a JWT;
-- easiest is to compare on the dashboard and in the Report Builder).
--
--  [1] The dashboard and the Report Builder agree for Millwood, July 2026:
--        Dashboard "Gross profit" = Report Builder "Gross Profit (incl.
--        Adjustments)", and the "% of sales" figure = "Gross Profit %
--        (incl. Adjustments)".
--  [2] The body adds Adjustments (true):
--        select pg_get_functiondef('public.dashboard_range_metrics(date,date,uuid)'::regprocedure)
--               like '%+ agg.k_groupon) - (agg.t_labor_cost%';
-- =====================================================================
