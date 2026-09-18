-- =====================================================================
-- PGW Support Portal — Employee profile + effective-dated pay rates
-- Run AFTER pgw_company_directory_55.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Asked for by the user 2026-09-18: pay rates should live in an employee
-- PROFILE, reached by clicking a name on Payroll (and the Tech Tracker),
-- with hire date, termination date and an Employee / ADP ID. Store
-- managers may open the profile; the pay section is admin/master only,
-- as employee_pay_rates always was.
--
-- THE BUG THIS FIXES. employee_pay_rates held ONE row per employee --
-- one current hourly rate, one flat rate, one salary -- and every payroll
-- reader joined it with no date. So a raise re-priced every week ever
-- worked: the grid, payroll_pct_summary, flat_flags_for_week,
-- payroll_to_sales_wtd and payroll_to_sales_range all silently rewrote
-- history the moment a rate was edited. Technician rates never had this
-- problem (tech_pay_rates is effective-dated since migration 24).
--
-- WHAT CHANGES
--
-- 1. employee_pay_rate_history: one row per (employee, rate type,
--    effective date). The three types have INDEPENDENT histories -- a
--    raise to the hourly rate does not have to restate the salary.
--
--      THE RULE: a week is paid at the rate whose effective_date is the
--      latest one ON OR BEFORE THE WEEK'S START. A change dated mid-week
--      therefore first applies to the NEXT pay week -- overtime is a
--      whole-week figure and cannot be priced at two rates.
--
--    public._pay_rate_at(employee, date) is the one implementation of
--    that rule; every SQL reader goes through it, and lib/payRates.js
--    mirrors it for the admin grid.
--
-- 2. NOTHING CHANGES AT MIGRATION TIME. Every existing employee_pay_rates
--    value is copied in as a 'legacy' row dated 2000-01-01, so every
--    past and present week prices exactly as it did before. (Zero values
--    are not copied: no row reads as 0, which is what the old
--    coalesce(r.x, 0) produced for a missing row.)
--
-- 3. Technician flat rates are still authored ONLY in the Tech Tracker.
--    sync_tech_flat_rate() used to overwrite employee_pay_rates with
--    "the tech rate in force today" -- itself a bug, since it only ran
--    when a tech rate row was written, so a future-dated raise never
--    took effect until somebody edited something else. It now mirrors
--    each tech_pay_rates row into the history AT ITS OWN DATE (source
--    'tech_tracker'). A guard refuses manual flat rates for technicians
--    and any hand edit of a mirrored row.
--
-- 4. employees gains hire_date, termination_date and employee_number
--    (the Employee / ADP ID; deliberately NOT unique -- nothing yet says
--    one person is one row company-wide, and a transfer may be a new
--    row).
--
-- 5. WHO APPEARS IN A PAY WEEK. payroll_pct_summary and
--    flat_flags_for_week used to filter `e.active`, so "Remove" erased a
--    person from PAST weeks too -- their paycheck vanished from a closed
--    week's payroll %. Now a person counts in a week when EITHER:
--      * they have hours or a timesheet row in that week (data is never
--        dropped), OR
--      * they were employed during it: hire_date (if set) on or before
--        the week's end, and termination_date (if set) on or after its
--        start -- or, with no termination date, still active.
--    public._employed_during() is that test; lib/payRates.js mirrors it.
--    The ONE place this can move an existing number: an employee who
--    was Removed (active = false) but has hours in a past week now
--    counts in that week again. That is the correction, not a side
--    effect.
--
-- 6. employee_pay_rates is kept, frozen, and commented as superseded.
--    Nothing writes or reads it after this migration.
--
-- DEPLOY ORDER: run this migration, THEN merge the frontend. The new
-- frontend reads employee_pay_rate_history, which does not exist before
-- this runs.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. EMPLOYEE PROFILE FIELDS
--    employees is location-scoped (can_access_location), so a store
--    manager may set these for their own people -- the same reach they
--    already have over name and position. Pay stays admin/master.
-- ---------------------------------------------------------------------
alter table public.employees
  add column if not exists hire_date        date null,
  add column if not exists termination_date date null,
  add column if not exists employee_number  text null;

