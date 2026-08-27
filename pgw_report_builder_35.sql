-- =====================================================================
-- PGW Support Portal — Task 10: REPORT BUILDER
-- Run AFTER pgw_revoke_internal_helpers_34.sql, in the Supabase SQL
-- Editor. Safe to re-run (functions only — no tables, no data).
-- =====================================================================
-- WHAT THIS ADDS
--   report_measure_catalog()  the list of measures a report may ask for,
--                             built partly from service_categories so a
--                             new category appears without a code change.
--   _report_tech_daily()      INTERNAL. Technician operations and pay at
--                             (location, day) grain, with the week-level
--                             parts of pay attributed to days by hours.
--   report_build()            the query behind the builder: a date range,
--                             a set of stores, a set of measures and one
--                             grouping in; a table of rows out.
--
-- THE ONE RULE THIS FILE EXISTS TO ENFORCE
--   Scope comes from can_access_location(). NOTHING here takes a store
--   list from the front end and trusts it. p_locations NARROWS the set
--   the user can already see; it can never widen it. A district user who
--   posts another district's store ids gets those rows back only if
--   can_access_location() says so — which it will not.
--
--   The same applies to measures. The pay breakdown is refused in the
--   QUERY, not hidden in the picker, so crafting the request by hand
--   gets a 42501 and no data.
--
-- WHAT IS AND IS NOT RESTRICTED  (Task 10, Part 2)
--   Restricted to admin/master: guarantee pay, commission, overtime,
--   other pay — the COMPONENTS of a technician's pay.
--
--   NOT restricted: tech_labor_cost. Part 2 lists "store labour cost
--   (aggregate)" as available to everyone and "total pay" as restricted,
--   but at store level those are the SAME NUMBER:
--       labor_cost = greatest(guarantee + overtime, commission) + other
--   summed over every technician. Publishing it twice under two labels
--   is the exact failure migration 33 refused for Sales. It is published
--   once, as Labor Cost, open to everyone — which is what the "gross
--   profit already depends on it" line in Part 2 requires. There is no
--   tech_total_pay measure; asking for the same figure by that name gets
--   an unknown-measure error, not a second answer.
--
--   No grouping in this builder is per-technician. Day, week, month,
--   store, district and region are all store-level or coarser, so an
--   individual's pay cannot be isolated here even by an admin — the Tech
--   Tracker remains the only per-person view.
--
-- TWO GROSS PROFITS ALREADY EXIST IN THIS PORTAL
--   Found while verifying this migration against Millwood's July, where
--   they differ by exactly the month's one Groupon entry (-942.44):
--
--     lib/grossProfit.js        gross sales = Sales + Groupon, the
--       (Summary R35)           Groupon split 50/50 across labour and
--                               parts. THE BONUS TRACKER USES THIS —
--                               useBonusTracker.js line 90 — so it is
--                               the figure managers are paid on.
--
--     dashboard_range_metrics   a column NAMED gross_sales that holds
--       (migration 33)          Sales with Groupon EXCLUDED, returned
--                               separately. Migration 33 chose this
--                               deliberately and flagged the
--                               alternative in its own header.
--
--   This file carries the BONUS figure, because that is the one with
--   money attached to it, and labels it "(incl. Groupon)" so a column
--   here can never be silently compared against the dashboard widget.
--   The groupon-excluded figure is here too, as "Sales (excl. Groupon)",
--   which is the tic sheet's Sales column exactly and equals the
--   dashboard's gross_sales to the cent (verified: 141,749.02).
--
--   FLAGGED for BDC — this is a question about the portal, not about
--   reports: the Dashboard widget and the Bonus Tracker currently answer
--   "gross profit" differently. Whichever is right, they should agree,
--   and migration 33 already named the one line that would change.
--
-- CASH DRAWER TENDERS
--   Part 2 lists "every tender type" among the tic sheet fields. The tic
--   sheet (daily_kpi) has no tender columns — cash, checks, cards,
--   Bread, Synchrony, American First, Koalifi, Snap and fleet charges
--   live on cash_drawer_closeouts (migration 8). They are exposed here
--   in their own group, labelled as cash drawer figures rather than tic
--   sheet ones, so the numbers are available without being mislabelled.
--   FLAGGED for BDC: if "tender" meant something on the tic sheet that
--   was never built, this is where it would go.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. THE MEASURE CATALOGUE
--    One list, read by the builder's picker AND by report_build()'s
--    validation, so the two can never disagree about what exists.
--
--    kind drives formatting on screen and in Excel:
--      money  currency, dash for zero (lib/excelFormats.js CURRENCY_FMT)
--      int    whole units
--      hours  two decimals, no currency
--      rate   dollars per hour
--      ratio  a fraction, rendered as a percentage
--
--    Category measures are DERIVED FROM DATA, not hardcoded: every
--    active row of brand_service_categories contributes a units measure
--    and a "% of cars" measure. Add a category to a brand and it appears
--    in the picker on the next load. Midas shows 30, SpeeDee 31; the
--    union across brands is what a multi-brand report needs.
-- ---------------------------------------------------------------------
create or replace function public.report_measure_catalog()
returns table (
  measure_key   text,
  label         text,
  group_label   text,
  kind          text,
  restricted    boolean,
  sort_order    int
)
language sql stable security definer set search_path = '' as $fn$
  with static_measures(measure_key, label, group_label, kind, restricted, sort_order) as (
    values
      -- Tic sheet — summary ------------------------------------------
      ('ro_count',              'Repair Orders',               'Tic sheet — summary', 'int',   false,  100),
      ('sales',                 'Sales (excl. Groupon)',       'Tic sheet — summary', 'money', false,  110),
      ('declined_sales',        'Declined',                    'Tic sheet — summary', 'money', false,  120),
      ('total_potential',       'Total Potential',             'Tic sheet — summary', 'money', false,  130),
      ('capture_rate',          'Sales Capture Rate',          'Tic sheet — summary', 'ratio', false,  140),
      ('ave_estimate',          'Ave Estimate / Car',          'Tic sheet — summary', 'money', false,  150),
      ('zero_dollar_tickets',   'Zero Dollar Tickets',         'Tic sheet — summary', 'int',   false,  160),
      ('zero_dollar_pct',       'Zero Dollar Tickets % of ROs','Tic sheet — summary', 'ratio', false,  170),
      ('credit_apps',           'Credit Apps',                 'Tic sheet — summary', 'int',   false,  180),
      ('credit_dollars',        'Credit $',                    'Tic sheet — summary', 'money', false,  190),
      ('days_with_data',        'Days Entered',                'Tic sheet — summary', 'int',   false,  200),
      -- Tic sheet — sales breakdown ----------------------------------
      ('tech_labor_sales',      'Labor Sales',                 'Tic sheet — sales breakdown', 'money', false, 300),
      ('sales_parts',           'Parts Sales',                 'Tic sheet — sales breakdown', 'money', false, 310),
      ('sales_tires',           'Tire Sales',                  'Tic sheet — sales breakdown', 'money', false, 320),
      ('sales_supplies',        'Supplies',                    'Tic sheet — sales breakdown', 'money', false, 330),
      ('sales_discounts',       'Discounts',                   'Tic sheet — sales breakdown', 'money', false, 340),
      ('sales_groupon',         'Groupon',                     'Tic sheet — sales breakdown', 'money', false, 350),
      -- Gross profit -------------------------------------------------
      -- The three "(incl. Groupon)" labels are not decoration — see the
      -- TWO GROSS PROFITS note in this file's header.
      ('gross_sales',           'Gross Sales (incl. Groupon)', 'Gross profit', 'money', false, 400),
      ('cost_parts',            'Parts Cost',                  'Gross profit', 'money', false, 410),
      ('cost_tires',            'Tire Cost',                   'Gross profit', 'money', false, 420),
      ('tech_labor_cost',       'Labor Cost',                  'Gross profit', 'money', false, 430),
      ('cost_of_sales',         'Cost of Sales',               'Gross profit', 'money', false, 440),
      ('gross_profit',          'Gross Profit (incl. Groupon)','Gross profit', 'money', false, 450),
      ('gross_profit_pct',      'Gross Profit % (incl. Groupon)','Gross profit','ratio', false, 460),
      -- Technician — operations --------------------------------------
      ('tech_hours_worked',     'Hours Worked',                'Technician — operations', 'hours', false, 500),
      ('tech_flag_hours',       'Flag Hours',                  'Technician — operations', 'hours', false, 510),
      ('tech_proficiency',      'Proficiency',                 'Technician — operations', 'ratio', false, 520),
      ('tech_elr',              'Effective Labor Rate',        'Technician — operations', 'rate',  false, 530),
      ('tech_cost_per_sold_hr', 'Ave Tech Cost / Sold Hour',   'Technician — operations', 'rate',  false, 540),
      -- Technician — pay breakdown (admin/master only) ---------------
      ('tech_guarantee_pay',    'Guarantee Pay',               'Technician — pay breakdown', 'money', true, 600),
      ('tech_commission',       'Commission',                  'Technician — pay breakdown', 'money', true, 610),
      ('tech_overtime',         'Overtime',                    'Technician — pay breakdown', 'money', true, 620),
      ('tech_other_pay',        'Other Pay',                   'Technician — pay breakdown', 'money', true, 630),
      -- Cash drawer — tenders ----------------------------------------
      ('drawer_cash',           'Cash',                        'Cash drawer — tenders', 'money', false, 700),
      ('drawer_checks',         'Customer Checks',             'Cash drawer — tenders', 'money', false, 710),
      ('drawer_cards',          'Visa / Disc / Amex / Debit / MC', 'Cash drawer — tenders', 'money', false, 720),
      ('drawer_bread',          'Midas CC (Bread)',            'Cash drawer — tenders', 'money', false, 730),
      ('drawer_synchrony',      'Sync Car Care',               'Cash drawer — tenders', 'money', false, 740),
      ('drawer_american_first', 'American First',              'Cash drawer — tenders', 'money', false, 750),
      ('drawer_koalifi',        'Koalifi',                     'Cash drawer — tenders', 'money', false, 760),
      ('drawer_snap',           'Snap',                        'Cash drawer — tenders', 'money', false, 770),
      ('drawer_fleet',          'Charges / Fleet Invoices',    'Cash drawer — tenders', 'money', false, 780)
  ),
  -- One entry per category, ordered by where its brands put it. A
  -- category carried by both brands sorts by the lower of the two
  -- display orders, so the shared list keeps a familiar sequence.
  cats as (
    select sc.horizon_key as hkey, sc.display_name as dname, min(bsc.display_order) as ord
      from public.service_categories sc
      join public.brand_service_categories bsc
        on bsc.service_category_id = sc.id and bsc.active
     group by sc.horizon_key, sc.display_name
  )
  select sm.measure_key, sm.label, sm.group_label, sm.kind, sm.restricted, sm.sort_order
    from static_measures sm
  union all
  select 'cat_units_' || cats.hkey, cats.dname,
         'Tic sheet — categories (units)', 'int', false, 1000 + cats.ord
    from cats
  union all
  select 'cat_pct_' || cats.hkey, cats.dname || ' — % of cars',
         'Tic sheet — categories (% of cars)', 'ratio', false, 2000 + cats.ord
    from cats;
