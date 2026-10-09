-- =====================================================================
-- Migration 85 — Yearly bonus-plan rollover
-- Run AFTER pgw_closeout_submitter_names_84.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Why: the user, 2026-10-09. Bonus plans are data (migration 26), but
-- starting a new year meant a hand-written seed every January. This adds
-- what a "copy 2026 to 2027, then edit" screen needs. User decisions:
--
--   1. RATES BY YEAR. bonus_model_rates, bonus_model_splits and
--      bonus_policy had no year, so changing a rate for 2027 would have
--      re-priced every 2026 payout. They gain plan_year (existing rows
--      = 2026) and it joins each primary key.
--   2. COPY + RECALCULATE. A new year starts as a copy of the last one:
--        days_open      recounted on the new calendar (Mon-Sat, not a
--                       holiday -- matched all 440 rows of 2026)
--        gold/silver/   recomputed from the plan's own RULE (below), so
--        bronze         a store's percentages carry over, Wesmark's 85%
--                       bronze included
--        last_year_gp   Model B: the previous year's ACTUAL monthly GP,
--                       the same figure the Bonus Tracker showed
--                       (tech labor + tic sheet). A month that was not
--                       fully entered is left blank, never zero.
--        everything     copied as a starting draft (GP budget, sales
--        else           goal, car goal, tiers, rates) to be edited.
--   3. DRAFT UNTIL PUBLISHED. A copied year is a draft. Store, district,
--      regional and office logins cannot read a draft year's plans,
--      targets, tiers or rates; admin/master can. Publishing checks
--      that every store-month has what its model needs.
--
-- THE RULE, per store per year, on bonus_plans (backfilled for 2026
-- from the data itself):
--   threshold_basis 'budget'     gold/silver/bronze = gp_budget * pct
--                                (A, C, D: 0.95 / 0.90 / 0.80)
--                   'last_year'  gold/silver = greatest(last_year_gp
--                                * pct, threshold_floor), no bronze
--                                (B: 1.1001 / 0.95, floor 35,000)
-- Thresholds stay stored values (the tracker reads them as before); the
-- rule is what recomputes them in a DRAFT year. Published years are
-- never recomputed -- 2026 stays exactly as seeded from the handouts.
--
-- KNOWN LIMIT: report_build (Reports) reads bonus_monthly_targets
-- inside a definer function, which RLS does not reach. A draft year's
-- GP budgets could show in a report run on that year's dates before it
-- is published. (The Scorecard reads the table directly, so RLS hides
-- drafts there.) Publish before January.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PLAN YEARS: draft / published
-- ---------------------------------------------------------------------
create table if not exists public.bonus_plan_years (
  plan_year     int primary key check (plan_year between 2020 and 2100),
  status        text not null default 'draft' check (status in ('draft','published')),
  copied_from   int,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users (id),
  published_at  timestamptz,
  published_by  uuid references auth.users (id)
);

-- Every year that already has plans is live today: published.
insert into public.bonus_plan_years (plan_year, status, published_at)
select distinct plan_year, 'published', now() from public.bonus_plans
on conflict (plan_year) do nothing;

alter table public.bonus_plan_years enable row level security;
drop policy if exists "bonus_plan_years_select" on public.bonus_plan_years;
create policy "bonus_plan_years_select" on public.bonus_plan_years
  for select to authenticated using (true);
-- Writes only through the functions below (no write policy).

comment on table public.bonus_plan_years is
  'Migration 85: one row per bonus plan year. draft = admin/master only; published = visible to everyone who can see the store.';

-- Published, or the caller is admin/master. A year with no row is not
-- visible to non-admins (every real year has a row after this migration).
create or replace function public.bonus_year_visible(p_year int)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_user_role(), '') in ('admin','master')
      or exists (select 1 from public.bonus_plan_years y
                  where y.plan_year = p_year and y.status = 'published');
$$;
revoke all on function public.bonus_year_visible(int) from public, anon;
grant execute on function public.bonus_year_visible(int) to authenticated;


