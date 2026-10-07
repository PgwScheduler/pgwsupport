-- =====================================================================
-- Migration 78 -- Office role: read-only, every store, no payroll
--
-- Why: the user, 2026-10-07. People in the office need the daily cash
-- drawer closeouts, the tic sheets, the reports and the employee
-- schedule for every store, but none of the sensitive payroll side (pay
-- rates, wages, timesheets, payroll hours, employee records).
--
-- WHAT AN OFFICE LOGIN CAN READ
--   Cash Drawer   cash_drawer_closeouts
--   Tic Sheet     daily_kpi, daily_service_units, the store goal tables,
--                 and tech_store_daily()/tech_store_month() -- the
--                 store's tech labor SALES and its TOTAL labor cost for
--                 the gross profit line, the same totals a store manager
--                 sees on that screen; nobody's individual pay
--   Reports       report_build() (Daily Reports, Who Sold What, Report
--                 Builder; the pay-breakdown measures stay refused, as
--                 for everyone below admin), tech_ranks(), and the
--                 per-store report config they read
--   Schedule      employee_schedules (the shifts), and schedule_people()
--                 for the names on them -- name, birthday month/day and
--                 hire dates only, never the employees table itself
--                 (RLS is per row, not per column: a policy there would
--                 hand over every column of the employee record)
--   Every non-sandbox store, never the Home Office (it has none of the
--   above). It can WRITE nothing: no insert/update/delete policy names
--   the role, and every write RPC checks for a role it does not have.
--
-- WHAT IT CANNOT READ -- everything else, by construction. This is an
-- ALLOW list, not a deny list:
--
--   1. can_access_location() learns an 'office' branch, but that branch
--      is only live while the session setting pgw.office_read = 'on'.
--      Nothing sets it except the five functions in sections 4-6, each
--      of which turns it on as its first statement and restores it as
--      its last (section 4 says why not a SET clause). So every payroll
--      policy and RPC (employees,
--      timesheet_entries, payroll_daily, employee_hours, the pay tables,
--      payroll_week_hours, payroll_to_sales_*, dashboard_range_metrics,
--      the bonus tables ...) calls can_access_location() with the
--      setting off and gets FALSE for an office login. A function added
--      later is closed to office unless someone opts it in here.
--      Clients cannot set it: PostgREST exposes only the public schema,
--      and no public function but those five calls set_config().
--   2. Direct table reads (the screens' .from() calls) go through RLS,
--      where the setting is off -- so each table the four screens read
--      gets its own select-only policy below, through office_can_read().
--
-- Run AFTER 77. Safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE ROLE
-- ---------------------------------------------------------------------
-- No scope column: an office login sees every store, like admin, so
-- location_id / district_id / region_id stay null.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('store','district','regional','office','admin','master'));


-- ---------------------------------------------------------------------
-- 2. THE ACCESS HELPER -- one new branch, gated (see header, point 1)
-- ---------------------------------------------------------------------
-- Recreated as it stands after migration 77 with ONE change: the office
-- branch.
create or replace function public.can_access_location(loc uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (
        p.role in ('admin','master')
        or (p.role = 'store'    and p.location_id = loc)
        or (p.role = 'district' and p.district_id =
              (select l.district_id from public.locations l where l.id = loc))
        or (p.role = 'regional' and p.region_id =
              (select d.region_id
                 from public.districts d
                 join public.locations l on l.district_id = d.id
                where l.id = loc))
        -- Migration 78: office, every store but the Home Office -- and
        -- ONLY inside a function that opted in (section 4).
        or (p.role = 'office'
            and current_setting('pgw.office_read', true) = 'on'
            and not coalesce(
                  (select l.is_home_office from public.locations l where l.id = loc), false))
      )
      -- A sandbox store is fake data. Only admin and master may reach it.
      and (
        p.role in ('admin','master')
        or not coalesce(
             (select l.is_sandbox from public.locations l where l.id = loc), false)
      )
  );
$$;

