-- =====================================================================
-- PGW Support Portal — roster prep: remove fictional employees, retire
-- two departures, and freeze slot assignment    (pre-roster, after 39a)
-- Run AFTER pgw_horizon_reservations_seed_39a.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Three data corrections and one guard, all of which must land BEFORE
-- the 185-technician roster is loaded into public.employees.
--
-- WHY THE ORDER MATTERS. Migration 39a resolved only 2 of 164 Horizon
-- occupants, because employees held 9 rows across 3 stores rather than
-- the roster. Once the roster loads, 39a's sections 3 and 4 get re-run
-- and those 162 slots resolve to real people. Everything below is a
-- thing that would be wrong to carry into that re-run.
--
-- 1. THREE FICTIONAL EMPLOYEES ARE DELETED. Tom Cruise, Dwayne Jonhson
--    and Albert Einstein sit at store 5254 from a July UI test. A slot
--    occupant is an upload payload field, so after the re-run nothing
--    structural stops a fictional name being written into Horizon TMG,
--    which is the franchisor's coaching system. Small mistake, large
--    audience. Only one of the three is position 'tech' and therefore
--    slot-eligible today, but position is editable and the other two are
--    equally fictional, so all three go.
--
-- 2. ALAN BARRON AND JOSEPH FABRE ARE MARKED INACTIVE, NOT DELETED.
--    Both are confirmed no longer with the company, which resolves the
--    disagreement 39a surfaced: the reconciliation workbook classed
--    Millwood slots 2 and 7 STALE ("not on active roster") while the
--    portal still had both active. THE WORKBOOK WAS RIGHT.
--    They are NOT deleted because they carry real history -- 3 and 8
--    tech_daily rows respectively on Millwood's July sheet, the only
--    genuine operational data in the portal. tech_daily.employee_id is
--    ON DELETE SET NULL, so deleting them would not fail; it would
--    silently un-attribute costed technician days and reintroduce the
--    "unattributed days" problem migration 29 exists to prevent.
--
--    THIS CHANGES NO SLOT STATE, BY DESIGN. Migration 38 deliberately
--    does not wire employees.active to slot occupancy, because
--    releasing is irreversible under the rehire rule. Their Horizon
--    slots 2 and 7 are already freed with no date, which is the correct
--    resting state for a departure whose date nobody has yet -- under
--    39's `nulls last` they sit at the very back of the reuse queue.
--    Their vacate dates belong in the workbook's Vacated tab and load
--    later through seed_horizon_slot(). A guessed date is worse than
--    none: it would move them UP the queue ahead of slots whose dates
--    are known.
--
--    Their tech_slots (the 9-row Excel grid) rows are also left alone.
--    That grid is freely reassignable by the store and is not a roster.
--
-- 3. SLOT ASSIGNMENT IS FROZEN. 162 slots that are occupied in Horizon
--    imported as freed-with-no-date, which is the safe direction but
--    leaves them ALLOCATABLE. Never-used slots 13-20 are handed out
--    first so the real exposure is small, but at a store where 13-20
--    are exhausted the next assignment takes a slot that is about to be
--    re-seeded as occupied -- and under the rehire rule that is not
--    cleanly unpickable. Cheap to prevent, annoying to unwind.
--
--    No frontend calls assign_horizon_slot() today, but it is granted
--    to `authenticated` and reachable directly through PostgREST by any
--    admin or master, so the guard belongs in the function.
--
-- ⚠ ALSO NOTE: re-running 39a sections 3-4 is a FULL RE-IMPORT from the
--    workbook. It overwrites live slot state for every non-reserved
--    slot. The freeze below closes the assignment path; it does not
--    close release_horizon_slot(), which stays available because a real
--    departure during the freeze should still be recordable. Any
--    release made between now and the roster load will be reverted by
--    that re-run -- note them and re-apply, or lift the freeze and
--    re-run 39a first.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. PREFLIGHT — say what is about to change, before changing it.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  raise notice '--- employees before ---';
  for r in
    select coalesce(l.store_number, l.name) as store, e.full_name, e.position, e.active
      from public.employees e
      join public.locations l on l.id = e.location_id
     order by 1, 2
  loop
    raise notice '  % / "%" / % / active=%', r.store, r.full_name, r.position, r.active;
  end loop;
end
$$;


-- ---------------------------------------------------------------------
-- 1. DELETE THE THREE FICTIONAL EMPLOYEES AT 5254
--
--    Matched on exact stored name AND store, never on name alone.
--    NOTE THE SPELLING: the row reads 'Dwayne Jonhson', not 'Johnson' --
--    the typo is in the data and matching the corrected spelling would
--    silently delete nothing.
--
--    EVERY DEPENDENT TABLE IS CHECKED FIRST and a row with any operational
--    history is SKIPPED WITH A WARNING rather than deleted. Three of the
--    eight references are ON DELETE SET NULL or CASCADE, so a careless
--    delete would destroy attribution instead of failing. All three rows
--    were verified clean before this migration was written; the guard is
--    here so that stays true if anything touched them in between.
-- ---------------------------------------------------------------------
do $$
declare
  v_names text[] := array['Tom Cruise', 'Dwayne Jonhson', 'Albert Einstein'];
  v_name  text;
  v_id    uuid;
  v_loc   uuid;
  v_deps  int;
  v_gone  int := 0;