-- ---------------------------------------------------------------------
-- 2. RATES BY YEAR
-- ---------------------------------------------------------------------
alter table public.bonus_model_rates  add column if not exists plan_year int;
alter table public.bonus_model_splits add column if not exists plan_year int;
alter table public.bonus_policy       add column if not exists plan_year int;
update public.bonus_model_rates  set plan_year = 2026 where plan_year is null;
update public.bonus_model_splits set plan_year = 2026 where plan_year is null;
update public.bonus_policy       set plan_year = 2026 where plan_year is null;
alter table public.bonus_model_rates  alter column plan_year set not null;
alter table public.bonus_model_splits alter column plan_year set not null;
alter table public.bonus_policy       alter column plan_year set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bonus_model_rates_pkey'
                  and pg_get_constraintdef(oid) like '%plan_year%') then
    alter table public.bonus_model_rates drop constraint bonus_model_rates_pkey;
    alter table public.bonus_model_rates add primary key (plan_year, model, tier, role);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bonus_model_splits_pkey'
                  and pg_get_constraintdef(oid) like '%plan_year%') then
    alter table public.bonus_model_splits drop constraint bonus_model_splits_pkey;
    alter table public.bonus_model_splits add primary key (plan_year, model, role);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bonus_policy_pkey'
                  and pg_get_constraintdef(oid) like '%plan_year%') then
    alter table public.bonus_policy drop constraint bonus_policy_pkey;
    alter table public.bonus_policy add primary key (plan_year, key);
  end if;
end $$;

-- The audit trigger (migration 81) was attached with the OLD primary key
-- as its arguments. Re-attach so a logged change names the year too.
do $$
begin
  if to_regprocedure('public._audit_attach(regclass, boolean)') is not null then
    perform public._audit_attach('public.bonus_model_rates',  true);
    perform public._audit_attach('public.bonus_model_splits', true);
    perform public._audit_attach('public.bonus_policy',       true);
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 3. THE THRESHOLD RULE, per plan
-- ---------------------------------------------------------------------
alter table public.bonus_plans
  add column if not exists threshold_basis text,
  add column if not exists gold_pct        numeric(6,4),
  add column if not exists silver_pct      numeric(6,4),
  add column if not exists bronze_pct      numeric(6,4),
  add column if not exists threshold_floor numeric(14,2);

-- Backfill from the data: the most common ratio across the plan's months.
update public.bonus_plans p
   set threshold_basis = case when p.model = 'B' then 'last_year' else 'budget' end
 where p.threshold_basis is null;

update public.bonus_plans p
   set gold_pct   = r.g, silver_pct = r.s, bronze_pct = r.b
  from (
    select t.location_id, t.plan_year,
           mode() within group (order by round(t.gold_threshold   / nullif(t.gp_budget, 0), 4)) g,
           mode() within group (order by round(t.silver_threshold / nullif(t.gp_budget, 0), 4)) s,
           mode() within group (order by round(t.bronze_threshold / nullif(t.gp_budget, 0), 4)) b
      from public.bonus_monthly_targets t
     group by t.location_id, t.plan_year
  ) r
 where r.location_id = p.location_id and r.plan_year = p.plan_year
   and p.threshold_basis = 'budget' and p.gold_pct is null;

-- Model B, from the handout's own wording: "+10.01% LY" and "Minimum to
-- Bonus" (95% of LY), both floored at 35,000 (migration 26).
update public.bonus_plans
   set gold_pct = 1.1001, silver_pct = 0.95, bronze_pct = null, threshold_floor = 35000
 where threshold_basis = 'last_year' and gold_pct is null;

alter table public.bonus_plans
  drop constraint if exists bonus_plans_rule_check;
alter table public.bonus_plans
  add constraint bonus_plans_rule_check check (
    threshold_basis is null
    or (threshold_basis in ('budget','last_year')
        and (gold_pct   is null or gold_pct   between 0 and 2)
        and (silver_pct is null or silver_pct between 0 and 2)
        and (bronze_pct is null or bronze_pct between 0 and 2)
        and (threshold_floor is null or threshold_floor >= 0)));