$fn$;
grant execute on function public.report_measure_catalog() to authenticated;


-- ---------------------------------------------------------------------
-- 1. TECHNICIAN FIGURES AT (LOCATION, DAY) GRAIN   ***INTERNAL***
--
--    The day-grain twin of _tech_pay_range (migration 33). It exists
--    because the builder can group by day, and the dashboard's helper
--    only ever returned one row per location for a whole range.
--
--    WHAT IS EXACT AND WHAT IS ATTRIBUTED
--      guarantee_pay  EXACT per day  — hours worked x the guarantee rate
--      commission     EXACT per day  — flag hours x the flat rate
--      overtime       ATTRIBUTED     — overtime is a property of a WEEK
--      other_pay      ATTRIBUTED     — stored once per week (migration 24)
--      total_pay      ATTRIBUTED     — greatest(guar+OT, commission)+other
--                                      is decided over the whole week, so
--                                      it cannot be recomputed per day
--
--    Attribution is by the day's share of the week's hours worked. Two
--    consequences worth stating plainly:
--      * summing any attributed column over a WHOLE week is exact, and
--        over the range it equals _tech_pay_range to the cent;
--      * a single day's overtime or total pay is indicative, not a
--        figure anyone was paid for that day. The builder says so on
--        screen whenever a pay measure is grouped by day.
--
--    total_pay is deliberately NOT guarantee + commission + overtime +
--    other. A technician is paid the GREATER of guarantee-plus-overtime
--    or commission, never both, plus other pay. Adding those four report
--    columns together overstates the cost; Labor Cost is the true one.
--
--    REVOKED FROM public, anon AND authenticated. `revoke ... from
--    public` alone is a no-op in Supabase — it strips the PUBLIC
--    pseudo-role while Supabase's own grants to anon/authenticated stand
--    (see migration 34). This function reads tech_pay_rates and
--    tech_weekly, both master-only tables, so it must be unreachable
--    except from the SECURITY DEFINER function below.
-- ---------------------------------------------------------------------
create or replace function public._report_tech_daily(
  d_from date,
  d_to   date,
  p_locs uuid[] default null
)
returns table (
  loc_id        uuid,
  d             date,
  hours_worked  numeric,
  flag_hours    numeric,
  labor_sales   numeric,
  guarantee_pay numeric,
  commission    numeric,
  overtime      numeric,
  other_pay     numeric,
  total_pay     numeric
)
language sql stable security definer set search_path = '' as $fn$
  with scope as (
    select l.id
      from public.locations l
     where public.can_access_location(l.id)
       and (p_locs is null or l.id = any(p_locs))
  ),
  -- Every day of every WHOLE Sunday–Saturday week the range touches, so
  -- the 40-hour threshold is always evaluated against a complete week
  -- even when the range cuts one in half.
  raw as (
    select
      td.location_id                                                 as l_id,
      td.tech_slot_id                                                as slot,
      td.work_date                                                   as wd,
      (td.work_date - (extract(dow from td.work_date)::int))::date    as wk,
      td.hours_worked                                                as hours,
      td.flag_hours                                                  as flag,
      td.labor_sales                                                 as labor,
      td.hours_worked * coalesce(r.guarantee_rate, 0)                as guar_pay,
      td.flag_hours   * coalesce(r.flat_rate, 0)                     as comm,
      coalesce(r.guarantee_rate, 0)                                  as guar_rate,
      (td.work_date >= d_from and td.work_date <= d_to)              as in_range
    from public.tech_daily td
    join scope s on s.id = td.location_id
    -- The rate of the person who WORKED the day (migration 29), never
    -- of whoever holds the slot today. Reassigning a slot must not
    -- re-cost history.
    left join lateral (
      select pr.flat_rate, pr.guarantee_rate
        from public.tech_pay_rates pr
       where pr.employee_id = td.employee_id
         and pr.effective_date <= td.work_date
       order by pr.effective_date desc
       limit 1
    ) r on true
    where td.work_date >= (d_from - (extract(dow from d_from)::int))
      and td.work_date <= (d_to   + (6 - extract(dow from d_to)::int))
  ),
  per_week as (
    select raw.l_id, raw.slot, raw.wk,
           sum(raw.hours)     as ht,
           sum(raw.guar_pay)  as gt,
           sum(raw.comm)      as ct,
           max(raw.guar_rate) as gr
      from raw
     group by raw.l_id, raw.slot, raw.wk
  ),
  paid as (
    select pw.l_id, pw.slot, pw.wk, pw.ht, pw.gt, pw.ct,
           coalesce(tw.other_pay, 0) as op,
           -- Below 40 hours there is no overtime, by definition. Above
           -- it, the half-time premium rides on whichever basis the
           -- technician is actually being paid on that week.
           case when pw.ht < 40    then 0
                when pw.gt > pw.ct then (pw.ht - 40) * pw.gr * 0.5
                else (pw.ht - 40) * (pw.ct / nullif(pw.ht, 0)) * 0.5
           end as ot
      from per_week pw
      left join public.tech_weekly tw
        on tw.tech_slot_id = pw.slot and tw.week_start = pw.wk
  )
  select
    raw.l_id,
    raw.wd,
    raw.hours,
    raw.flag,
    raw.labor,
    raw.guar_pay,
    raw.comm,
    case when p.ht = 0 then 0 else p.ot * (raw.hours / p.ht) end,
    case when p.ht = 0 then 0 else p.op * (raw.hours / p.ht) end,
    case when p.ht = 0 then 0
         else (greatest(p.gt + p.ot, p.ct) + p.op) * (raw.hours / p.ht) end
  from raw
  join paid p
    on p.l_id = raw.l_id and p.slot = raw.slot and p.wk = raw.wk
  where raw.in_range;
