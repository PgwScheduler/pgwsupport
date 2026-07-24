-- =====================================================================
-- PGW Support Portal — Employee Schedule (monthly shift calendar)
-- Run AFTER pgw_speedee_brand_16.sql, in the Supabase SQL Editor.
-- Safe to re-run (drop-then-create throughout).
-- =====================================================================
-- A per-store shift calendar. INDEPENDENT of Employee Hours / payroll:
-- no FK to the timesheet tables, no pay data — it only references the
-- shared `employees` roster (for names). It must never join
-- employee_pay_rates or timesheet_pay.
--
-- Wall-clock times are stored timezone-naive (`date` + `time`, never
-- `timestamptz`). PGW operates across five states; a 7:00 AM open must
-- read as 7:00 AM for every viewer regardless of their timezone. Overnight
-- shifts are not supported — a check constraint rejects them rather than
-- handling the midnight wraparound.
--
-- Access mirrors the roster: anyone who can_access_location() the store may
-- VIEW and EDIT its schedule (store -> own, district -> district,
-- regional -> region, admin/master -> all). No role filtering in app code.
-- =====================================================================

create table if not exists public.employee_schedules (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations (id) on delete cascade,
  employee_id uuid not null references public.employees (id) on delete cascade,
  shift_date  date not null,
  start_time  time not null,
  end_time    time not null,
  notes       text,
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id),
  updated_at  timestamptz,
  -- Overnight shifts are out of scope: reject the wraparound at the db layer.
  constraint employee_schedules_end_after_start check (end_time > start_time),
  -- Guard against fat-fingered duplicate entry of the same shift.
  constraint employee_schedules_uniq unique (employee_id, shift_date, start_time)
);

-- Primary query pattern: a store's shifts for a visible month range.
create index if not exists employee_schedules_loc_date_idx
  on public.employee_schedules (location_id, shift_date);

alter table public.employee_schedules enable row level security;

-- Same house pattern as employees / timesheet_entries: every operation is
-- gated by can_access_location(location_id). District & regional managers get
-- view + edit within their scope (decision confirmed with the team).
drop policy if exists "employee_schedules_select" on public.employee_schedules;
create policy "employee_schedules_select" on public.employee_schedules for select to authenticated
  using (public.can_access_location(location_id));

drop policy if exists "employee_schedules_insert" on public.employee_schedules;
create policy "employee_schedules_insert" on public.employee_schedules for insert to authenticated
  with check (public.can_access_location(location_id));

drop policy if exists "employee_schedules_update" on public.employee_schedules;
create policy "employee_schedules_update" on public.employee_schedules for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));

drop policy if exists "employee_schedules_delete" on public.employee_schedules;
create policy "employee_schedules_delete" on public.employee_schedules for delete to authenticated
  using (public.can_access_location(location_id));


-- =====================================================================
-- VERIFY
--   1) As a STORE user, scoped to their own location:
--        select * from public.employee_schedules;       -- only their store
--   2) Cross-store INSERT must be rejected by RLS (0 rows / error):
--        insert into public.employee_schedules
--          (location_id, employee_id, shift_date, start_time, end_time)
--          values ('OTHER-STORE-ID','EMP-ID','2026-07-20','07:00','15:30');
--   3) Overnight guard must fail:
--        insert into public.employee_schedules
--          (location_id, employee_id, shift_date, start_time, end_time)
--          values ('YOUR-STORE-ID','EMP-ID','2026-07-20','23:00','02:00');
--   4) Pay data stays invisible — this table has no path to it:
--        select * from public.employee_pay_rates;        -- still 0 rows
-- =====================================================================