comment on column public.bonus_plans.threshold_basis is
  'Migration 85: budget = thresholds are gp_budget x pct (A/C/D); last_year = greatest(last_year_gp x pct, threshold_floor) (B). Used to recompute a DRAFT year only.';


-- ---------------------------------------------------------------------
-- 4. DRAFT YEARS ARE HIDDEN -- select policies gain bonus_year_visible()
-- ---------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array array['bonus_plans','bonus_monthly_targets','bonus_incentive_tiers']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($f$create policy %I on public.%I for select to authenticated
                        using (public.can_access_location(location_id)
                               and public.bonus_year_visible(plan_year))$f$, t || '_select', t);
  end loop;
  foreach t in array array['bonus_model_rates','bonus_model_splits','bonus_policy']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($f$create policy %I on public.%I for select to authenticated
                        using (public.bonus_year_visible(plan_year))$f$, t || '_select', t);
  end loop;
end
$do$;

-- Office's own read of targets (migration 78) gets the same rule.
drop policy if exists "bonus_monthly_targets_office_select" on public.bonus_monthly_targets;
create policy "bonus_monthly_targets_office_select" on public.bonus_monthly_targets
  for select to authenticated
  using (public.office_can_read(location_id) and public.bonus_year_visible(plan_year));


-- ---------------------------------------------------------------------
-- 5. HELPERS
-- ---------------------------------------------------------------------
-- Working days in a month: Mon-Sat, not a holiday.
create or replace function public.bonus_days_open(p_year int, p_month int)
returns int
language sql stable set search_path = '' as $$
  select count(*)::int
    from generate_series(make_date(p_year, p_month, 1),
                         (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date,
                         interval '1 day') g(d)
   where extract(dow from d) <> 0
     and not exists (select 1 from public.holidays h where h.holiday_date = d::date);
$$;

-- A year's ACTUAL monthly gross profit per store, as the Bonus Tracker
-- computes it (lib/grossProfit.js): tech labor (tech_store_month) plus
-- the tic sheet. `complete` = every working day of the month entered.
-- Admin/master only (internal to the rollover and the setup screen).
create or replace function public.bonus_actual_gp(p_year int, p_location uuid default null)
returns table (location_id uuid, month int, gross_profit numeric, entered_days int, working_days int, complete boolean)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if coalesce(public.current_user_role(), '') not in ('admin','master') then
    raise exception 'admin or master only' using errcode = '42501';
  end if;
  return query
  with months as (select generate_series(1, 12) m),
  stores as (
    select distinct p.location_id from public.bonus_plans p
     where p.plan_year = p_year and (p_location is null or p.location_id = p_location)
  )
  select s.location_id, mo.m,
         round( coalesce(t.labor_sales, 0)
              + coalesce(k.parts, 0) + coalesce(k.supplies, 0) + coalesce(k.tires, 0)
              + coalesce(k.adjustments, 0) + coalesce(k.discounts, 0)
              - coalesce(t.labor_cost, 0) - coalesce(k.cparts, 0) - coalesce(k.ctires, 0), 2),
         coalesce(k.entered, 0),
         public.bonus_days_open(p_year, mo.m),
         coalesce(k.entered, 0) >= public.bonus_days_open(p_year, mo.m)
           and make_date(p_year, mo.m, 1) + interval '1 month' <= public.pgw_today()
    from stores s
    cross join months mo
    left join lateral (
      select sum(d.sales_parts) parts, sum(d.sales_supplies) supplies, sum(d.sales_tires) tires,
             sum(d.sales_adjustments) adjustments, sum(d.sales_discounts) discounts,
             sum(d.cost_parts) cparts, sum(d.cost_tires) ctires,
             count(*) filter (where public.tic_day_entered(d.ro_count, d.sales_labor, d.sales_parts, d.sales_tires))::int entered
        from public.daily_kpi d
       where d.location_id = s.location_id
         and d.business_date >= make_date(p_year, mo.m, 1)
         and d.business_date <  make_date(p_year, mo.m, 1) + interval '1 month'
    ) k on true
    left join lateral public.tech_store_month(s.location_id, make_date(p_year, mo.m, 1)) t on true
   order by s.location_id, mo.m;
end
$fn$;
revoke all on function public.bonus_actual_gp(int, uuid) from public, anon;
grant execute on function public.bonus_actual_gp(int, uuid) to authenticated;

create or replace function public._bonus_require_master()
returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(public.current_user_role(), '') <> 'master' then
    raise exception 'Only a master can change bonus plan years.' using errcode = '42501';
  end if;
end $$;
revoke all on function public._bonus_require_master() from public, anon, authenticated;

create or replace function public._bonus_require_draft(p_year int)
returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.bonus_plan_years where plan_year = p_year and status = 'draft') then
    raise exception '% is not a draft plan year. Published years are not changed here.', p_year using errcode = '22023';
  end if;
