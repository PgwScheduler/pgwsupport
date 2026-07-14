-- =====================================================================
-- PGW Support Portal — Speedee brand + brand-aware payroll restructure
-- Run AFTER pgw_flat_flags_for_store_15.sql. Safe to re-run.
-- =====================================================================
-- The four Speedee stores use a fundamentally different payroll sheet
-- from Midas (labor-sales %, no hours-turned/flat-rate/work-orders,
-- different positions, single payroll % target). This migration makes
-- the payroll layer BRAND-AWARE rather than Midas-only.
--
-- Design principles carried over from the Midas rebuild:
--   * Brand is DATA on locations, never hardcoded store numbers. A fifth
--     Speedee (or a conversion) is a one-field edit.
--   * Pay data stays invisible to store users at the DB level. Speedee
--     adds one twist: stores may see the payroll DOLLAR TOTAL (a brand
--     setting), but never an individual paycheck. That total is served
--     by a SECURITY DEFINER function, so no per-row pay is exposed.
--   * The app does NOT calculate Speedee paychecks — payroll ENTERS them.
--     paycheck_amount is a master/admin input; the hourly/OT figures are
--     reference only and never feed it.
--   * Derived values are computed on read; nothing derived is stored.
--
-- Shared core (timesheet_entries) keeps location/employee/week + PTO +
-- clock hours. Brand-specific columns move to their own tables so
-- neither brand carries the other's nullable clutter.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. BRAND on locations
-- ---------------------------------------------------------------------
alter table public.locations
  add column if not exists brand text not null default 'midas';
alter table public.locations drop constraint if exists locations_brand_check;
alter table public.locations add constraint locations_brand_check
  check (brand in ('midas','speedee'));

update public.locations set brand = 'speedee'
  where store_number in ('3009','3025','3029','3308');


-- ---------------------------------------------------------------------
-- 2. BRAND SETTINGS  (one row per brand; drives store-level toggles)
--    show_payroll_dollars_to_store: Speedee true, Midas false.
--    (Individual paychecks stay master-only for BOTH brands regardless.)
-- ---------------------------------------------------------------------
create table if not exists public.brand_settings (
  brand                         text primary key check (brand in ('midas','speedee')),
  show_payroll_dollars_to_store boolean not null default false,
  updated_at                    timestamptz not null default now()
);
insert into public.brand_settings (brand, show_payroll_dollars_to_store) values
  ('midas', false), ('speedee', true)
on conflict (brand) do nothing;

alter table public.brand_settings enable row level security;
drop policy if exists "brand_settings_select" on public.brand_settings;
create policy "brand_settings_select" on public.brand_settings for select to authenticated using (true);
drop policy if exists "brand_settings_master_write" on public.brand_settings;
create policy "brand_settings_master_write" on public.brand_settings for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 3. ROLE SALES RATES  (sales expectation = total_hours * this rate)
--    Store-readable (needed to compute the expectation); master-writable.
--    Seed $75 for every role; a master can adjust later.
-- ---------------------------------------------------------------------
create table if not exists public.role_sales_rates (
  brand               text not null check (brand in ('midas','speedee')),
  position            text not null,
  sales_rate_per_hour numeric(10,2) not null default 75,
  updated_at          timestamptz not null default now(),
  primary key (brand, position)
);
insert into public.role_sales_rates (brand, position, sales_rate_per_hour) values
  ('speedee','manager',75), ('speedee','front',75), ('speedee','cashier',75),
  ('speedee','labor_pct_tech',75), ('speedee','pitman',75), ('speedee','hood_tech',75)
on conflict (brand, position) do nothing;

