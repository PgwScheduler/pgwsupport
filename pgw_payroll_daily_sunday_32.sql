-- =====================================================================
-- PGW Support Portal — Payroll: daily entry, Sunday week, technician
-- hours from the Tech Tracker, and week-to-date payroll-to-sales.
-- Run AFTER pgw_open_shifts_31.sql, in the Supabase SQL Editor.
-- Safe to re-run (drop-then-create / if-not-exists throughout).
-- =====================================================================
-- Three changes that only work together:
--
--   1. The pay week moves Monday -> SUNDAY, matching the tic sheet, the
--      tech tracker and the bonus math. Payroll was the one screen out
--      of step, which made every Sunday fall in a different week
--      depending on the screen and made payroll-to-sales meaningless.
--   2. Hours are captured DAILY (payroll_daily), not as one weekly
--      total. Overtime stays WEEKLY -- forty hours across the Sunday-
--      Saturday week, straight time to 40, time and a half beyond.
--      There is no daily overtime anywhere in this file.
--   3. A technician's hours are READ FROM tech_daily, never re-typed.
--      One entry per person per day, in exactly one place, enforced by
--      triggers in both directions rather than by convention.
--
-- CUTOVER  2026-08-30 (a Sunday), company-wide, stored in payroll_config
-- so nothing hardcodes it. Weeks BEFORE it read the old weekly rows;
-- weeks FROM it read payroll_daily. Daily detail cannot be recovered
-- from a weekly total, so nothing is backfilled.
--
-- WHAT ELSE THIS TOUCHES, AND WHY -- read before running:
--
--   * SALARY NOW KEYS OFF is_store_manager, NOT position = 'manager'.
--     The old rule paid EVERY 'manager' row manager_salary and never
--     computed hourly or overtime for them. BDC's rule is that only the
--     GM is salaried and excluded, and that assistant managers stay in
--     the metric -- which is only coherent if assistants are paid
--     hourly. So payroll_pct_summary and flat_flags_for_week (and
--     lib/payrollMath.js alongside them) now treat is_store_manager as
--     the salaried flag. An assistant manager needs
--     employee_pay_rates.hourly_rate set; their manager_salary is
--     ignored. FLAGGED: this changes how an existing 'manager' row is
--     paid on the grid. Exactly one such row exists company-wide
--     (#5254 'Tom Cruise', test data), so nothing real moves today.
--
--   * payroll_pct_summary and flat_flags_for_week are REWRITTEN to
--     resolve hours through the cutover, and to drive off the roster
--     rather than off timesheet_entries. Post-cutover an employee can
--     have daily hours and no weekly row at all, so the old
--     entries-driven query would have silently dropped them.
--
--   * timesheet_entries keeps what is genuinely weekly (pto_days, and
--     the timesheet_midas / timesheet_pay extensions). Only HOURS move
--     daily. clock_hours / clock_hours_other become legacy: they still
--     serve pre-cutover weeks and are rejected on post-cutover rows.
--
--   * payroll_speedee_summary is deliberately NOT changed. It sums
--     ENTERED paychecks against store_week_sales and never reads hours,
--     so the cutover does not reach it. Its week key moves to Sunday
--     with everything else via section 4.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. CUTOVER DATE + TECHNICIAN POLICY  (one row; read by all, master writes)
--    A CHECK constraint cannot reference a table, so every rule that
--    depends on the cutover is a trigger reading this row. One row is
--    enforced by the boolean primary key, so a second cutover date
--    cannot be inserted.
--
--    include_technicians is here rather than in code because the brief
--    asks for it to be a one-line change if BDC decides technicians
--    should come out of payroll-to-sales. As a policy row it is a
--    one-FIELD change with no deploy at all. It defaults TRUE: techs
--    are the largest labour cost in the store, and a staffing metric
--    that omits them tells a manager nothing.
-- ---------------------------------------------------------------------
create table if not exists public.payroll_config (
  id                  boolean primary key default true check (id),
  daily_cutover_date  date not null,
  include_technicians boolean not null default true,
  updated_at          timestamptz not null default now(),
  constraint payroll_config_cutover_is_sunday
    check (extract(dow from daily_cutover_date) = 0)
);

-- Re-run safety: bring an older payroll_config up to the current shape.
alter table public.payroll_config
  add column if not exists include_technicians boolean not null default true;
alter table public.payroll_config
  drop constraint if exists payroll_config_cutover_is_sunday;
alter table public.payroll_config
  add constraint payroll_config_cutover_is_sunday
  check (extract(dow from daily_cutover_date) = 0);

insert into public.payroll_config (id, daily_cutover_date)
values (true, date '2026-08-30')
on conflict (id) do update
  set daily_cutover_date = excluded.daily_cutover_date,
      updated_at = now();

alter table public.payroll_config enable row level security;

drop policy if exists "payroll_config_select" on public.payroll_config;
create policy "payroll_config_select" on public.payroll_config
  for select to authenticated using (true);

drop policy if exists "payroll_config_master_write" on public.payroll_config;
create policy "payroll_config_master_write" on public.payroll_config
  for all to authenticated
  using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');

create or replace function public.payroll_cutover()
returns date language sql stable security definer set search_path = '' as $$
  select daily_cutover_date from public.payroll_config where id;
$$;
grant execute on function public.payroll_cutover() to authenticated;


-- ---------------------------------------------------------------------
-- 2. THE STORE MANAGER, NAMED EXPLICITLY
--    Payroll-to-sales excludes the store manager entirely -- not their
--    wages, not their hours -- because they are salaried. That
--    exclusion has to be a fact on the row, not an inference from a
--    salary field being non-zero or from a position bucket that also
--    holds assistant managers.
--
--    The CHECK keeps the two facts consistent: a tech cannot be flagged
--    as the store manager. One flagged manager per location.
-- ---------------------------------------------------------------------
alter table public.employees
  add column if not exists is_store_manager boolean not null default false;

alter table public.employees drop constraint if exists employees_store_manager_is_manager;
alter table public.employees add constraint employees_store_manager_is_manager
  check (not is_store_manager or position = 'manager');

create unique index if not exists employees_one_store_manager_per_location
  on public.employees (location_id)
  where is_store_manager;


-- ---------------------------------------------------------------------
-- 3. CLEAR THE TEST ROWS  (approved by BDC)
--    Three timesheet_entries at #5254 for the week of 2026-07-13, their
--    timesheet_midas extensions and timesheet_pay rows (both cascade),
--    plus the single store_week_sales row for the same week.
--    tech_daily is NOT touched -- Millwood's July is real data.
--    Narrowed by week so a later re-run cannot widen its reach.
-- ---------------------------------------------------------------------
delete from public.timesheet_entries where week_start = date '2026-07-13';
delete from public.store_week_sales  where week_start = date '2026-07-13';


-- ---------------------------------------------------------------------
-- 4. THE WEEK BECOMES SUNDAY -- ON BOTH WEEKLY TABLES, TOGETHER
--    timesheet_entries and store_week_sales must flip on the SAME date.
--    store_week_sales is the denominator of the SpeeDee payroll
--    percentage; a one-week disagreement would compare a Sunday wage
--    week against a Monday sales week -- the exact failure this task
--    exists to remove.
--
--    A straight flip to dow = 0 is impossible while any Monday row
--    exists and would strand genuine pre-cutover history, so the CHECK
--    admits both and a trigger picks the right one by date:
--      week_start >= cutover  ->  must be a SUNDAY
--      week_start <  cutover  ->  must be a MONDAY
--
--    No day is lost or double-counted at the boundary. The last Monday
--    week (2026-08-24) covers Aug 24-29; the first Sunday week opens
--    Aug 30, itself a Sunday, and stores are closed Sundays
--    (derived_days_open counts Mon-Sat). No worked day changes week.
-- ---------------------------------------------------------------------
alter table public.timesheet_entries
  drop constraint if exists timesheet_entries_week_is_monday;
alter table public.timesheet_entries
  drop constraint if exists timesheet_entries_week_start_dow;
alter table public.timesheet_entries
  add constraint timesheet_entries_week_start_dow
  check (extract(dow from week_start) in (0, 1));

alter table public.store_week_sales
  drop constraint if exists store_week_sales_week_is_monday;
alter table public.store_week_sales
  drop constraint if exists store_week_sales_week_start_dow;
alter table public.store_week_sales
  add constraint store_week_sales_week_start_dow
  check (extract(dow from week_start) in (0, 1));

create or replace function public.enforce_week_start_alignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  cut date := public.payroll_cutover();
  dw  int  := extract(dow from new.week_start)::int;
begin
  if new.week_start >= cut and dw <> 0 then
    raise exception
      'Pay weeks from % run Sunday-Saturday; % is not a Sunday.',
      to_char(cut, 'FMMon FMDD, YYYY'), new.week_start
      using errcode = '23514';
  elsif new.week_start < cut and dw <> 1 then
    raise exception
      'Pay weeks before % ran Monday-Saturday; % is not a Monday.',
      to_char(cut, 'FMMon FMDD, YYYY'), new.week_start
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_week_start_alignment on public.timesheet_entries;
create trigger trg_week_start_alignment
  before insert or update of week_start on public.timesheet_entries
  for each row execute function public.enforce_week_start_alignment();

drop trigger if exists trg_week_start_alignment on public.store_week_sales;
create trigger trg_week_start_alignment
  before insert or update of week_start on public.store_week_sales
  for each row execute function public.enforce_week_start_alignment();


-- ---------------------------------------------------------------------
-- 5. LEGACY WEEKLY HOURS ARE FROZEN
--    Two rules, both about HOURS only -- the weekly row itself stays
--    editable for what is still weekly (pto_days and the extensions).
--
--      * On a PRE-cutover row, clock_hours / clock_hours_other cannot
--        change. That history is read-only; it cannot be rebuilt into
--        daily detail, so it must not drift either. Master keeps an
--        escape hatch for genuine corrections.
--      * On a POST-cutover row they must stay zero. Those hours belong
--        in payroll_daily, and a value here would be counted by nothing
--        and silently lost.
-- ---------------------------------------------------------------------
create or replace function public.guard_legacy_weekly_hours()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  cut date := public.payroll_cutover();
begin
  if new.week_start >= cut then
    if coalesce(new.clock_hours, 0) <> 0 or coalesce(new.clock_hours_other, 0) <> 0 then
      raise exception
        'Hours from % are entered by day. Use the daily columns, not the weekly total.',
        to_char(cut, 'FMMon FMDD, YYYY')
        using errcode = '42501';
    end if;
  elsif tg_op = 'UPDATE'
        and (new.clock_hours is distinct from old.clock_hours
             or new.clock_hours_other is distinct from old.clock_hours_other)
        and public.current_user_role() <> 'master' then
    raise exception
      'Weeks before % are closed; their hours cannot be changed.',
      to_char(cut, 'FMMon FMDD, YYYY')
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_legacy_weekly_hours on public.timesheet_entries;
create trigger trg_guard_legacy_weekly_hours
  before insert or update on public.timesheet_entries
  for each row execute function public.guard_legacy_weekly_hours();


-- ---------------------------------------------------------------------
-- 6. DAILY HOURS  (store-visible)
--    One row per employee per day. hours_worked_other keeps the
--    existing "clocked at another store" split rather than widening the
--    key: a person's day still belongs to exactly one store's payroll,
--    which is what the weekly model recorded and what this key holds.
--
--    hours_turned is here so the daily grain is uniform. For a
--    TECHNICIAN it is never written here -- their turned hours are
--    tech_daily.flag_hours, resolved by payroll_day_hours in section 8.
--
--    ON DELETE RESTRICT on employee_id, matching timesheet_entries:
--    removing an employee is a soft delete (active = false) precisely
--    so payroll history survives.
-- ---------------------------------------------------------------------
create table if not exists public.payroll_daily (
  id                 uuid primary key default gen_random_uuid(),
  location_id        uuid not null references public.locations (id) on delete cascade,
  employee_id        uuid not null references public.employees (id) on delete restrict,
  work_date          date not null,
  hours_worked       numeric(6,2) not null default 0,
  hours_worked_other numeric(6,2) not null default 0,
  hours_turned       numeric(6,2) not null default 0,
  submitted_by       uuid references auth.users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index if not exists payroll_daily_loc_date_idx
  on public.payroll_daily (location_id, work_date);

alter table public.payroll_daily enable row level security;

drop policy if exists "payroll_daily_select" on public.payroll_daily;
create policy "payroll_daily_select" on public.payroll_daily for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "payroll_daily_insert" on public.payroll_daily;
create policy "payroll_daily_insert" on public.payroll_daily for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "payroll_daily_update" on public.payroll_daily;
create policy "payroll_daily_update" on public.payroll_daily for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
drop policy if exists "payroll_daily_delete" on public.payroll_daily;
create policy "payroll_daily_delete" on public.payroll_daily for delete to authenticated
  using (public.can_access_location(location_id));

-- Daily entry starts AT the cutover. A day before it belongs to the
-- weekly model, and accepting one here would put the same week in two
-- grains at once.
create or replace function public.payroll_daily_after_cutover()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  cut date := public.payroll_cutover();
begin
  if new.work_date < cut then
    raise exception
      'Daily hours start %. Earlier weeks are held in the weekly timesheet.',
      to_char(cut, 'FMMon FMDD, YYYY')
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payroll_daily_after_cutover on public.payroll_daily;
create trigger trg_payroll_daily_after_cutover
  before insert or update of work_date on public.payroll_daily
  for each row execute function public.payroll_daily_after_cutover();


-- ---------------------------------------------------------------------
-- 7. ONE ENTRY PER PERSON PER DAY, IN EXACTLY ONE PLACE
--    A unique index cannot span two tables, so disjointness between
--    payroll_daily and tech_daily is enforced by a trigger on each
--    side. Neither side silently wins: a same-day collision is REFUSED
--    with a message naming the conflict, so a human decides which entry
--    is right instead of one screen deleting the other's typed hours.
--
--    Placeholder slots (tech_daily.employee_id null) are exempt --
--    they belong to nobody, so they cannot collide with anybody.
--
--    The tech_daily guard is an AFTER trigger on purpose. tech_daily
--    already carries a BEFORE INSERT trigger (tech_daily_stamp_employee,
--    migration 29) that fills employee_id from the slot; a BEFORE guard
--    would race it on name order and could read a null. AFTER runs once
--    every BEFORE trigger has finished, so employee_id is populated,
--    and raising there still rolls the whole statement back.
-- ---------------------------------------------------------------------
create or replace function public.payroll_daily_no_tech_overlap()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  if exists (select 1 from public.tech_daily td
              where td.employee_id = new.employee_id
                and td.work_date   = new.work_date) then
    select full_name into v_name from public.employees where id = new.employee_id;
    raise exception
      '% already has technician hours for % in the Tech Tracker. Hours are entered in one place only -- correct them there.',
      coalesce(nullif(v_name, ''), 'This employee'), new.work_date
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payroll_daily_no_tech_overlap on public.payroll_daily;
create trigger trg_payroll_daily_no_tech_overlap
  before insert or update of employee_id, work_date on public.payroll_daily
  for each row execute function public.payroll_daily_no_tech_overlap();

create or replace function public.tech_daily_no_payroll_overlap()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  if new.employee_id is not null
     and exists (select 1 from public.payroll_daily pd
                  where pd.employee_id = new.employee_id
                    and pd.work_date   = new.work_date) then
    select full_name into v_name from public.employees where id = new.employee_id;
    raise exception
      '% already has hours entered for % in Payroll. Clear that Payroll day first.',
      coalesce(nullif(v_name, ''), 'This employee'), new.work_date
      using errcode = '23505';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_tech_daily_no_payroll_overlap on public.tech_daily;
create trigger trg_tech_daily_no_payroll_overlap
  after insert or update of employee_id, work_date on public.tech_daily
  for each row execute function public.tech_daily_no_payroll_overlap();


-- ---------------------------------------------------------------------
-- 8. THE ONE ROW PER PERSON PER DAY, RESOLVED
--    Every weekly figure below reads THIS function and nothing else. A
--    day resolves to tech_daily if the person has a row there, else to
--    payroll_daily; section 7 guarantees never both.
--
--    Because resolution is per (person, DAY) and not per person, an
--    employee who is a technician for part of a period and not for the
--    rest needs no special case: their early days resolve to tech,
--    their later days to payroll, and section 9 sums all seven
--    regardless of source -- so they get ONE 40-hour overtime threshold
--    across the week, which is what the law requires and what a
--    per-role split would have got wrong.
--
--    SECURITY INVOKER (the default): both tables are store-visible and
--    RLS-scoped, so a caller sees exactly the locations they may see.
--    Hours only -- no pay is touched here.
-- ---------------------------------------------------------------------
create or replace function public.payroll_day_hours(loc uuid, d_from date, d_to date)
returns table (
  employee_id        uuid,
  work_date          date,
  hours_worked       numeric,
  hours_worked_other numeric,
  hours_turned       numeric,
  source             text
)
language sql stable set search_path = '' as $$
  select td.employee_id, td.work_date,
         td.hours_worked, 0::numeric, td.flag_hours, 'tech'::text
    from public.tech_daily td
   where td.location_id = loc
     and td.employee_id is not null
     and td.work_date >= d_from and td.work_date <= d_to
  union all
  select pd.employee_id, pd.work_date,
         pd.hours_worked, pd.hours_worked_other, pd.hours_turned, 'payroll'::text
    from public.payroll_daily pd
   where pd.location_id = loc
     and pd.work_date >= d_from and pd.work_date <= d_to;
$$;
grant execute on function public.payroll_day_hours(uuid, date, date) to authenticated;


-- ---------------------------------------------------------------------
-- 9. WEEKLY HOURS PER EMPLOYEE, ACROSS THE CUTOVER
--    Overtime is computed HERE, weekly, once, on the sum of the seven
--    days. There is no daily overtime.
--
--    Before the cutover the week is Monday-based and hours come from
--    the frozen weekly columns; from the cutover it is Sunday-based and
--    hours come from the daily rows. Callers pass a week_start and get
--    the same shape either way.
-- ---------------------------------------------------------------------
create or replace function public.payroll_week_hours(loc uuid, wk date)
returns table (
  employee_id   uuid,
  total_hours   numeric,
  total_turned  numeric,
  regular_hours numeric,
  ot_hours      numeric,
  tech_days     int,
  payroll_days  int
)
language sql stable set search_path = '' as $$
  with src as (
    select h.employee_id,
           sum(h.hours_worked + h.hours_worked_other)   as total_hours,
           sum(h.hours_turned)                          as total_turned,
           count(*) filter (where h.source = 'tech')    as tech_days,
           count(*) filter (where h.source = 'payroll') as payroll_days
      from public.payroll_day_hours(loc, wk, wk + 6) h
     where wk >= public.payroll_cutover()
     group by h.employee_id
    union all
    select te.employee_id,
           te.clock_hours + te.clock_hours_other,
           coalesce(tm.hrs_turned_other, 0) + coalesce(tm.hrs_turned_here, 0),
           0, 0
      from public.timesheet_entries te
      left join public.timesheet_midas tm on tm.timesheet_entry_id = te.id
     where te.location_id = loc
       and te.week_start = wk
       and wk < public.payroll_cutover()
  )
  select employee_id,
         total_hours,
         total_turned,
         least(total_hours, 40),
         greatest(total_hours - 40, 0),
         tech_days::int,
         payroll_days::int
    from src;
$$;
grant execute on function public.payroll_week_hours(uuid, date) to authenticated;


-- ---------------------------------------------------------------------
-- 10. THE STORE'S WEEKLY PAYROLL PERCENTAGES  (rewritten)
--     Same contract as migrations 14/16 -- percentages out, never a
--     dollar -- with two corrections:
--
--       * hours resolve through payroll_week_hours, so the figure
--         recomputes from daily rows once daily entry starts;
--       * the salaried test is is_store_manager, not position.
--
--     Driven off the ROSTER, not off timesheet_entries: post-cutover an
--     employee can have daily hours and no weekly row at all, and the
--     old entries-driven query would have dropped them silently.
--
--     Paycheck formula MUST match computePayRow() in lib/payrollMath.js:
--       store manager : manager_salary + bonus + incentives
--       everyone else : max(hourly+OT, flat) + bonus + incentives
--     CST = manager + front paychecks (a cost CATEGORY, unrelated to
--     the salaried test). VST = total - CST.
-- ---------------------------------------------------------------------
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
    left join public.employee_pay_rates r on r.employee_id = e.id
    left join public.timesheet_pay p on p.timesheet_entry_id = te.id
    where e.location_id = loc and e.active
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


-- ---------------------------------------------------------------------
-- 11. FLAT FLAG  (rewritten on the same two corrections)
--     Returns one boolean per employee and nothing else, so a store
--     user learns which side of the guarantee an employee landed on
--     without seeing either figure.
-- ---------------------------------------------------------------------
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
  left join public.employee_pay_rates r on r.employee_id = e.id
  where e.location_id = loc and e.active;
end;
$$;
grant execute on function public.flat_flags_for_week(uuid, date) to authenticated;


-- ---------------------------------------------------------------------
-- 12. PAYROLL-TO-SALES, WEEK TO DATE
--     wages_to_date / gross_sales_to_date, both over the IDENTICAL date
--     window, so a part-week wage figure is never divided by a
--     full-week sales figure.
--
--     THE WINDOW is Sunday through the last day BOTH sides have data
--     for: min(last day with hours, last day with a tic-sheet entry,
--     as_of). A store that enters the tic sheet nightly but payroll on
--     Friday would otherwise read a flattering number all week and jump
--     on Friday. Both bounds are returned so the widget can say which
--     days it covered.
--
--     NUMERATOR -- hourly wages, no bonuses, no store manager:
--       * everyone else: max(hourly + OT, flat x turned). BDC's rule
--         is that timesheet_pay.bonus AND incentives both come out, so
--         they are never added -- not added then subtracted.
--       * technicians: the Tech Tracker pay engine, which is
--         max(guarantee + OT, commission) + tech_weekly.other_pay.
--         other_pay STAYS IN per BDC. It is entered at week close, so
--         mid-week it is normally zero and the figure is unaffected.
--       * the store manager is absent entirely -- not their wages, not
--         their hours, not their days in the window bound.
--
--     DENOMINATOR -- gross sales per the tic sheet, which is
--     ticSheetMath.daySales(): tech labor_sales + parts + tires +
--     supplies + discounts. Groupon is excluded (migration 25) and
--     discounts are signed as entered and added algebraically.
--
--     TWO HONEST CAVEATS, both worth showing on the widget:
--       * Overtime cannot be known until the week closes. Below 40
--         hours OT is zero by definition, so a mid-week figure
--         understates a week heading for overtime.
--       * A technician's pay is the greater of guarantee and
--         commission across the WHOLE week. Week to date it can flip
--         from one to the other as flag hours land, so the number can
--         move without anyone's hours changing.
--
--     SECURITY DEFINER: it reads employee_pay_rates, tech_pay_rates and
--     tech_weekly, all master-only, and calls _tech_days, which is
--     revoked from public. It re-checks can_access_location itself.
--     It returns AGGREGATE dollars, which store users may see -- and
--     which they could already derive, since gross sales are visible on
--     the tic sheet and percentage x sales is the wage total exactly.
--     Hiding the numerator would be theatre; BDC accepted the trade.
-- ---------------------------------------------------------------------
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
    left join public.employee_pay_rates r on r.employee_id = h.employee_id;

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


-- =====================================================================
-- VERIFY
--
--  1) Cutover is stored, not hardcoded, and is a Sunday:
--       select daily_cutover_date,
--              to_char(daily_cutover_date,'Day') as dow,
--              include_technicians
--         from public.payroll_config;
--       -- 2026-08-30, Sunday, true
--
--  2) Test rows are gone, tech_daily is untouched:
--       select count(*) from public.timesheet_entries;   -- 0
--       select count(*) from public.store_week_sales;    -- 0
--       select count(*) from public.tech_daily;          -- 83
--
--  3) The week rule holds in BOTH directions:
--       -- rejected (post-cutover Monday):
--       insert into public.timesheet_entries (location_id, employee_id, week_start)
--         values ('LOC','EMP', date '2026-08-31');
--       -- rejected (pre-cutover Sunday):
--       insert into public.timesheet_entries (location_id, employee_id, week_start)
--         values ('LOC','EMP', date '2026-08-23');
--       -- accepted:
--       insert into public.timesheet_entries (location_id, employee_id, week_start)
--         values ('LOC','EMP', date '2026-08-30');
--
--  4) One entry per person per day, both directions. Using a Millwood
--     tech (they already hold tech_daily rows for July):
--       insert into public.payroll_daily (location_id, employee_id, work_date, hours_worked)
--         values ('MILLWOOD','BRAYBOY', date '2026-07-01', 8);
--       -- refused: "... already has technician hours for 2026-07-01"
--       -- (also refused by section 6: 2026-07-01 predates the cutover)
--     And the reverse, on a post-cutover date:
--       insert into public.payroll_daily (...) values ('LOC','EMP','2026-08-31', 8);
--       insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked)
--         values ('LOC','SLOT-HELD-BY-EMP','2026-08-31', 8);
--       -- refused: "... already has hours entered for 2026-08-31 in Payroll"
--
--  5) Overtime is WEEKLY, not daily. Nine hours a day Sunday to
--     Thursday = 45 hours, 5 of overtime, ONE threshold:
--       select * from public.payroll_week_hours('LOC', date '2026-08-30');
--       -- total_hours 45, regular_hours 40, ot_hours 5
--
--  6) A store user still cannot reach an individual's pay:
--       select * from public.employee_pay_rates;   -- zero rows
--       select * from public.tech_pay_rates;       -- zero rows
--       select * from public.tech_weekly;          -- zero rows
--       select * from public._tech_days('LOC','2026-08-30','2026-09-06');
--                                                  -- permission denied
--     ...while the aggregate they are meant to have works:
--       select * from public.payroll_to_sales_wtd('LOC', date '2026-08-30');
--
--  7) Cross-store isolation, as any store user:
--       select * from public.payroll_daily where location_id = 'OTHER-STORE';
--                                                  -- zero rows
--       select * from public.payroll_to_sales_wtd('OTHER-STORE', date '2026-08-30');
--                                                  -- not authorized
--
--  8) Both sides of the ratio cover the same days -- enter the tic
--     sheet through Wednesday and hours through Tuesday, then confirm
--     window_end is TUESDAY and sales_thru is Wednesday.
-- =====================================================================