end $$;
revoke all on function public._bonus_require_draft(int) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. RECALCULATE a draft year's thresholds from each plan's rule.
--    p_location null = every store in the year.
-- ---------------------------------------------------------------------
create or replace function public.bonus_recalc_thresholds(p_year int, p_location uuid default null)
returns int
language plpgsql security definer set search_path = '' as $fn$
declare v_n int;
begin
  if coalesce(public.current_user_role(), '') not in ('admin','master') then
    raise exception 'admin or master only' using errcode = '42501';
  end if;
  perform public._bonus_require_draft(p_year);

  update public.bonus_monthly_targets t
     set gold_threshold = case p.threshold_basis
           when 'budget'    then round(t.gp_budget * p.gold_pct, 2)
           when 'last_year' then case when t.last_year_gp is null or p.gold_pct is null then null
                                      else greatest(round(t.last_year_gp * p.gold_pct, 2), coalesce(p.threshold_floor, 0)) end end,
         silver_threshold = case p.threshold_basis
           when 'budget'    then round(t.gp_budget * p.silver_pct, 2)
           when 'last_year' then case when t.last_year_gp is null or p.silver_pct is null then null
                                      else greatest(round(t.last_year_gp * p.silver_pct, 2), coalesce(p.threshold_floor, 0)) end end,
         bronze_threshold = case p.threshold_basis
           when 'budget'    then round(t.gp_budget * p.bronze_pct, 2)
           when 'last_year' then case when t.last_year_gp is null or p.bronze_pct is null then null
                                      else greatest(round(t.last_year_gp * p.bronze_pct, 2), coalesce(p.threshold_floor, 0)) end end
    from public.bonus_plans p
   where p.location_id = t.location_id and p.plan_year = t.plan_year
     and t.plan_year = p_year
     and (p_location is null or t.location_id = p_location);
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;
revoke all on function public.bonus_recalc_thresholds(int, uuid) from public, anon;
grant execute on function public.bonus_recalc_thresholds(int, uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 7. FILL Model B's last_year_gp in a draft year from the previous
--    year's actuals. Only complete months; p_overwrite = false keeps any
--    figure already there (typed by hand or filled earlier).
-- ---------------------------------------------------------------------
create or replace function public.bonus_fill_last_year_gp(p_year int, p_overwrite boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_filled int;
  v_missing jsonb;
begin
  if coalesce(public.current_user_role(), '') not in ('admin','master') then
    raise exception 'admin or master only' using errcode = '42501';
  end if;
  perform public._bonus_require_draft(p_year);

  create temp table if not exists pg_temp._bonus_ly (location_id uuid, month int, gross_profit numeric, entered_days int, working_days int, complete boolean) on commit drop;
  delete from pg_temp._bonus_ly where true;  -- 85a: the API refuses a DELETE with no WHERE (safeupdate)
  insert into pg_temp._bonus_ly select * from public.bonus_actual_gp(p_year - 1);

  update public.bonus_monthly_targets t
     set last_year_gp = a.gross_profit
    from public.bonus_plans p, pg_temp._bonus_ly a
   where p.location_id = t.location_id and p.plan_year = t.plan_year
     and p.threshold_basis = 'last_year'
     and t.plan_year = p_year
     and a.location_id = t.location_id and a.month = t.month and a.complete
     and (p_overwrite or t.last_year_gp is null);
  get diagnostics v_filled = row_count;

  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', t.location_id, 'store_number', l.store_number, 'month', t.month,
           'entered_days', a.entered_days, 'working_days', a.working_days)
         order by l.store_number, t.month), '[]'::jsonb)
    into v_missing
    from public.bonus_monthly_targets t
    join public.bonus_plans p on p.location_id = t.location_id and p.plan_year = t.plan_year
    join public.locations l on l.id = t.location_id
    left join pg_temp._bonus_ly a on a.location_id = t.location_id and a.month = t.month
   where t.plan_year = p_year and p.threshold_basis = 'last_year' and t.last_year_gp is null;

  perform public.bonus_recalc_thresholds(p_year);
  return jsonb_build_object('filled', v_filled, 'still_missing', v_missing);