-- For the RLS policies in section 3: an office login, a real store.
create or replace function public.office_can_read(loc uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_user_role(), '') = 'office'
     and exists (select 1 from public.locations l
                  where l.id = loc and not l.is_sandbox and not l.is_home_office);
$$;
revoke all on function public.office_can_read(uuid) from public, anon;
grant execute on function public.office_can_read(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 3. SELECT-ONLY POLICIES on exactly the tables the three screens read
-- ---------------------------------------------------------------------
-- Permissive policies OR together, so each one only ADDS office to who
-- may read; nothing existing changes. Config tables already readable by
-- everyone (holidays, service_categories, brand_service_categories,
-- districts, regions, markets, report_settings, report_format_rules,
-- service_penetration_goals) need nothing.
do $$
declare
  t text;
begin
  foreach t in array array[
    'cash_drawer_closeouts',
    'daily_kpi',
    'store_category_goals',
    'store_tic_goals',
    'store_annual_goals',      -- behind v_store_monthly_gp_target (security_invoker)
    'store_monthly_goals',
    'store_report_profile',
    'store_report_config',
    'prior_year_actuals',
    'bonus_monthly_targets',   -- the scorecard's bonus tiers (store targets, not pay)
    'employee_schedules'       -- the shifts; names come from schedule_people()
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_office_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.office_can_read(location_id))',
      t || '_office_select', t);
  end loop;
end $$;

drop policy if exists "locations_office_select" on public.locations;
create policy "locations_office_select" on public.locations for select to authenticated
  using (public.office_can_read(id));

drop policy if exists "daily_service_units_office_select" on public.daily_service_units;
create policy "daily_service_units_office_select" on public.daily_service_units for select to authenticated
  using (exists (select 1 from public.daily_kpi k
                  where k.id = daily_service_units.daily_kpi_id
                    and public.office_can_read(k.location_id)));

-- ---------------------------------------------------------------------
-- 4. THE OPT-IN: the only functions in which office passes
--    can_access_location()
-- ---------------------------------------------------------------------
--   report_build      Daily Reports, Who Sold What, Report Builder
--   tech_store_daily  Tic Sheet: labor sales + labor cost per day
--   tech_store_month  Tic Sheet goals strip: the month's gross profit
--   tech_ranks        Tech Ranks (section 5)
--   schedule_people   Employee Schedule names (section 6)
--
-- Each one, and nothing else, turns pgw.office_read on as its first
-- statement and puts it back as its last -- the three lines marked
-- "migration 78". (A function-level SET clause would do the same more
-- neatly, but Supabase refuses ALTER FUNCTION ... SET for a custom
-- setting: "permission denied to set parameter".) If one of these
-- raises, the request's transaction is rolled back and the setting with
-- it.
--
-- report_build, tech_store_daily and tech_store_month below are their
-- current definitions (migrations 68 and 24) copied unchanged apart from
-- those three lines. A LATER MIGRATION THAT RECREATES ANY OF THE FIVE
-- MUST KEEP THEM, or office loses that screen (it fails closed: the
-- screen comes back empty, nothing extra is exposed).

-- 4a. report_build -- from migration 68.
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
  v_office_prev text := current_setting('pgw.office_read', true);  -- migration 78
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
  perform set_config('pgw.office_read', 'on', true);  -- migration 78: office may read, for this call only
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
       where public.can_access_location(l.id) and l.is_sandbox = false and not l.is_home_office
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
     where public.can_access_location(l.id) and l.is_sandbox = false and not l.is_home_office
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
      k.sales_parts, k.sales_tires, k.sales_supplies, k.sales_discounts, k.sales_adjustments,
      k.declined_sales, k.credit_apps::numeric, k.credit_dollars,
      k.cost_parts, k.cost_tires,
      case when coalesce(k.ro_count, 0)        <> 0
             or coalesce(k.sales_parts, 0)     <> 0
             or coalesce(k.sales_tires, 0)     <> 0
             or coalesce(k.sales_supplies, 0)  <> 0
             or coalesce(k.sales_discounts, 0) <> 0
             or coalesce(k.sales_adjustments, 0)   <> 0
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
  perform set_config('pgw.office_read', coalesce(v_office_prev, ''), true);  -- migration 78
