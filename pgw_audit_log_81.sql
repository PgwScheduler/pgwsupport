-- =====================================================================
-- PGW Support Portal — Audit log: who changed what, when (migration 81)
-- Run AFTER pgw_missing_entries_80.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- WHY: DMs, RMs, office staff and stores all edit the numbers that pay
-- people -- payroll hours, pay rates, tic sheet sales, adjustments, bonus
-- inputs -- and until now only the Adjustments column (48/62) and pay
-- rate history (56) remembered who last touched them, and only the LAST
-- person. The first disputed bonus needs the whole trail.
--
--   1. audit_log            one row per changed record: who (name + role
--                           AS OF THE CHANGE), when, which store, which
--                           employee, and only the fields that changed
--                           (old -> new). Append-only: no one can edit or
--                           delete it through the app, and a guard
--                           trigger refuses UPDATE/DELETE/TRUNCATE even
--                           from the SQL Editor until it is dropped.
--   2. audit_row_change()   the one AFTER trigger function, attached to
--                           every table in section 4. AFTER, so it records
--                           what was actually stored (the column guards in
--                           14/16/48/62/65 have already run).
--   3. _audit_attach()      attaches it; reads the table's primary key
--                           from the catalog. Future tables:
--                             select public._audit_attach('public.x', false);
--   4. the tables           payroll, pay rates, tic sheet + adjustments,
--                           bonus inputs and config, employees (incl.
--                           transfers), user roles.
--   5. audit_log_feed()     the Change Log screen's read. SECURITY
--                           INVOKER: RLS on audit_log does the scoping.
--
-- WHO SEES IT (decided 2026-10-09):
--   * admin / master: everything.
--   * district / regional: rows for stores they can access, EXCEPT
--     admin_only rows -- tables they cannot read today (pay rates,
--     timesheet_pay, tech other pay, user roles). The log must not
--     become a side door to wages.
--   * store / office: nothing.
--
-- DECISIONS (change here if they are wrong):
--   * Updates that change nothing (the same value saved again) and
--     bookkeeping columns (updated_at/_by, entered_*, submitted_*,
--     created_at, the adjustments_*_updated_* stamps) are not logged --
--     the log's own actor/at replace them.
--   * An INSERT that carries no values yet (the tic sheet creates an
--     empty day the moment someone tabs into it) is not logged; the
--     first real value arrives as an update and is.
--   * Changes made in the SQL Editor or by a cron/edge function are
--     logged with source 'database' / 'service' and no person. Bulk
--     loads therefore show up -- on purpose.
--   * Multi-row actions (a transfer touches 6 tables) share one txid, so
--     the screen shows them as one event.
--   * No retention limit. Only changed fields are stored; at 38 stores
--     this is a few hundred thousand small rows a year.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE LOG
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default clock_timestamp(),
  txid         bigint      not null default txid_current(),
  table_name   text        not null,
  action       text        not null check (action in ('insert', 'update', 'delete')),
  area         text        not null,
  admin_only   boolean     not null default false,
  -- No foreign keys: the log must outlive the store, employee or login
  -- it describes, and must never block their deletion.
  location_id  uuid,
  employee_id  uuid,
  subject_name text,                     -- employee / login name at the time
  row_ref      jsonb       not null,     -- primary key + the date/week/month that identifies the row
  old_values   jsonb,                    -- update: changed fields only; delete: the whole row
  new_values   jsonb,                    -- update: changed fields only; insert: the whole row
  actor_id     uuid,
  actor_name   text,
  actor_role   text,
  source       text        not null check (source in ('portal', 'service', 'database'))
);

create index if not exists audit_log_at_idx       on public.audit_log (at desc);
create index if not exists audit_log_location_idx on public.audit_log (location_id, id desc);
create index if not exists audit_log_employee_idx on public.audit_log (employee_id, id desc);
create index if not exists audit_log_actor_idx    on public.audit_log (actor_id, id desc);
create index if not exists audit_log_txid_idx     on public.audit_log (txid);

comment on table public.audit_log is
  'Migration 81: append-only change history for payroll, pay rates, tic sheet, adjustments, bonus inputs, employees and user roles. Written only by audit_row_change(). actor_role is the role at the time of the change.';

