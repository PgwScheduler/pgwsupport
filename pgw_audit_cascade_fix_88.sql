-- =====================================================================
-- Migration 88 — Change Log: a CASCADE delete no longer fails
-- Run AFTER pgw_rpc_lockdown_87.sql, in the SQL Editor.
-- Safe to re-run (create or replace; no data touched).
-- =====================================================================
-- Why: found 2026-10-12 while deleting test rows. audit_row_change()
-- (migration 81) looks up a row's PARENT to say where it belongs --
-- daily_service_units -> daily_kpi for the date and store, and the same
-- for timesheet_entries, service_categories, tech_slots and employees.
-- It did so with SELECT ... INTO. When the parent row is not found,
-- SELECT INTO sets EVERY target to NULL. In a CASCADE delete the parent
-- is always gone by the time the child's AFTER trigger runs, so:
--
--   * daily_service_units: row_ref became NULL and the audit insert
--     failed (23502, row_ref not null) -- which rolled back the whole
--     delete. Deleting ANY tic sheet day that has service units was
--     impossible: the app's delete, a location delete, a manual cleanup.
--   * timesheet_entry_id children: same NULL row_ref, same failure.
--   * tech_slots lookup: did not crash, but quietly wiped the store.
--     Deleting a tech slot cascades its tech_daily rows; a day with no
--     technician on it goes through the slot lookup, the slot is already
--     gone, and the log row was written with location_id NULL -- so a
--     district manager could no longer see it. (Reproduced locally.)
--   * employees lookup: the same pattern. No audited table both carries
--     a store and cascades from employees today, so it has not bitten,
--     but it is fixed the same way rather than left waiting.
--
-- THE FIX: every parent lookup is now a scalar subquery wrapped in
-- coalesce, so a missing parent ADDS nothing and REMOVES nothing.
-- Nothing else in the function changes; the triggers already point at
-- it by name, so no re-attach is needed.
--
-- Note for a cascaded units line: its store came only from the parent,
-- so that one log row has no location_id (admin/master see it in the
-- Change Log; district/regional do not). The parent daily_kpi delete
-- itself is logged with its store as normal.
-- =====================================================================

create or replace function public.audit_row_change()
returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare
  -- Bookkeeping, not data: the log's own actor/at replace these.
  c_skip constant text[] := array[
    'updated_at', 'updated_by', 'created_at', 'entered_at', 'entered_by',
    'submitted_at', 'submitted_by',
    'adjustments_updated_at', 'adjustments_updated_by',
    'adjustments_note_updated_at', 'adjustments_note_updated_by'];
  -- Columns that say WHICH row, not WHAT it holds.
  c_ref constant text[] := array[
    'id', 'location_id', 'employee_id', 'business_date', 'work_date',
    'week_start', 'plan_year', 'month', 'effective_date', 'rate_type',
    'tech_slot_id', 'timesheet_entry_id', 'daily_kpi_id',
    'service_category_id', 'slot_index', 'kind', 'tier_index'];
  v_full   jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_old    jsonb;
  v_new    jsonb;
  v_ref    jsonb := '{}'::jsonb;
  v_loc    uuid;
  v_emp    uuid;
  v_subj   text;
  v_area   text;
  v_uid    uuid := auth.uid();
  v_aname  text;
  v_arole  text;
  v_source text;
  k        text;
  i        int;