$fn$;

revoke all on function public._report_tech_daily(date, date, uuid[])
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. THE GRAIN   ***INTERNAL***
--    Every (location, date) pair that ANY source has something for, so a
--    report never invents a row for a day nobody traded and never drops
--    a day that only one of the three sources knows about. Used twice —
--    once to size the result before running it, once to build it — so it
--    lives in a function rather than being pasted into both.
-- ---------------------------------------------------------------------
create or replace function public._report_grain(
  d_from date,
  d_to   date,
  p_locs uuid[] default null
)
returns table (loc_id uuid, d date)
language sql stable security definer set search_path = '' as $fn$
  with scope as (
    select l.id
      from public.locations l
     where public.can_access_location(l.id)
       and (p_locs is null or l.id = any(p_locs))
  )
  select k.location_id, k.business_date
    from public.daily_kpi k join scope s on s.id = k.location_id
   where k.business_date between d_from and d_to
  union
  select t.location_id, t.work_date
    from public.tech_daily t join scope s on s.id = t.location_id
   where t.work_date between d_from and d_to
  union
  select c.location_id, c.business_date
    from public.cash_drawer_closeouts c join scope s on s.id = c.location_id
   where c.business_date between d_from and d_to;
$fn$;

revoke all on function public._report_grain(date, date, uuid[])
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. THE REPORT
--
--    p_group_by  one of day | week | month | store | district | region.
--                Weeks are SUNDAY–SATURDAY, the same week the Tech
--                Tracker, Payroll and the tic sheet use.
--    p_measures  measure keys from report_measure_catalog().
--    p_locations narrows the accessible set; null means all of it.
--    p_split_by_store  applies only to a period grouping. It emits one
--                row per store per period instead of one row per period,
--                which is what the Excel export needs to fill a tab per
--                store. Ignored for store/district/region groupings,
--                which are already one row per organisational unit.
--    p_max_rows  the guard rail. Two years of 36 stores by day is 26,280
--                rows; the size is measured BEFORE the aggregation runs
--                and refused with a message that says the numbers, so
--                nobody watches a request time out and guesses why.
--
--    RETURNS one row per bucket plus total rows (is_total = true): a
--    grand total always, and — when splitting by store — one per store.
--    Totals are computed by GROUPING SETS over the same facts, so a
--    ratio in the total row is recomputed from the whole set's
--    components rather than being an average of the column above it.
--    Summing a capture rate down a column is meaningless; this is the
--    same rule the tic sheet's Weekly Totals row follows.
--
--    A bucket with no data still appears when the grouping is store,
--    district or region — "this store reported nothing" is an answer a
--    district comparison must be able to give. Period groupings emit
--    only periods that have data, so a month-to-date report does not
--    trail thirty empty future days.
-- ---------------------------------------------------------------------
create or replace function public.report_build(
  p_from           date,
  p_to             date,
  p_group_by       text,
  p_measures       text[],
  p_locations      uuid[] default null,
  p_split_by_store boolean default false,
  p_max_rows       int     default 5000
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
  -- Every local name here is deliberately unlike the OUT parameters
  -- above. In plpgsql an OUT parameter is a variable, so a CTE column
  -- called `measures` or `store_id` is a latent 42702 — the same trap
  -- migrations 32 and 33 both document.
  v_split boolean;
  v_bad   text;
  v_rows  int;
  v_cap   int;
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

  -- THE RESTRICTION, ENFORCED IN THE QUERY.
  -- The picker hides these from a district user, but hiding a checkbox
  -- is decoration. A hand-crafted request stops here, before a single
  -- row is read, and gets no data back at all.
  if coalesce(public.current_user_role(), '') not in ('admin', 'master') then
    select string_agg(c.label, ', ' order by c.sort_order) into v_bad
      from public.report_measure_catalog() c
     where c.restricted and c.measure_key = any(p_measures);
    if v_bad is not null then
      raise exception 'not authorized for measure(s): %', v_bad using errcode = '42501';
    end if;
  end if;

  v_cap := least(greatest(coalesce(p_max_rows, 5000), 1), 20000);
  v_split := coalesce(p_split_by_store, false) and p_group_by in ('day', 'week', 'month');

  -- ---- size the answer before computing it ---------------------------
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
    select l.id as lid, l.store_number as snum, l.name as sname,
           l.district_id as did, dd.name as dname,
           dd.region_id as rid, rr.name as rname
      from public.locations l
      left join public.districts dd on dd.id = l.district_id
      left join public.regions   rr on rr.id = dd.region_id
     where public.can_access_location(l.id)
       and (p_locations is null or l.id = any(p_locations))
  ),
  -- (location, date) -> the bucket it belongs to, and the store the row
  -- is split under when splitting is on.
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
      from public._report_grain(p_from, p_to, p_locations) g
      join scope s on s.lid = g.loc_id
  ),
  -- Every source flattened to one shape so the aggregation is written
  -- once. A source contributes its own columns and zeros for the rest;
  -- f_entered carries the date only when the tic-sheet row has content,
  -- which is what makes "Days Entered" count traded days rather than
  -- rows that exist because someone opened a panel.
  facts (
    bkey, skey,
    f_ro, f_zdt, f_parts, f_tires, f_supplies, f_disc, f_groupon,
    f_declined, f_capps, f_cdollars, f_cparts, f_ctires, f_entered,
    f_hours, f_flag, f_labor, f_guar, f_comm, f_ot, f_other, f_total,
    f_cash, f_checks, f_cards, f_bread, f_sync, f_amfirst, f_koalifi,
    f_snap, f_fleet
  ) as (
    -- Tic sheet
    select bm.bkey, bm.skey,
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
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric
      from public.daily_kpi k
      join bmap bm on bm.lid = k.location_id and bm.dd = k.business_date
    union all
    -- Technician tracker
    select bm.bkey, bm.skey,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, null::date,
      t.hours_worked, t.flag_hours, t.labor_sales,
      t.guarantee_pay, t.commission, t.overtime, t.other_pay, t.total_pay,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric
      from public._report_tech_daily(p_from, p_to, p_locations) t
      join bmap bm on bm.lid = t.loc_id and bm.dd = t.d
    union all
    -- Cash drawer tenders. `fleet` is a jsonb array of line items, so it
    -- is summed here rather than read from a column. A malformed amount
    -- contributes zero instead of failing the whole report — one bad
    -- line item must not take a district's month down with it.
    select bm.bkey, bm.skey,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, null::date,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      c.cash, c.checks, c.cards, c.bread, c.synchrony, c.american_first, c.koalifi, c.snap,
      (select coalesce(sum(case when (e ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
                                then (e ->> 'amount')::numeric else 0 end), 0)
         from jsonb_array_elements(c.fleet) e)
      from public.cash_drawer_closeouts c
      join bmap bm on bm.lid = c.location_id and bm.dd = c.business_date
  ),
  -- Three levels in one pass: the bucket rows, the per-store totals and
  -- the grand total. grouping() says which level a row is.
  agg as (
    select
      facts.bkey                       as bkey,
      facts.skey                       as skey,
      grouping(facts.bkey)             as g_b,
      grouping(facts.skey)             as g_s,
      coalesce(sum(facts.f_ro), 0)        as a_ro,
      coalesce(sum(facts.f_zdt), 0)       as a_zdt,
      coalesce(sum(facts.f_parts), 0)     as a_parts,
      coalesce(sum(facts.f_tires), 0)     as a_tires,
      coalesce(sum(facts.f_supplies), 0)  as a_supplies,
      coalesce(sum(facts.f_disc), 0)      as a_disc,
      coalesce(sum(facts.f_groupon), 0)   as a_groupon,
      coalesce(sum(facts.f_declined), 0)  as a_declined,
      coalesce(sum(facts.f_capps), 0)     as a_capps,
      coalesce(sum(facts.f_cdollars), 0)  as a_cdollars,
      coalesce(sum(facts.f_cparts), 0)    as a_cparts,
      coalesce(sum(facts.f_ctires), 0)    as a_ctires,
      count(distinct facts.f_entered)::numeric as a_days,
      coalesce(sum(facts.f_hours), 0)     as a_hours,
      coalesce(sum(facts.f_flag), 0)      as a_flag,
      coalesce(sum(facts.f_labor), 0)     as a_labor,
      coalesce(sum(facts.f_guar), 0)      as a_guar,
      coalesce(sum(facts.f_comm), 0)      as a_comm,
      coalesce(sum(facts.f_ot), 0)        as a_ot,
      coalesce(sum(facts.f_other), 0)     as a_other,
      coalesce(sum(facts.f_total), 0)     as a_total,
      coalesce(sum(facts.f_cash), 0)      as a_cash,
      coalesce(sum(facts.f_checks), 0)    as a_checks,
      coalesce(sum(facts.f_cards), 0)     as a_cards,
      coalesce(sum(facts.f_bread), 0)     as a_bread,
      coalesce(sum(facts.f_sync), 0)      as a_sync,
      coalesce(sum(facts.f_amfirst), 0)   as a_amfirst,
      coalesce(sum(facts.f_koalifi), 0)   as a_koalifi,
      coalesce(sum(facts.f_snap), 0)      as a_snap,
      coalesce(sum(facts.f_fleet), 0)     as a_fleet
      from facts
     group by grouping sets ((facts.bkey, facts.skey), (facts.skey), ())
  ),
  -- Category units, at the same three levels. Only the categories the
  -- request actually asked for are computed — a report with no category
  -- measures never touches daily_service_units.
  units_long as (
    select bm.bkey as bkey, bm.skey as skey,
           grouping(bm.bkey) as g_b, grouping(bm.skey) as g_s,
           sc.horizon_key as hkey,
           coalesce(sum(dsu.units), 0)::numeric as u
      from public.daily_service_units dsu
      join public.daily_kpi k on k.id = dsu.daily_kpi_id
      join bmap bm on bm.lid = k.location_id and bm.dd = k.business_date
      join public.service_categories sc on sc.id = dsu.service_category_id
     where ('cat_units_' || sc.horizon_key) = any(p_measures)
        or ('cat_pct_'   || sc.horizon_key) = any(p_measures)
     group by grouping sets (
       (bm.bkey, bm.skey, sc.horizon_key),
       (bm.skey, sc.horizon_key),
       (sc.horizon_key)
     )
  ),
  -- "% of cars" divides by the repair orders of the SAME bucket, so the
  -- total row's percentage is the whole set's units over the whole set's
  -- ROs — never the average of the percentages above it.
  units_obj as (
    select ul.bkey as bkey, ul.skey as skey, ul.g_b as g_b, ul.g_s as g_s,
           jsonb_object_agg('cat_units_' || ul.hkey, ul.u) as o_units,
           jsonb_object_agg('cat_pct_'   || ul.hkey,
             case when coalesce(a.a_ro, 0) = 0 then null else ul.u / a.a_ro end) as o_pct
      from units_long ul
      join agg a
        on a.g_b = ul.g_b and a.g_s = ul.g_s
       and a.bkey is not distinct from ul.bkey
       and a.skey is not distinct from ul.skey
     group by ul.bkey, ul.skey, ul.g_b, ul.g_s
  ),
  -- Every measure this file knows how to answer, computed once per row.
  -- Derived figures follow the definitions already in the portal:
  --   sales           labor + parts + tires + supplies + discounts,
  --                   Groupon EXCLUDED (migration 25), discounts signed
  --                   and added algebraically
  --   gross_sales     sales + Groupon — the Summary-sheet figure, which
  --                   splits Groupon 50/50 across labour and parts and
  --                   therefore lands on the same total
  --   cost_of_sales   technician pay + parts cost + tire cost
  --   elr             groupon-blended labour over flag hours (Summary
  --                   R22), matching lib/grossProfit.js
  --
  -- HEADROOM: jsonb_build_object is VARIADIC "any" and Postgres caps a
  -- function call at 100 arguments. Forty-two key/value pairs is 84.
  -- There is room for seven more measures here; the eighth needs the
  -- object splitting in two and merged with `||`, exactly as the
  -- category objects already are. It will not fail quietly — the whole
  -- function refuses to compile — but the error names an argument count,
  -- not a measure, so this note is where to look.
  shaped as (
    select a.bkey as bkey, a.skey as skey, a.g_b as g_b, a.g_s as g_s,
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
        'sales',                 (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc),
        'total_potential',       (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined,
        'capture_rate',
          case when ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined) = 0 then null
               else (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc)
                    / ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined) end,
        'ave_estimate',
          case when a.a_ro = 0 then null
               else ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined) / a.a_ro end,
        'gross_sales',           (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon,
        'cost_of_sales',         a.a_total + a.a_cparts + a.a_ctires,
        'gross_profit',
          ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
          - (a.a_total + a.a_cparts + a.a_ctires),
        'gross_profit_pct',
          case when ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon) = 0 then null
               else (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                     - (a.a_total + a.a_cparts + a.a_ctires))
                    / ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon) end,
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
      || coalesce(uo.o_units, '{}'::jsonb)
      || coalesce(uo.o_pct,   '{}'::jsonb) as full_o
      from agg a
      left join units_obj uo
        on uo.g_b = a.g_b and uo.g_s = a.g_s
       and uo.bkey is not distinct from a.bkey
       and uo.skey is not distinct from a.skey
  ),
  -- Hand back only what was asked for. Everything above is computed
  -- either way; this is what keeps a four-column report four columns.
  picked as (
    select sh.bkey as bkey, sh.skey as skey, sh.g_b as g_b, sh.g_s as g_s,
           (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
              from jsonb_each(sh.full_o) e
             where e.key = any(p_measures)) as obj
      from shaped sh
  ),
  -- The rows the report must show, which is not the same as the rows
  -- that have data (see the header note on empty buckets).
  keys as (
    select distinct bm.bkey as bkey, bm.skey as skey
      from bmap bm
     where p_group_by in ('day', 'week', 'month')
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
    -- the bucket rows
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
    -- one total per store, only when the rows are split by store
    select '~total', 'TOTAL', '~~1', p.skey, sc.sname, true, p.obj
      from picked p
      left join scope sc on sc.lid = p.skey
     where v_split and p.g_b = 1 and p.g_s = 0 and p.skey is not null
    union all
    -- the grand total, always
    select '~total', 'TOTAL', '~~2', null::uuid, null::text, true, p.obj
      from picked p
     where p.g_b = 1 and p.g_s = 1
  )
  select e.o_key::text, e.o_label::text, e.o_sort::text,
         e.o_store::uuid, e.o_store_label::text, e.o_total::boolean, e.o_obj::jsonb
    from emitted e
   order by e.o_total, e.o_store_label nulls first, e.o_sort, e.o_key;