alter table public.audit_log enable row level security;

drop policy if exists "audit_log_select" on public.audit_log;
create policy "audit_log_select" on public.audit_log
  for select to authenticated
  using (
    public.current_user_role() in ('admin', 'master')
    or (not admin_only
        and location_id is not null
        and public.current_user_role() in ('district', 'regional')
        and public.can_access_location(location_id))
  );
-- No insert/update/delete policy: nothing but the trigger writes here.
revoke all on public.audit_log from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;
grant select on public.audit_log to authenticated;   -- explicit: don't lean on default privileges

-- Even the SQL Editor (which bypasses RLS) cannot quietly rewrite
-- history: changing the log means dropping this trigger first, which is
-- itself a deliberate, visible act.
create or replace function public.audit_log_immutable()
returns trigger
language plpgsql set search_path = '' as $fn$
begin
  raise exception 'audit_log is append-only (migration 81)' using errcode = '42501';
end;
$fn$;

drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update
  before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();

drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.audit_log_immutable();

revoke all on function public.audit_log_immutable() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. THE TRIGGER FUNCTION
--    TG_ARGV[0] = admin_only ('true'/'false'); TG_ARGV[1..] = PK columns.
--    SECURITY DEFINER so it can write the log; auth.uid() still reads
--    the caller's JWT, including inside definer RPCs like
--    transfer_employee().
-- ---------------------------------------------------------------------
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

    if v_full ? 'timesheet_entry_id' then
      select coalesce(v_loc, t.location_id), coalesce(v_emp, t.employee_id),
             v_ref || jsonb_build_object('week_start', t.week_start)
        into v_loc, v_emp, v_ref
        from public.timesheet_entries t where t.id = (v_full ->> 'timesheet_entry_id')::uuid;
    end if;
    if v_full ? 'daily_kpi_id' then
      select coalesce(v_loc, d.location_id), v_ref || jsonb_build_object('business_date', d.business_date)
        into v_loc, v_ref
        from public.daily_kpi d where d.id = (v_full ->> 'daily_kpi_id')::bigint;
    end if;
    if v_full ? 'service_category_id' then
      select v_ref || jsonb_build_object('category', c.display_name)
        into v_ref
        from public.service_categories c where c.id = (v_full ->> 'service_category_id')::bigint;
    end if;
    if v_full ? 'tech_slot_id' and (v_loc is null or v_emp is null) then
      select coalesce(v_loc, s.location_id), coalesce(v_emp, s.employee_id)
        into v_loc, v_emp
        from public.tech_slots s where s.id = (v_full ->> 'tech_slot_id')::uuid;
    end if;
    if v_emp is not null then
      select coalesce(v_loc, e.location_id), e.full_name
        into v_loc, v_subj
        from public.employees e where e.id = v_emp;
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

comment on function public.audit_row_change() is
  'Migration 81: AFTER row trigger writing public.audit_log. Args: admin_only, then the primary-key columns. Attach with _audit_attach().';


-- ---------------------------------------------------------------------
-- 3. ATTACH HELPER
-- ---------------------------------------------------------------------
create or replace function public._audit_attach(p_table regclass, p_admin_only boolean)
returns void
language plpgsql set search_path = '' as $fn$
declare
  v_args text;
begin
  select string_agg(quote_literal(a.attname), ', ' order by array_position(i.indkey::int2[], a.attnum))
    into v_args
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
   where i.indrelid = p_table and i.indisprimary;
  if v_args is null then
    raise exception '% has no primary key; audit_row_change needs one', p_table;
  end if;
  execute format('drop trigger if exists audit_row_change on %s', p_table);
  execute format(
    'create trigger audit_row_change after insert or update or delete on %s '
    'for each row execute function public.audit_row_change(%L, %s)',
    p_table, p_admin_only::text, v_args);
end;
$fn$;

