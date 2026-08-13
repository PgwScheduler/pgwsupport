-- =====================================================================
-- PGW Support Portal — Technician Time Tracker (Task 4)
-- Run AFTER pgw_daily_kpi_discount_sign_23.sql, in the Supabase SQL Editor.
-- Safe to re-run (drop-then-create / if-not-exists throughout).
-- =====================================================================
-- Replaces the Excel "Technician Tracking" tech sheets (nine identical
-- sheets per store) with flag hours, labor sales, and the guarantee /
-- commission pay engine. Labor sales and labor cost both ORIGINATE here;
-- every gross-profit figure in the portal reads from this.
--
-- Four tables + a per-store shape of NINE SLOTS (not nine employees):
--   tech_slots      slot roster (1..9)      store-visible (can_access_location)
--   tech_daily      hours/flag/labor/day    store-visible (can_access_location)
--   tech_weekly     other_pay per week      MASTER/ADMIN ONLY  (it is pay)
--   tech_pay_rates  flat + guarantee rates  MASTER/ADMIN ONLY  (effective-dated)
--
-- SECURITY MODEL — two tiers.
--   PER-TECHNICIAN pay (this slot's guarantee, commission, OT, total pay)
--   is master/admin only. It is derived, never stored, and needs the RATES;
--   tech_pay_rates + tech_weekly return ZERO rows to a store user, so a
--   store cannot derive an individual paycheck and no endpoint hands one
--   back (mirrors the employee_pay_rates boundary from migration 14).
--
--   STORE-LEVEL AGGREGATE labor cost is NOT restricted — it is the Cost of
--   Sales -> Labor line on the Summary sheet, and it feeds gross profit,
--   the bonus tracker, and the Horizon upload. It must exist server-side,
--   so section 6 exposes it through SECURITY DEFINER functions that read
--   the rate/pay tables INTERNALLY and return only store totals (monthly
--   labor cost, per-day labor cost, per-day allocation, and the derived
--   store metrics). A summed figure reveals no one person's pay. The
--   internal per-slot helper is revoked from PUBLIC so only the definer
--   functions can reach the per-slot pay it computes.
--
-- Store users CAN see and enter: hours worked, flag hours, labor sales,
-- and the slot roster; and CAN see store-level ELR, proficiency, and
-- aggregate labor cost. They CANNOT see any individual technician's pay.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. SLOTS  (store-visible)
--    Nine slots per store. A slot may hold a named employee, a
--    placeholder label (e.g. 'MANAGER OR SA'), or be empty. An empty slot
--    contributes zero everywhere and must never error.
-- ---------------------------------------------------------------------
create table if not exists public.tech_slots (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references public.locations (id) on delete cascade,
  slot_index       int  not null check (slot_index between 1 and 9),
  employee_id      uuid references public.employees (id) on delete set null,
  label            text,                    -- shown when no employee is assigned
  is_manager_or_sa boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (location_id, slot_index)
);
create index if not exists tech_slots_location_idx on public.tech_slots (location_id);

alter table public.tech_slots enable row level security;

drop policy if exists "tech_slots_select" on public.tech_slots;
create policy "tech_slots_select" on public.tech_slots for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "tech_slots_insert" on public.tech_slots;
create policy "tech_slots_insert" on public.tech_slots for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "tech_slots_update" on public.tech_slots;
create policy "tech_slots_update" on public.tech_slots for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
drop policy if exists "tech_slots_delete" on public.tech_slots;
create policy "tech_slots_delete" on public.tech_slots for delete to authenticated
  using (public.current_user_role() = 'master');


-- ---------------------------------------------------------------------
-- 2. DAILY  (store-visible) — one row per slot per work_date
--    The three columns a store manager types: hours worked, flag hours,
--    labor sales. Everything else is derived on read. Empty slots simply
--    have no rows (or rows of zeros) and fall out of every sum.
-- ---------------------------------------------------------------------
create table if not exists public.tech_daily (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations (id) on delete cascade,
  tech_slot_id uuid not null references public.tech_slots (id) on delete cascade,
  work_date    date not null,
  hours_worked numeric(6,2)  not null default 0,
  flag_hours   numeric(6,2)  not null default 0,
  labor_sales  numeric(12,2) not null default 0,
  updated_at   timestamptz not null default now(),
  unique (tech_slot_id, work_date)
);
create index if not exists tech_daily_loc_date_idx on public.tech_daily (location_id, work_date);
create index if not exists tech_daily_slot_idx on public.tech_daily (tech_slot_id);

alter table public.tech_daily enable row level security;

drop policy if exists "tech_daily_select" on public.tech_daily;
create policy "tech_daily_select" on public.tech_daily for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "tech_daily_insert" on public.tech_daily;
create policy "tech_daily_insert" on public.tech_daily for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "tech_daily_update" on public.tech_daily;
create policy "tech_daily_update" on public.tech_daily for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
drop policy if exists "tech_daily_delete" on public.tech_daily;
create policy "tech_daily_delete" on public.tech_daily for delete to authenticated
  using (public.current_user_role() = 'master');


-- ---------------------------------------------------------------------
-- 3. WEEKLY  ***MASTER / ADMIN ONLY*** — one row per slot per week
--    other_pay is a PAY figure, so a store SELECT returns zero rows.
--    week_start is always a Sunday (weeks run Sun..Sat). Stored once per
--    week: the Excel sheet has a daily Other Pay column but its weekly
--    total reads only the Sunday cell (H13 = H6), so anything typed on
--    another day silently vanishes. We store it weekly and sidestep that.
-- ---------------------------------------------------------------------
create table if not exists public.tech_weekly (
  id           uuid primary key default gen_random_uuid(),
  tech_slot_id uuid not null references public.tech_slots (id) on delete cascade,
  week_start   date not null,
  other_pay    numeric(12,2) not null default 0,
  updated_at   timestamptz not null default now(),
  constraint tech_weekly_week_is_sunday check (extract(dow from week_start) = 0),
  unique (tech_slot_id, week_start)
);
create index if not exists tech_weekly_slot_idx on public.tech_weekly (tech_slot_id);

alter table public.tech_weekly enable row level security;

drop policy if exists "tech_weekly_admin_all" on public.tech_weekly;
create policy "tech_weekly_admin_all" on public.tech_weekly for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 4. PAY RATES  ***MASTER / ADMIN ONLY*** — effective-dated
--    flat_rate      = dollars per FLAG hour  (commission)
--    guarantee_rate = dollars per hour WORKED (guarantee floor)
--    For a given work_date, the effective rate is the row with the
--    greatest effective_date <= that date. Kept in its OWN table so the
--    current-only employee_pay_rates (migration 14) is undisturbed.
--    No store policy exists -> a store SELECT returns zero rows.
--
--    AUTHORITATIVE SOURCE FOR A TECHNICIAN'S FLAT RATE
--    tech_pay_rates.flat_rate and employee_pay_rates.flat_rate_per_hour
--    hold the SAME fact (dollars per flag/turned hour). To stop them
--    diverging, tech_pay_rates.flat_rate is AUTHORITATIVE and section 5
--    syncs the current effective value forward into
--    employee_pay_rates.flat_rate_per_hour. Edit a tech's flat rate ONLY
--    here; the Employee-Hours rate field is a read-only mirror for techs.
--    (guarantee_rate is tech-only; employee_pay_rates.hourly_rate is the
--    unrelated Employee-Hours clock rate and is left alone.)
-- ---------------------------------------------------------------------
create table if not exists public.tech_pay_rates (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees (id) on delete cascade,
  effective_date date not null,
  flat_rate      numeric(10,2) not null default 0,
  guarantee_rate numeric(10,2) not null default 0,
  updated_at     timestamptz not null default now(),
  unique (employee_id, effective_date)
);
create index if not exists tech_pay_rates_emp_idx on public.tech_pay_rates (employee_id, effective_date desc);

alter table public.tech_pay_rates enable row level security;

drop policy if exists "tech_pay_rates_admin_all" on public.tech_pay_rates;
create policy "tech_pay_rates_admin_all" on public.tech_pay_rates for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 5. FLAT-RATE SYNC  (single source of truth)
--    After any change to a tech's rates, push the CURRENT effective
--    flat_rate into employee_pay_rates.flat_rate_per_hour so the legacy
--    Employee-Hours math (payroll_pct_summary / flat_flags_for_week /
--    lib/payrollMath.js) keeps working against one authoritative value.
--    Future-dated-only rows (no effective row as of today) leave the
--    existing value untouched.
-- ---------------------------------------------------------------------
create or replace function public.sync_tech_flat_rate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  emp uuid := coalesce(new.employee_id, old.employee_id);
  v   numeric;
begin
  select flat_rate into v
    from public.tech_pay_rates
    where employee_id = emp and effective_date <= current_date
    order by effective_date desc
    limit 1;

  if v is not null then
    insert into public.employee_pay_rates (employee_id, flat_rate_per_hour)
      values (emp, v)
      on conflict (employee_id)
      do update set flat_rate_per_hour = excluded.flat_rate_per_hour,
                    updated_at = now();
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_sync_tech_flat_rate on public.tech_pay_rates;
create trigger trg_sync_tech_flat_rate
  after insert or update or delete on public.tech_pay_rates
  for each row execute function public.sync_tech_flat_rate();


-- ---------------------------------------------------------------------
-- 6. STORE-LEVEL AGGREGATES  (SECURITY DEFINER, store-callable)
--    These return ONLY store totals — never a per-slot paycheck. They
--    read the master-only rate/pay tables internally. Weeks run Sun..Sat;
--    a month is the five Sun..Sat blocks starting at the Sunday on-or-
--    before the 1st (35 day-rows), exactly like the tech sheet.
--
--    Pay engine (MUST match lib/techPayMath.js EXACTLY):
--      per day  : guar_pay = hours*guarantee_rate ; commission = flag*flat_rate
--      per week : overtime = hours<40 ? 0
--                          : guar_total>comm_total ? (hours-40)*guar_rate*0.5
--                                                  : (hours-40)*(comm_total/hours)*0.5
--                 total_pay = MAX(guar_total+overtime, comm_total) + other_pay
--      labor_cost(month) = SUM of weekly total_pay across all slots/weeks.
-- ---------------------------------------------------------------------

-- 6a. INTERNAL per-day helper. Emits per-slot guar_pay/commission, which
--     ARE per-technician pay, so it is REVOKED FROM PUBLIC: only the
--     SECURITY DEFINER functions below (running as owner) may call it.
create or replace function public._tech_days(loc uuid, d_from date, d_to date)
returns table (
  slot uuid, work_date date, week_start date,
  hours numeric, flag numeric, labor numeric,
  guar_pay numeric, commission numeric, guar_rate numeric
)
language sql stable security definer set search_path = '' as $$
  select
    td.tech_slot_id,
    td.work_date,
    (td.work_date - (extract(dow from td.work_date)::int))::date          as week_start,
    td.hours_worked, td.flag_hours, td.labor_sales,
    td.hours_worked * coalesce(r.guarantee_rate, 0)                       as guar_pay,
    td.flag_hours   * coalesce(r.flat_rate, 0)                            as commission,
    coalesce(r.guarantee_rate, 0)                                         as guar_rate
  from public.tech_daily td
  join public.tech_slots ts on ts.id = td.tech_slot_id
  left join lateral (
    select pr.flat_rate, pr.guarantee_rate
    from public.tech_pay_rates pr
    where pr.employee_id = ts.employee_id
      and pr.effective_date <= td.work_date
    order by pr.effective_date desc
    limit 1
  ) r on true
  where td.location_id = loc
    and td.work_date >= d_from
    and td.work_date <  d_to;
$$;
revoke all on function public._tech_days(uuid, date, date) from public;

-- 6b. MONTH aggregates for a store.
--     NOTE on ELR: the portal's Effective Labor Rate is the spreadsheet's
--     Summary!R22 = (labor_sales + 0.5*groupon) / flag_hours. Groupon lives
--     in daily_kpi, not here, so this function returns the pure-tech
--     operands (labor_sales, flag_hours) and the official ELR is blended in
--     lib/grossProfit.js where the groupon is available. This function does
--     NOT return a raw labor_sales/flag ratio, to avoid two figures both
--     labelled "ELR" (raw would be 158.19; official is 156.92).
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
  first_sun date := month_start - (extract(dow from month_start)::int);
begin
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
end;
$$;
grant execute on function public.tech_store_month(uuid, date) to authenticated;

-- 6c. PER-DAY labor sales + allocated labor cost for a store.
--     labor_sales      -> the tic sheet's read-only Labor Sales column.
--     labor_cost_alloc -> the DEFECTIVE daily spread for the Horizon upload
--                         (replicates the sheet's P column; does NOT sum to
--                         monthly labor_cost, by design — see Part 3 brief).
create or replace function public.tech_store_daily(loc uuid, month_start date)
returns table (
  work_date        date,
  labor_sales      numeric,
  labor_cost_alloc numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  first_sun date := month_start - (extract(dow from month_start)::int);
begin
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
end;
$$;
grant execute on function public.tech_store_daily(uuid, date) to authenticated;


-- =====================================================================
-- VERIFY
--   1) As a STORE user these must each return zero rows:
--        select * from public.tech_weekly;
--        select * from public.tech_pay_rates;
--        select * from public._tech_days('LOC', '2026-06-28', '2026-08-02'); -- permission denied
--   2) As a STORE user these must SUCCEED (aggregates only, no per-slot pay):
--        select * from public.tech_store_month('LOC', '2026-07-01');
--        select * from public.tech_store_daily('LOC', '2026-07-01');
--        select * from public.tech_slots where location_id = 'LOC';
--        select * from public.tech_daily where location_id = 'LOC';
--   3) Flat-rate sync: insert a tech_pay_rates row (effective <= today) and
--      confirm employee_pay_rates.flat_rate_per_hour for that employee matches.
--   4) Column list:
--        select table_name, column_name from information_schema.columns
--          where table_name in
--            ('tech_slots','tech_daily','tech_weekly','tech_pay_rates')
--          order by table_name, ordinal_position;
-- =====================================================================
