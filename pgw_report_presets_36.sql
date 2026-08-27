-- =====================================================================
-- PGW Support Portal — Task 10 (revised): the five leadership reports
-- Run AFTER pgw_report_builder_35.sql, in the Supabase SQL Editor.
-- Safe to re-run (two new tables use `create table if not exists`; the
-- seed rows upsert; everything else is create-or-replace).
-- =====================================================================
-- WHAT MIGRATION 35 LEFT OUT, AND THIS ADDS
--   prior_year_actuals    2025 sales / gross profit / cars per store per
--                         month, plus an import path. EMPTY on arrival —
--                         two of the five reports stay unavailable until
--                         BDC supplies it.
--   report_format_rules   conditional formatting as DATA. Leadership
--                         changes these; nobody should need a deploy.
--   report_pace()         the projection formula, in SQL for the first
--                         time. See THE PACE PROBLEM below.
--   report_build()        gains a SORT, a second date window, and the
--                         ~28 measures the five reports need.
--
-- THE PACE PROBLEM (audited before building, and worth writing down)
--   `MTD / days_elapsed * days_open` existed in THREE JavaScript
--   implementations and NO SQL one:
--     lib/ticSheetMath.js  paceOf()          the tic sheet's PACE row
--     lib/bonusMath.js                       projected month-end GP
--     lib/useMonthlyGoals.js                 a DIFFERENT metric, "daily
--                                            pace needed" = remaining /
--                                            days left. Not this formula.
--   The first two agree exactly. Three of the five reports need pace and
--   all of them aggregate ACROSS STORES in SQL, so neither JS copy was
--   reachable. `report_pace()` below is now the definition reports use.
--
--   NOT DONE HERE, deliberately: refactoring the tic sheet and the bonus
--   tracker onto it. Both are shipped and verified, the formula is
--   identical, and rewriting two working screens inside a reporting task
--   trades real regression risk for tidiness. FLAGGED as a follow-up.
--
--   ONE REAL DIVERGENCE, NOT INVENTED HERE: `days_elapsed` counts days
--   with `ro_count > 0` in ticSheetMath and useBonusTracker, but days
--   with ANY non-zero content in dashboard_range_metrics (migration 33).
--   They disagree for a day where somebody entered sales but no repair
--   orders. This file follows the RO rule, because that is what the
--   bonus figures people are paid on already use. FLAGGED for BDC.
--
-- THE AUDIT, for the record (2026-08-27, live)
--   * Markets are `districts`. FIVE of them, covering ALL 36 stores:
--     Charleston 10, North 8, Columbia East 6, Columbia West 6,
--     Florida 6. There are NO unassigned stores.
--   * The task's sample shows five markets covering 35 stores with
--     SpeeDee Lexington outside them. **#3308 SpeeDee Lexington IS
--     assigned, to Columbia West.** Nothing here changes that, and no
--     store is silently reassigned. The $6,359 gap in the sample needs
--     another explanation; with all 36 assigned, market projections
--     reconcile exactly to the company total. FLAGGED for BDC.
--   * There are FOUR SpeeDee stores (#3009, #3025, #3029 Charleston;
--     #3308 Columbia West), not one.
--   * Prior-year data: NONE. The only 2025 figure in the database is
--     bonus_monthly_targets.last_year_gp — 2025 GROSS PROFIT for the
--     nine Model B stores. Report 1 needs 2025 CARS and report 4 needs
--     2025 SALES, so neither can read it.
--   * bonus_monthly_targets is complete: 432 rows (36 stores x 12
--     months), every one carrying gp_budget, gold and silver. Bronze is
--     null for exactly the nine Model B stores, because Model B is a
--     two-tier plan — those cells are CORRECTLY empty, which is the
--     sample's "lower tiers render empty", not a data gap.
--   * store_annual_goals covers all 36 stores for 2026, so "% of
--     budget" has a denominator everywhere.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PRIOR-YEAR ACTUALS
--    Monthly grain, which is all the samples ever compare against.
--
--    ARRIVES EMPTY AND MUST STAY THAT WAY UNTIL BDC SENDS DATA. Reports
--    1 and 4 render their comparison columns as UNAVAILABLE while it is
--    empty — never as zero, and never as a percentage against nothing,
--    which would read as infinite improvement.
--
--    NOT BACKFILLED from bonus_monthly_targets.last_year_gp, though nine
--    stores' 2025 gross profit sits there. Model B's bonus math reads
--    that column, and copying it here would put one fact in two tables
--    with no owner — the failure this codebase has refused twice
--    (migration 33's two Sales, migration 35's two labels for labour
--    cost). If BDC's file includes those nine stores' GP, it lands here
--    and `last_year_gp` stays the bonus engine's input; if the two ever
--    disagree, that disagreement is a fact worth seeing, not hiding.
-- ---------------------------------------------------------------------
create table if not exists public.prior_year_actuals (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations (id) on delete cascade,
  year         int  not null,
  month        int  not null check (month between 1 and 12),
  sales        numeric(14,2),
  gross_profit numeric(14,2),
  cars         int,
  updated_by   uuid references auth.users (id),
  updated_at   timestamptz not null default now(),
  unique (location_id, year, month)
);

create index if not exists prior_year_actuals_loc_idx
  on public.prior_year_actuals (location_id, year, month);

alter table public.prior_year_actuals enable row level security;

-- Read follows the same rule as every other per-store figure. Write is
-- admin/master: prior-year actuals are a company record, not something a
-- store edits about itself.
drop policy if exists "prior_year_actuals_select" on public.prior_year_actuals;
create policy "prior_year_actuals_select" on public.prior_year_actuals
  for select to authenticated
  using (public.can_access_location(location_id));

drop policy if exists "prior_year_actuals_write" on public.prior_year_actuals;
create policy "prior_year_actuals_write" on public.prior_year_actuals
  for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 1b. THE IMPORT PATH
--     Takes what BDC will actually send: a table keyed by STORE NUMBER,
--     not by uuid. Rows arrive as jsonb so the whole file lands in one
--     call and one transaction.
--
--     It reports what it did rather than failing silently on a typo: an
--     unrecognised store number is returned in `unknown_stores` and that
--     row is skipped, so a file with one bad line still imports the rest
--     and names the line to fix. A null measure leaves the existing
--     value alone rather than erasing it, so a sales-only file can be
--     followed by a cars-only file.
-- ---------------------------------------------------------------------
create or replace function public.prior_year_actuals_import(p_rows jsonb)
returns table (
  imported       int,
  updated_rows   int,
  unknown_stores text[]
)
language plpgsql volatile security definer set search_path = '' as $fn$
declare
  v_unknown text[];
  v_count   int;
begin
  if public.current_user_role() not in ('admin','master') then
    raise exception 'only an admin or master may import prior-year actuals'
      using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'expected a json array of rows' using errcode = '22023';
  end if;

  with incoming as (
    select
      nullif(trim(r ->> 'store_number'), '')            as snum,
      (r ->> 'year')::int                               as yr,
      (r ->> 'month')::int                              as mo,
      nullif(r ->> 'sales', '')::numeric                as sales,
      nullif(r ->> 'gross_profit', '')::numeric         as gp,
      nullif(r ->> 'cars', '')::int                     as cars
    from jsonb_array_elements(p_rows) r
  )
  select coalesce(array_agg(distinct i.snum), '{}')
    into v_unknown
    from incoming i
   where i.snum is not null
     and not exists (select 1 from public.locations l where l.store_number = i.snum);

  with incoming as (
    select
      nullif(trim(r ->> 'store_number'), '')            as snum,
      (r ->> 'year')::int                               as yr,
      (r ->> 'month')::int                              as mo,
      nullif(r ->> 'sales', '')::numeric                as sales,
      nullif(r ->> 'gross_profit', '')::numeric         as gp,
      nullif(r ->> 'cars', '')::int                     as cars
    from jsonb_array_elements(p_rows) r
  ),
  resolved as (
    select l.id as loc, i.yr, i.mo, i.sales, i.gp, i.cars
      from incoming i
      join public.locations l on l.store_number = i.snum
     where i.yr is not null and i.mo between 1 and 12
  ),
  upserted as (
    insert into public.prior_year_actuals
      (location_id, year, month, sales, gross_profit, cars, updated_by, updated_at)
    select resolved.loc, resolved.yr, resolved.mo,
           resolved.sales, resolved.gp, resolved.cars, auth.uid(), now()
      from resolved
    on conflict (location_id, year, month) do update set
      -- A null in the file means "not supplied", never "erase it".
      sales        = coalesce(excluded.sales,        public.prior_year_actuals.sales),
      gross_profit = coalesce(excluded.gross_profit, public.prior_year_actuals.gross_profit),
      cars         = coalesce(excluded.cars,         public.prior_year_actuals.cars),
      updated_by   = auth.uid(),
      updated_at   = now()
    returning 1
  )
  select count(*)::int into v_count from upserted;

  return query select v_count, v_count, coalesce(v_unknown, '{}');
end;
$fn$;
grant execute on function public.prior_year_actuals_import(jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 2. CONDITIONAL FORMATTING AS DATA
--    Leadership will change these. A cut point in a CASE statement is a
--    deploy; a cut point in a row is an update.
--
--    `label` REPLACES the value when the rule matches — that is how
--    'BOOM!' appears in place of a remaining figure once a tier is
--    cleared, and it is why label is on the rule rather than hardcoded
--    into the tier measures.
--
--    `basis` says what threshold_a/threshold_b are measured against:
--      absolute        the value itself
--      pct_of_goal     the value already IS a ratio (0.92 = 92%)
--      vs_prior_year   the value is a change; sign is what matters
--      rank            the row's 1-based position in the sorted table
--
--    `color_token` is a CSS variable name for the screen and is mapped
--    to an ARGB fill for Excel by lib/reportFormat.js — the same
--    indirection migration 30 introduced with export_argb, because
--    screen tokens are illegible as light-workbook fills.
-- ---------------------------------------------------------------------
create table if not exists public.report_format_rules (
  id          uuid primary key default gen_random_uuid(),
  measure_key text not null,
  comparison  text not null check (comparison in ('gt','gte','lt','lte','between')),
  threshold_a numeric,
  threshold_b numeric,
  basis       text not null check (basis in ('absolute','pct_of_goal','vs_prior_year','rank')),
  color_token text not null,
  label       text,
  sort_order  int not null default 0,
  -- Not in the task's sketch, added because the seed needs it: a rule
  -- that applies to EVERY measure (the prior-year colouring) rather than
  -- being repeated once per measure key. '*' is the wildcard.
  updated_at  timestamptz not null default now()
);

create index if not exists report_format_rules_measure_idx
  on public.report_format_rules (measure_key, sort_order);

alter table public.report_format_rules enable row level security;

-- Everyone reads them (the colours have to render for the people the
-- reports are for); admin/master writes.
drop policy if exists "report_format_rules_select" on public.report_format_rules;
create policy "report_format_rules_select" on public.report_format_rules
  for select to authenticated using (true);

drop policy if exists "report_format_rules_write" on public.report_format_rules;
create policy "report_format_rules_write" on public.report_format_rules
  for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 2a. MAKE THE SEED ACTUALLY IDEMPOTENT
--
--     Caught in verification: after three runs of this migration the
--     table held 39 rules, not 13. `on conflict do nothing` needs
--     something to conflict WITH, and there was no unique constraint —
--     so every run inserted another identical copy. The duplicates were
--     harmless to read, because the evaluator takes the first match by
--     sort_order and the copies are identical, but the table would have
--     grown without bound and any later edit would have had to be made
--     three times to take effect.
--
--     NULLS NOT DISTINCT is the point: threshold_b is null on every rule
--     except a `between`, and under the default NULLS DISTINCT two rows
--     with a null threshold_b are never equal, so the constraint would
--     not have caught the duplicates it exists to catch.
--
--     The dedupe keeps the OLDEST row of each identical group, so an id
--     already referenced elsewhere survives.
-- ---------------------------------------------------------------------
delete from public.report_format_rules a
 using public.report_format_rules b
 where a.ctid > b.ctid
   and a.measure_key = b.measure_key
   and a.comparison  = b.comparison
   and a.basis       = b.basis
   and a.threshold_a is not distinct from b.threshold_a
   and a.threshold_b is not distinct from b.threshold_b;

create unique index if not exists report_format_rules_uniq
  on public.report_format_rules (measure_key, comparison, basis, threshold_a, threshold_b)
  nulls not distinct;


-- ---------------------------------------------------------------------
-- 2b. SEED — the rules observed in the samples.
--
--     TWO OF THESE ARE PLACEHOLDERS AND ARE MARKED AS SUCH.
--     The task says to ask BDC rather than infer them from a screenshot,
--     and that ask is outstanding:
--
--       * the percent-of-budget cut points (high green / mid yellow /
--         low red). Seeded at 100 / 90 because those are the obvious
--         round numbers, NOT because anyone confirmed them.
--       * the store-name fill by market. NOT SEEDED AT ALL — five
--         arbitrary colours would look authoritative while being
--         invented. The mapping is one insert per market once BDC says
--         which colour is which.
--
--     Correcting either is an UPDATE, not a deploy. That is the whole
--     point of the table.
-- ---------------------------------------------------------------------
insert into public.report_format_rules
  (measure_key, comparison, threshold_a, threshold_b, basis, color_token, label, sort_order)
values
  -- Prior-year comparisons: up is green, down is red. Applies to any
  -- measure whose name marks it as a change against last year.
  ('sales_vs_py',            'gt',  0, null, 'vs_prior_year', 'pos', null, 10),
  ('sales_vs_py',            'lt',  0, null, 'vs_prior_year', 'neg', null, 11),
  ('sales_vs_py_pct',        'gt',  0, null, 'vs_prior_year', 'pos', null, 12),
  ('sales_vs_py_pct',        'lt',  0, null, 'vs_prior_year', 'neg', null, 13),
  ('cars_per_store_vs_py',   'gt',  0, null, 'vs_prior_year', 'pos', null, 14),
  ('cars_per_store_vs_py',   'lt',  0, null, 'vs_prior_year', 'neg', null, 15),

  -- PLACEHOLDER CUT POINTS — awaiting BDC. 1.00 and 0.90 are round
  -- numbers, not a confirmed policy.
  ('pct_of_budget',          'gte', 1.00, null, 'pct_of_goal', 'pos',  null, 20),
  ('pct_of_budget',          'between', 0.90, 1.00, 'pct_of_goal', 'warn', null, 21),
  ('pct_of_budget',          'lt',  0.90, null, 'pct_of_goal', 'neg',  null, 22),

  -- A tier already cleared: the remaining figure is <= 0, so the cell
  -- reads BOOM! instead of a negative number nobody wants to read.
  ('gold_remaining',         'lte', 0, null, 'absolute', 'pos', 'BOOM!', 30),
  ('silver_remaining',       'lte', 0, null, 'absolute', 'pos', 'BOOM!', 31),
  ('bronze_remaining',       'lte', 0, null, 'absolute', 'pos', 'BOOM!', 32),
  ('gp_budget_remaining',    'lte', 0, null, 'absolute', 'pos', 'BOOM!', 33)
on conflict do nothing;


-- ---------------------------------------------------------------------
-- 3. PACE — one definition, in SQL, for the first time.
--
--    projected = (measure_to_date / days_elapsed) * days_open
--
--    Returns NULL, never zero, when there is nothing to project from. A
--    store with no entered days has no projection; printing 0 would say
--    "on track for nothing", which is a different and false claim.
-- ---------------------------------------------------------------------
create or replace function public.report_pace(
  p_to_date      numeric,
  p_days_elapsed numeric,
  p_days_open    numeric
)
returns numeric
language sql immutable set search_path = '' as $fn$
  select case
           when p_to_date is null then null
           when coalesce(p_days_elapsed, 0) <= 0 then null
           when coalesce(p_days_open, 0) <= 0 then null
           else (p_to_date / p_days_elapsed) * p_days_open
         end;
$fn$;
grant execute on function public.report_pace(numeric, numeric, numeric) to authenticated;


-- ---------------------------------------------------------------------
-- 3b. "PER DAY" — what a store must earn each remaining day to reach a
--     threshold it has not reached yet.
--
--     Returns NULL in the two cases where the question has no answer,
--     and they are different cases with the same rendering:
--       * the threshold is already cleared (remaining <= 0). The task
--         says the per-day cell BLANKS when a tier is cleared, while the
--         remaining cell reads BOOM!. Blank is not zero — "you need $0
--         a day" invites the reading "you need nothing", which is true
--         but says it in the language of a target rather than of an
--         achievement.
--       * there are no days left. Dividing by zero days would print an
--         infinity, and rounding it would print a lie.
--
--     Days left is per STORE, so a market of six stores each with five
--     days remaining has thirty store-days remaining and its market
--     total divides by the same thirty. p_days_open_sum and p_stores
--     arrive summed for exactly that reason.
-- ---------------------------------------------------------------------
create or replace function public.report_remaining_per_day(
  p_remaining     numeric,
  p_days_open_sum numeric,
  p_traded_days   numeric,
  p_stores        numeric
)
returns numeric
language sql immutable set search_path = '' as $fn$
  select case
           when p_remaining is null then null
           when p_remaining <= 0 then null              -- cleared: blank, not zero
           when coalesce(p_stores, 0) <= 0 then null
           when coalesce(p_days_open_sum, 0) <= 0 then null
           when (p_days_open_sum - (coalesce(p_traded_days, 0) * p_stores)) <= 0 then null
           else p_remaining / (p_days_open_sum - (coalesce(p_traded_days, 0) * p_stores))
         end;
$fn$;
grant execute on function public.report_remaining_per_day(numeric, numeric, numeric, numeric)
  to authenticated;


-- ---------------------------------------------------------------------
-- 3c. BUG FIX IN MIGRATION 20'S DAY-COUNT FUNCTIONS
--
--     `derived_days_open` was created with NO search_path of its own and
--     an UNQUALIFIED reference to `holidays`, so it resolves that table
--     using whatever search_path its caller happens to have. Every
--     caller so far has reached it through PostgREST, where `public` is
--     on the path, so it has always worked.
--
--     _report_store_scalars below is `security definer set search_path =
--     ''` — the convention every function in this codebase follows,
--     because an empty search_path is what stops a caller from shadowing
--     a table with one of their own. Calling into derived_days_open from
--     there inherits the empty path and fails outright with
--     `relation "holidays" does not exist`. Found exactly that way.
--
--     Both functions are re-created qualified and pinned. This is a
--     strict improvement for every existing caller — the tic sheet and
--     the goals view resolve the same objects either way — and it stops
--     the next definer function from tripping over the same wire.
--     `annual_days_open` gets the same treatment for the same reason:
--     it calls derived_days_open unqualified.
-- ---------------------------------------------------------------------
create or replace function public.derived_days_open(p_year int, p_month int)
returns int language sql stable set search_path = '' as $fn$
  select count(*)::int
  from generate_series(make_date(p_year, p_month, 1),
                       (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date,
                       '1 day') d
  where extract(dow from d) <> 0
    and not exists (select 1 from public.holidays h where h.holiday_date = d::date);
$fn$;

create or replace function public.annual_days_open(p_year int)
returns int language sql stable set search_path = '' as $fn$
  select sum(public.derived_days_open(p_year, m))::int from generate_series(1, 12) m;
$fn$;

grant execute on function public.derived_days_open(int, int) to authenticated;
grant execute on function public.annual_days_open(int)       to authenticated;


-- ---------------------------------------------------------------------
-- 4. PER-STORE MONTHLY SCALARS   ***INTERNAL***
--    Budget, tier thresholds, planned days and prior-year actuals: all
--    per store per MONTH, none of them per day. They cannot live in the
--    day-grain facts CTE or a store's monthly budget would be counted
--    once for every day it traded.
--
--    TWO HOMES FOR ONE FACT, noted rather than smoothed over:
--    `bonus_monthly_targets.gp_budget` / `.days_open` and
--    `v_store_monthly_gp_target.gp_target` / `.days_open` both exist.
--    Verified live 2026-08-27: they agree for ALL 36 stores in July
--    2026, to the cent and to the day. This reads bonus_monthly_targets
--    first because the Bonus Tracker does, and falls back to the goals
--    view where no bonus row exists. If they ever disagree that is a
--    data problem worth seeing — nothing here averages or hides it.
--
--    Prior year is the SAME MONTH one year earlier. Absent rows stay
--    NULL and every derived comparison stays NULL with them; see the
--    note on report 1 and 4 in the header.
-- ---------------------------------------------------------------------
create or replace function public._report_store_scalars(
  p_year  int,
  p_month int,
  p_locs  uuid[] default null
)
returns table (
  loc_id        uuid,
  days_open     numeric,
  gp_budget     numeric,
  gold_thr      numeric,
  silver_thr    numeric,
  bronze_thr    numeric,
  py_sales      numeric,
  py_gross      numeric,
  py_cars       numeric
)
language sql stable security definer set search_path = '' as $fn$
  select
    l.id,
    coalesce(b.days_open, v.days_open)::numeric,
    coalesce(b.gp_budget, v.gp_target)::numeric,
    b.gold_threshold,
    b.silver_threshold,
    b.bronze_threshold,
    p.sales,
    p.gross_profit,
    p.cars::numeric
  from public.locations l
  left join public.bonus_monthly_targets b
    on b.location_id = l.id and b.plan_year = p_year and b.month = p_month
  left join public.v_store_monthly_gp_target v
    on v.location_id = l.id and v.goal_year = p_year and v.goal_month = p_month
  left join public.prior_year_actuals p
    on p.location_id = l.id and p.year = p_year - 1 and p.month = p_month
 where public.can_access_location(l.id)
   and (p_locs is null or l.id = any(p_locs));
$fn$;

revoke all on function public._report_store_scalars(int, int, uuid[])
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. THE MEASURE CATALOGUE, EXTENDED
--    Replaces migration 35's version. Everything it had is still here
--    and unchanged; 29 measures are added for the five reports.
--
--    TWO DAY COUNTS, BOTH PUBLISHED, DELIBERATELY.
--      Days Entered (any data)  a date whose tic-sheet row has ANY
--                               non-zero content. Migration 33's rule,
--                               and what tires-per-day divides by.
--      Days Traded (ROs)        a date with ro_count > 0. The tic
--                               sheet's PACE row and the bonus figures
--                               use this, so pace here uses it too.
--    They differ for a day where somebody typed sales but no repair
--    orders. Publishing one and quietly using the other is how a report
--    ends up unreconcilable with the screen it came from. FLAGGED.
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
      ('ave_estimate',          'Est / Car',                   'Tic sheet — summary', 'money', false,  150),
      ('zero_dollar_tickets',   'Zero Dollar Tickets',         'Tic sheet — summary', 'int',   false,  160),
      ('zero_dollar_pct',       'Zero Dollar Tickets % of ROs','Tic sheet — summary', 'ratio', false,  170),
      ('credit_apps',           'Credit Apps',                 'Tic sheet — summary', 'int',   false,  180),
      ('credit_dollars',        'Credit $',                    'Tic sheet — summary', 'money', false,  190),
      ('days_with_data',        'Days Entered (any data)',     'Tic sheet — summary', 'int',   false,  200),
      ('days_elapsed',          'Days Traded (ROs)',           'Tic sheet — summary', 'int',   false,  205),
      ('tires_per_day',         'Tires per Day',               'Tic sheet — summary', 'num',   false,  210),
      -- Tic sheet — sales breakdown ----------------------------------
      ('tech_labor_sales',      'Labor Sales',                 'Tic sheet — sales breakdown', 'money', false, 300),
      ('sales_parts',           'Parts Sales',                 'Tic sheet — sales breakdown', 'money', false, 310),
      ('sales_tires',           'Tire Sales',                  'Tic sheet — sales breakdown', 'money', false, 320),
      ('sales_supplies',        'Supplies',                    'Tic sheet — sales breakdown', 'money', false, 330),
      ('sales_discounts',       'Discounts',                   'Tic sheet — sales breakdown', 'money', false, 340),
      ('sales_groupon',         'Groupon',                     'Tic sheet — sales breakdown', 'money', false, 350),
      -- Gross profit -------------------------------------------------
      ('gross_sales',           'Gross Sales (incl. Groupon)', 'Gross profit', 'money', false, 400),
      ('cost_parts',            'Parts Cost',                  'Gross profit', 'money', false, 410),
      ('cost_tires',            'Tire Cost',                   'Gross profit', 'money', false, 420),
      ('tech_labor_cost',       'Labor Cost',                  'Gross profit', 'money', false, 430),
      ('cost_of_sales',         'Cost of Sales',               'Gross profit', 'money', false, 440),
      ('gross_profit',          'Gross Profit (incl. Groupon)','Gross profit', 'money', false, 450),
      ('gross_profit_pct',      'Gross Profit % (incl. Groupon)','Gross profit','ratio',false, 460),
      -- Projection & budget ------------------------------------------
      ('days_open',             'Days Open (planned)',         'Projection & budget', 'num',   false, 470),
      ('days_left',             'Days Left',                   'Projection & budget', 'num',   false, 472),
      ('projected_gp',          'Projected Monthly GP',        'Projection & budget', 'money', false, 474),
      ('projected_sales',       'Sales Projection',            'Projection & budget', 'money', false, 476),
      ('gp_budget',             'GP Budget',                   'Projection & budget', 'money', false, 478),
      ('pct_of_budget',         '% of Budget',                 'Projection & budget', 'ratio', false, 480),
      ('gp_budget_remaining',   'Budget Remaining',            'Projection & budget', 'money', false, 482),
      ('gp_budget_per_day',     'Budget Per Day',              'Projection & budget', 'money', false, 484),
      -- Per store (market roll-ups) ----------------------------------
      ('store_count',           'Stores',                      'Per store', 'int',   false, 486),
      ('cars_per_store',        'Cars per Store',              'Per store', 'num',   false, 488),
      ('sales_per_store',       'Sales per Store',             'Per store', 'money', false, 490),
      ('gp_per_store',          'GP per Store',                'Per store', 'money', false, 492),
      -- Prior year ---------------------------------------------------
      ('py_sales',              'Sales Last Year',             'Prior year', 'money', false, 494),
      ('py_gross_profit',       'GP Last Year',                'Prior year', 'money', false, 495),
      ('py_cars',               'Cars Last Year',              'Prior year', 'int',   false, 496),
      ('sales_vs_py',           'vs Last Year ($)',            'Prior year', 'money', false, 497),
      ('sales_vs_py_pct',       'vs Last Year (%)',            'Prior year', 'ratio', false, 498),
      ('cars_per_store_vs_py',  'Cars per Store vs Last Year', 'Prior year', 'num',   false, 499),
      -- Bonus tiers --------------------------------------------------
      ('gold_threshold',        'Gold',                        'Bonus tiers', 'money', false, 900),
      ('gold_remaining',        'Gold Remaining',              'Bonus tiers', 'money', false, 901),
      ('gold_per_day',          'Gold Per Day',                'Bonus tiers', 'money', false, 902),
      ('silver_threshold',      'Silver',                      'Bonus tiers', 'money', false, 903),
      ('silver_remaining',      'Silver Remaining',            'Bonus tiers', 'money', false, 904),
      ('silver_per_day',        'Silver Per Day',              'Bonus tiers', 'money', false, 905),
      ('bronze_threshold',      'Bronze',                      'Bonus tiers', 'money', false, 906),
      ('bronze_remaining',      'Bronze Remaining',            'Bonus tiers', 'money', false, 907),
      ('bronze_per_day',        'Bronze Per Day',              'Bonus tiers', 'money', false, 908),
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
-- 6. THE REPORT, REBUILT
--
--    Migration 35's report_build is DROPPED first, not overloaded. Every
--    new parameter has a default, so a 7-argument call would be
--    ambiguous between the two signatures and PostgREST would pick one
--    at random. Dropping is the only safe way to widen a function whose
--    extra arguments are optional.
--
--    THREE THINGS ARE NEW.
--
--    SORT (p_sort_measure / p_sort_dir). Not optional, because every
--    leadership report is "sorted by" something and the sort IS the
--    message — "who sold the most tyres yesterday" is a different
--    question from "here are the stores alphabetically". Totals always
--    sort last regardless of direction; a row with no value for the sort
--    measure sorts last too, because a blank is not a zero.
--
--    A SECOND DATE WINDOW (p_alt_from / p_alt_to / p_alt_measures).
--    Two of the five reports put columns from two different windows side
--    by side: the Market Review is month-to-date with one YESTERDAY
--    column, and the tyre report is yesterday with one MONTH-TO-DATE
--    column. Rather than let a measure secretly decide its own window,
--    the CALLER names exactly which measures use the alt window, and the
--    column header carries that window. Nothing is implicit: a measure
--    not in p_alt_measures is always the main range.
--    THE ROWS are the main window's. A bucket that exists only in the
--    alt window does not create a row — otherwise a report "for
--    yesterday" could grow rows for days nobody asked about.
--
--    MONTHLY MEASURES (budget, tier thresholds, prior year, days open)
--    attach per STORE per MONTH, never per day. They are joined at
--    bucket level from _report_store_scalars, so a store's monthly
--    budget is counted once per bucket no matter how many days it
--    traded. Grouped by month they follow each bucket's own month;
--    grouped by anything else they follow the month of p_to.
--    Grouped by DAY or WEEK a monthly figure necessarily repeats on
--    every row — the front end says so rather than pretending.
--
--    PROJECTIONS ARE COMPUTED PER STORE AND THEN SUMMED. This is the
--    subtle one. A market's projected GP is the sum of six stores'
--    projections, NOT the market's month-to-date divided by the market's
--    elapsed days times the sum of six stores' planned days — that last
--    form multiplies days_open by the number of stores and overstates
--    the projection roughly six-fold. Per-store day counts are used
--    internally for this and are never published; the day counts in the
--    catalogue stay calendar-based.
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
          'cars_per_store_vs_py',
            case when sg.s_py_cars is null or coalesce(sg.n_stores, 0) = 0
                      or coalesce(sg.s_days_open, 0) = 0 then null
                 else (a.a_ro / sg.n_stores)
                      - ((sg.s_py_cars / sg.n_stores)
                         * (a.a_traded / (sg.s_days_open / sg.n_stores))) end
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