alter table public.employees drop constraint if exists employees_dates_order;
alter table public.employees add constraint employees_dates_order
  check (hire_date is null or termination_date is null or termination_date >= hire_date);

alter table public.employees drop constraint if exists employees_number_nonblank;
alter table public.employees add constraint employees_number_nonblank
  check (employee_number is null or btrim(employee_number) <> '');

create index if not exists employees_employee_number_idx
  on public.employees (employee_number) where employee_number is not null;

comment on column public.employees.hire_date is
  'First day employed. A person is not listed on pay weeks that end before it (unless that week holds their hours). Null = unknown.';
comment on column public.employees.termination_date is
  'Last day employed. Set by "End employment" together with active = false. The person stays on every pay week up to and including the one containing this date.';
comment on column public.employees.employee_number is
  'Employee / ADP ID, for matching payroll-system exports. Not unique by design.';

-- Is a person employed at any point in [d_from, d_to]? Mirrors
-- employedDuring() in lib/payRates.js. With no termination date the
-- active flag decides, so a legacy "Remove" (active = false, no date)
-- still hides the person from weeks where they have no data.
create or replace function public._employed_during(
  p_active boolean, p_hire date, p_term date, d_from date, d_to date)
returns boolean language sql immutable set search_path = '' as $$
  select (p_hire is null or p_hire <= d_to)
     and case when p_term is not null then p_term >= d_from else coalesce(p_active, false) end;
$$;