begin
  select id into v_loc from public.locations where store_number = '5254';
  if v_loc is null then
    raise warning 'Store 5254 not found; nothing deleted.';
    return;
  end if;

  foreach v_name in array v_names loop
    select e.id into v_id
      from public.employees e
     where e.location_id = v_loc and e.full_name = v_name;

    if v_id is null then
      raise notice 'DELETE: "%" not present at 5254 (already removed).', v_name;
      continue;
    end if;

    select
      (select count(*) from public.tech_daily            where employee_id = v_id)
    + (select count(*) from public.tech_slots            where employee_id = v_id)
    + (select count(*) from public.payroll_daily         where employee_id = v_id)
    + (select count(*) from public.timesheet_entries     where employee_id = v_id)
    + (select count(*) from public.employee_schedules    where employee_id = v_id)
    + (select count(*) from public.employee_pay_rates    where employee_id = v_id)
    + (select count(*) from public.tech_pay_rates        where employee_id = v_id)
    + (select count(*) from public.location_horizon_slots where current_technician_id = v_id)
    + (select count(*) from public.horizon_slot_import   where resolved_employee_id = v_id)
      into v_deps;

    if v_deps > 0 then
      raise warning
        'DELETE SKIPPED: "%" at 5254 has % dependent row(s). It is no longer a clean test row -- inspect before removing.',
        v_name, v_deps;
      continue;
    end if;

    delete from public.employees where id = v_id;
    v_gone := v_gone + 1;
    raise notice 'DELETED: "%" at 5254 (no dependent rows).', v_name;
  end loop;

  raise notice 'DELETE: % fictional employee row(s) removed.', v_gone;
end
$$;


-- ---------------------------------------------------------------------
-- 2. RETIRE ALAN BARRON AND JOSEPH FABRE AT MILLWOOD (#3303)
--
--    active = false only. No delete, no slot change, no vacate date.
--    See the header for why each of those three is deliberate.
-- ---------------------------------------------------------------------
do $$
declare
  v_loc uuid;
  v_n   int;
begin
  select id into v_loc from public.locations where store_number = '3303';
  if v_loc is null then
    raise warning 'Store 3303 not found; no one retired.';
    return;
  end if;

  update public.employees
     set active = false
   where location_id = v_loc
     and full_name in ('Alan Barron', 'Joseph Fabre')
     and active;
  get diagnostics v_n = row_count;

  raise notice 'RETIRED: % employee row(s) set inactive at 3303.', v_n;

  -- Prove the migration-38 rule held: an active flip must not have
  -- moved a slot. Both should already be freed-with-no-date from 39a.
  if exists (
    select 1
      from public.location_horizon_slots s
      join public.employees e on e.id = s.current_technician_id
     where s.location_id = v_loc
       and e.full_name in ('Alan Barron', 'Joseph Fabre')
  ) then
    raise warning
      'One of the retired technicians still HOLDS a Horizon slot at 3303. That is not an error -- a departed technician holding a slot is the safe state -- but it will show in horizon_slots_held_by_inactive until released deliberately.';
  else
    raise notice 'Neither retired technician holds a Horizon slot; slots 2 and 7 remain freed with no date, at the back of the queue.';
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 3. FREEZE SLOT ASSIGNMENT
--
--    Single-row config table, following migration 32's payroll_config
--    precedent (a CHECK cannot reference a table, so the switch lives in
--    a row and the rule that reads it lives in the function).
--
--    DEFAULTS TO FROZEN, because it is frozen right now by definition --
--    the roster is not in. Lifting it is one UPDATE, printed at the
--    bottom of this file.
-- ---------------------------------------------------------------------
create table if not exists public.horizon_config (
  id                     boolean primary key default true check (id),
  slot_assignment_frozen boolean not null default true,
  freeze_reason          text,
  updated_at             timestamptz not null default now()
);

-- Re-run safety: bring an older horizon_config up to the current shape.
alter table public.horizon_config
  add column if not exists slot_assignment_frozen boolean not null default true;
alter table public.horizon_config
  add column if not exists freeze_reason text;

insert into public.horizon_config (id, slot_assignment_frozen, freeze_reason)
values (true, true,
        'The 185-technician roster is not yet loaded. 162 Horizon slots that are occupied in Horizon imported as freed-with-no-date and are therefore allocatable; assigning one now takes a slot that is about to be re-seeded as occupied.')
on conflict (id) do nothing;

alter table public.horizon_config enable row level security;

drop policy if exists "horizon_config_select" on public.horizon_config;
create policy "horizon_config_select" on public.horizon_config
  for select to authenticated using (true);

drop policy if exists "horizon_config_master_write" on public.horizon_config;
create policy "horizon_config_master_write" on public.horizon_config
  for all to authenticated
  using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');

comment on table public.horizon_config is
  'Single-row switch for Horizon slot behaviour. slot_assignment_frozen blocks assign_horizon_slot() while the roster load is outstanding; seeding and release stay open.';

-- 3.1 The guard, first thing in the function -- ahead of the role check,
--     so a frozen system says "frozen" to everyone rather than telling
--     an admin he lacks permission. Everything after it is migration
--     39's body, unchanged.
create or replace function public.assign_horizon_slot(
  p_location_id   uuid,
  p_technician_id uuid
) returns smallint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_slot   smallint;
  v_occ    int;
  v_res    int;
  v_frozen boolean;
  v_why    text;
begin
  select c.slot_assignment_frozen, c.freeze_reason
    into v_frozen, v_why
    from public.horizon_config c
   where c.id;

  if coalesce(v_frozen, false) then
    raise exception
      'Horizon slot assignment is frozen. %  Lift it with: update public.horizon_config set slot_assignment_frozen = false, updated_at = now() where id;',
      coalesce(v_why, '')
      using errcode = 'P0001';
  end if;

  if public.current_user_role() not in ('admin','master') then
    raise exception 'Only an admin can assign a Horizon slot' using errcode = '42501';
  end if;
  if not public.can_access_location(p_location_id) then
    raise exception 'not authorized for that location' using errcode = '42501';
  end if;
  if p_technician_id is null then
    raise exception 'a technician is required' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.location_horizon_slots
     where location_id = p_location_id
       and current_technician_id = p_technician_id
  ) then
    raise exception 'That technician already holds a Horizon slot at this store'
      using errcode = '23505';
  end if;

  select public.next_horizon_slot(p_location_id) into v_slot;

  if v_slot is null then
    select count(*) filter (where current_technician_id is not null),
           count(*) filter (where is_reserved)
      into v_occ, v_res
      from public.location_horizon_slots
     where location_id = p_location_id;

    raise exception
      'All 20 Horizon slots at location % are unavailable (% occupied, % reserved). Release a technician or clear a reservation before assigning.',
      p_location_id, v_occ, v_res
      using errcode = 'P0001';
  end if;

  update public.location_horizon_slots
     set current_technician_id = p_technician_id,
         ever_used             = true,
         last_released_at      = null
   where location_id = p_location_id and slot_number = v_slot;

  return v_slot;
