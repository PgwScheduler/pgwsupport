-- =====================================================================
-- PGW Support Portal — the freeze check belongs AFTER the role check
--                                                    (corrects 39b)
-- Run AFTER pgw_horizon_roster_prep_39b.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Migration 39b put the slot-assignment freeze check at the very top of
-- assign_horizon_slot(), ahead of the role check, reasoning that a
-- frozen system should say "frozen" to everyone rather than tell an
-- admin he lacks permission.
--
-- THAT REASONING WAS WRONG, and store-role verification caught it. An
-- admin PASSES the role check, so moving the freeze below it still
-- gives admins the freeze message -- the position only ever changed what
-- NON-ADMINS see. Two things went wrong for them:
--
--   1. THE DENIAL CODE CHANGED. A store user calling assign_horizon_slot
--      got 42501 'Only an admin can assign a Horizon slot' from
--      migration 38 onward. Under 39b they get P0001 '...is frozen...'.
--      Migration 38's own verification asserts 42501 there, and anything
--      keying on the authorization failure now sees a transient
--      operational state instead. release_horizon_slot(),
--      reserve_horizon_slot() and horizon_upload_target() all still
--      return 42501, so 39b also made assign the odd one out.
--
--   2. IT LEAKED INTERNAL STATE. freeze_reason names the roster gap and
--      the count of unresolved slots. That is operational detail for an
--      admin, not something to hand a store manager who asked only
--      whether he could assign a technician.
--
-- The fix is two lines of ordering plus tightening the config table's
-- read policy. No behaviour changes for an admin or master.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. REORDER — role, then location, then freeze.
--
--    Authorization first: a caller who may not assign at all is told
--    that, and learns nothing about system state. Only a caller who
--    WOULD have been allowed to assign is told why he cannot right now.
--
--    Everything else is migration 39b's body, unchanged.
-- ---------------------------------------------------------------------
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
  -- Authorization first, so a non-admin's answer is unchanged from
  -- migration 38 and reveals nothing about the freeze.
  if public.current_user_role() not in ('admin','master') then
    raise exception 'Only an admin can assign a Horizon slot' using errcode = '42501';
  end if;
  if not public.can_access_location(p_location_id) then
    raise exception 'not authorized for that location' using errcode = '42501';
  end if;

  -- Only now: this caller could have assigned, so tell him why he cannot.
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


-- ---------------------------------------------------------------------
-- 2. horizon_config IS ADMIN/MASTER READ, NOT WORLD READ
--
--    39b gave it `using (true)` on the theory that a UI might want to
--    disable an assign button. Nothing does -- no frontend calls
--    assign_horizon_slot(), and assignment is admin-only anyway, so the
--    only readers who could act on the flag are the ones this policy
--    still admits. Meanwhile freeze_reason was readable by every signed-
--    in store user, which is the same leak as (2) above by a different
--    route; closing one without the other would have been theatre.
--
--    Matches horizon_upload_log's policy from migration 38.
-- ---------------------------------------------------------------------
drop policy if exists "horizon_config_select" on public.horizon_config;
create policy "horizon_config_select" on public.horizon_config
  for select to authenticated
  using (public.current_user_role() in ('admin','master'));


-- =====================================================================
-- VERIFY
--
--  1) As a STORE user (teststore), assignment is refused the way it was
--     before 39b, and says nothing about the freeze:
--       select public.assign_horizon_slot(
--         (select id from public.locations where store_number = '3303'),
--         (select id from public.employees limit 1));
--     Expect 42501 'Only an admin can assign a Horizon slot'.
--
--  2) As a STORE user, the config table is now invisible:
--       select * from public.horizon_config;      -- 0 rows
--
--  3) As MASTER, the freeze still bites and still explains itself:
--       select public.assign_horizon_slot(
--         (select id from public.locations where store_number = '3303'),
--         (select id from public.employees where full_name = 'Cash Cantrell'));
--     Expect P0001 naming the freeze and printing the lift statement.
--
--  4) As MASTER, the config is readable and still frozen:
--       select slot_assignment_frozen, freeze_reason from public.horizon_config;
--
--  5) Nothing else moved: release, reserve and upload_target still
--     return 42501 for a store user, and the 42 reservations are intact:
--       select count(*) from public.horizon_reserved_slots;   -- 42
-- =====================================================================
