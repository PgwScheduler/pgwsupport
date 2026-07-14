-- =====================================================================
-- PGW Support Portal — Employee Hours -> full Payroll rebuild
-- Run AFTER pgw_profiles_email_13.sql, in the Supabase SQL Editor.
-- Safe to re-run (drop-then-create throughout).
-- =====================================================================
-- WHAT THIS DOES
-- Replaces the simple weekly employee_hours grid with the full payroll
-- spreadsheet the stores actually use. The whole point of this migration
-- is a security boundary that the Excel version never had:
--
--   PAY DATA IS INVISIBLE TO STORE USERS AT THE DATABASE LEVEL.
--
-- In Excel this was "hide columns M–U" (trivially defeated). Here, pay
-- rates and dollar figures live in their OWN tables whose RLS returns
-- ZERO rows to a store user. A store's SELECT never sees a rate, a
-- paycheck, or a bonus — not hidden in the UI, absent from the response.
--
-- Four tables:
--   employees          roster           store-visible (can_access_location)
--   timesheet_entries  weekly inputs    store-visible (can_access_location)
--   employee_pay_rates rates            MASTER/ADMIN ONLY
--   timesheet_pay      bonus/incentives MASTER/ADMIN ONLY
--
-- Nothing derived is stored — totals, OT, paychecks, percentages are all
-- recomputed on read (same pattern as the Cash Drawer). The store's
-- payroll PERCENTAGES (which it is allowed to see) come from a
-- SECURITY DEFINER function that returns only percentages, never the
-- underlying dollars.
--
-- The old employee_hours table is dropped — it is superseded and holds
-- no production data.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. DROP THE SUPERSEDED TABLE
-- ---------------------------------------------------------------------
drop table if exists public.employee_hours cascade;