end
$fn$;
revoke all on function public.bonus_fill_last_year_gp(int, boolean) from public, anon;
grant execute on function public.bonus_fill_last_year_gp(int, boolean) to authenticated;


-- ---------------------------------------------------------------------
-- 8. THE ROLLOVER: copy p_from into a new DRAFT year p_to.
-- ---------------------------------------------------------------------
create or replace function public.bonus_rollover(p_from int, p_to int)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_plans int; v_targets int; v_tiers int; v_rates int;
  v_ly jsonb;
  v_holidays int;
begin
  perform public._bonus_require_master();
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Copy forward only: % to %', p_from, p_to using errcode = '22023';
  end if;
  if not exists (select 1 from public.bonus_plans where plan_year = p_from) then
    raise exception 'There are no % plans to copy.', p_from using errcode = '22023';
  end if;
  if exists (select 1 from public.bonus_plan_years where plan_year = p_to)
     or exists (select 1 from public.bonus_plans where plan_year = p_to) then
    raise exception '% already exists. Discard the draft first to start over.', p_to using errcode = '23505';
  end if;

  insert into public.bonus_plan_years (plan_year, status, copied_from, created_by)
  values (p_to, 'draft', p_from, auth.uid());

  insert into public.bonus_model_rates (plan_year, model, tier, role, pct)
  select p_to, model, tier, role, pct from public.bonus_model_rates where plan_year = p_from;
  get diagnostics v_rates = row_count;
  insert into public.bonus_model_splits (plan_year, model, role, share, sort_order)
  select p_to, model, role, share, sort_order from public.bonus_model_splits where plan_year = p_from;
  insert into public.bonus_policy (plan_year, key, value, note)
  select p_to, key, value, note from public.bonus_policy where plan_year = p_from;

  insert into public.bonus_plans (location_id, model, plan_year, threshold_basis, gold_pct, silver_pct, bronze_pct, threshold_floor)
  select location_id, model, p_to, threshold_basis, gold_pct, silver_pct, bronze_pct, threshold_floor
    from public.bonus_plans where plan_year = p_from;
  get diagnostics v_plans = row_count;

  insert into public.bonus_incentive_tiers (location_id, plan_year, kind, tier_index, threshold, payout, increment_above)
  select location_id, p_to, kind, tier_index, threshold, payout, increment_above
    from public.bonus_incentive_tiers where plan_year = p_from;
  get diagnostics v_tiers = row_count;

  -- All twelve months for every plan. A store that joined partway
  -- through p_from (2320 Semoran and 2322 Oviedo had 4 months of 2026)
  -- gets blank goals for the missing months -- the publish check
  -- lists them. last_year_gp starts blank; the step below fills Model B
  -- from actuals.
  insert into public.bonus_monthly_targets
    (location_id, plan_year, month, days_open, daily_car_goal, sales_goal, gp_budget,
     gold_threshold, silver_threshold, bronze_threshold, last_year_gp)
  select p.location_id, p_to, m.m, public.bonus_days_open(p_to, m.m),
         t.daily_car_goal, t.sales_goal, t.gp_budget, null, null, null, null
    from public.bonus_plans p
    cross join generate_series(1, 12) m(m)
    left join public.bonus_monthly_targets t
      on t.location_id = p.location_id and t.plan_year = p_from and t.month = m.m
   where p.plan_year = p_to;
  get diagnostics v_targets = row_count;

  v_ly := public.bonus_fill_last_year_gp(p_to, false);   -- also recalculates every threshold

  select count(*) into v_holidays from public.holidays
   where holiday_date between make_date(p_to, 1, 1) and make_date(p_to, 12, 31);

  return jsonb_build_object(
    'plan_year', p_to, 'copied_from', p_from,
    'plans', v_plans, 'targets', v_targets, 'tiers', v_tiers, 'rates', v_rates,
    'last_year_gp_filled', v_ly -> 'filled',
    'last_year_gp_missing', v_ly -> 'still_missing',
    'holidays_in_year', v_holidays);