begin
  -- What changed
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(o.key, o.value), jsonb_object_agg(o.key, to_jsonb(new) -> o.key)
      into v_old, v_new
      from jsonb_each(to_jsonb(old) - c_skip) o
     where o.value is distinct from (to_jsonb(new) -> o.key);
    if v_old is null then
      return null;                        -- nothing real changed
    end if;
  elsif tg_op = 'INSERT' then
    v_new := jsonb_strip_nulls(to_jsonb(new) - c_skip);
    -- A placeholder row (all values empty / zero / false) is not news.
    if not exists (
      select 1 from jsonb_each(v_new - c_ref) e
       where e.value not in ('0'::jsonb, 'false'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)
    ) then
      return null;
    end if;
  else
    v_old := jsonb_strip_nulls(to_jsonb(old) - c_skip);
  end if;

  -- Which row: the primary key, plus any identifying columns it carries
  for i in 1 .. tg_nargs - 1 loop
    v_ref := v_ref || jsonb_build_object(tg_argv[i], v_full -> tg_argv[i]);
  end loop;
  foreach k in array c_ref loop
    if v_full ? k and k not in ('location_id', 'employee_id') then
      v_ref := v_ref || jsonb_build_object(k, v_full -> k);
    end if;
  end loop;

  -- Which store and employee
  if tg_table_name = 'profiles' then
    v_loc := null;                        -- logins: admin/master only
    v_subj := coalesce(nullif(v_full ->> 'full_name', ''), v_full ->> 'email');
  else
    v_loc := (v_full ->> 'location_id')::uuid;
    v_emp := case when tg_table_name = 'employees' then (v_full ->> 'id')::uuid
                  else (v_full ->> 'employee_id')::uuid end;

    -- Parent lookups. Each one only ADDS what it finds: a scalar
    -- subquery returns NULL on no row and coalesce keeps what we had.
    -- (Migration 81 used SELECT ... INTO, which assigns NULL to every
    -- target when the parent is gone -- as it always is in a CASCADE --
    -- so v_ref became NULL and the insert below failed 23502.)
    if v_full ? 'timesheet_entry_id' then
      v_loc := coalesce(v_loc, (select t.location_id from public.timesheet_entries t
                                 where t.id = (v_full ->> 'timesheet_entry_id')::uuid));
      v_emp := coalesce(v_emp, (select t.employee_id from public.timesheet_entries t
                                 where t.id = (v_full ->> 'timesheet_entry_id')::uuid));
      v_ref := v_ref || coalesce((select jsonb_build_object('week_start', t.week_start)
                                    from public.timesheet_entries t
                                   where t.id = (v_full ->> 'timesheet_entry_id')::uuid), '{}'::jsonb);
    end if;
    if v_full ? 'daily_kpi_id' then
      v_loc := coalesce(v_loc, (select d.location_id from public.daily_kpi d
                                 where d.id = (v_full ->> 'daily_kpi_id')::bigint));
      v_ref := v_ref || coalesce((select jsonb_build_object('business_date', d.business_date)
                                    from public.daily_kpi d
                                   where d.id = (v_full ->> 'daily_kpi_id')::bigint), '{}'::jsonb);
    end if;
    if v_full ? 'service_category_id' then
      v_ref := v_ref || coalesce((select jsonb_build_object('category', c.display_name)
                                    from public.service_categories c
                                   where c.id = (v_full ->> 'service_category_id')::bigint), '{}'::jsonb);
    end if;
    if v_full ? 'tech_slot_id' and (v_loc is null or v_emp is null) then
      v_loc := coalesce(v_loc, (select s.location_id from public.tech_slots s
                                 where s.id = (v_full ->> 'tech_slot_id')::uuid));
      v_emp := coalesce(v_emp, (select s.employee_id from public.tech_slots s
                                 where s.id = (v_full ->> 'tech_slot_id')::uuid));
    end if;
    if v_emp is not null then
      v_loc := coalesce(v_loc, (select e.location_id from public.employees e where e.id = v_emp));
      v_subj := (select e.full_name from public.employees e where e.id = v_emp);
      if tg_table_name = 'employees' then
        v_subj := v_full ->> 'full_name';   -- the name on this very row, even mid-delete
      end if;
    end if;
  end if;

  -- Which area of the app
  v_area := case
    when tg_table_name = 'daily_kpi' and tg_op = 'UPDATE'
     and v_old ?| array['sales_adjustments', 'adjustments_note']       then 'adjustments'
    when tg_table_name in ('daily_kpi', 'daily_service_units')        then 'tic'
    when tg_table_name in ('employee_pay_rate_history', 'tech_pay_rates') then 'pay_rates'
    when tg_table_name like 'bonus\_%' or tg_table_name = 'market_bonus_brackets' then 'bonus'
    when tg_table_name = 'employees'                                  then 'people'
    when tg_table_name = 'profiles'                                   then 'access'
    else 'payroll'
  end;

  -- Who
  if v_uid is not null then
    select coalesce(nullif(p.full_name, ''), p.email), p.role
      into v_aname, v_arole
      from public.profiles p where p.id = v_uid;
    v_source := 'portal';
  elsif coalesce(auth.role(), '') = 'service_role' then
    v_source := 'service';
  else
    v_source := 'database';
  end if;

  insert into public.audit_log
    (table_name, action, area, admin_only, location_id, employee_id, subject_name,
     row_ref, old_values, new_values, actor_id, actor_name, actor_role, source)
  values
    (tg_table_name, lower(tg_op), v_area, coalesce(tg_argv[0]::boolean, false),
     v_loc, v_emp, v_subj, v_ref, v_old, v_new, v_uid, v_aname, v_arole, v_source);

  return null;
end;
$fn$;

revoke all on function public.audit_row_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Check: the live function is the new one. Expect one row: three trues
-- and audited_tables = 23 (unchanged -- the triggers are not touched).
-- ---------------------------------------------------------------------
select
  position('into v_loc, v_ref' in p.prosrc) = 0                         as old_select_into_gone,
  position('coalesce((select jsonb_build_object(''business_date''' in p.prosrc) > 0 as new_lookup_live,
  p.prosecdef                                                         as still_security_definer,
  (select count(*) from pg_trigger t where t.tgfoid = p.oid and not t.tgisinternal)
                                                                      as audited_tables   -- 23 after migration 87
from pg_proc p
where p.oid = 'public.audit_row_change()'::regprocedure;
