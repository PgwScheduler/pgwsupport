-- =====================================================================
-- PGW Support Portal — Tech Tracker slot management
-- Run AFTER pgw_bonus_wesmark_fix_28.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Admins get to assign an employee to a slot, clear a slot, or give a
-- placeholder slot a label. Doing that safely needs one thing the schema
-- did not have: a record of WHO ACTUALLY WORKED a given day.
--
-- THE PROBLEM
-- tech_daily references only tech_slot_id. _tech_days then resolves the
-- pay rate by joining tech_slots.employee_id — the slot's CURRENT
-- occupant. So reassigning a slot did not merely relabel past days, it
-- RE-COSTED them at the incoming technician's rates, and that flows
-- labor cost -> gross profit -> the goals strip -> the bonus tracker.
-- Reassigning a slot in August would have silently changed July's bonus
-- payout. Millwood's verified $15,640.19 July labor cost would move.
--
-- THE FIX
-- Stamp the worker onto the day row. tech_daily.employee_id is written
-- at insert from whoever holds the slot at that moment and is never
-- rewritten by a reassignment. _tech_days resolves rates from the DAY
-- row, so history is self-describing rather than reconstructed from
-- today's slot occupancy.
--
-- Considered and rejected: a slot-assignment history table with
-- effective date ranges. It models the same fact indirectly and makes
-- every read temporal — a daterange, an exclusion constraint, and a
-- resolver joined into _tech_days, tech_store_month and
-- tech_store_daily. The day row is where the fact belongs.
--
-- A NULL employee_id means a placeholder or empty slot. That already
-- resolves to zero pay (no rates -> no cost), so nothing changes there.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. WHO WORKED THE DAY
-- ---------------------------------------------------------------------
alter table public.tech_daily
  add column if not exists employee_id uuid references public.employees (id) on delete set null;

create index if not exists tech_daily_employee_idx on public.tech_daily (employee_id);

-- Backfill from current slot occupancy. This is correct ONLY because no
-- slot has ever been reassigned: until this migration there was no way
-- to change an occupied slot, so occupancy has only ever been set by the
-- seed. Guarded to rows that are still unstamped so a re-run is a no-op.
update public.tech_daily td
   set employee_id = ts.employee_id
  from public.tech_slots ts
 where ts.id = td.tech_slot_id
   and td.employee_id is null
   and ts.employee_id is not null;


-- ---------------------------------------------------------------------
-- 2. STAMP ON INSERT
--    Belt and braces: the client does not have to remember. Fires only
--    when employee_id arrives null, so an explicit value (the effective
--    date re-stamp in section 5) is respected. UPDATE is deliberately
--    NOT touched — that is what keeps history stable.
-- ---------------------------------------------------------------------
create or replace function public.tech_daily_stamp_employee()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.employee_id is null then
    select ts.employee_id into new.employee_id
      from public.tech_slots ts
     where ts.id = new.tech_slot_id;
  end if;
  return new;
end
$fn$;

drop trigger if exists tech_daily_stamp_employee on public.tech_daily;
create trigger tech_daily_stamp_employee
  before insert on public.tech_daily
  for each row execute function public.tech_daily_stamp_employee();


-- ---------------------------------------------------------------------
-- 3. PAY RESOLVES FROM THE DAY, NOT THE SLOT
--    The single line that decouples historical pay from today's roster:
--    `pr.employee_id = td.employee_id` (was ts.employee_id).
-- ---------------------------------------------------------------------
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
  left join lateral (
    select pr.flat_rate, pr.guarantee_rate
    from public.tech_pay_rates pr
    where pr.employee_id = td.employee_id      -- the person who worked it
      and pr.effective_date <= td.work_date
    order by pr.effective_date desc
    limit 1
  ) r on true
  where td.location_id = loc
    and td.work_date >= d_from
    and td.work_date <  d_to;
$$;
revoke all on function public._tech_days(uuid, date, date) from public;


-- ---------------------------------------------------------------------
-- 4. ONE SLOT PER EMPLOYEE PER LOCATION
--    Enforced at the database, not just in the dropdown. Placeholder and
--    empty slots (employee_id null) are exempt — there can be many.
-- ---------------------------------------------------------------------
create unique index if not exists tech_slots_one_slot_per_employee
  on public.tech_slots (location_id, employee_id)
  where employee_id is not null;


