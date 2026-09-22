-- =====================================================================
-- 64 -- Tech Tracker: up to 20 tech slots per store (was 9)
--
-- Why: the Columbia tic-sheet imports (2026-09-21). Two Notch ran ~15 techs
-- at once in January 2026, Lake Murray 11, Decker and Gervais ~10; the
-- 9-slot check (migration 24) can't hold them. 20 matches Horizon's own
-- slot count (location_horizon_slots, migration 38).
--
-- Only the range check changes. Nothing else keys on slot_index:
-- migration 29's RPCs, _tech_days, payroll and the Horizon upload all join
-- slots by id (the Horizon upload never reads slot_index -- see the warning
-- in migration 38 against joining the two slot tables). The Tech Tracker
-- picker shows 9 slots and grows to one past the highest one in use.
--
-- Run in the Supabase SQL Editor. Repeatable.
-- =====================================================================
-- Drop the old range check whatever it is called (migration 24 left it unnamed).
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.tech_slots'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%slot_index%'
  loop
    execute format('alter table public.tech_slots drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.tech_slots add constraint tech_slots_slot_index_check
  check (slot_index between 1 and 20);

-- =====================================================================
-- CHECK -- should return one row: check ((slot_index >= 1) AND (slot_index <= 20))
-- =====================================================================
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.tech_slots'::regclass and contype = 'c';
