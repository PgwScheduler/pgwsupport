-- =====================================================================
-- PGW Support Portal — fix: cars vs prior year reads 0 when nothing traded
-- Run AFTER pgw_report_presets_36.sql, in the Supabase SQL Editor.
-- Safe to re-run (one create-or-replace).
-- =====================================================================
-- THE BUG
--   Found the moment real 2025 actuals were loaded and the Market Review
--   was run for a month only one store had traded:
--
--     Charleston   cars/store 0   2025 cars 6,392   vs 2025 = 0
--
--   Ten stores, none of them trading in the reporting month, against a
--   real prior year of 6,392 cars — reported as NO CHANGE.
--
--   `cars_per_store_vs_py` prorates the prior year to the same share of
--   the month the current period covers:
--
--     (ro / stores) - ((py_cars / stores) * (traded_days / avg_days_open))
--
--   When nothing has traded, `traded_days` is 0, so the whole prior-year
--   term is multiplied by zero and the expression collapses to
--   `0 - 0 = 0`. The proration factor did exactly what it was written to
--   do; the mistake was letting a factor of zero stand in for "there is
--   nothing to compare".
--
--   Task 10 says a missing prior year must not render as zero and must
--   not render as a 100% improvement over nothing. This is the third
--   face of the same rule: a missing CURRENT period must not render as
--   no change against a prior year that really exists. Zero is a claim.
--
-- WHY ONLY THIS MEASURE
--   `sales_vs_py` and `sales_vs_py_pct` were already safe, because they
--   subtract from `projected_sales`, which is NULL when a store has no
--   traded days — NULL minus anything is NULL. `cars_per_store_vs_py`
--   builds off `a_ro`, a SUM, which is 0 rather than null. Verified
--   after the fix: report 4's untraded stores were already blank, and
--   report 1's now are too.
--
-- THE FIX
--   One more condition on the guard that already returns NULL. Nothing
--   else in report_build changes; the function is reproduced whole only
--   because Postgres has no way to patch one expression inside it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- The guard, extracted so the change is one readable function rather
-- than a condition buried four hundred lines into a query.
--
-- Every branch that returns NULL is a case where the question has no
-- answer, and they are different questions with the same rendering:
-- no prior year, no stores, no planned days, and — the one this
-- migration adds — no days traded in the current period.
-- ---------------------------------------------------------------------
create or replace function public.report_cars_vs_prior_year(
  p_ro            numeric,
  p_stores        numeric,
  p_py_cars       numeric,
  p_traded_days   numeric,
  p_days_open_sum numeric
)
returns numeric
language sql immutable set search_path = '' as $fn$
  select case
           when p_py_cars is null then null
           when coalesce(p_stores, 0) = 0 then null
           when coalesce(p_days_open_sum, 0) = 0 then null
           -- NOTHING HAS TRADED. This is the fix. Without it the
           -- proration factor is 0, the prior-year term vanishes, and a
           -- market that reported nothing claims parity with a real
           -- prior year.
           when coalesce(p_traded_days, 0) = 0 then null
           else (p_ro / p_stores)
                - ((p_py_cars / p_stores)
                   * (p_traded_days / (p_days_open_sum / p_stores)))
         end;
$fn$;
grant execute on function public.report_cars_vs_prior_year(numeric, numeric, numeric, numeric, numeric)
  to authenticated;


-- ---------------------------------------------------------------------
-- report_build, reproduced in full with the one expression corrected.
--
-- Every other line is byte-identical to migration 36 — it was extracted
-- from that file programmatically and the single CASE substituted, so
-- no line was retyped. Reproducing the whole function is how every
-- other migration here changes one, and it means a reader can see what
-- report_build IS rather than reconstructing it from a patch.
-- ---------------------------------------------------------------------
drop function if exists public.report_build(date, date, text, text[], uuid[], boolean, int);