end;
$fn$;

-- 4b. tech_store_month -- from migration 24.
create or replace function public.tech_store_month(loc uuid, month_start date)
returns table (
  labor_sales               numeric,
  labor_cost                numeric,
  flag_hours                numeric,
  hours_worked              numeric,
  avg_tech_cost_per_sold_hr numeric,
  shop_proficiency          numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_office_prev text := current_setting('pgw.office_read', true);  -- migration 78
  first_sun date := month_start - (extract(dow from month_start)::int);
begin
  perform set_config('pgw.office_read', 'on', true);  -- migration 78: office may read, for this call only
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc;
  end if;

  return query
  with wk as (
    select slot, week_start,
      sum(hours) ht, sum(flag) ft, sum(labor) lt,
      sum(guar_pay) gt, sum(commission) ct,
      count(*) filter (where hours > 0) dw,
      max(guar_rate) gr
    from public._tech_days(loc, first_sun, first_sun + 35)
    group by slot, week_start
  ),
  wp as (
    select wk.*, coalesce(tw.other_pay, 0) op,
      case when ht < 40 then 0
           when gt > ct then (ht - 40) * gr * 0.5
           else (ht - 40) * (ct / ht) * 0.5 end ot
    from wk
    left join public.tech_weekly tw
      on tw.tech_slot_id = wk.slot and tw.week_start = wk.week_start
  ),
  wt as (
    select *, greatest(gt + ot, ct) + op tp from wp
  )
  select
    coalesce(sum(lt), 0),                                                    -- labor_sales
    coalesce(sum(tp), 0),                                                    -- labor_cost
    coalesce(sum(ft), 0),                                                    -- flag_hours
    coalesce(sum(ht), 0),                                                    -- hours_worked
    case when coalesce(sum(ft), 0) = 0 then 0 else sum(tp) / sum(ft) end,    -- avg_tech_cost_per_sold_hr
    case when coalesce(sum(ht), 0) = 0 then 0 else sum(ft) / sum(ht) end     -- shop_proficiency
  from wt;
  perform set_config('pgw.office_read', coalesce(v_office_prev, ''), true);  -- migration 78
end;
$$;

-- 4c. tech_store_daily -- from migration 24.
create or replace function public.tech_store_daily(loc uuid, month_start date)
returns table (
  work_date        date,
  labor_sales      numeric,
  labor_cost_alloc numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_office_prev text := current_setting('pgw.office_read', true);  -- migration 78
  first_sun date := month_start - (extract(dow from month_start)::int);
begin
  perform set_config('pgw.office_read', 'on', true);  -- migration 78: office may read, for this call only
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc;
  end if;

  return query
  with d as (
    select * from public._tech_days(loc, first_sun, first_sun + 35)
  ),
  wk as (
    select slot, week_start,
      sum(hours) ht, sum(guar_pay) gt, sum(commission) ct,
      count(*) filter (where hours > 0) dw, max(guar_rate) gr
    from d group by slot, week_start
  ),
  wp as (
    select wk.*, coalesce(tw.other_pay, 0) op,
      case when ht < 40 then 0
           when gt > ct then (ht - 40) * gr * 0.5
           else (ht - 40) * (ct / ht) * 0.5 end ot
    from wk
    left join public.tech_weekly tw
      on tw.tech_slot_id = wk.slot and tw.week_start = wk.week_start
  ),
  alloc as (
    select d.work_date, d.labor,
      case when (d.guar_pay + d.commission) <= 0 then 0
        else (case when (wp.gt + wp.ot) > wp.ct
                   then d.guar_pay + (case when wp.dw = 0 then 0 else wp.ot / wp.dw end)
                   else d.commission end)
             + (case when wp.dw = 0 then 0 else wp.op / wp.dw end)
      end as allocation
    from d
    join wp on wp.slot = d.slot and wp.week_start = d.week_start
  )
  -- qualify with the CTE alias: the OUT column is also named work_date, so a
  -- bare reference is ambiguous (PL/pgSQL error 42702).
  select alloc.work_date, coalesce(sum(alloc.labor), 0), coalesce(sum(alloc.allocation), 0)
  from alloc
  group by alloc.work_date
  order by alloc.work_date;
  perform set_config('pgw.office_read', coalesce(v_office_prev, ''), true);  -- migration 78
end;
$$;


-- ---------------------------------------------------------------------
-- 5. tech_ranks() -- recreated from migration 77 with two changes: the
--    role list admits 'office', and the opt-in lines (section 4).
-- ---------------------------------------------------------------------
create or replace function public.tech_ranks(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_office_prev text := current_setting('pgw.office_read', true);  -- migration 78
  v_role text := public.current_user_role();
  v_out  jsonb;
begin
  perform set_config('pgw.office_read', 'on', true);  -- migration 78: office may read, for this call only
  if v_role is null or v_role not in ('district', 'regional', 'office', 'admin', 'master') then
    raise exception 'Tech Ranks is available to district managers, the office and above.'
      using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid range % .. %', p_from, p_to using errcode = '22007';
  end if;

  with recursive stores as (
    select l.id, l.store_number, l.district_id,
           coalesce(srp.report_display_name, regexp_replace(l.name, '^Midas\s+', '')) as short_name
      from public.locations l
      left join public.store_report_profile srp on srp.location_id = l.id
     where l.brand = 'midas'
       and not l.is_sandbox
       and not l.is_home_office
       and l.district_id is not null
  ),
  -- A PERSON, not an employee row (migration 77). A transfer (migration
  -- 76) ends one row and starts a linked one at the new store, so one
  -- technician can be several rows. Each row maps to the first row of
  -- its transfer chain (`person`); a row whose link was cut (the old row
  -- deleted) starts a chain of its own.
  chain as (
    select e.id, e.id as person
      from public.employees e
     where e.transferred_from_id is null
    union all
    select e.id, c.person
      from public.employees e
      join chain c on e.transferred_from_id = c.id
  ),
  -- Their CURRENT row: the one nothing was transferred out of. It gives
  -- the name shown and the position the manager rule (migration 75)
  -- reads -- "position today", as before.
  latest as (
    select c.person, e.id, e.full_name, e.position
      from chain c
      join public.employees e on e.id = c.id
     where not exists (select 1 from public.employees x where x.transferred_from_id = e.id)
  ),
  -- one row per person per store over the range
  per_store as (
    select coalesce(c.person, td.employee_id) as person, td.location_id,
           sum(td.flag_hours)   as turned,
           sum(td.hours_worked) as worked
      from public.tech_daily td
      join stores s on s.id = td.location_id
      left join chain c on c.id = td.employee_id
     where td.work_date between p_from and p_to
       and td.employee_id is not null
     group by 1, td.location_id
  ),
  -- the store each person is ranked under: most hours worked, then most
  -- turned, then store number, so a tie can never split them
  home as (
    select distinct on (ps.person)
           ps.person, ps.location_id
      from per_store ps
      join stores s on s.id = ps.location_id
     order by ps.person, ps.worked desc, ps.turned desc, s.store_number
  ),
  -- Managers are not ranked (migration 75): anyone whose position is
  -- 'manager' today, on their current row.
  techs as (
    select ps.person,
           sum(ps.turned) as turned,
           sum(ps.worked) as worked,
           count(*)       as store_count
      from per_store ps
      left join latest lt on lt.person = ps.person
      left join public.employees e on e.id = ps.person
     where coalesce(lt.position, e.position) is distinct from 'manager'
     group by ps.person
    having sum(ps.turned) > 0 or sum(ps.worked) > 0
  ),
  with_data as (
    select distinct td.location_id
      from public.tech_daily td
      join stores s on s.id = td.location_id
     where td.work_date between p_from and p_to
       and (td.flag_hours <> 0 or td.hours_worked <> 0)
  )
  select jsonb_build_object(
    'from', p_from,
    'to',   p_to,
    'divisions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'district_id', d.id,
               'name',        d.name,
               'stores', (
                 select jsonb_agg(jsonb_build_object(
                          'store_number', s.store_number,
                          'name',         s.short_name,
                          'has_data',     exists (select 1 from with_data w where w.location_id = s.id))
                        order by s.short_name)
                   from stores s where s.district_id = d.id))
             order by d.name)
        from public.districts d
       where exists (select 1 from stores s where s.district_id = d.id)
    ), '[]'::jsonb),
    'techs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'employee_id',  coalesce(lt.id, t.person),
               'name',         coalesce(lt.full_name, e.full_name),
               'district_id',  s.district_id,
               'store_number', s.store_number,
               'store_name',   s.short_name,
               'store_count',  t.store_count,
               'hours_turned', round(t.turned, 2),
               'hours_worked', round(t.worked, 2)))
        from techs t
        join home h            on h.person = t.person
        join stores s          on s.id = h.location_id
        left join latest lt    on lt.person = t.person
        left join public.employees e on e.id = t.person
    ), '[]'::jsonb)
  ) into v_out;

  perform set_config('pgw.office_read', coalesce(v_office_prev, ''), true);  -- migration 78
  return v_out;