-- ---------------------------------------------------------------------
-- 1. ROSTER  (store-visible)
--    One row per employee at a store. Removing an employee is a soft
--    delete (active = false) so weekly history is preserved.
-- ---------------------------------------------------------------------
create table if not exists public.employees (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  full_name   text not null default '',
  position    text not null default 'tech' check (position in ('manager','front','tech')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists employees_location_idx on public.employees (location_id);

alter table public.employees enable row level security;

drop policy if exists "employees_select" on public.employees;
create policy "employees_select" on public.employees for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "employees_insert" on public.employees;
create policy "employees_insert" on public.employees for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "employees_update" on public.employees;
create policy "employees_update" on public.employees for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
drop policy if exists "employees_delete" on public.employees;
create policy "employees_delete" on public.employees for delete to authenticated
  using (public.can_access_location(location_id));


-- ---------------------------------------------------------------------
-- 2. PAY RATES  ***MASTER / ADMIN ONLY***
--    Persistent per-employee rates. A store user's SELECT on this table
--    returns zero rows — there is no policy that grants them access.
--    Current values only (not effective-dated).
-- ---------------------------------------------------------------------
create table if not exists public.employee_pay_rates (
  employee_id        uuid primary key references public.employees (id) on delete cascade,
  hourly_rate        numeric(10,2) not null default 0,
  flat_rate_per_hour numeric(10,2) not null default 0,
  manager_salary     numeric(12,2) not null default 0,   -- salaried managers
  updated_at         timestamptz not null default now()
);

alter table public.employee_pay_rates enable row level security;

-- Single ALL policy: only admin/master, for every operation. No store path.
drop policy if exists "pay_rates_admin_all" on public.employee_pay_rates;
create policy "pay_rates_admin_all" on public.employee_pay_rates for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 3. TIMESHEET ENTRIES  (store-visible) — one row per employee per week
--    week_start is always a Monday. sales_required is on this row so the
--    store can SEE its goal, but a trigger (section 5) stops the store
--    from CHANGING it — only admin/master may.
-- ---------------------------------------------------------------------
create table if not exists public.timesheet_entries (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null references public.locations (id) on delete cascade,
  employee_id       uuid not null references public.employees (id) on delete restrict,
  week_start        date not null,
  pto_days          numeric(6,2) not null default 0,
  clock_hours_other numeric(6,2) not null default 0,   -- clocked at another store
  clock_hours       numeric(6,2) not null default 0,   -- clocked at this store
  hrs_turned_other  numeric(6,2) not null default 0,
  hrs_turned_here   numeric(6,2) not null default 0,
  actual_sales      numeric(12,2) not null default 0,  -- manager/front rows
  work_orders       numeric(8,2)  not null default 0,
  sales_required    numeric(12,2),                     -- goal; master-set only
  submitted_by      uuid references auth.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint timesheet_entries_week_is_monday check (extract(dow from week_start) = 1),
  constraint timesheet_entries_uniq unique (employee_id, week_start)
);
create index if not exists timesheet_entries_loc_week_idx
  on public.timesheet_entries (location_id, week_start);

alter table public.timesheet_entries enable row level security;

drop policy if exists "timesheet_entries_select" on public.timesheet_entries;
create policy "timesheet_entries_select" on public.timesheet_entries for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "timesheet_entries_insert" on public.timesheet_entries;
create policy "timesheet_entries_insert" on public.timesheet_entries for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "timesheet_entries_update" on public.timesheet_entries;
create policy "timesheet_entries_update" on public.timesheet_entries for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
drop policy if exists "timesheet_entries_delete" on public.timesheet_entries;
create policy "timesheet_entries_delete" on public.timesheet_entries for delete to authenticated
  using (public.can_access_location(location_id));


-- ---------------------------------------------------------------------
-- 4. TIMESHEET PAY  ***MASTER / ADMIN ONLY*** — one row per entry
--    Bonus & incentives. Like pay_rates: no store policy exists, so a
--    store SELECT returns zero rows.
-- ---------------------------------------------------------------------
create table if not exists public.timesheet_pay (
  timesheet_entry_id uuid primary key references public.timesheet_entries (id) on delete cascade,
  bonus              numeric(12,2) not null default 0,
  incentives         numeric(12,2) not null default 0,
  updated_at         timestamptz not null default now()
);

alter table public.timesheet_pay enable row level security;

drop policy if exists "timesheet_pay_admin_all" on public.timesheet_pay;
create policy "timesheet_pay_admin_all" on public.timesheet_pay for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 5. SALES_REQUIRED WRITE-GUARD
--    sales_required lives on a store-visible row, but only admin/master
--    may change it. RLS is row-level, not column-level, so a trigger
--    enforces the column rule. For a non-admin/master caller it silently
--    preserves the prior value (INSERT -> null, UPDATE -> old), so a
--    store autosave that happens to include the column can't move the
--    goal. No error is raised — the write of the other columns succeeds.
-- ---------------------------------------------------------------------
create or replace function public.guard_sales_required()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.current_user_role() not in ('admin','master') then
    if tg_op = 'INSERT' then
      new.sales_required := null;
    else
      new.sales_required := old.sales_required;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_sales_required on public.timesheet_entries;
create trigger trg_guard_sales_required
  before insert or update on public.timesheet_entries
  for each row execute function public.guard_sales_required();


-- ---------------------------------------------------------------------
-- 6. PAYROLL PERCENTAGES for STORE users
--    Stores may see their payroll PERCENTAGES but not the dollars behind
--    them. This SECURITY DEFINER function computes paychecks internally
--    (bypassing the pay-table RLS) and returns ONLY percentages + actual
--    sales. No paycheck, rate, or payroll-dollar total ever leaves it.
--    It re-checks can_access_location so a store can't read another
--    store's numbers.
--
--    Paycheck formula here MUST match lib/payrollMath.js exactly:
--      manager : manager_salary + bonus + incentives
--      other   : max(hourly+OT, flat) + bonus + incentives
--          regular = min(total_hours, 40), ot = max(total_hours-40, 0)
--          hourly+OT = rate*regular + rate*1.5*ot
--          flat      = flat_rate * (turned_other + turned_here)
--    CST = manager + front paychecks. VST = total - CST.
--    Targets (UI): total <= 26%, CST <= 10%, VST <= 16%.
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
  v_sales    numeric := 0;
  v_total    numeric := 0;
  v_cst      numeric := 0;
begin
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc;
  end if;

  with base as (
    select
      e.position,
      coalesce(te.actual_sales, 0)                            as actual_sales,
      te.clock_hours_other + te.clock_hours                   as total_hours,
      te.hrs_turned_other + te.hrs_turned_here                as total_turned,
      coalesce(r.hourly_rate, 0)                              as hourly_rate,
      coalesce(r.flat_rate_per_hour, 0)                       as flat_rate_per_hour,
      coalesce(r.manager_salary, 0)                           as manager_salary,
      coalesce(p.bonus, 0)                                    as bonus,
      coalesce(p.incentives, 0)                               as incentives
    from public.timesheet_entries te
    join public.employees e on e.id = te.employee_id
    left join public.employee_pay_rates r on r.employee_id = te.employee_id
    left join public.timesheet_pay p on p.timesheet_entry_id = te.id
    where te.location_id = loc and te.week_start = wk
  ),
  calc as (
    select
      position,
      actual_sales,
      case when position = 'manager'
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
    coalesce(sum(actual_sales), 0),
    coalesce(sum(paycheck), 0),
    coalesce(sum(paycheck) filter (where position in ('manager','front')), 0)
  into v_sales, v_total, v_cst
  from calc;

  actual_sales      := v_sales;
  total_payroll_pct := case when v_sales = 0 then null else v_total / v_sales end;
  cst_payroll_pct   := case when v_sales = 0 then null else v_cst   / v_sales end;
  vst_payroll_pct   := case when v_sales = 0 then null
                            else (v_total - v_cst) / v_sales end;
  return next;
end;
$$;

grant execute on function public.payroll_pct_summary(uuid, date) to authenticated;


-- =====================================================================
-- VERIFY
--   1) As a STORE user these must each return zero rows / be denied:
--        select * from public.employee_pay_rates;
--        select * from public.timesheet_pay;
--   2) As a STORE user this must succeed and expose only percentages:
--        select * from public.payroll_pct_summary('LOCATION-ID', '2026-07-13');
--   3) Column list:
--        select table_name, column_name from information_schema.columns
--          where table_name in
--            ('employees','employee_pay_rates','timesheet_entries','timesheet_pay')
--          order by table_name, ordinal_position;
-- =====================================================================