-- ---------------------------------------------------------------------
-- 5. REASSIGNMENT, ATOMIC AND DATE-BOUNDED
--    Moves the slot and re-stamps day rows on/after p_effective_date in
--    one transaction. Rows BEFORE that date are never touched, which is
--    the whole point: past days keep the person who actually worked them.
--    Returns the number of rows re-stamped so the UI can preview it.
--
--    SECURITY DEFINER because it writes tech_daily rows the caller may
--    not otherwise update, so it re-checks BOTH the role and location
--    access itself rather than relying on the table policies.
-- ---------------------------------------------------------------------
create or replace function public.tech_reassign_slot(
  p_slot_id          uuid,
  p_employee_id      uuid,
  p_label            text,
  p_is_manager_or_sa boolean,
  p_effective_date   date
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_loc     uuid;
  v_stamped int;
begin
  if public.current_user_role() not in ('admin','master') then
    raise exception 'Only an admin can change slot assignments' using errcode = '42501';
  end if;

  select location_id into v_loc from public.tech_slots where id = p_slot_id;
  if v_loc is null then
    raise exception 'slot % not found', p_slot_id using errcode = '42704';
  end if;
  if not public.can_access_location(v_loc) then
    raise exception 'not authorized for that location' using errcode = '42501';
  end if;

  -- An employee holds at most one slot per location. The unique index
  -- catches this too; checking here gives a readable message instead of
  -- a constraint-violation string.
  if p_employee_id is not null and exists (
    select 1 from public.tech_slots
     where location_id = v_loc and employee_id = p_employee_id and id <> p_slot_id
  ) then
    raise exception 'That technician already holds another slot at this store'
      using errcode = '23505';
  end if;

  update public.tech_daily
     set employee_id = p_employee_id,
         updated_at  = now()
   where tech_slot_id = p_slot_id
     and work_date   >= p_effective_date;
  get diagnostics v_stamped = row_count;

  update public.tech_slots
     set employee_id      = p_employee_id,
         label            = case when p_employee_id is null then p_label else null end,
         is_manager_or_sa = coalesce(p_is_manager_or_sa, is_manager_or_sa)
   where id = p_slot_id;

  return v_stamped;
end
$fn$;

revoke all on function public.tech_reassign_slot(uuid, uuid, text, boolean, date) from public;
grant execute on function public.tech_reassign_slot(uuid, uuid, text, boolean, date) to authenticated;


-- ---------------------------------------------------------------------
-- 6. SLOT WRITES ARE ADMIN/MASTER
--    tech_slots insert/update were open to can_access_location, so a
--    store user could rewrite slots straight through the API even though
--    the UI hid the controls. Slot assignment decides whose pay rates
--    apply, so it belongs with the other admin-only settings. SELECT is
--    unchanged — a store still sees its own roster.
-- ---------------------------------------------------------------------
drop policy if exists "tech_slots_insert" on public.tech_slots;
create policy "tech_slots_insert" on public.tech_slots for insert to authenticated
  with check (public.current_user_role() in ('admin','master')
              and public.can_access_location(location_id));

drop policy if exists "tech_slots_update" on public.tech_slots;
create policy "tech_slots_update" on public.tech_slots for update to authenticated
  using (public.current_user_role() in ('admin','master')
         and public.can_access_location(location_id))
  with check (public.current_user_role() in ('admin','master')
              and public.can_access_location(location_id));


-- =====================================================================
-- VERIFY
--   1) Every historical row now names its worker (placeholders aside):
--        select count(*) filter (where employee_id is null) as unstamped,
--               count(*) as total
--          from public.tech_daily;
--   2) Millwood July labor cost is UNCHANGED by the backfill — this is
--      the check that the rate join still resolves the same people:
--        select labor_cost from public.tech_store_month(
--          (select id from public.locations where store_number='3303'),
--          '2026-07-01');                          -- 15640.19
--   3) An employee cannot hold two slots at one store:
--        update public.tech_slots set employee_id =
--          (select employee_id from public.tech_slots
--            where location_id = <loc> and slot_index = 1)
--          where location_id = <loc> and slot_index = 6;   -- 23505
--   4) A store user can no longer write slots:
--        (as store) update public.tech_slots set label = 'x'
--          where location_id = <own>;                      -- 0 rows
--   5) Reassignment leaves earlier days alone:
--        select public.tech_reassign_slot(<slot>, <new emp>, null, null, '2026-07-20');
--        -- returns the count re-stamped; rows before 2026-07-20 keep
--        -- their original employee_id.
-- =====================================================================