alter table public.role_sales_rates enable row level security;
drop policy if exists "role_sales_rates_select" on public.role_sales_rates;
create policy "role_sales_rates_select" on public.role_sales_rates for select to authenticated using (true);
drop policy if exists "role_sales_rates_master_write" on public.role_sales_rates;
create policy "role_sales_rates_master_write" on public.role_sales_rates for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 4. EMPLOYEES  — Speedee positions + per-employee labor % eligibility
--    Position validity depends on the store's brand, so it's enforced by
--    a trigger (a plain CHECK can't see another table).
-- ---------------------------------------------------------------------
alter table public.employees drop constraint if exists employees_position_check;
alter table public.employees add constraint employees_position_check
  check (position in ('manager','front','tech','cashier','labor_pct_tech','pitman','hood_tech'));

alter table public.employees
  add column if not exists labor_pct_eligible     boolean not null default false,
  add column if not exists labor_pct_rate         numeric(6,4),
  add column if not exists sales_expectation_flat numeric(12,2);  -- manager flat override

create or replace function public.enforce_position_brand()
returns trigger language plpgsql security definer set search_path = '' as $$
declare b text;
begin
  select brand into b from public.locations where id = new.location_id;
  if b = 'speedee' then
    if new.position not in ('manager','front','cashier','labor_pct_tech','pitman','hood_tech') then
      raise exception 'position % is not valid for a Speedee store', new.position;
    end if;
  else
    if new.position not in ('manager','front','tech') then
      raise exception 'position % is not valid for a Midas store', new.position;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_enforce_position_brand on public.employees;
create trigger trg_enforce_position_brand
  before insert or update on public.employees
  for each row execute function public.enforce_position_brand();


-- ---------------------------------------------------------------------
-- 5. TIMESHEET_PAY  — add the ENTERED Speedee paycheck
--    Table stays master/admin-only (policy from migration 14 unchanged).
--    paycheck_amount: Speedee's entered figure. Midas keeps computing its
--    paycheck from rates + bonus/incentives and ignores this column.
-- ---------------------------------------------------------------------
alter table public.timesheet_pay
  add column if not exists paycheck_amount numeric(12,2);


-- ---------------------------------------------------------------------
-- 6. SPLIT timesheet_entries -> shared core + brand tables
--    Move the Midas-only columns into timesheet_midas (data-preserving),
--    then drop them from the core. Re-runnable via the column-exists guard.
-- ---------------------------------------------------------------------
create table if not exists public.timesheet_midas (
  timesheet_entry_id uuid primary key references public.timesheet_entries (id) on delete cascade,
  location_id        uuid not null references public.locations (id) on delete cascade,
  hrs_turned_other   numeric(6,2)  not null default 0,
  hrs_turned_here    numeric(6,2)  not null default 0,
  actual_sales       numeric(12,2) not null default 0,
  work_orders        numeric(8,2)  not null default 0,
  sales_required     numeric(12,2),                       -- goal; master-set only
  updated_at         timestamptz   not null default now()
);
create index if not exists timesheet_midas_loc_idx on public.timesheet_midas (location_id);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'timesheet_entries'
      and column_name = 'actual_sales'
  ) then
    insert into public.timesheet_midas
      (timesheet_entry_id, location_id, hrs_turned_other, hrs_turned_here,
       actual_sales, work_orders, sales_required)
    select id, location_id, hrs_turned_other, hrs_turned_here,
           actual_sales, work_orders, sales_required
    from public.timesheet_entries
    on conflict (timesheet_entry_id) do nothing;

    alter table public.timesheet_entries
      drop column if exists hrs_turned_other,
      drop column if exists hrs_turned_here,
      drop column if exists actual_sales,
      drop column if exists work_orders,
      drop column if exists sales_required;
  end if;
end $$;

-- The sales_required write-guard now lives on timesheet_midas.
drop trigger if exists trg_guard_sales_required on public.timesheet_entries;

alter table public.timesheet_midas enable row level security;
drop policy if exists "timesheet_midas_select" on public.timesheet_midas;
create policy "timesheet_midas_select" on public.timesheet_midas for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "timesheet_midas_insert" on public.timesheet_midas;
create policy "timesheet_midas_insert" on public.timesheet_midas for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "timesheet_midas_update" on public.timesheet_midas;
create policy "timesheet_midas_update" on public.timesheet_midas for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
drop policy if exists "timesheet_midas_delete" on public.timesheet_midas;
create policy "timesheet_midas_delete" on public.timesheet_midas for delete to authenticated
  using (public.can_access_location(location_id));