revoke all on function public._audit_attach(regclass, boolean) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 4. THE TABLES
--    admin_only = true where district/regional cannot read the table
--    today (RLS is admin/master): keeps wages out of the DM view.
-- ---------------------------------------------------------------------
-- Payroll
select public._audit_attach('public.payroll_daily',             false);
select public._audit_attach('public.timesheet_entries',         false);  -- PTO days
select public._audit_attach('public.timesheet_midas',           false);
select public._audit_attach('public.timesheet_speedee',         false);
select public._audit_attach('public.store_week_sales',          false);
select public._audit_attach('public.tech_daily',                false);
select public._audit_attach('public.tech_slots',                false);
select public._audit_attach('public.timesheet_pay',             true);   -- bonus / paycheck amounts
select public._audit_attach('public.tech_weekly',               true);   -- tech other pay
-- Pay rates
select public._audit_attach('public.employee_pay_rate_history', true);
select public._audit_attach('public.tech_pay_rates',            true);
-- Tic sheet + Adjustments
select public._audit_attach('public.daily_kpi',                 false);
select public._audit_attach('public.daily_service_units',       false);
-- Bonus inputs and config
select public._audit_attach('public.bonus_monthly_inputs',      false);
select public._audit_attach('public.bonus_monthly_targets',     false);
select public._audit_attach('public.bonus_plans',               false);
select public._audit_attach('public.bonus_incentive_tiers',     false);
select public._audit_attach('public.bonus_model_rates',         true);
select public._audit_attach('public.bonus_model_splits',        true);
select public._audit_attach('public.bonus_policy',              true);
select public._audit_attach('public.market_bonus_brackets',     true);
-- People and transfers
select public._audit_attach('public.employees',                 false);
-- Logins and roles
select public._audit_attach('public.profiles',                  true);


-- ---------------------------------------------------------------------
-- 5. THE CHANGE LOG FEED
--    Newest first, keyset-paged by id (pass the last id you got as
--    p_before_id). Dates are Eastern. p_employee_id follows the person
--    across transfers (migration 76 chain), as far as the caller can
--    see employees.
-- ---------------------------------------------------------------------
create or replace function public.audit_log_feed(
  p_from        date,
  p_to          date,
  p_location_id uuid   default null,
  p_area        text   default null,
  p_employee_id uuid   default null,
  p_before_id   bigint default null,
  p_limit       int    default 200)
returns table (
  id           bigint,
  at           timestamptz,
  txid         bigint,
  table_name   text,
  action       text,
  area         text,
  location_id  uuid,
  store_number text,
  store_name   text,
  employee_id  uuid,
  subject_name text,
  row_ref      jsonb,
  old_values   jsonb,
  new_values   jsonb,
  actor_name   text,
  actor_role   text,
  source       text
)
language sql stable security invoker set search_path = '' as $fn$
  with recursive
  earlier(id) as (                        -- back through earlier stores
    select p_employee_id where p_employee_id is not null
    union
    select e.transferred_from_id from public.employees e join earlier p on e.id = p.id
     where e.transferred_from_id is not null
  ),
  person(id) as (                         -- then forward to every later one
    select earlier.id from earlier
    union
    select e.id from public.employees e join person p on e.transferred_from_id = p.id
  )
  select a.id, a.at, a.txid, a.table_name, a.action, a.area,
         a.location_id, l.store_number, l.name,
         a.employee_id, a.subject_name, a.row_ref, a.old_values, a.new_values,
         a.actor_name, a.actor_role, a.source
    from public.audit_log a
    left join public.locations l on l.id = a.location_id
   where a.at >= (p_from::timestamp at time zone 'America/New_York')
     and a.at <  ((p_to + 1)::timestamp at time zone 'America/New_York')
     and (p_location_id is null or a.location_id = p_location_id)
     and (p_area is null or a.area = p_area)
     and (p_employee_id is null or a.employee_id in (select person.id from person))
     and (p_before_id is null or a.id < p_before_id)
   order by a.id desc
   limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$fn$;

revoke all on function public.audit_log_feed(date, date, uuid, text, uuid, bigint, int) from public, anon;
grant execute on function public.audit_log_feed(date, date, uuid, text, uuid, bigint, int) to authenticated;

comment on function public.audit_log_feed(date, date, uuid, text, uuid, bigint, int) is
  'Migration 81: the Change Log screen. SECURITY INVOKER -- audit_log RLS decides what the caller sees (admin/master all; district/regional their stores minus admin_only rows; others nothing).';
