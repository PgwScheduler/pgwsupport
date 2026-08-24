-- =====================================================================
-- PGW Support Portal — open shifts need no person
-- Run AFTER pgw_shift_types_30.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Migration 30 added an "Open / Unassigned" shift type to a table whose
-- employee_id was NOT NULL, so an open shift had to be parked against a
-- real person — which is precisely what it should not be. This drops
-- that requirement.
--
-- Making the column nullable is one line. Three things break with it,
-- and all three are fixed here rather than left to be discovered:
--
--   1. THE COPY PLAN WOULD SKIP EVERY OPEN SHIFT. Its verdict reads
--      `when e.id is null or e.active = false then 'inactive'`, and a
--      null employee_id makes the left join produce a null e.id. Open
--      shifts are is_copyable = true and are meant to duplicate, so the
--      inactive test now applies only when an employee is actually
--      named. Without this, every open shift would be reported as
--      "skipped — employee no longer active", with a null in the names.
--
--   2. FILL-EMPTY WOULD DUPLICATE THEM ON EVERY RUN. The collision test
--      is `x.employee_id = s.employee_id`, and NULL = NULL is never
--      true, so an open shift would never look like it already existed.
--      Re-running a fill copy is currently a no-op; that property would
--      have quietly died. Unassigned shifts now collide on
--      (date, start_time) instead of on the employee.
--
--   3. THE FAT-FINGER GUARD STOPS COVERING THEM. Postgres treats NULLs
--      as distinct in a unique index, so employee_schedules_uniq no
--      longer constrains unassigned rows. That is left as-is
--      DELIBERATELY: "we need three people Saturday morning" is a real
--      thing to express, and three identical open shifts is how you
--      express it. Duplication-on-copy is handled by (2) instead.
--
-- employee_id keeps ON DELETE CASCADE. Deleting an employee still
-- removes their shifts rather than turning them into open ones; that is
-- the existing behaviour and changing it is a separate decision.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE COLUMN
-- ---------------------------------------------------------------------
alter table public.employee_schedules
  alter column employee_id drop not null;

-- A row with neither a person nor a type is a blank block on the
-- calendar: no name to show and nothing to label it with. Require one or
-- the other, so an unassigned shift always says what it is.
alter table public.employee_schedules
  drop constraint if exists employee_schedules_person_or_type;
alter table public.employee_schedules
  add constraint employee_schedules_person_or_type
  check (employee_id is not null or shift_type_id is not null);


-- ---------------------------------------------------------------------
-- 2. THE COPY PLAN, corrected for unassigned shifts
--    Only the two verdict clauses noted above change; the weekday
--    alignment is untouched.
-- ---------------------------------------------------------------------
create or replace function public._schedule_copy_plan(
  p_location_id uuid,
  p_src_first   date,
  p_tgt_first   date,
  p_mode        text
)
returns table (
  employee_id   uuid,
  employee_name text,
  target_date   date,
  start_time    time,
  end_time      time,
  shift_type_id uuid,
  notes         text,
  verdict       text
)
language sql stable
set search_path = public, pg_temp
as $fn$
  with bounds as (
    select
      p_src_first as src_first,
      (p_src_first + interval '1 month - 1 day')::date as src_last,
      p_tgt_first as tgt_first,
      (p_tgt_first + interval '1 month - 1 day')::date as tgt_last,
      p_src_first - ((extract(dow from p_src_first)::int + 6) % 7) as src_monday,
      p_tgt_first - ((extract(dow from p_tgt_first)::int + 6) % 7) as tgt_monday
  )
  select
    s.employee_id,
    e.full_name,
    (b.tgt_monday + (s.shift_date - b.src_monday))::date as target_date,
    s.start_time,
    s.end_time,
    s.shift_type_id,
    s.notes,
    case
      when st.id is not null and st.is_copyable = false then 'time_off'
      -- only judge activity when somebody is actually named; an
      -- unassigned shift has no employee to have departed
      when s.employee_id is not null
           and (e.id is null or e.active = false)         then 'inactive'
      when (b.tgt_monday + (s.shift_date - b.src_monday))::date
             not between b.tgt_first and b.tgt_last       then 'overflow'
      -- an assigned shift collides on the PERSON's day; an unassigned one
      -- has no person, so it collides on the slot it would occupy
      when p_mode = 'fill' and s.employee_id is not null and exists (
             select 1 from public.employee_schedules x
             where x.location_id = p_location_id
               and x.employee_id = s.employee_id
               and x.shift_date  = (b.tgt_monday + (s.shift_date - b.src_monday))::date
           )                                              then 'existing'
      when p_mode = 'fill' and s.employee_id is null and exists (
             select 1 from public.employee_schedules x
             where x.location_id = p_location_id
               and x.employee_id is null
               and x.shift_date  = (b.tgt_monday + (s.shift_date - b.src_monday))::date
               and x.start_time  = s.start_time
           )                                              then 'existing'
      else 'create'
    end as verdict
  from bounds b
  join public.employee_schedules s
    on s.location_id = p_location_id
   and s.shift_date between b.src_first and b.src_last
  left join public.employees e    on e.id  = s.employee_id
  left join public.shift_types st on st.id = s.shift_type_id;
$fn$;

revoke all on function public._schedule_copy_plan(uuid, date, date, text) from public;
grant execute on function public._schedule_copy_plan(uuid, date, date, text) to authenticated;


-- =====================================================================
-- VERIFY
--   1) The column is nullable and the guard is in place:
--        select is_nullable from information_schema.columns
--          where table_name='employee_schedules' and column_name='employee_id';   -- YES
--        insert into public.employee_schedules (location_id, shift_date, start_time, end_time)
--          values (<loc>, '2026-08-05','09:00','17:00');   -- 23514, needs a type
--   2) An open shift saves with no person:
--        insert into public.employee_schedules
--          (location_id, shift_date, start_time, end_time, shift_type_id)
--          values (<loc>, '2026-08-05','09:00','17:00',
--                  (select id from public.shift_types where abbreviation='OPEN'));
--   3) It copies rather than being reported as a departed employee:
--        select verdict, count(*) from public._schedule_copy_plan(
--          <loc>, '2026-08-01','2026-09-01','fill') group by 1;
--        -- the open shift is 'create', NOT 'inactive'
--   4) Re-running a fill copy still creates nothing (idempotent):
--        select public.schedule_copy_month(<loc>,'2026-08-01','2026-09-01','fill',true);
--        select public.schedule_copy_month(<loc>,'2026-08-01','2026-09-01','fill',true);
--        -- second call returns created = 0
--   5) Several open shifts may share a slot (three people needed):
--        -- two inserts of the same date/time with employee_id null both succeed
-- =====================================================================
