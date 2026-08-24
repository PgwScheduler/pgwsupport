-- =====================================================================
-- PGW Support Portal — Shift types + month duplication   (Task 7)
-- Run AFTER pgw_tech_slot_management_29.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Two additions to the existing employee_schedules calendar. NO parallel
-- schedule table — shift_type_id hangs off the table already in use.
--
-- shift_type_id is NULLABLE and null means an ordinary worked shift. The
-- existing month grid must render a null exactly as it does today; every
-- new behaviour keys off the catalog row, never off the column existing.
--
-- The catalog is COMPANY-WIDE, not per store. Thirty-six stores inventing
-- their own colours makes cross-store review unreadable for district and
-- regional users, so everyone reads and only admin/master writes.
--
-- COLOUR: color_token is a design-token key, never a raw hex. The screen
-- value lives in index.css / tailwind.config.js. export_argb is the
-- SEPARATE value the Excel export uses, because the two palettes cannot
-- be the same: screen tokens are tuned to clear WCAG AA on near-black
-- (#0B0B0C), and the workbooks are deliberately light with black text
-- ("The Excel export code is intentionally NOT themed from here" —
-- index.css). A colour legible on near-black is not legible on white, so
-- each token carries a pale fill for print. Storing it here rather than
-- in the export module keeps both resolutions of a token together and
-- lets an admin tune a fill after seeing it printed.
--
-- Neither the accent orange (#F26B21) nor the warning yellow (#E3B341)
-- is used, nor anything within 40 degrees of hue at usable saturation.
-- Every token clears AA on all three surfaces; the weakest is
-- shift-slate at 5.52:1. Colour is never the only signal — the
-- abbreviation renders alongside it and a legend sits above the grid.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE CATALOG
-- ---------------------------------------------------------------------
create table if not exists public.shift_types (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  abbreviation        text not null,
  color_token         text not null,
  export_argb         text not null default 'FFFFFFFF',
  counts_toward_hours boolean not null default true,
  is_copyable         boolean not null default true,
  sort_order          int not null default 0,
  active              boolean not null default true,
  unique (name),
  constraint shift_types_abbrev_len check (char_length(abbreviation) <= 4),
  constraint shift_types_argb_format check (export_argb ~ '^[0-9A-F]{8}$')
);

-- counts_toward_hours drives the weekly totals row on the calendar.
-- PTO is paid, so it counts. Unpaid time off does not. An open shift is
-- a staffing placeholder, not somebody's hours, so it must not inflate
-- the total. is_copyable governs month duplication: copying somebody's
-- vacation into next month is the worst failure this feature can have.
insert into public.shift_types
  (name, abbreviation, color_token, export_argb, counts_toward_hours, is_copyable, sort_order) values
  ('Regular Shift',    '',     'shift-neutral', 'FFF2F2F0', true,  true,  10),
  ('Paid Time Off',    'PTO',  'shift-blue',    'FFD6E8FF', true,  false, 20),
  ('Unpaid Time Off',  'UTO',  'shift-slate',   'FFE4E7EA', false, false, 30),
  ('Sick',             'SICK', 'shift-violet',  'FFEADCFF', true,  false, 40),
  ('Training',         'TRN',  'shift-teal',    'FFD2F2F4', true,  true,  50),
  ('Holiday',          'HOL',  'shift-green',   'FFD8F0DC', true,  false, 60),
  ('Open / Unassigned','OPEN', 'shift-magenta', 'FFFBDCEB', false, true,  70)
on conflict (name) do update set
  abbreviation        = excluded.abbreviation,
  color_token         = excluded.color_token,
  export_argb         = excluded.export_argb,
  counts_toward_hours = excluded.counts_toward_hours,
  is_copyable         = excluded.is_copyable,
  sort_order          = excluded.sort_order;

alter table public.employee_schedules
  add column if not exists shift_type_id uuid references public.shift_types (id);

create index if not exists employee_schedules_shift_type_idx
  on public.employee_schedules (shift_type_id) where shift_type_id is not null;


-- ---------------------------------------------------------------------
-- 2. RLS — everyone reads the catalog, admin/master writes it.
--    Store managers select from it; they do not extend it.
-- ---------------------------------------------------------------------
alter table public.shift_types enable row level security;

drop policy if exists "shift_types_select" on public.shift_types;
create policy "shift_types_select" on public.shift_types for select to authenticated
  using (true);

drop policy if exists "shift_types_write" on public.shift_types;
create policy "shift_types_write" on public.shift_types for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 3. THE COPY PLAN — one source of truth for preview AND commit.
--
--    ALIGNMENT: by weekday position, never by date. August 3rd is a
--    Monday and September 3rd is a Thursday; copying date-to-date
--    scatters every shift onto the wrong weekday. A shift's offset in
--    DAYS from the Monday that opens the source month's grid is carried
--    unchanged onto the Monday that opens the target month's grid. That
--    single offset already encodes (week index, weekday), so weeks stay
--    Monday-start and weekday position is preserved exactly.
--
--    Surplus weeks in a longer target month are simply never written to.
--    Shifts that would land past the end of a shorter target month are
--    dropped and counted as overflow.
--
--    Verdicts are mutually exclusive and evaluated in this order:
--      time_off  the shift type is not copyable
--      inactive  the employee is no longer active at this location
--      overflow  the target date falls outside the target month
--      existing  fill mode only, the employee already has a shift that day
--      create    everything else
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
      -- Monday opening each month's grid (Mon=0 .. Sun=6)
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
      when e.id is null or e.active = false               then 'inactive'
      when (b.tgt_monday + (s.shift_date - b.src_monday))::date
             not between b.tgt_first and b.tgt_last       then 'overflow'
      when p_mode = 'fill' and exists (
             select 1 from public.employee_schedules x
             where x.location_id = p_location_id
               and x.employee_id = s.employee_id
               and x.shift_date  = (b.tgt_monday + (s.shift_date - b.src_monday))::date
           )                                              then 'existing'
      else 'create'
    end as verdict
  from bounds b
  join public.employee_schedules s
    on s.location_id = p_location_id
   and s.shift_date between b.src_first and b.src_last
  left join public.employees e   on e.id  = s.employee_id
  left join public.shift_types st on st.id = s.shift_type_id;
$fn$;

revoke all on function public._schedule_copy_plan(uuid, date, date, text) from public;
grant execute on function public._schedule_copy_plan(uuid, date, date, text) to authenticated;


-- ---------------------------------------------------------------------
-- 4. PREVIEW / COMMIT
--    p_commit = false returns the summary and writes nothing. true does
--    the work. Both read the SAME plan function, so what the user
--    confirms cannot drift from what runs.
--
--    The whole copy is one transaction: a plpgsql function body either
--    completes or rolls back entirely, so a failure partway through
--    leaves the target month exactly as it was.
--
--    Replace mode clears the target month first and is restricted to
--    admin/master — it is the only action here that destroys existing
--    work in bulk. (Deleting shifts ONE AT A TIME remains open to anyone
--    with can_access_location, which is the pre-existing behaviour of
--    employee_schedules and is deliberately not changed here.)
-- ---------------------------------------------------------------------
create or replace function public.schedule_copy_month(
  p_location_id  uuid,
  p_source_month date,
  p_target_month date,
  p_mode         text default 'fill',
  p_commit       boolean default false
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_src   date := date_trunc('month', p_source_month)::date;
  v_tgt   date := date_trunc('month', p_target_month)::date;
  v_plan  jsonb;
  v_names text[];
  v_del   int := 0;
  v_ins   int := 0;
  v_would int := 0;
begin
  if p_mode not in ('fill','replace') then
    raise exception 'mode must be fill or replace' using errcode = '22023';
  end if;
  if not public.can_access_location(p_location_id) then
    raise exception 'not authorized for that location' using errcode = '42501';
  end if;
  if p_mode = 'replace' and public.current_user_role() not in ('admin','master') then
    raise exception 'Only an admin can replace a whole month of shifts' using errcode = '42501';
  end if;
  if v_src = v_tgt then
    raise exception 'source and target months are the same' using errcode = '22023';
  end if;

  select
    jsonb_build_object(
      'create',   count(*) filter (where verdict = 'create'),
      'time_off', count(*) filter (where verdict = 'time_off'),
      'inactive', count(*) filter (where verdict = 'inactive'),
      'overflow', count(*) filter (where verdict = 'overflow'),
      'existing', count(*) filter (where verdict = 'existing')),
    array_agg(distinct employee_name) filter (where verdict = 'inactive'),
    count(*) filter (where verdict = 'create')
  into v_plan, v_names, v_would
  from public._schedule_copy_plan(p_location_id, v_src, v_tgt, p_mode);

  -- how many rows replace mode would remove
  select count(*) into v_del
  from public.employee_schedules
  where location_id = p_location_id
    and shift_date between v_tgt and (v_tgt + interval '1 month - 1 day')::date;
  if p_mode <> 'replace' then v_del := 0; end if;

  if p_commit then
    if p_mode = 'replace' then
      delete from public.employee_schedules
       where location_id = p_location_id
         and shift_date between v_tgt and (v_tgt + interval '1 month - 1 day')::date;
      get diagnostics v_del = row_count;
    end if;

    insert into public.employee_schedules
      (location_id, employee_id, shift_date, start_time, end_time, notes, shift_type_id, created_by)
    select p_location_id, pl.employee_id, pl.target_date, pl.start_time, pl.end_time,
           pl.notes, pl.shift_type_id, auth.uid()
    from public._schedule_copy_plan(p_location_id, v_src, v_tgt, p_mode) pl
    where pl.verdict = 'create';
    get diagnostics v_ins = row_count;
  end if;

  return jsonb_build_object(
    'committed',      p_commit,
    'mode',           p_mode,
    'source_month',   to_char(v_src, 'YYYY-MM'),
    'target_month',   to_char(v_tgt, 'YYYY-MM'),
    'to_create',      v_would,
    'created',        v_ins,
    'to_delete',      v_del,
    'skipped',        v_plan,
    'inactive_names', coalesce(to_jsonb(v_names), '[]'::jsonb));
end
$fn$;

revoke all on function public.schedule_copy_month(uuid, date, date, text, boolean) from public;
grant execute on function public.schedule_copy_month(uuid, date, date, text, boolean) to authenticated;


-- =====================================================================
-- VERIFY
--   1) Catalog is seven rows, none using the reserved brand colours:
--        select name, abbreviation, color_token, counts_toward_hours, is_copyable
--          from public.shift_types order by sort_order;
--   2) Existing shifts are untouched and still type-less:
--        select count(*) filter (where shift_type_id is null) as untyped,
--               count(*) as total from public.employee_schedules;
--   3) Preview writes nothing (run twice, counts identical):
--        select public.schedule_copy_month(
--          (select id from public.locations where store_number='3303'),
--          '2026-08-01', '2026-09-01', 'fill', false);
--   4) Weekday alignment — a source Monday lands on a target Monday:
--        select target_date, to_char(target_date,'Dy') from public._schedule_copy_plan(
--          (select id from public.locations where store_number='3303'),
--          '2026-08-01','2026-09-01','fill') where verdict='create' limit 5;
--   5) A store user cannot write the catalog:
--        (as store) insert into public.shift_types
--          (name, abbreviation, color_token) values ('X','X','shift-blue');  -- 42501
--   6) A store user cannot replace a month:
--        (as store) select public.schedule_copy_month(<own loc>,
--          '2026-08-01','2026-09-01','replace', false);                      -- 42501
-- =====================================================================