drop trigger if exists trg_guard_sales_required on public.timesheet_midas;
create trigger trg_guard_sales_required
  before insert or update on public.timesheet_midas
  for each row execute function public.guard_sales_required();


-- ---------------------------------------------------------------------
-- 7. TIMESHEET_SPEEDEE  (store-visible)
--    spiffs: store-entered. labor_sales: store-VISIBLE but master-write
--    only (DECIDED: expose it so Total Incentive isn't a hidden-but-
--    derivable leak). Guarded like sales_required.
-- ---------------------------------------------------------------------
create table if not exists public.timesheet_speedee (
  timesheet_entry_id uuid primary key references public.timesheet_entries (id) on delete cascade,
  location_id        uuid not null references public.locations (id) on delete cascade,
  spiffs             numeric(12,2) not null default 0,
  labor_sales        numeric(12,2),                       -- master-set only
  updated_at         timestamptz   not null default now()
);
create index if not exists timesheet_speedee_loc_idx on public.timesheet_speedee (location_id);

create or replace function public.guard_labor_sales()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.current_user_role() not in ('admin','master') then
    if tg_op = 'INSERT' then
      new.labor_sales := null;
    else
      new.labor_sales := old.labor_sales;
    end if;
  end if;
  return new;
end;
$$;

alter table public.timesheet_speedee enable row level security;
drop policy if exists "timesheet_speedee_select" on public.timesheet_speedee;
create policy "timesheet_speedee_select" on public.timesheet_speedee for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "timesheet_speedee_insert" on public.timesheet_speedee;
create policy "timesheet_speedee_insert" on public.timesheet_speedee for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "timesheet_speedee_update" on public.timesheet_speedee;
create policy "timesheet_speedee_update" on public.timesheet_speedee for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
drop policy if exists "timesheet_speedee_delete" on public.timesheet_speedee;
create policy "timesheet_speedee_delete" on public.timesheet_speedee for delete to authenticated
  using (public.can_access_location(location_id));

drop trigger if exists trg_guard_labor_sales on public.timesheet_speedee;
create trigger trg_guard_labor_sales
  before insert or update on public.timesheet_speedee
  for each row execute function public.guard_labor_sales();