end
$fn$;


-- =====================================================================
-- VERIFY
--
--  1) The fictional rows are gone and the real ones are not:
--       select l.store_number, e.full_name, e.position, e.active
--         from public.employees e
--         join public.locations l on l.id = e.location_id
--        order by 1, 2;
--     Expect 6 rows: none at 5254; Millwood's five with Alan Barron and
--     Joseph Fabre now active = false; and the one blank-named inactive
--     row at 2321 (pre-existing, untouched here, worth cleaning up
--     separately).
--
--  2) Millwood's July data still attributes:
--       select count(*) from public.tech_daily td
--         join public.employees e on e.id = td.employee_id
--        where e.full_name in ('Alan Barron','Joseph Fabre');
--     Expect 11 (3 + 8). Deleting instead of retiring would have made
--     this 0 with no error.
--
--  3) The active flip moved no slot:
--       select s.slot_number, s.current_technician_id, s.ever_used, s.last_released_at
--         from public.location_horizon_slots s
--         join public.locations l on l.id = s.location_id
--        where l.store_number = '3303' and s.slot_number in (2, 7);
--     Both still occupant null, ever_used true, last_released_at null.
--
--  4) The freeze bites:
--       select public.assign_horizon_slot(
--         (select id from public.locations where store_number = '3303'),
--         (select id from public.employees  where full_name  = 'Cash Cantrell'));
--     Expect P0001 naming the freeze and printing the lift statement.
--
--  5) Seeding and release are NOT frozen -- both must still work, since
--     the roster load runs through seed_horizon_slot():
--       select public.seed_horizon_slot(
--         (select id from public.locations where store_number = '3303'),
--         9::smallint, null, null);           -- no-op reseed of an empty slot
--
--  6) Reservations are untouched by the freeze:
--       select count(*) from public.horizon_reserved_slots;   -- 42
--
--
-- WHEN THE ROSTER IS IN, in this order:
--
--   a) Load the 185 technicians into public.employees.
--   b) Re-run pgw_horizon_reservations_seed_39a.sql sections 3 and 4
--      (resolve + apply). It is a FULL re-import from the workbook and
--      will revert any slot change made during the freeze.
--   c) Check what is still unresolved:
--        select store_number, slot_number, horizon_value, roster_match, resolution
--          from public.horizon_slot_import
--         where class = 'OCCUPIED' and resolution <> 'occupied'
--         order by store_number, slot_number;
--      The 44 spelling confirmations will still be here by design.
--   d) Only then lift the freeze:
--        update public.horizon_config
--           set slot_assignment_frozen = false, updated_at = now()
--         where id;
-- =====================================================================