end
$fn$;
revoke all on function public.bonus_rollover(int, int) from public, anon;
grant execute on function public.bonus_rollover(int, int) to authenticated;


-- ---------------------------------------------------------------------
-- 9. CHECK + PUBLISH, and DISCARD a draft
-- ---------------------------------------------------------------------
create or replace function public.bonus_year_problems(p_year int)
returns table (location_id uuid, store_number text, month int, problem text)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if coalesce(public.current_user_role(), '') not in ('admin','master') then
    raise exception 'admin or master only' using errcode = '42501';
  end if;
  return query
  -- plans with fewer than 12 months
  select p.location_id, l.store_number::text, null::int, 'has ' || count(t.month) || ' of 12 months'
    from public.bonus_plans p
    join public.locations l on l.id = p.location_id
    left join public.bonus_monthly_targets t on t.location_id = p.location_id and t.plan_year = p.plan_year
   where p.plan_year = p_year
   group by p.location_id, l.store_number
  having count(t.month) <> 12
  union all
  select t.location_id, l.store_number::text, t.month,
         case
           when t.days_open is null or t.days_open < 1                       then 'days open missing'
           when t.gp_budget is null                                          then 'GP budget missing'
           when t.sales_goal is null                                         then 'sales goal missing'
           when p.model <> 'B' and t.daily_car_goal is null                then 'daily car goal missing'
           when p.threshold_basis = 'last_year' and t.last_year_gp is null   then 'last year GP missing'
           when t.gold_threshold is null or t.silver_threshold is null       then 'gold/silver not calculated'
           when p.threshold_basis = 'budget' and p.bronze_pct is not null
                and t.bronze_threshold is null                              then 'bronze not calculated'
         end
    from public.bonus_monthly_targets t
    join public.bonus_plans p on p.location_id = t.location_id and p.plan_year = t.plan_year
    join public.locations l on l.id = t.location_id
   where t.plan_year = p_year
     and (t.days_open is null or t.days_open < 1
          or t.gp_budget is null or t.sales_goal is null
          or (p.model <> 'B' and t.daily_car_goal is null)
          or (p.threshold_basis = 'last_year' and t.last_year_gp is null)
          or t.gold_threshold is null or t.silver_threshold is null
          or (p.threshold_basis = 'budget' and p.bronze_pct is not null and t.bronze_threshold is null))
  union all
  -- a model in use with no rates for the year
  select null::uuid, null::text, null::int, 'no ' || x.model || ' rates for ' || p_year
    from (select distinct model from public.bonus_plans where plan_year = p_year) x
   where not exists (select 1 from public.bonus_model_rates r where r.plan_year = p_year and r.model = x.model)
  order by 2 nulls first, 3 nulls first;