-- ---------------------------------------------------------------------
-- 2. EFFECTIVE-DATED PAY RATES
-- ---------------------------------------------------------------------
create table if not exists public.employee_pay_rate_history (
  employee_id    uuid not null references public.employees (id) on delete cascade,
  rate_type      text not null check (rate_type in ('hourly', 'flat', 'salary')),
  effective_date date not null,
  amount         numeric(12,2) not null check (amount >= 0),
  -- manual       : entered on the employee profile
  -- tech_tracker : mirrored from tech_pay_rates by sync_tech_flat_rate()
  -- legacy       : the single pre-history rate, copied in by this migration
  source         text not null default 'manual' check (source in ('manual', 'tech_tracker', 'legacy')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid null default auth.uid(),
  primary key (employee_id, rate_type, effective_date)
);

comment on table public.employee_pay_rate_history is
  'Effective-dated pay rates. A pay week uses, per rate_type, the row with the latest effective_date on or before the week start (see _pay_rate_at). hourly = $/hr; flat = $/turned hr; salary = $/week for a salaried store manager. admin/master only.';

alter table public.employee_pay_rate_history enable row level security;

-- Same check as employee_pay_rates: admin/master, every operation, no
-- store path. DELETE is allowed so a mistaken or scheduled change can
-- be withdrawn; the guard below protects mirrored and legacy rows.
drop policy if exists "pay_rate_history_admin_all" on public.employee_pay_rate_history;
create policy "pay_rate_history_admin_all" on public.employee_pay_rate_history for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

revoke all on public.employee_pay_rate_history from anon;
revoke truncate on public.employee_pay_rate_history from authenticated;

-- Guard. SECURITY INVOKER on purpose: current_user is 'authenticated' for
-- a PostgREST caller, but the function OWNER when the write comes from
-- inside a SECURITY DEFINER function -- which is exactly
-- the difference between a person editing the table and the sync
-- trigger mirroring the Tech Tracker. The SQL Editor (no JWT) is never
-- blocked.
create or replace function public.pay_rate_history_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_by_person boolean := current_user in ('authenticated', 'anon');
  v_pos text;
begin
  if not v_by_person then
    return coalesce(new, old);
  end if;

  if tg_op in ('UPDATE', 'DELETE') and old.source = 'tech_tracker' then
    raise exception 'This flat rate comes from the Tech Tracker; change it there'
      using errcode = '42501';
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if new.source <> 'manual' then
      raise exception 'Only manual pay rates can be entered here' using errcode = '42501';
    end if;
    if new.rate_type = 'flat' then
      select e.position into v_pos from public.employees e where e.id = new.employee_id;
      if v_pos = 'tech' then
        raise exception 'A technician''s flat rate is set in the Tech Tracker' using errcode = '42501';
      end if;
    end if;
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists pay_rate_history_guard on public.employee_pay_rate_history;
create trigger pay_rate_history_guard
  before insert or update or delete on public.employee_pay_rate_history
  for each row execute function public.pay_rate_history_guard();

revoke all on function public.pay_rate_history_guard() from public, anon, authenticated;

-- The one implementation of "which rate pays this week". Always returns
-- exactly one row; a type with no history reads 0, as the old
-- coalesce(r.x, 0) over a missing employee_pay_rates row did.
-- Internal: every caller is SECURITY DEFINER, so the revoke below does
-- not reach them (migration 34's lesson -- checked: payroll_pct_summary,
-- flat_flags_for_week, payroll_to_sales_wtd and payroll_to_sales_range
-- are all definer).
create or replace function public._pay_rate_at(emp uuid, d date)
returns table (hourly_rate numeric, flat_rate_per_hour numeric, manager_salary numeric)
language sql stable set search_path = '' as $$
  select
    coalesce((select h.amount from public.employee_pay_rate_history h
               where h.employee_id = emp and h.rate_type = 'hourly' and h.effective_date <= d
               order by h.effective_date desc limit 1), 0)::numeric,
    coalesce((select h.amount from public.employee_pay_rate_history h
               where h.employee_id = emp and h.rate_type = 'flat' and h.effective_date <= d
               order by h.effective_date desc limit 1), 0)::numeric,
    coalesce((select h.amount from public.employee_pay_rate_history h
               where h.employee_id = emp and h.rate_type = 'salary' and h.effective_date <= d
               order by h.effective_date desc limit 1), 0)::numeric;
$$;

revoke all on function public._pay_rate_at(uuid, date) from public, anon, authenticated;

-- Backfill 1: the single legacy rate, dated before any week that exists.
insert into public.employee_pay_rate_history (employee_id, rate_type, effective_date, amount, source)
select r.employee_id, t.rate_type, date '2000-01-01', t.amount, 'legacy'
  from public.employee_pay_rates r
  cross join lateral (values ('hourly', r.hourly_rate),
                             ('flat',   r.flat_rate_per_hour),
                             ('salary', r.manager_salary)) t(rate_type, amount)
 where t.amount <> 0
on conflict (employee_id, rate_type, effective_date) do nothing;

-- Backfill 2: every Tech Tracker rate, at its own date.
insert into public.employee_pay_rate_history (employee_id, rate_type, effective_date, amount, source)
select t.employee_id, 'flat', t.effective_date, t.flat_rate, 'tech_tracker'
  from public.tech_pay_rates t
on conflict (employee_id, rate_type, effective_date)
do update set amount = excluded.amount, source = 'tech_tracker', updated_at = now();

comment on table public.employee_pay_rates is
  'SUPERSEDED by employee_pay_rate_history (migration 56). Frozen: nothing reads or writes it. Its values were copied in as legacy rows dated 2000-01-01.';


-- ---------------------------------------------------------------------
-- 3. TECH TRACKER -> HISTORY MIRROR  (replaces migration 24's version)
-- ---------------------------------------------------------------------
create or replace function public.sync_tech_flat_rate()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.employee_pay_rate_history
     where employee_id = old.employee_id
       and rate_type = 'flat'
       and effective_date = old.effective_date
       and source = 'tech_tracker';
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into public.employee_pay_rate_history (employee_id, rate_type, effective_date, amount, source)
    values (new.employee_id, 'flat', new.effective_date, new.flat_rate, 'tech_tracker')
    on conflict (employee_id, rate_type, effective_date)
    do update set amount = excluded.amount, source = 'tech_tracker', updated_at = now();
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_sync_tech_flat_rate on public.tech_pay_rates;
create trigger trg_sync_tech_flat_rate
  after insert or update or delete on public.tech_pay_rates
  for each row execute function public.sync_tech_flat_rate();


-- ---------------------------------------------------------------------
-- 4. THE FOUR PAYROLL READERS
--    Each body below is the shipped one, copied VERBATIM from the
--    migration named, with only the lines listed changed. Nothing else
--    in them moved.
-- ---------------------------------------------------------------------

-- ---- payroll_pct_summary -- copied VERBATIM from migrations/32_pgw_payroll_daily_sunday_32.sql; changed:
--      Rates: employee_pay_rates -> _pay_rate_at(employee, week start).
--      Who counts: `e.active` -> has data this week OR _employed_during(the week).
create or replace function public.payroll_pct_summary(loc uuid, wk date)
returns table (
  actual_sales      numeric,
  total_payroll_pct numeric,
  cst_payroll_pct   numeric,
  vst_payroll_pct   numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sales numeric := 0;
  v_total numeric := 0;
  v_cst   numeric := 0;
begin
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc;
  end if;

  with base as (
    select
      -- CTE columns are deliberately NOT named after this function's OUT
      -- parameters. In plpgsql an OUT parameter is a variable, and an
      -- unqualified reference that matches both a variable and a column
      -- raises 42702. Migrations 14 and 16 both shipped a CTE column
      -- called actual_sales alongside the OUT parameter of the same
      -- name; that is a latent ambiguity, not a working pattern worth
      -- copying.
      e.id, e.position, e.is_store_manager,
      coalesce(tm.actual_sales, 0)     as emp_sales,
      coalesce(wh.total_hours, 0)      as total_hours,
      coalesce(wh.total_turned, 0)     as total_turned,
      coalesce(r.hourly_rate, 0)       as hourly_rate,
      coalesce(r.flat_rate_per_hour,0) as flat_rate_per_hour,
      coalesce(r.manager_salary, 0)    as manager_salary,
      coalesce(p.bonus, 0)             as bonus,
      coalesce(p.incentives, 0)        as incentives
    from public.employees e
    left join public.payroll_week_hours(loc, wk) wh on wh.employee_id = e.id
    left join public.timesheet_entries te
           on te.employee_id = e.id and te.week_start = wk and te.location_id = loc
    left join public.timesheet_midas tm on tm.timesheet_entry_id = te.id
    left join lateral public._pay_rate_at(e.id, wk) r on true
    left join public.timesheet_pay p on p.timesheet_entry_id = te.id
    where e.location_id = loc
      and (wh.employee_id is not null or te.id is not null
           or public._employed_during(e.active, e.hire_date, e.termination_date, wk, wk + 6))
  ),
  calc as (
    select
      position,
      emp_sales,
      case when is_store_manager
        then manager_salary + bonus + incentives
        else greatest(
               hourly_rate * least(total_hours, 40)
                 + hourly_rate * 1.5 * greatest(total_hours - 40, 0),
               flat_rate_per_hour * total_turned
             ) + bonus + incentives
      end as paycheck
    from base
  )
  select
    coalesce(sum(emp_sales), 0),
    coalesce(sum(paycheck), 0),
    coalesce(sum(paycheck) filter (where position in ('manager','front')), 0)
  into v_sales, v_total, v_cst
  from calc;

  actual_sales      := v_sales;
  total_payroll_pct := case when v_sales = 0 then null else v_total / v_sales end;
  cst_payroll_pct   := case when v_sales = 0 then null else v_cst   / v_sales end;
  vst_payroll_pct   := case when v_sales = 0 then null else (v_total - v_cst) / v_sales end;
  return next;
end;
$$;
grant execute on function public.payroll_pct_summary(uuid, date) to authenticated;

-- ---- flat_flags_for_week -- copied VERBATIM from migrations/32_pgw_payroll_daily_sunday_32.sql; changed:
--      Rates: employee_pay_rates -> _pay_rate_at(employee, week start).
--      Who counts: `e.active` -> has hours this week OR _employed_during(the week).
create or replace function public.flat_flags_for_week(loc uuid, wk date)
returns table (employee_id uuid, flat_flag boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc;
  end if;

  return query
  select
    e.id,
    case
      when e.is_store_manager then false
      else
        (coalesce(r.flat_rate_per_hour, 0) * coalesce(wh.total_turned, 0))
        >
        (coalesce(r.hourly_rate, 0) * least(coalesce(wh.total_hours, 0), 40)
         + coalesce(r.hourly_rate, 0) * 1.5
             * greatest(coalesce(wh.total_hours, 0) - 40, 0))
    end
  from public.employees e
  left join public.payroll_week_hours(loc, wk) wh on wh.employee_id = e.id
  left join lateral public._pay_rate_at(e.id, wk) r on true
  where e.location_id = loc
    and (wh.employee_id is not null
         or public._employed_during(e.active, e.hire_date, e.termination_date, wk, wk + 6));
end;
$$;
grant execute on function public.flat_flags_for_week(uuid, date) to authenticated;

-- ---- payroll_to_sales_wtd -- copied VERBATIM from migrations/32_pgw_payroll_daily_sunday_32.sql; changed:
--      Rates: employee_pay_rates -> _pay_rate_at(employee, week start).
create or replace function public.payroll_to_sales_wtd(loc uuid, wk date, as_of date default null)
returns table (
  window_start          date,
  window_end            date,
  hours_thru            date,
  sales_thru            date,
  wages_non_tech        numeric,
  wages_tech            numeric,
  wages_total           numeric,
  gross_sales           numeric,
  payroll_to_sales      numeric,
  techs_included        boolean,
  week_complete         boolean,
  missing_store_manager boolean,
  unattributed_days     int
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_as_of    date;
  v_hours    date;
  v_sales    date;
  v_end      date;
  v_techs    boolean;
  v_non_tech numeric := 0;
  v_tech     numeric := 0;
  v_gross    numeric := 0;
  v_unattr   int     := 0;
  v_missing  boolean := false;
begin
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc;
  end if;

  select include_technicians into v_techs from public.payroll_config where id;
  v_as_of := least(coalesce(as_of, current_date), wk + 6);

  -- Last day with countable hours. The store manager is excluded from
  -- the bound too -- their day must not extend a window their wages
  -- do not contribute to.
  select max(h.work_date) into v_hours
    from public.payroll_day_hours(loc, wk, v_as_of) h
    join public.employees e on e.id = h.employee_id
   where not e.is_store_manager
     and (h.hours_worked + h.hours_worked_other) > 0;

  -- Last day the tic sheet was actually filled in. A daily_kpi row is
  -- created merely by opening a day's panel, so an empty row does not
  -- count as an entered day.
  select max(k.business_date) into v_sales
    from public.daily_kpi k
   where k.location_id = loc
     and k.business_date >= wk and k.business_date <= v_as_of
     and (coalesce(k.ro_count, 0) <> 0
          or coalesce(k.sales_parts, 0) <> 0
          or coalesce(k.sales_tires, 0) <> 0
          or coalesce(k.sales_supplies, 0) <> 0
          or coalesce(k.sales_discounts, 0) <> 0);

  -- NOT least(): SQL's LEAST ignores nulls and would return the other
  -- bound, extending the window past a side that has no data at all.
  -- If either side is empty there is no overlap to report.
  if v_hours is null or v_sales is null then
    v_end := null;
  else
    v_end := least(v_hours, v_sales);
  end if;

  window_start          := wk;
  window_end            := v_end;
  hours_thru            := v_hours;
  sales_thru            := v_sales;
  techs_included        := v_techs;
  week_complete         := coalesce(v_end = wk + 6, false);

  select exists (select 1 from public.employees
                  where location_id = loc and active and position = 'manager')
     and not exists (select 1 from public.employees
                      where location_id = loc and active and is_store_manager)
    into v_missing;
  missing_store_manager := v_missing;

  -- Nothing both sides can agree on yet.
  if v_end is null or v_end < wk then
    wages_non_tech := null; wages_tech := null; wages_total := null;
    gross_sales := null; payroll_to_sales := null; unattributed_days := 0;
    return next;
    return;
  end if;

  -- ---- numerator, non-technicians -----------------------------------
  with h as (
    select ph.employee_id,
           sum(ph.hours_worked + ph.hours_worked_other) as hrs,
           sum(ph.hours_turned)                         as turned
      from public.payroll_day_hours(loc, wk, v_end) ph
      join public.employees e on e.id = ph.employee_id
     where ph.source = 'payroll'
       and not e.is_store_manager
     group by ph.employee_id
  )
  select coalesce(sum(greatest(
           coalesce(r.hourly_rate, 0) * least(h.hrs, 40)
             + coalesce(r.hourly_rate, 0) * 1.5 * greatest(h.hrs - 40, 0),
           coalesce(r.flat_rate_per_hour, 0) * h.turned)), 0)
    into v_non_tech
    from h
    left join lateral public._pay_rate_at(h.employee_id, wk) r on true;

  -- ---- numerator, technicians ---------------------------------------
  -- _tech_days takes an EXCLUSIVE upper bound, hence v_end + 1.
  if v_techs then
    with d as (
      select td2.*, tdr.employee_id
        from public._tech_days(loc, wk, v_end + 1) td2
        join public.tech_daily tdr
          on tdr.tech_slot_id = td2.slot and tdr.work_date = td2.work_date
    ),
    per_slot as (
      select d.slot,
             sum(d.hours)      as ht,
             sum(d.guar_pay)   as gt,
             sum(d.commission) as ct,
             max(d.guar_rate)  as gr
        from d
        left join public.employees e on e.id = d.employee_id
       where coalesce(e.is_store_manager, false) = false
       group by d.slot
    ),
    paid as (
      select per_slot.*,
             coalesce(tw.other_pay, 0) as op,
             case when ht < 40 then 0
                  when gt > ct then (ht - 40) * gr * 0.5
                  else (ht - 40) * (ct / nullif(ht, 0)) * 0.5 end as ot
        from per_slot
        left join public.tech_weekly tw
               on tw.tech_slot_id = per_slot.slot and tw.week_start = wk
    )
    select coalesce(sum(greatest(gt + ot, ct) + op), 0) into v_tech from paid;
  else
    v_tech := 0;
  end if;

  -- ---- denominator, the tic sheet's own Sales ------------------------
  select coalesce(sum(
           coalesce(lab.labor, 0)
           + coalesce(k.sales_parts, 0)
           + coalesce(k.sales_tires, 0)
           + coalesce(k.sales_supplies, 0)
           + coalesce(k.sales_discounts, 0)), 0)
    into v_gross
    from generate_series(wk, v_end, interval '1 day') g(d)
    left join public.daily_kpi k
           on k.location_id = loc and k.business_date = g.d::date
    left join (
      select td.work_date, sum(td.labor_sales) as labor
        from public.tech_daily td
       where td.location_id = loc
         and td.work_date >= wk and td.work_date <= v_end
       group by td.work_date
    ) lab on lab.work_date = g.d::date;

  -- ---- unattributed technician days in the window --------------------
  -- Mirrors the Tech Tracker banner exactly (PR #20): a day typed
  -- against a slot nobody held. A PLACEHOLDER slot -- labelled and
  -- deliberately unstaffed, e.g. 'MANAGER OR SA' -- is excluded, or
  -- every store would carry a permanent warning it could never clear.
  select count(distinct td.work_date) into v_unattr
    from public.tech_daily td
    join public.tech_slots ts on ts.id = td.tech_slot_id
   where td.location_id = loc
     and td.work_date >= wk and td.work_date <= v_end
     and td.employee_id is null
     and not (ts.employee_id is null and ts.label is not null)
     and (coalesce(td.hours_worked, 0) <> 0
          or coalesce(td.flag_hours, 0) <> 0
          or coalesce(td.labor_sales, 0) <> 0);

  wages_non_tech    := v_non_tech;
  wages_tech        := v_tech;
  wages_total       := v_non_tech + v_tech;
  gross_sales       := v_gross;
  payroll_to_sales  := case when v_gross = 0 then null
                            else (v_non_tech + v_tech) / v_gross end;
  unattributed_days := v_unattr;
  return next;
end;
$$;
grant execute on function public.payroll_to_sales_wtd(uuid, date, date) to authenticated;

-- ---- payroll_to_sales_range -- copied VERBATIM from migrations/38_pgw_horizon_slots_38.sql; changed:
--      Rates: employee_pay_rates -> _pay_rate_at(employee, that week's Sunday start), per week.
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
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc);

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
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc)
     and not e.is_store_manager
     and pd.work_date >= v_start and pd.work_date <= d_to
     and (pd.hours_worked + pd.hours_worked_other) > 0;

  select greatest(v_hours, max(td.work_date)) into v_hours
    from public.tech_daily td
    join public.locations l on l.id = td.location_id
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc)
     and td.employee_id is not null
     and td.work_date >= v_start and td.work_date <= d_to
     and td.hours_worked > 0;

  select max(dk.business_date) into v_sales
    from public.daily_kpi dk
    join public.locations l on l.id = dk.location_id
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc)
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
     where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc)
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
    left join lateral public._pay_rate_at(wk.employee_id, wk.week_start) r on true;

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
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc);

  wages_non_tech   := v_non;
  wages_tech       := v_tech;
  wages_total      := v_non + v_tech;
  gross_sales      := v_gross;
  payroll_to_sales := case when v_gross = 0 then null else (v_non + v_tech) / v_gross end;
  return next;
end;
$$;
grant execute on function public.payroll_to_sales_range(date, date, uuid) to authenticated;

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Every non-zero legacy rate was copied (expect equal counts):
--        select (select count(*) from public.employee_pay_rates where hourly_rate <> 0)
--             + (select count(*) from public.employee_pay_rates where flat_rate_per_hour <> 0)
--             + (select count(*) from public.employee_pay_rates where manager_salary <> 0) as legacy_values,
--               (select count(*) from public.employee_pay_rate_history where source = 'legacy') as legacy_rows;
--
--  [2] Every Tech Tracker rate is mirrored (expect 0):
--        select count(*) from public.tech_pay_rates t
--         where not exists (select 1 from public.employee_pay_rate_history h
--                            where h.employee_id = t.employee_id and h.rate_type = 'flat'
--                              and h.effective_date = t.effective_date and h.amount = t.flat_rate);
--
--  [3] Today's rate for everyone equals the old single rate, except where
--      a Tech Tracker rate is dated later than today (expect 0 rows):
--        select r.employee_id from public.employee_pay_rates r
--         cross join lateral public._pay_rate_at(r.employee_id, current_date) n
--         where n.hourly_rate <> r.hourly_rate or n.manager_salary <> r.manager_salary
--            or n.flat_rate_per_hour <> r.flat_rate_per_hour;
-- =====================================================================