end
$fn$;

comment on function public.tech_ranks(date, date) is
  'Tech Ranks report (migrations 74, 75, 77, 78): per-technician hours turned and worked over a range, company-wide, Midas stores only, managers excluded, a transferred technician counted once. District, office and above; names and hours only, no pay.';

revoke all on function public.tech_ranks(date, date) from public, anon;
grant execute on function public.tech_ranks(date, date) to authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
-- 6. schedule_people() -- the names on the Employee Schedule
-- ---------------------------------------------------------------------
-- The schedule reads names (and the birthday / anniversary fields from
-- migration 67) from the employees table, which an office login cannot
-- read -- on purpose: that row also holds the Employee/ADP IDs, position
-- and employment dates. This returns ONLY what the calendar shows: the
-- store's active people, plus anyone holding a shift in the range (a
-- shift whose person has since left still needs a name).
--
-- Office logins use it; other roles keep reading employees directly as
-- before. It answers anyone who may see the store, and opts office in
-- through the same three lines as section 4.
create or replace function public.schedule_people(p_location_id uuid, p_from date, p_to date)
returns table (
  id          uuid,
  full_name   text,
  active      boolean,
  birth_month smallint,
  birth_day   smallint,
  hire_date   date,
  rehire_date date
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_office_prev text := current_setting('pgw.office_read', true);  -- migration 78
begin
  perform set_config('pgw.office_read', 'on', true);  -- migration 78: office may read, for this call only
  if not public.can_access_location(p_location_id) then
    raise exception 'not authorized for location %', p_location_id using errcode = '42501';
  end if;

  return query
  select e.id, e.full_name, e.active, e.birth_month, e.birth_day, e.hire_date, e.rehire_date
    from public.employees e
   where e.location_id = p_location_id
     and (e.active
          or exists (select 1 from public.employee_schedules s
                      where s.employee_id = e.id
                        and s.location_id = p_location_id
                        and s.shift_date between p_from and p_to))
   order by e.full_name;
  perform set_config('pgw.office_read', coalesce(v_office_prev, ''), true);  -- migration 78
end
$fn$;

comment on function public.schedule_people(uuid, date, date) is
  'Employee Schedule names for one store (migration 78): name, active, birthday month/day, hire/rehire date -- nothing else from the employee record. Used by the office role, which cannot read employees.';

revoke all on function public.schedule_people(uuid, date, date) from public, anon;
grant execute on function public.schedule_people(uuid, date, date) to authenticated;

notify pgrst, 'reload schema';