end
$fn$;
revoke all on function public.bonus_year_problems(int) from public, anon;
grant execute on function public.bonus_year_problems(int) to authenticated;

create or replace function public.bonus_publish_year(p_year int)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare v_problems jsonb;
begin
  perform public._bonus_require_master();
  perform public._bonus_require_draft(p_year);
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_problems
    from public.bonus_year_problems(p_year) x;
  if jsonb_array_length(v_problems) > 0 then
    return jsonb_build_object('published', false, 'problems', v_problems);
  end if;
  update public.bonus_plan_years
     set status = 'published', published_at = now(), published_by = auth.uid()
   where plan_year = p_year;
  return jsonb_build_object('published', true, 'problems', '[]'::jsonb);
end
$fn$;
revoke all on function public.bonus_publish_year(int) from public, anon;
grant execute on function public.bonus_publish_year(int) to authenticated;

create or replace function public.bonus_discard_draft(p_year int)
returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  perform public._bonus_require_master();
  perform public._bonus_require_draft(p_year);
  delete from public.bonus_monthly_inputs  where plan_year = p_year;
  delete from public.bonus_monthly_targets where plan_year = p_year;
  delete from public.bonus_incentive_tiers where plan_year = p_year;
  delete from public.bonus_plans           where plan_year = p_year;
  delete from public.bonus_model_rates     where plan_year = p_year;
  delete from public.bonus_model_splits    where plan_year = p_year;
  delete from public.bonus_policy          where plan_year = p_year;
  delete from public.bonus_plan_years      where plan_year = p_year;
end
$fn$;
revoke all on function public.bonus_discard_draft(int) from public, anon;
grant execute on function public.bonus_discard_draft(int) to authenticated;


-- ---------------------------------------------------------------------
-- 10. A PUBLISHED year's setup is not edited from the portal: per-store
--     writes (plans, targets, tiers) are allowed only in a draft year.
--     Rates already were master-only; they get the same draft rule.
--     (SQL Editor is unaffected. Monthly INPUTS are untouched.)
-- ---------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array array['bonus_plans','bonus_monthly_targets','bonus_incentive_tiers']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($f$create policy %I on public.%I for all to authenticated
                        using (public.current_user_role() in ('admin','master')
                               and exists (select 1 from public.bonus_plan_years y
                                            where y.plan_year = %I.plan_year and y.status = 'draft'))
                        with check (public.current_user_role() in ('admin','master')
                               and exists (select 1 from public.bonus_plan_years y
                                            where y.plan_year = %I.plan_year and y.status = 'draft'))$f$,
                   t || '_write', t, t, t);
  end loop;
  foreach t in array array['bonus_model_rates','bonus_model_splits','bonus_policy']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($f$create policy %I on public.%I for all to authenticated
                        using (public.current_user_role() = 'master'
                               and exists (select 1 from public.bonus_plan_years y
                                            where y.plan_year = %I.plan_year and y.status = 'draft'))
                        with check (public.current_user_role() = 'master'
                               and exists (select 1 from public.bonus_plan_years y
                                            where y.plan_year = %I.plan_year and y.status = 'draft'))$f$,
                   t || '_write', t, t, t);
  end loop;
end
$do$;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------
-- select * from public.bonus_plan_years;                              -- 2026 published
-- select plan_year, count(*) from public.bonus_model_rates group by 1; -- 2026: 11
-- select threshold_basis, gold_pct, silver_pct, bronze_pct, threshold_floor, count(*)
--   from public.bonus_plans where plan_year = 2026 group by 1,2,3,4,5;
--   -> budget .95/.90/.80 (28), budget .95/.90/.85 (1 Wesmark), last_year 1.1001/.95/null/35000 (9)
-- select * from public.bonus_year_problems(2026);  -- as master in the portal only: 2320 + 2322 "has 4 of 12 months" (they joined mid-2026)
