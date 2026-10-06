-- =====================================================================
-- Migration 76 -- Transfer an employee to another store
--
-- Why: the user, 2026-10-06. Move a person from one location to another
-- from their employee profile.
--
-- WHAT A TRANSFER IS: the old row ENDS and a new, linked row STARTS.
-- Changing employees.location_id in place was considered and rejected:
-- every payroll read lists a store's people by `e.location_id = loc`
-- (payroll_pct_summary, flat_flags_for_week, usePayroll), so moving the
-- row would pull the person out of every PAST week at the old store --
-- the old store's labor cost and payroll % would change after the fact.
-- Ending and starting is how the portal already treats a departure, so
-- every report keeps working with no change:
--
--   old row   termination_date = transfer date - 1, active = false.
--             Exactly what "End employment" writes. Untouched otherwise
--             (its is_store_manager stays, as it does on any ending, so
--             its past salaried weeks still cost the same).
--   new row   at the new store, active, with transferred_from_id -> the
--             old row and transfer_date = first day there. Name, hire
--             date, rehire date, birthday, Employee / ADP ID and ADP
--             Position ID carry over, so anniversaries and ADP matching
--             are unaffected.
--   pay       the old row's whole rate history is copied, dates and all,
--             so the new store pays the same rates. Admin/master may
--             pass new rates, effective on the transfer date.
--   cleanup   the old store's Tech Tracker slot is vacated (day rows
--             keep the person who worked them -- migration 29); shifts
--             at the old store on/after the transfer date become open
--             shifts (working shifts) or are removed (PTO, sick, call
--             out...); a directory contact linked to them follows them.
--   Horizon   NOT touched. Migration 38 deliberately never releases a
--             Horizon slot as a side effect; the old store's slot stays
--             held (and shows in the held-by-inactive indicator) until
--             an admin releases it, and the new store assigns one the
--             usual way.
--
-- THE ONE CHANGE TO PAYROLL: the new row carries the ORIGINAL hire date,
-- which on its own would put them on every earlier week at the new
-- store (_employed_during reads the hire date). payroll_pct_summary and
-- flat_flags_for_week are recreated from migration 56 with that test
-- reading greatest(hire_date, transfer_date) -- their only change.
-- lib/payRates.js employedDuring() mirrors it.
--
-- WHO: admin and master anywhere; district and regional between stores
-- they can both access (can_access_location on each end). Store users
-- cannot -- they cannot see the other store. Setting the store-manager
-- flag or new pay rates is admin/master only, as on the profile.
--
-- Independent of migration 75; run either first. Run AFTER 74.
-- Safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE LINK
-- ---------------------------------------------------------------------
alter table public.employees
  add column if not exists transferred_from_id uuid null
    references public.employees (id) on delete set null,
  add column if not exists transfer_date date null;

comment on column public.employees.transferred_from_id is
  'Migration 76: the row this person was transferred from (their row at the previous store). That row ended the day before transfer_date.';
comment on column public.employees.transfer_date is
  'Migration 76: first day at this store by transfer. Payroll counts them here from this date; hire_date stays the original hire.';

-- A row is transferred out at most once.
create unique index if not exists employees_transferred_from_key
  on public.employees (transferred_from_id) where transferred_from_id is not null;

alter table public.employees drop constraint if exists employees_transfer_dated;
alter table public.employees add constraint employees_transfer_dated
  check (transferred_from_id is null or transfer_date is not null);


-- ---------------------------------------------------------------------
-- 2. PAYROLL: a transferred-in row counts from its transfer date
-- ---------------------------------------------------------------------

-- ---- payroll_pct_summary -- copied VERBATIM from pgw_employee_profile_pay_history_56.sql; changed:
--      Who counts: _employed_during reads greatest(hire_date, transfer_date).
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
           or public._employed_during(e.active, greatest(e.hire_date, e.transfer_date), e.termination_date, wk, wk + 6))
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

-- ---- flat_flags_for_week -- copied VERBATIM from pgw_employee_profile_pay_history_56.sql; changed:
--      Who counts: _employed_during reads greatest(hire_date, transfer_date).
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
         or public._employed_during(e.active, greatest(e.hire_date, e.transfer_date), e.termination_date, wk, wk + 6));
end;
$$;
grant execute on function public.flat_flags_for_week(uuid, date) to authenticated;