create or replace function public.report_build(
  p_from           date,
  p_to             date,
  p_group_by       text,
  p_measures       text[],
  p_locations      uuid[] default null,
  p_split_by_store boolean default false,
  p_max_rows       int     default 5000,
  p_sort_measure   text    default null,
  p_sort_dir       text    default 'desc',
  p_alt_from       date    default null,
  p_alt_to         date    default null,
  p_alt_measures   text[]  default null
)
returns table (
  bucket_key   text,
  bucket_label text,
  bucket_sort  text,
  store_id     uuid,
  store_label  text,
  is_total     boolean,
  measures     jsonb
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_split  boolean;
  v_bad    text;
  v_rows   int;
  v_cap    int;
  v_afrom  date;
  v_ato    date;
  v_gfrom  date;
  v_gto    date;
  v_year   int;
  v_month  int;
  v_alt    text[];
  v_dir    text;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid range % .. %', p_from, p_to using errcode = '22007';
  end if;
  if p_group_by is null
     or p_group_by not in ('day', 'week', 'month', 'store', 'district', 'region') then
    raise exception 'unknown grouping %', coalesce(p_group_by, '(null)') using errcode = '22023';
  end if;
  if p_measures is null or cardinality(p_measures) = 0 then
    raise exception 'no measures requested' using errcode = '22023';
  end if;

  select string_agg(m.k, ', ') into v_bad
    from unnest(p_measures) as m(k)
   where m.k not in (select c.measure_key from public.report_measure_catalog() c);
  if v_bad is not null then
    raise exception 'unknown measure(s): %', v_bad using errcode = '22023';
  end if;

  -- THE RESTRICTION, ENFORCED IN THE QUERY (migration 35, unchanged).
  if coalesce(public.current_user_role(), '') not in ('admin', 'master') then
    select string_agg(c.label, ', ' order by c.sort_order) into v_bad
      from public.report_measure_catalog() c
     where c.restricted and c.measure_key = any(p_measures);
    if v_bad is not null then
      raise exception 'not authorized for measure(s): %', v_bad using errcode = '42501';
    end if;
  end if;

  v_dir := lower(coalesce(p_sort_dir, 'desc'));
  if v_dir not in ('asc', 'desc') then
    raise exception 'sort direction must be asc or desc, got %', p_sort_dir using errcode = '22023';
  end if;
  if p_sort_measure is not null and not (p_sort_measure = any(p_measures)) then
    raise exception 'cannot sort by %, it is not one of the selected measures', p_sort_measure
      using errcode = '22023';
  end if;

  v_alt   := coalesce(p_alt_measures, '{}');
  v_afrom := coalesce(p_alt_from, p_from);
  v_ato   := coalesce(p_alt_to,   p_to);
  if v_afrom > v_ato then
    raise exception 'invalid alternate range % .. %', v_afrom, v_ato using errcode = '22007';
  end if;
  v_gfrom := least(p_from, v_afrom);
  v_gto   := greatest(p_to, v_ato);

  v_year  := extract(year  from p_to)::int;
  v_month := extract(month from p_to)::int;

  v_cap   := least(greatest(coalesce(p_max_rows, 5000), 1), 20000);
  v_split := coalesce(p_split_by_store, false) and p_group_by in ('day', 'week', 'month');

  -- ---- size the answer before computing it (main window only) --------
  if p_group_by in ('store', 'district', 'region') then
    select count(*)::int into v_rows from (
      select distinct
        case p_group_by
          when 'store'    then l.id::text
          when 'district' then coalesce(l.district_id::text, '~unassigned')
          else                 coalesce(dd.region_id::text, '~unassigned')
        end as k
        from public.locations l
        left join public.districts dd on dd.id = l.district_id
       where public.can_access_location(l.id)
         and (p_locations is null or l.id = any(p_locations))
    ) q;
  else
    select count(*)::int into v_rows from (
      select distinct
        case p_group_by
          when 'day'  then to_char(g.d, 'YYYY-MM-DD')
          when 'week' then to_char((g.d - (extract(dow from g.d)::int))::date, 'YYYY-MM-DD')
          else             to_char(g.d, 'YYYY-MM')
        end as k,
        case when v_split then g.loc_id else null::uuid end as s
        from public._report_grain(p_from, p_to, p_locations) g
    ) q;
  end if;

  if v_rows > v_cap then
    raise exception
      'That report would return % rows, over the limit of %. Narrow the date range, pick fewer stores, or group by a coarser period.',
      v_rows, v_cap
      using errcode = '54000';
  end if;

  return query
  with scope as (
    select l.id as lid, l.store_number as snum, l.name as sname, l.brand as brnd,
           l.district_id as did, dd.name as dname,
           dd.region_id as rid, rr.name as rname
      from public.locations l
      left join public.districts dd on dd.id = l.district_id
      left join public.regions   rr on rr.id = dd.region_id
     where public.can_access_location(l.id)
       and (p_locations is null or l.id = any(p_locations))
  ),
  -- Every month the range touches, so a month grouping gets its own
  -- budget and prior year rather than the last month's.
  months as (
    select extract(year from d)::int as yy, extract(month from d)::int as mm
      from generate_series(date_trunc('month', p_from::timestamp),
                           date_trunc('month', p_to::timestamp),
                           interval '1 month') d
  ),
  scal as (
    select m.yy, m.mm, s.loc_id, s.days_open, s.gp_budget,
           s.gold_thr, s.silver_thr, s.bronze_thr, s.py_sales, s.py_gross, s.py_cars
      from months m
      cross join lateral public._report_store_scalars(m.yy, m.mm, p_locations) s
  ),
  bmap as (
    select g.loc_id as lid, g.d as dd,
      case p_group_by
        when 'day'      then to_char(g.d, 'YYYY-MM-DD')
        when 'week'     then to_char((g.d - (extract(dow from g.d)::int))::date, 'YYYY-MM-DD')
        when 'month'    then to_char(g.d, 'YYYY-MM')
        when 'store'    then s.lid::text
        when 'district' then coalesce(s.did::text, '~unassigned')
        else                 coalesce(s.rid::text, '~unassigned')
      end as bkey,
      case when v_split then g.loc_id else null::uuid end as skey
      from public._report_grain(v_gfrom, v_gto, p_locations) g
      join scope s on s.lid = g.loc_id
  ),
  facts (
    bkey, skey, f_loc, f_date,
    f_ro, f_zdt, f_parts, f_tires, f_supplies, f_disc, f_groupon,
    f_declined, f_capps, f_cdollars, f_cparts, f_ctires, f_entered, f_traded,
    f_hours, f_flag, f_labor, f_guar, f_comm, f_ot, f_other, f_total,
    f_cash, f_checks, f_cards, f_bread, f_sync, f_amfirst, f_koalifi,
    f_snap, f_fleet, f_tireunits, f_alignunits
  ) as (
    select bm.bkey, bm.skey, k.location_id, k.business_date,
      k.ro_count::numeric, k.zero_dollar_tickets::numeric,
      k.sales_parts, k.sales_tires, k.sales_supplies, k.sales_discounts, k.sales_groupon,
      k.declined_sales, k.credit_apps::numeric, k.credit_dollars,
      k.cost_parts, k.cost_tires,
      case when coalesce(k.ro_count, 0)        <> 0
             or coalesce(k.sales_parts, 0)     <> 0
             or coalesce(k.sales_tires, 0)     <> 0
             or coalesce(k.sales_supplies, 0)  <> 0
             or coalesce(k.sales_discounts, 0) <> 0
             or coalesce(k.sales_groupon, 0)   <> 0
           then k.business_date else null::date end,
      -- "Traded" is the tic sheet's PACE rule and the bonus rule: a day
      -- with repair orders. It drives every projection below.
      case when coalesce(k.ro_count, 0) <> 0 then k.business_date else null::date end,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric,
      coalesce((select sum(u.units) from public.daily_service_units u
                 join public.service_categories c on c.id = u.service_category_id
                where u.daily_kpi_id = k.id and c.horizon_key = 'kpi_su_tires'), 0)::numeric,
      coalesce((select sum(u.units) from public.daily_service_units u
                 join public.service_categories c on c.id = u.service_category_id
                where u.daily_kpi_id = k.id and c.horizon_key = 'kpi_su_wheel_alignments'), 0)::numeric
      from public.daily_kpi k
      join bmap bm on bm.lid = k.location_id and bm.dd = k.business_date
    union all
    select bm.bkey, bm.skey, t.loc_id, t.d,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, null::date, null::date,
      t.hours_worked, t.flag_hours, t.labor_sales,
      t.guarantee_pay, t.commission, t.overtime, t.other_pay, t.total_pay,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric
      from public._report_tech_daily(v_gfrom, v_gto, p_locations) t
      join bmap bm on bm.lid = t.loc_id and bm.dd = t.d
    union all
    select bm.bkey, bm.skey, c.location_id, c.business_date,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, null::date, null::date,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      c.cash, c.checks, c.cards, c.bread, c.synchrony, c.american_first, c.koalifi, c.snap,
      (select coalesce(sum(case when (e ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
                                then (e ->> 'amount')::numeric else 0 end), 0)
         from jsonb_array_elements(c.fleet) e),
      0::numeric, 0::numeric
      from public.cash_drawer_closeouts c
      join bmap bm on bm.lid = c.location_id and bm.dd = c.business_date
  ),
  -- A row lands in the main window, the alt window, or both.
  long as (
    select f.*, w.win
      from facts f
      cross join lateral (
        select 'main'::text as win where f.f_date between p_from and p_to
        union all
        select 'alt'::text  where f.f_date between v_afrom and v_ato
      ) w
  ),
  -- PER STORE first, so a projection is a store's own and a market's is
  -- the sum of its stores'.
  per_store as (
    select long.bkey, long.skey, long.f_loc as loc, long.win,
           sum(long.f_ro)       as ro,
           sum(long.f_parts)    as parts,
           sum(long.f_tires)    as tires,
           sum(long.f_supplies) as supplies,
           sum(long.f_disc)     as disc,
           sum(long.f_groupon)  as groupon,
           sum(long.f_cparts)   as cparts,
           sum(long.f_ctires)   as ctires,
           sum(long.f_labor)    as labor,
           sum(long.f_total)    as total_pay,
           count(distinct long.f_traded)::numeric as traded_days
      from long
     group by long.bkey, long.skey, long.f_loc, long.win
  ),
  -- Each store's own projection, ready to be summed.
  per_store_proj as (
    select ps.bkey, ps.skey, ps.win,
           public.report_pace(
             (ps.labor + ps.parts + ps.tires + ps.supplies + ps.disc + ps.groupon)
             - (ps.total_pay + ps.cparts + ps.ctires),
             ps.traded_days, sc.days_open)                         as p_gp,
           public.report_pace(
             ps.labor + ps.parts + ps.tires + ps.supplies + ps.disc,
             ps.traded_days, sc.days_open)                         as p_sales
      from per_store ps
      left join scal sc
        on sc.loc_id = ps.loc
       and sc.yy = case when p_group_by = 'month' then split_part(ps.bkey, '-', 1)::int else v_year end
       and sc.mm = case when p_group_by = 'month' then split_part(ps.bkey, '-', 2)::int else v_month end
  ),
  proj as (
    select per_store_proj.bkey, per_store_proj.skey, per_store_proj.win,
           grouping(per_store_proj.bkey) as g_b, grouping(per_store_proj.skey) as g_s,
           sum(per_store_proj.p_gp)    as a_proj_gp,
           sum(per_store_proj.p_sales) as a_proj_sales
      from per_store_proj
     group by grouping sets (
       (per_store_proj.bkey, per_store_proj.skey, per_store_proj.win),
       (per_store_proj.skey, per_store_proj.win),
       (per_store_proj.win)
     )
  ),
  agg as (
    select
      long.bkey as bkey, long.skey as skey, long.win as win,
      grouping(long.bkey) as g_b, grouping(long.skey) as g_s,
      coalesce(sum(long.f_ro), 0)        as a_ro,
      coalesce(sum(long.f_zdt), 0)       as a_zdt,
      coalesce(sum(long.f_parts), 0)     as a_parts,
      coalesce(sum(long.f_tires), 0)     as a_tires,
      coalesce(sum(long.f_supplies), 0)  as a_supplies,
      coalesce(sum(long.f_disc), 0)      as a_disc,
      coalesce(sum(long.f_groupon), 0)   as a_groupon,
      coalesce(sum(long.f_declined), 0)  as a_declined,
      coalesce(sum(long.f_capps), 0)     as a_capps,
      coalesce(sum(long.f_cdollars), 0)  as a_cdollars,
      coalesce(sum(long.f_cparts), 0)    as a_cparts,
      coalesce(sum(long.f_ctires), 0)    as a_ctires,
      count(distinct long.f_entered)::numeric as a_days,
      count(distinct long.f_traded)::numeric  as a_traded,
      coalesce(sum(long.f_hours), 0)     as a_hours,
      coalesce(sum(long.f_flag), 0)      as a_flag,
      coalesce(sum(long.f_labor), 0)     as a_labor,
      coalesce(sum(long.f_guar), 0)      as a_guar,
      coalesce(sum(long.f_comm), 0)      as a_comm,
      coalesce(sum(long.f_ot), 0)        as a_ot,
      coalesce(sum(long.f_other), 0)     as a_other,
      coalesce(sum(long.f_total), 0)     as a_total,
      coalesce(sum(long.f_cash), 0)      as a_cash,
      coalesce(sum(long.f_checks), 0)    as a_checks,
      coalesce(sum(long.f_cards), 0)     as a_cards,
      coalesce(sum(long.f_bread), 0)     as a_bread,
      coalesce(sum(long.f_sync), 0)      as a_sync,
      coalesce(sum(long.f_amfirst), 0)   as a_amfirst,
      coalesce(sum(long.f_koalifi), 0)   as a_koalifi,
      coalesce(sum(long.f_snap), 0)      as a_snap,
      coalesce(sum(long.f_fleet), 0)     as a_fleet,
      coalesce(sum(long.f_tireunits), 0) as a_tireunits,
      coalesce(sum(long.f_alignunits), 0) as a_alignunits
      from long
     group by grouping sets ((long.bkey, long.skey, long.win), (long.skey, long.win), (long.win))
  ),
  -- Which stores belong to which bucket. For store/district/region this
  -- is EVERY store in scope, so a store that reported nothing still gets
  -- a row with its budget on it — a district comparison has to be able
  -- to say "this one sent nothing".
  sloc as (
    select distinct bm.bkey as bkey, bm.skey as skey, bm.lid as lid
      from bmap bm
     where p_group_by in ('day', 'week', 'month')
       and bm.dd between p_from and p_to
    union
    select distinct
      case p_group_by
        when 'store'    then s.lid::text
        when 'district' then coalesce(s.did::text, '~unassigned')
        else                 coalesce(s.rid::text, '~unassigned')
      end,
      null::uuid, s.lid
      from scope s
     where p_group_by in ('store', 'district', 'region')
  ),
  sagg as (
    select sloc.bkey as bkey, sloc.skey as skey,
           grouping(sloc.bkey) as g_b, grouping(sloc.skey) as g_s,
           count(*)::numeric              as n_stores,
           sum(sc.days_open)              as s_days_open,
           sum(sc.gp_budget)              as s_budget,
           sum(sc.gold_thr)               as s_gold,
           sum(sc.silver_thr)             as s_silver,
           sum(sc.bronze_thr)             as s_bronze,
           sum(sc.py_sales)               as s_py_sales,
           sum(sc.py_gross)               as s_py_gross,
           sum(sc.py_cars)                as s_py_cars
      from sloc
      left join scal sc
        on sc.loc_id = sloc.lid
       and sc.yy = case when p_group_by = 'month' then split_part(sloc.bkey, '-', 1)::int else v_year end
       and sc.mm = case when p_group_by = 'month' then split_part(sloc.bkey, '-', 2)::int else v_month end
     group by grouping sets ((sloc.bkey, sloc.skey), (sloc.skey), ())
  ),
  units_long as (
    select bm.bkey as bkey, bm.skey as skey,
           grouping(bm.bkey) as g_b, grouping(bm.skey) as g_s,
           sc.horizon_key as hkey,
           coalesce(sum(dsu.units), 0)::numeric as u
      from public.daily_service_units dsu
      join public.daily_kpi k on k.id = dsu.daily_kpi_id
      join bmap bm on bm.lid = k.location_id and bm.dd = k.business_date
      join public.service_categories sc on sc.id = dsu.service_category_id
     where k.business_date between p_from and p_to
       and (('cat_units_' || sc.horizon_key) = any(p_measures)
         or ('cat_pct_'   || sc.horizon_key) = any(p_measures))
     group by grouping sets (
       (bm.bkey, bm.skey, sc.horizon_key),
       (bm.skey, sc.horizon_key),
       (sc.horizon_key)
     )
  ),
  units_obj as (
    select ul.bkey as bkey, ul.skey as skey, ul.g_b as g_b, ul.g_s as g_s,
           jsonb_object_agg('cat_units_' || ul.hkey, ul.u) as o_units,
           jsonb_object_agg('cat_pct_'   || ul.hkey,
             case when coalesce(a.a_ro, 0) = 0 then null else ul.u / a.a_ro end) as o_pct
      from units_long ul
      join agg a
        on a.win = 'main' and a.g_b = ul.g_b and a.g_s = ul.g_s
       and a.bkey is not distinct from ul.bkey
       and a.skey is not distinct from ul.skey
     group by ul.bkey, ul.skey, ul.g_b, ul.g_s
  ),
  -- A BUCKET WITH NO DATA STILL HAS A BUDGET.
  --
  -- Caught in verification: `agg` is built from facts, so a store or
  -- market that entered nothing produced no row at all, and the report
  -- lost not just its (correctly empty) sales but its GP Budget, its
  -- Gold, Silver and Bronze thresholds and its planned days — none of
  -- which depend on anyone entering anything. With one store currently
  -- carrying data, the Month Total GP report would have rendered 35 of
  -- 36 rows completely blank, which is precisely the report somebody
  -- needs when a store has not reported.
  --
  -- The universe of rows is therefore every bucket that has SCALARS, in
  -- both windows, unioned with every bucket that has facts. `aggu`
  -- coalesces the fact sums to zero once, here, so the measure
  -- expressions below stay readable instead of carrying sixty coalesces.
  universe as (
    select sg.bkey as bkey, sg.skey as skey, sg.g_b as g_b, sg.g_s as g_s, w.win as win
      from sagg sg cross join (values ('main'), ('alt')) as w(win)
    union
    select a.bkey, a.skey, a.g_b, a.g_s, a.win from agg a
  ),
  aggu as (
    select u.bkey as bkey, u.skey as skey, u.win as win, u.g_b as g_b, u.g_s as g_s,
      coalesce(a.a_ro, 0) as a_ro,               coalesce(a.a_zdt, 0) as a_zdt,
      coalesce(a.a_parts, 0) as a_parts,         coalesce(a.a_tires, 0) as a_tires,
      coalesce(a.a_supplies, 0) as a_supplies,   coalesce(a.a_disc, 0) as a_disc,
      coalesce(a.a_groupon, 0) as a_groupon,     coalesce(a.a_declined, 0) as a_declined,
      coalesce(a.a_capps, 0) as a_capps,         coalesce(a.a_cdollars, 0) as a_cdollars,
      coalesce(a.a_cparts, 0) as a_cparts,       coalesce(a.a_ctires, 0) as a_ctires,
      coalesce(a.a_days, 0) as a_days,           coalesce(a.a_traded, 0) as a_traded,
      coalesce(a.a_hours, 0) as a_hours,         coalesce(a.a_flag, 0) as a_flag,
      coalesce(a.a_labor, 0) as a_labor,         coalesce(a.a_guar, 0) as a_guar,
      coalesce(a.a_comm, 0) as a_comm,           coalesce(a.a_ot, 0) as a_ot,
      coalesce(a.a_other, 0) as a_other,         coalesce(a.a_total, 0) as a_total,
      coalesce(a.a_cash, 0) as a_cash,           coalesce(a.a_checks, 0) as a_checks,
      coalesce(a.a_cards, 0) as a_cards,         coalesce(a.a_bread, 0) as a_bread,
      coalesce(a.a_sync, 0) as a_sync,           coalesce(a.a_amfirst, 0) as a_amfirst,
      coalesce(a.a_koalifi, 0) as a_koalifi,     coalesce(a.a_snap, 0) as a_snap,
      coalesce(a.a_fleet, 0) as a_fleet,         coalesce(a.a_tireunits, 0) as a_tireunits,
      coalesce(a.a_alignunits, 0) as a_alignunits
      from universe u
      left join agg a
        on a.win = u.win and a.g_b = u.g_b and a.g_s = u.g_s
       and a.bkey is not distinct from u.bkey
       and a.skey is not distinct from u.skey
  ),
  shaped as (
    select a.bkey as bkey, a.skey as skey, a.win as win, a.g_b as g_b, a.g_s as g_s,
      (
        jsonb_build_object(
          'ro_count',              a.a_ro,
          'zero_dollar_tickets',   a.a_zdt,
          'zero_dollar_pct',       case when a.a_ro = 0 then null else a.a_zdt / a.a_ro end,
          'sales_parts',           a.a_parts,
          'sales_tires',           a.a_tires,
          'sales_supplies',        a.a_supplies,
          'sales_discounts',       a.a_disc,
          'sales_groupon',         a.a_groupon,
          'declined_sales',        a.a_declined,
          'credit_apps',           a.a_capps,
          'credit_dollars',        a.a_cdollars,
          'cost_parts',            a.a_cparts,
          'cost_tires',            a.a_ctires,
          'days_with_data',        a.a_days,
          'days_elapsed',          a.a_traded,
          'tech_hours_worked',     a.a_hours,
          'tech_flag_hours',       a.a_flag,
          'tech_labor_sales',      a.a_labor,
          'tech_labor_cost',       a.a_total,
          'tech_guarantee_pay',    a.a_guar,
          'tech_commission',       a.a_comm,
          'tech_overtime',         a.a_ot,
          'tech_other_pay',        a.a_other,
          'tech_proficiency',      case when a.a_hours = 0 then null else a.a_flag / a.a_hours end,
          'tech_elr',              case when a.a_flag  = 0 then null
                                        else (a.a_labor + 0.5 * a.a_groupon) / a.a_flag end,
          'tech_cost_per_sold_hr', case when a.a_flag  = 0 then null else a.a_total / a.a_flag end,
          'drawer_cash',           a.a_cash,
          'drawer_checks',         a.a_checks,
          'drawer_cards',          a.a_cards,
          'drawer_bread',          a.a_bread,
          'drawer_synchrony',      a.a_sync,
          'drawer_american_first', a.a_amfirst,
          'drawer_koalifi',        a.a_koalifi,
          'drawer_snap',           a.a_snap,
          'drawer_fleet',          a.a_fleet
        )
        ||
        jsonb_build_object(
          'sales',           (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc),
          'total_potential', (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined,
          'capture_rate',
            case when ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined) = 0 then null
                 else (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc)
                      / ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined) end,
          -- Est / Car is TOTAL POTENTIAL over repair orders, not sales
          -- over cars. With no declined sales recorded, potential IS
          -- sales and the figure would be sales-per-car wearing the
          -- wrong name — so it is NULL, which is what renders blank for
          -- the SpeeDee stores in the sample. FLAGGED for BDC: if
          -- SpeeDee must stay blank even once it records declines, that
          -- is a brand rule and one more condition here.
          'ave_estimate',
            case when a.a_ro = 0 or a.a_declined = 0 then null
                 else ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined) / a.a_ro end,
          'gross_sales',   (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon,
          'cost_of_sales', a.a_total + a.a_cparts + a.a_ctires,
          'gross_profit',
            ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
            - (a.a_total + a.a_cparts + a.a_ctires),
          'gross_profit_pct',
            case when ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon) = 0 then null
                 else (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                       - (a.a_total + a.a_cparts + a.a_ctires))
                      / ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon) end,
          'tires_per_day', case when a.a_days = 0 then null else a.a_tireunits / a.a_days end
        )
        ||
        jsonb_build_object(
          'store_count',    sg.n_stores,
          'days_open',      sg.s_days_open,
          'days_left',      case when sg.s_days_open is null then null
                                 else greatest(sg.s_days_open - (a.a_traded * coalesce(sg.n_stores, 1)), 0) end,
          'gp_budget',      sg.s_budget,
          'projected_gp',   pr.a_proj_gp,
          'projected_sales',pr.a_proj_sales,
          'pct_of_budget',  case when coalesce(sg.s_budget, 0) = 0 then null
                                 else pr.a_proj_gp / sg.s_budget end,
          'cars_per_store',  case when coalesce(sg.n_stores, 0) = 0 then null else a.a_ro / sg.n_stores end,
          'sales_per_store', case when coalesce(sg.n_stores, 0) = 0 then null
                                  else (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) / sg.n_stores end,
          'gp_per_store',    case when coalesce(sg.n_stores, 0) = 0 then null
                                  else (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                                        - (a.a_total + a.a_cparts + a.a_ctires)) / sg.n_stores end,
          'py_sales',        sg.s_py_sales,
          'py_gross_profit', sg.s_py_gross,
          'py_cars',         sg.s_py_cars,
          -- Month-end projection against the FULL prior month: both are
          -- whole-month figures, so no proration is needed or wanted.
          'sales_vs_py',     case when sg.s_py_sales is null then null else pr.a_proj_sales - sg.s_py_sales end,
          'sales_vs_py_pct', case when coalesce(sg.s_py_sales, 0) = 0 then null
                                  else (pr.a_proj_sales - sg.s_py_sales) / sg.s_py_sales end,
          -- Cars per store is MONTH-TO-DATE, so last year is PRORATED to
          -- the same share of the month. Comparing a part-month against
          -- a whole one would show every store collapsing. FLAGGED for
          -- BDC: if the sample compares against the whole prior month
          -- instead, drop the proration factor here.
          -- FIXED in migration 37. When nothing has traded, a_traded is
          -- 0, the proration factor is 0, and this collapsed to 0 - 0 = 0
          -- — a market that reported nothing claiming parity with a real
          -- prior year. The helper returns NULL for that case instead.
          'cars_per_store_vs_py',
            public.report_cars_vs_prior_year(
              a.a_ro, sg.n_stores, sg.s_py_cars, a.a_traded, sg.s_days_open)
        )
        ||
        jsonb_build_object(
          'gp_budget_remaining', case when sg.s_budget is null then null
            else sg.s_budget - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                                - (a.a_total + a.a_cparts + a.a_ctires)) end,
          'gp_budget_per_day',   case when sg.s_budget is null then null else
            public.report_remaining_per_day(
              sg.s_budget - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                             - (a.a_total + a.a_cparts + a.a_ctires)),
              sg.s_days_open, a.a_traded, sg.n_stores) end,
          'gold_threshold',   sg.s_gold,
          'gold_remaining',   case when sg.s_gold is null then null
            else sg.s_gold - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                              - (a.a_total + a.a_cparts + a.a_ctires)) end,
          'gold_per_day',     case when sg.s_gold is null then null else
            public.report_remaining_per_day(
              sg.s_gold - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                           - (a.a_total + a.a_cparts + a.a_ctires)),
              sg.s_days_open, a.a_traded, sg.n_stores) end,
          'silver_threshold', sg.s_silver,
          'silver_remaining', case when sg.s_silver is null then null
            else sg.s_silver - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                                - (a.a_total + a.a_cparts + a.a_ctires)) end,
          'silver_per_day',   case when sg.s_silver is null then null else
            public.report_remaining_per_day(
              sg.s_silver - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                             - (a.a_total + a.a_cparts + a.a_ctires)),
              sg.s_days_open, a.a_traded, sg.n_stores) end,
          'bronze_threshold', sg.s_bronze,
          'bronze_remaining', case when sg.s_bronze is null then null
            else sg.s_bronze - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                                - (a.a_total + a.a_cparts + a.a_ctires)) end,
          'bronze_per_day',   case when sg.s_bronze is null then null else
            public.report_remaining_per_day(
              sg.s_bronze - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                             - (a.a_total + a.a_cparts + a.a_ctires)),
              sg.s_days_open, a.a_traded, sg.n_stores) end
        )
      )
      || coalesce(uo.o_units, '{}'::jsonb)
      || coalesce(uo.o_pct,   '{}'::jsonb) as full_o
      from aggu a
      left join proj pr
        on pr.win = a.win and pr.g_b = a.g_b and pr.g_s = a.g_s
       and pr.bkey is not distinct from a.bkey
       and pr.skey is not distinct from a.skey
      left join sagg sg
        on sg.g_b = a.g_b and sg.g_s = a.g_s
       and sg.bkey is not distinct from a.bkey
       and sg.skey is not distinct from a.skey
      left join units_obj uo
        on a.win = 'main' and uo.g_b = a.g_b and uo.g_s = a.g_s
       and uo.bkey is not distinct from a.bkey
       and uo.skey is not distinct from a.skey
  ),
  -- Main-window values for every measure except those the caller marked
  -- as alt-window, which come from the alt shape instead.
  picked as (
    select m.bkey as bkey, m.skey as skey, m.g_b as g_b, m.g_s as g_s,
      coalesce((select jsonb_object_agg(e.key, e.value)
                  from jsonb_each(m.full_o) e
                 where e.key = any(p_measures) and not (e.key = any(v_alt))), '{}'::jsonb)
      ||
      coalesce((select jsonb_object_agg(e.key, e.value)
                  from jsonb_each(al.full_o) e
                 where e.key = any(v_alt)), '{}'::jsonb) as obj
      from shaped m
      left join shaped al
        on al.win = 'alt' and al.g_b = m.g_b and al.g_s = m.g_s
       and al.bkey is not distinct from m.bkey
       and al.skey is not distinct from m.skey
     where m.win = 'main'
  ),
  keys as (
    select distinct bm.bkey as bkey, bm.skey as skey
      from bmap bm
     where p_group_by in ('day', 'week', 'month')
       and bm.dd between p_from and p_to
    union
    select distinct
      case p_group_by
        when 'store'    then s.lid::text
        when 'district' then coalesce(s.did::text, '~unassigned')
        else                 coalesce(s.rid::text, '~unassigned')
      end,
      null::uuid
      from scope s
     where p_group_by in ('store', 'district', 'region')
  ),
  bmeta as (
    select s.lid::text as bkey,
           '#' || s.snum || ' · ' || s.sname as blabel,
           s.snum as bsort
      from scope s where p_group_by = 'store'
    union all
    select distinct coalesce(s.did::text, '~unassigned'),
           coalesce(s.dname, 'Unassigned'),
           coalesce(s.dname, 'zzzz')
      from scope s where p_group_by = 'district'
    union all
    select distinct coalesce(s.rid::text, '~unassigned'),
           coalesce(s.rname, 'Unassigned'),
           coalesce(s.rname, 'zzzz')
      from scope s where p_group_by = 'region'
  ),
  labelled as (
    select k.bkey as bkey, k.skey as skey,
      case p_group_by
        when 'day'   then to_char(to_date(k.bkey, 'YYYY-MM-DD'), 'MM/DD/YYYY')
        when 'week'  then to_char(to_date(k.bkey, 'YYYY-MM-DD'), 'MM/DD')
                          || ' – ' || to_char(to_date(k.bkey, 'YYYY-MM-DD') + 6, 'MM/DD/YYYY')
        when 'month' then to_char(to_date(k.bkey, 'YYYY-MM'), 'Mon YYYY')
        else bm.blabel
      end as blabel,
      coalesce(bm.bsort, k.bkey) as bsort
      from keys k
      left join bmeta bm on bm.bkey = k.bkey
  ),
  emitted as (
    select l.bkey as o_key, l.blabel as o_label, l.bsort as o_sort,
           l.skey as o_store, sc.sname as o_store_label,
           false as o_total, coalesce(p.obj, '{}'::jsonb) as o_obj
      from labelled l
      left join picked p
        on p.g_b = 0 and p.g_s = 0
       and p.bkey = l.bkey
       and p.skey is not distinct from l.skey
      left join scope sc on sc.lid = l.skey
    union all
    select '~total', 'TOTAL', '~~1', p.skey, sc.sname, true, p.obj
      from picked p
      left join scope sc on sc.lid = p.skey
     where v_split and p.g_b = 1 and p.g_s = 0 and p.skey is not null
    union all
    select '~total', 'TOTAL', '~~2', null::uuid, null::text, true, p.obj
      from picked p
     where p.g_b = 1 and p.g_s = 1
  )
  select e.o_key::text, e.o_label::text, e.o_sort::text,
         e.o_store::uuid, e.o_store_label::text, e.o_total::boolean, e.o_obj::jsonb
    from emitted e
   order by
     e.o_total,
     e.o_store_label nulls first,
     -- The sort IS the message. A row with no value for the sort measure
     -- goes last in both directions: a blank is not a zero and does not
     -- belong at either end of a ranking.
     case when p_sort_measure is not null and v_dir = 'asc'
          then (e.o_obj ->> p_sort_measure)::numeric end asc nulls last,
     case when p_sort_measure is not null and v_dir = 'desc'
          then (e.o_obj ->> p_sort_measure)::numeric end desc nulls last,
     e.o_sort, e.o_key;
end;
$fn$;
grant execute on function public.report_build(
  date, date, text, text[], uuid[], boolean, int, text, text, date, date, text[]
) to authenticated;


-- =====================================================================
-- VERIFY
-- =====================================================================
-- A market that traded nothing must be BLANK, not zero:
--
--   select bucket_label,
--          measures ->> 'cars_per_store'       as cars_per_store,
--          measures ->> 'py_cars'              as py_cars,
--          measures ->> 'cars_per_store_vs_py' as vs_py
--     from public.report_build('2026-07-01','2026-07-31','district',
--            array['cars_per_store','py_cars','cars_per_store_vs_py'])
--    where not is_total;
--
-- Expect: Columbia East (which traded) carries a number; Charleston,
-- Columbia West, Florida and North carry NULL, not 0.