-- ---------------------------------------------------------------------
-- 8. STORE WEEK SALES  (Speedee's actual weekly sales, excl. tax)
--    Store-visible and store-editable.
-- ---------------------------------------------------------------------
create table if not exists public.store_week_sales (
  location_id         uuid not null references public.locations (id) on delete cascade,
  week_start          date not null,
  actual_weekly_sales numeric(12,2) not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (location_id, week_start),
  constraint store_week_sales_week_is_monday check (extract(dow from week_start) = 1)
);

alter table public.store_week_sales enable row level security;
drop policy if exists "store_week_sales_select" on public.store_week_sales;
create policy "store_week_sales_select" on public.store_week_sales for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "store_week_sales_insert" on public.store_week_sales;
create policy "store_week_sales_insert" on public.store_week_sales for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "store_week_sales_update" on public.store_week_sales;
create policy "store_week_sales_update" on public.store_week_sales for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
drop policy if exists "store_week_sales_delete" on public.store_week_sales;
create policy "store_week_sales_delete" on public.store_week_sales for delete to authenticated
  using (public.can_access_location(location_id));


-- ---------------------------------------------------------------------
-- 9. MIDAS RPCs — repoint at timesheet_midas (actual_sales & hrs_turned
--    moved off timesheet_entries). Behaviour otherwise unchanged: Midas
--    stores still see percentages only, never dollars.
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
      e.position,
      coalesce(tm.actual_sales, 0)                            as actual_sales,
      te.clock_hours_other + te.clock_hours                   as total_hours,
      coalesce(tm.hrs_turned_other,0) + coalesce(tm.hrs_turned_here,0) as total_turned,
      coalesce(r.hourly_rate, 0)                              as hourly_rate,
      coalesce(r.flat_rate_per_hour, 0)                       as flat_rate_per_hour,
      coalesce(r.manager_salary, 0)                           as manager_salary,
      coalesce(p.bonus, 0)                                    as bonus,
      coalesce(p.incentives, 0)                               as incentives
    from public.timesheet_entries te
    join public.employees e on e.id = te.employee_id
    left join public.timesheet_midas tm on tm.timesheet_entry_id = te.id
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
  vst_payroll_pct   := case when v_sales = 0 then null else (v_total - v_cst) / v_sales end;
  return next;
end;
$$;
grant execute on function public.payroll_pct_summary(uuid, date) to authenticated;

create or replace function public.flat_flags_for_week(loc uuid, wk date)
returns table (employee_id uuid, flat_flag boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc;
  end if;

  return query
  select
    te.employee_id,
    case
      when e.position = 'manager' then false
      else
        (coalesce(r.flat_rate_per_hour, 0)
          * (coalesce(tm.hrs_turned_other,0) + coalesce(tm.hrs_turned_here,0)))
        >
        (coalesce(r.hourly_rate, 0) * least(te.clock_hours_other + te.clock_hours, 40)
         + coalesce(r.hourly_rate, 0) * 1.5
             * greatest(te.clock_hours_other + te.clock_hours - 40, 0))
    end
  from public.timesheet_entries te
  join public.employees e on e.id = te.employee_id
  left join public.timesheet_midas tm on tm.timesheet_entry_id = te.id
  left join public.employee_pay_rates r on r.employee_id = te.employee_id
  where te.location_id = loc and te.week_start = wk;
end;
$$;
grant execute on function public.flat_flags_for_week(uuid, date) to authenticated;


-- ---------------------------------------------------------------------
-- 10. SPEEDEE SUMMARY RPC
--     total payroll $ = SUM(entered paycheck_amount); % = / actual sales.
--     Dollars returned only when the caller is admin/master OR the brand
--     setting allows the store to see the total (Speedee = true). Even
--     then, only the TOTAL is exposed — never an individual paycheck.
-- ---------------------------------------------------------------------
create or replace function public.payroll_speedee_summary(loc uuid, wk date)
returns table (
  actual_sales          numeric,
  total_payroll_dollars numeric,   -- null when the caller may not see it
  payroll_pct           numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sales   numeric := 0;
  v_dollars numeric := 0;
  v_show    boolean := false;
begin
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc;
  end if;

  select coalesce(actual_weekly_sales, 0) into v_sales
  from public.store_week_sales where location_id = loc and week_start = wk;
  v_sales := coalesce(v_sales, 0);

  select coalesce(sum(tp.paycheck_amount), 0) into v_dollars
  from public.timesheet_entries te
  join public.timesheet_pay tp on tp.timesheet_entry_id = te.id
  where te.location_id = loc and te.week_start = wk;

  v_show := public.current_user_role() in ('admin','master')
            or coalesce((select show_payroll_dollars_to_store
                           from public.brand_settings where brand = 'speedee'), false);

  actual_sales          := v_sales;
  payroll_pct           := case when v_sales = 0 then null else v_dollars / v_sales end;
  total_payroll_dollars := case when v_show then v_dollars else null end;
  return next;
end;
$$;
grant execute on function public.payroll_speedee_summary(uuid, date) to authenticated;


-- =====================================================================
-- VERIFY
--   select store_number, brand from public.locations order by brand, store_number;
--   -- 3009/3025/3029/3308 -> speedee, the rest -> midas
--
--   As a SPEEDEE STORE user (through the app):
--     select * from public.timesheet_pay;            -> zero rows
--     select * from public.payroll_speedee_summary('LOC','2026-07-13');
--        -> actual_sales + total_payroll_dollars (allowed for Speedee) + %
--     select * from public.timesheet_speedee ...;    -> spiffs + labor_sales visible
--
--   As a MIDAS STORE user:
--     select * from public.payroll_pct_summary('LOC','2026-07-13');
--        -> percentages only, dollars never present
-- =====================================================================