-- ---------------------------------------------------------------------
-- 3. THE TRANSFER
--    SECURITY DEFINER: it writes pay history and tech rates (admin-only
--    tables) on a district manager's behalf, and the old store's slot
--    and shifts. So it checks role and BOTH locations itself, and never
--    returns a rate. Runs as one transaction: all of it or none of it.
--
--    p_rates (admin/master only): new rates from the transfer date, any
--    of {"hourly", "salary", "flat", "guarantee"}. Omitted keys carry
--    over. For a technician, flat and guarantee go to the Tech Tracker's
--    rates (tech_pay_rates), which mirror into the history as usual.
-- ---------------------------------------------------------------------
create or replace function public.transfer_employee(
  p_employee_id      uuid,
  p_to_location_id   uuid,
  p_transfer_date    date,
  p_position         text,
  p_is_store_manager boolean default false,
  p_rates            jsonb   default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_role   text := public.current_user_role();
  v_admin  boolean := v_role in ('admin', 'master');
  v_old    public.employees%rowtype;
  v_to     public.locations%rowtype;
  v_new    uuid;
  v_open   uuid;
  v_key    text;
  v_amt    numeric;
  v_tech   record;
begin
  if v_role is null or v_role not in ('admin', 'master', 'district', 'regional') then
    raise exception 'Only an administrator or a district or regional manager can transfer an employee'
      using errcode = '42501';
  end if;

  select * into v_old from public.employees where id = p_employee_id for update;
  if not found or not public.can_access_location(v_old.location_id) then
    raise exception 'This employee could not be found, or is not in your scope' using errcode = '42501';
  end if;
  select * into v_to from public.locations where id = p_to_location_id;
  if not found or not public.can_access_location(p_to_location_id) then
    raise exception 'You can only transfer to a store you manage' using errcode = '42501';
  end if;

  if p_to_location_id = v_old.location_id then
    raise exception 'They already work at that store' using errcode = '22023';
  end if;
  if not v_old.active or v_old.termination_date is not null then
    raise exception 'Only an active employee can be transferred' using errcode = '22023';
  end if;
  if p_transfer_date is null then
    raise exception 'Enter the first day at the new store' using errcode = '22023';
  end if;
  -- Today or tomorrow at most (the database clock is UTC, so "tomorrow"
  -- also covers an evening transfer on the East Coast).
  if p_transfer_date > current_date + 1 then
    raise exception 'The transfer date can''t be in the future. Transfer them once they''ve moved.'
      using errcode = '22023';
  end if;
  -- The old row ends the day before; it can't end before it began.
  if p_transfer_date <= greatest(v_old.hire_date, v_old.transfer_date) then
    raise exception 'The first day at the new store must be after they started at this one (%)',
      to_char(greatest(v_old.hire_date, v_old.transfer_date), 'Mon DD, YYYY') using errcode = '22023';
  end if;

  if (p_is_store_manager or p_rates is not null) and not v_admin then
    raise exception 'Only an administrator can set the store-manager flag or pay rates' using errcode = '42501';
  end if;
  if p_rates is not null then
    if jsonb_typeof(p_rates) <> 'object' then
      raise exception 'p_rates must be an object' using errcode = '22023';
    end if;
    for v_key in select jsonb_object_keys(p_rates) loop
      if v_key not in ('hourly', 'salary', 'flat', 'guarantee') then
        raise exception 'Unknown rate %', v_key using errcode = '22023';
      end if;
      if jsonb_typeof(p_rates -> v_key) <> 'number' or (p_rates ->> v_key)::numeric < 0 then
        raise exception 'The % rate must be a number, zero or more', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  -- The store-manager slot, said plainly (the unique index would say it
  -- as a constraint name). Same predicate as employees_one_store_manager_per_location.
  if p_is_store_manager and p_position = 'manager' and exists (
    select 1 from public.employees
     where location_id = p_to_location_id and is_store_manager and position = 'manager'
  ) then
    raise exception '#% already has a store manager. Clear that flag on their profile first.', v_to.store_number
      using errcode = '23505';
  end if;

  -- 1. End the old row. First, so its ADP Position ID is free (unique
  --    among ACTIVE rows, migration 72) for the new one.
  update public.employees
     set termination_date = p_transfer_date - 1, active = false
   where id = v_old.id;

  -- 2. Start the new one. enforce_position_brand() refuses a position
  --    the new store's brand doesn't have.
  insert into public.employees (
    location_id, full_name, position, active, is_store_manager,
    hire_date, rehire_date, employee_number, adp_position_id,
    birth_month, birth_day, transferred_from_id, transfer_date
  ) values (
    p_to_location_id, v_old.full_name, p_position, true, coalesce(p_is_store_manager, false),
    v_old.hire_date, v_old.rehire_date, v_old.employee_number, v_old.adp_position_id,
    v_old.birth_month, v_old.birth_day, v_old.id, p_transfer_date
  ) returning id into v_new;

  -- 3. Pay carries over, dates and all. Tech Tracker rates first: their
  --    trigger mirrors each into the history as source 'tech_tracker'.
  --    Then everything else (manual, legacy) as it was.
  insert into public.tech_pay_rates (employee_id, effective_date, flat_rate, guarantee_rate)
  select v_new, t.effective_date, t.flat_rate, t.guarantee_rate
    from public.tech_pay_rates t
   where t.employee_id = v_old.id;

  insert into public.employee_pay_rate_history (employee_id, rate_type, effective_date, amount, source)
  select v_new, h.rate_type, h.effective_date, h.amount, h.source
    from public.employee_pay_rate_history h
   where h.employee_id = v_old.id and h.source <> 'tech_tracker'
  on conflict (employee_id, rate_type, effective_date) do nothing;

  -- 4. New rates, from the transfer date.
  if p_rates is not null then
    for v_key, v_amt in
      select k, (p_rates ->> k)::numeric
        from (values ('hourly', 'hourly'), ('salary', 'salary')) m(k, t)
       where p_rates ? k
    loop
      insert into public.employee_pay_rate_history (employee_id, rate_type, effective_date, amount, source)
      values (v_new, v_key, p_transfer_date, v_amt, 'manual')
      on conflict (employee_id, rate_type, effective_date)
      do update set amount = excluded.amount, source = 'manual', updated_at = now(), updated_by = auth.uid();
    end loop;

    if p_rates ? 'flat' or p_rates ? 'guarantee' then
      if p_position = 'tech' then
        -- The Tech Tracker holds both; fill whichever wasn't given from
        -- the rate in effect on the day.
        select t.flat_rate, t.guarantee_rate into v_tech
          from public.tech_pay_rates t
         where t.employee_id = v_new and t.effective_date <= p_transfer_date
         order by t.effective_date desc limit 1;
        insert into public.tech_pay_rates (employee_id, effective_date, flat_rate, guarantee_rate)
        values (v_new, p_transfer_date,
                coalesce((p_rates ->> 'flat')::numeric, v_tech.flat_rate, 0),
                coalesce((p_rates ->> 'guarantee')::numeric, v_tech.guarantee_rate, 0))
        on conflict (employee_id, effective_date)
        do update set flat_rate = excluded.flat_rate, guarantee_rate = excluded.guarantee_rate, updated_at = now();
      elsif p_rates ? 'guarantee' then
        raise exception 'A guarantee rate is for technicians only' using errcode = '22023';
      else
        insert into public.employee_pay_rate_history (employee_id, rate_type, effective_date, amount, source)
        values (v_new, 'flat', p_transfer_date, (p_rates ->> 'flat')::numeric, 'manual')
        on conflict (employee_id, rate_type, effective_date)
        do update set amount = excluded.amount, source = 'manual', updated_at = now(), updated_by = auth.uid();
      end if;
    end if;
  end if;

  -- 5. The old store's Tech Tracker slot. Vacated, NOT re-stamped: day
  --    rows already entered keep the person who worked them (migration 29).
  update public.tech_slots
     set employee_id = null
   where location_id = v_old.location_id and employee_id = v_old.id;

  -- 6. The old store's schedule from the transfer date. A working shift
  --    still needs covering, so it becomes an open shift; time off,
  --    sick, call out and the like are the person's own and go.
  select id into v_open from public.shift_types where name = 'Open / Unassigned';

  delete from public.employee_schedules s
   where s.employee_id = v_old.id
     and s.location_id = v_old.location_id
     and s.shift_date >= p_transfer_date
     and (v_open is null
          or exists (select 1 from public.shift_types st
                      where st.id = s.shift_type_id
                        and not (st.counts_toward_hours and st.is_copyable)));

  update public.employee_schedules
     set employee_id   = null,
         shift_type_id = v_open,
         updated_by    = auth.uid(),
         updated_at    = now()
   where employee_id = v_old.id
     and location_id = v_old.location_id
     and shift_date >= p_transfer_date;

  -- 7. A directory contact linked to them follows them.
  update public.directory_contacts set employee_id = v_new, updated_at = now()
   where employee_id = v_old.id;

  return v_new;
end
$fn$;

revoke all on function public.transfer_employee(uuid, uuid, date, text, boolean, jsonb) from public, anon;
grant execute on function public.transfer_employee(uuid, uuid, date, text, boolean, jsonb) to authenticated;

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY -- in the SQL Editor
--
--  [1] Two new columns:
--        select column_name, data_type from information_schema.columns
--         where table_name = 'employees'
--           and column_name in ('transferred_from_id', 'transfer_date');
--
--  [2] The function exists and the public can't run it:
--        select has_function_privilege('anon',
--          'public.transfer_employee(uuid, uuid, date, text, boolean, jsonb)', 'execute');   -- false
--
--  [3] After a transfer, the pair:
--        select e.full_name, l.store_number, e.active, e.termination_date,
--               e.transfer_date, e.transferred_from_id
--          from public.employees e join public.locations l on l.id = e.location_id
--         where e.id = '<new id>' or e.id = (select transferred_from_id from public.employees where id = '<new id>');
-- =====================================================================