end;
$fn$;
grant execute on function public.report_build(date, date, text, text[], uuid[], boolean, int)
  to authenticated;


-- =====================================================================
-- VERIFY
-- =====================================================================
-- 1. The catalogue loads and the category measures came from data:
--      select group_label, count(*) from public.report_measure_catalog()
--       group by 1 order by 1;
--    Expect two "categories" groups of the same size (32 with both
--    brands seeded), and 'Technician — pay breakdown' with 4 rows.
--
-- 2. A district user is refused the pay breakdown (run as that user):
--      select * from public.report_build(
--        '2026-08-01', '2026-08-31', 'store',
--        array['tech_guarantee_pay'], null, false, 5000);
--    Expect ERROR 42501 'not authorized for measure(s): Guarantee Pay'.
--
-- 3. The internal helpers are unreachable directly (any signed-in user):
--      select * from public._report_tech_daily('2026-08-01','2026-08-31');
--    Expect ERROR 42501 permission denied for function _report_tech_daily.
--
-- 4. The cap fires rather than the query timing out:
--      select * from public.report_build(
--        '2024-01-01', '2026-12-31', 'day',
--        array['sales'], null, true, 10);
--    Expect ERROR 54000 naming the row count and the limit.
--
-- 5. Weeks run Sunday–Saturday:
--      select bucket_key, bucket_label from public.report_build(
--        '2026-08-01', '2026-08-31', 'week', array['ro_count'])
--       where not is_total order by bucket_sort;
--    Every bucket_key is a Sunday; every label ends on the Saturday.
