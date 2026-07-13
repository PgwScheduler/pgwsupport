-- =====================================================================
-- PGW Support Portal — Rewrite employee_hours: daily -> weekly
-- Run AFTER pgw_add_drawer_float_06.sql.
-- =====================================================================
-- WHAT THIS DOES: the old employee_hours table had one row per employee
-- per DAY. The app now works in weekly Mon-Sat grids, so this drops that
-- table and rebuilds it with one row per employee per WEEK, with a
-- column for each day (mon..sat) plus "Hours Turned" (a PGW productivity
-- metric tracked alongside — but separate from — hours worked).
--
-- Table is empty (no real data yet), so this is a clean drop + recreate,
-- not a data migration.
--
-- A check constraint enforces that week_start is always a Monday, since
-- that's a hard rule from the brief, not just a UI convention.
--
-- RLS CHANGE: store managers can now UPDATE and DELETE rows for their
-- own store (previously delete was master-only). Typos in an hours grid
-- are routine and a manager needs to be able to fix or remove a bad row
-- without waiting on a master. Access is still scoped by
-- can_access_location(), so a store role can only touch its own store's
-- rows — district/regional/admin/master follow the same hierarchy rules
-- as everywhere else.
-- =====================================================================

drop table if exists public.employee_hours cascade;

create table public.employee_hours (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations (id) on delete cascade,
  week_start    date not null,              -- always a Monday
  employee_name text not null,
  mon           numeric(6,2) not null default 0,
  tue           numeric(6,2) not null default 0,
  wed           numeric(6,2) not null default 0,
  thu           numeric(6,2) not null default 0,
  fri           numeric(6,2) not null default 0,
  sat           numeric(6,2) not null default 0,
  hours_turned  numeric(6,2),
  submitted_by  uuid references auth.users (id),
  created_at    timestamptz not null default now(),
  constraint employee_hours_week_start_is_monday check (extract(dow from week_start) = 1)
);

alter table public.employee_hours enable row level security;

drop policy if exists "employee_hours_select" on public.employee_hours;
create policy "employee_hours_select" on public.employee_hours for select to authenticated
  using (public.can_access_location(location_id));

drop policy if exists "employee_hours_insert" on public.employee_hours;
create policy "employee_hours_insert" on public.employee_hours for insert to authenticated
  with check (public.can_access_location(location_id));

drop policy if exists "employee_hours_update" on public.employee_hours;
create policy "employee_hours_update" on public.employee_hours for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));

drop policy if exists "employee_hours_delete" on public.employee_hours;
create policy "employee_hours_delete" on public.employee_hours for delete to authenticated
  using (public.can_access_location(location_id));

-- Verify:
--   select column_name, data_type from information_schema.columns
--     where table_name = 'employee_hours' order by ordinal_position;
