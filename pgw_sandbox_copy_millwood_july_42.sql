-- =====================================================================
-- PGW Support Portal — copy Millwood's July 2026 into Value Service
--                      (data only; the sandbox's test upload source)
-- Run AFTER pgw_horizon_credentials_41.sql, in the SQL Editor.
-- Safe to re-run: each run RESETS Value Service and copies again.
-- =====================================================================
-- The first portal upload goes to the sandbox shop (b306006) and is
-- compared, field by field, with what Millwood's own workbook sent for
-- July. For that the sandbox needs Millwood's July, so this file copies
-- it -- FROM THE LIVE TABLES AT RUN TIME, not from the 24s/25s seed
-- files, because live data has drifted from those seeds before.
--
-- WHAT IS COPIED (Millwood #3303 -> Value Service)
--   employees + employee_pay_rates + tech_pay_rates   all 5, all dates
--   tech_slots                                        all 9 grid slots
--   tech_daily                                        July 2026
--   tech_weekly (other pay)                           weeks touching July
--   daily_kpi + daily_service_units                   July 2026
--   store_category_goals, store_tic_goals             current values
--   Every column is copied -- the column lists are read from the
--   catalog, so a column added later cannot be silently left behind.
--   Only the ids and location_id change.
--
-- NOT COPIED: payroll (Millwood has no July payroll_daily rows, and the
-- Horizon payload does not read it), cash drawer, schedules, bonus and
-- goals (the sandbox has no bonus plan by design, migration 38), prior
-- year actuals, documents.
--
-- THE HORIZON SLOTS FOLLOW THE WORKBOOK'S JULY LAYOUT, NOT MILLWOOD'S
-- CURRENT ONE. This is deliberate. Millwood's live slots today hold only
-- Brayboy (1) and Jones (8): Barron and Fabre have since left (39b) and
-- Cantrell is held pending a spelling confirmation (39a). But all three
-- WORKED IN JULY -- Barron 3 days, Fabre 8, Cantrell 23 -- and the July
-- workbook sent them in slots 2, 7 and 4. Copying today's layout would
-- give their July numbers nowhere to go, and the comparison would fail
-- for a reason that has nothing to do with the upload. Sandbox slots:
--     1 Phillip Brayboy     2 Alan Barron     4 Cash Cantrell
--     6 Front Staff (reserved, migration 40)
--     7 Joseph Fabre        8 Bradley Jones
-- Every other slot takes Millwood's ever_used / last_released_at.
-- Slot 12 stays empty: the workbook names Rick Schroeder there, but he
-- has no employee row and no July numbers, so the only difference this
-- leaves is his NAME in kpi_tech_12_name.
--
-- ⚠ THE REAL UPLOAD WILL HAVE THE SAME PROBLEM. location_horizon_slots
-- holds who is in each slot NOW. Uploading a past month needs who was in
-- each slot THAT month. That is a design question for the transport,
-- not for this file -- this file only sidesteps it for the test.
--
-- RESET ON EVERY RUN. Value Service is emptied first: its employees
-- (and their pay rates), tech grid, tech days, tic sheet days and goals
-- are DELETED, and its Horizon slots return to never-used -- except the
-- Front Staff reservation, which is kept. Value Service is fake data by
-- definition; anything added to it by hand is lost on a re-run. A
-- payroll or timesheet row at Value Service blocks the employee delete
-- (ON DELETE RESTRICT) and stops the file with nothing changed.
--
-- Everything is in one DO block, so it either all happens or none of it
-- does. Real stores are only ever READ.
-- =====================================================================

-- Copies every column of p_table for rows matching p_where. p_over maps
-- a column to a replacement SQL expression over `src`; an identity
-- column is left to its default. Session-only (pg_temp).
create or replace function pg_temp.pgw_copy_rows(
  p_table text, p_where text, p_over jsonb
) returns bigint
language plpgsql
as $fn$
declare
  v_cols text;
  v_sel  text;
  v_n    bigint;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position),
         string_agg(coalesce(p_over ->> c.column_name, 'src.' || quote_ident(c.column_name)),
                    ', ' order by c.ordinal_position)
    into v_cols, v_sel
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name   = p_table
     and c.is_identity  = 'NO'
     and c.is_generated = 'NEVER';

  if v_cols is null then
    raise exception 'pgw_copy_rows: table public.% not found', p_table;
  end if;

  execute format('insert into public.%I (%s) select %s from public.%I src where %s',
                 p_table, v_cols, v_sel, p_table, p_where);
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

do $$
declare
  v_vs      uuid;
  v_mw      uuid;
  v_n       int;
  v_vs_fs   smallint;
  v_mw_fs   smallint;
  v_from    constant date := date '2026-07-01';
  v_to      constant date := date '2026-07-31';
  v_dates   text;
  v_loc_vs  text;
  r         record;
begin
  -- -------------------------------------------------------------------
  -- 0. GUARDS
  -- -------------------------------------------------------------------
  select count(*), min(id::text)::uuid into v_n, v_vs
    from public.locations where is_sandbox;
  if v_n <> 1 then
    raise exception 'Expected exactly one sandbox location, found %. Nothing changed.', v_n;
  end if;

  select count(*), min(id::text)::uuid into v_n, v_mw
    from public.locations where store_number = '3303' and not is_sandbox;
  if v_n <> 1 then
    raise exception 'Expected exactly one Millwood (#3303), found %. Nothing changed.', v_n;
  end if;

  -- Employee positions are validated against the store's brand.
  if (select brand from public.locations where id = v_vs)
     is distinct from (select brand from public.locations where id = v_mw) then
    raise exception 'Value Service and Millwood have different brands. Nothing changed.';
  end if;

  select slot_number into v_vs_fs from public.location_horizon_slots
   where location_id = v_vs and is_reserved and reservation_kind = 'front_staff';
  select slot_number into v_mw_fs from public.location_horizon_slots
   where location_id = v_mw and is_reserved and reservation_kind = 'front_staff';
  if v_vs_fs is distinct from 6 or v_mw_fs is distinct from 6 then
    raise exception 'Front Staff must be slot 6 at both Value Service (is %) and Millwood (is %). Nothing changed.',
      v_vs_fs, v_mw_fs;
  end if;

  v_loc_vs := quote_literal(v_vs) || '::uuid';
  v_dates  := format('between %L::date and %L::date', v_from, v_to);

  -- -------------------------------------------------------------------
  -- 1. RESET VALUE SERVICE
  -- -------------------------------------------------------------------
  update public.location_horizon_slots
     set current_technician_id = null, ever_used = false, last_released_at = null
   where location_id = v_vs and not is_reserved;

  delete from public.daily_kpi            where location_id = v_vs;  -- units cascade
  delete from public.tech_slots           where location_id = v_vs;  -- tech_daily, tech_weekly cascade
  delete from public.tech_daily           where location_id = v_vs;  -- any orphan
  delete from public.store_category_goals where location_id = v_vs;
  delete from public.store_tic_goals      where location_id = v_vs;
  delete from public.employees            where location_id = v_vs;  -- pay rates cascade

  -- -------------------------------------------------------------------
  -- 2. ID MAPS  (old Millwood id -> new Value Service id)
  -- -------------------------------------------------------------------
  drop table if exists pg_temp.pgw_map_emp;
  drop table if exists pg_temp.pgw_map_slot;
  create temp table pgw_map_emp as
    select id as old_id, gen_random_uuid() as new_id, full_name
      from public.employees where location_id = v_mw;
  create temp table pgw_map_slot as
    select id as old_id, gen_random_uuid() as new_id
      from public.tech_slots where location_id = v_mw;

  -- -------------------------------------------------------------------
  -- 3. COPY
  -- -------------------------------------------------------------------
  perform pg_temp.pgw_copy_rows('employees',
    format('src.location_id = %L', v_mw),
    jsonb_build_object(
      'id',          '(select m.new_id from pgw_map_emp m where m.old_id = src.id)',
      'location_id', v_loc_vs,
      'created_at',  'now()'));

  -- employee_pay_rates before tech_pay_rates: the tech_pay_rates trigger
  -- upserts flat_rate_per_hour, exactly as it did at Millwood.
  perform pg_temp.pgw_copy_rows('employee_pay_rates',
    'src.employee_id in (select old_id from pgw_map_emp)',
    jsonb_build_object(
      'employee_id', '(select m.new_id from pgw_map_emp m where m.old_id = src.employee_id)'));

  perform pg_temp.pgw_copy_rows('tech_pay_rates',
    'src.employee_id in (select old_id from pgw_map_emp)',
    jsonb_build_object(
      'id',          'gen_random_uuid()',
      'employee_id', '(select m.new_id from pgw_map_emp m where m.old_id = src.employee_id)'));

  perform pg_temp.pgw_copy_rows('tech_slots',
    format('src.location_id = %L', v_mw),
    jsonb_build_object(
      'id',          '(select m.new_id from pgw_map_slot m where m.old_id = src.id)',
      'location_id', v_loc_vs,
      'employee_id', '(select m.new_id from pgw_map_emp m where m.old_id = src.employee_id)',
      'created_at',  'now()'));

  -- Other pay is stored per Sunday-started week; take every week that
  -- overlaps July.
  perform pg_temp.pgw_copy_rows('tech_weekly',
    format('src.tech_slot_id in (select old_id from pgw_map_slot) and src.week_start between %L::date and %L::date',
           v_from - 6, v_to),
    jsonb_build_object(
      'id',           'gen_random_uuid()',
      'tech_slot_id', '(select m.new_id from pgw_map_slot m where m.old_id = src.tech_slot_id)'));

  -- employee_id is the day's historical attribution (pay resolves from
  -- it), so it is mapped explicitly rather than re-stamped from the slot.
  perform pg_temp.pgw_copy_rows('tech_daily',
    format('src.location_id = %L and src.work_date %s', v_mw, v_dates),
    jsonb_build_object(
      'id',           'gen_random_uuid()',
      'location_id',  v_loc_vs,
      'tech_slot_id', '(select m.new_id from pgw_map_slot m where m.old_id = src.tech_slot_id)',
      'employee_id',  '(select m.new_id from pgw_map_emp m where m.old_id = src.employee_id)'));

  perform pg_temp.pgw_copy_rows('daily_kpi',
    format('src.location_id = %L and src.business_date %s', v_mw, v_dates),
    jsonb_build_object('location_id', v_loc_vs));

  -- Units follow their day; the new daily_kpi id is found by date.
  perform pg_temp.pgw_copy_rows('daily_service_units',
    format('src.daily_kpi_id in (select k.id from public.daily_kpi k where k.location_id = %L and k.business_date %s)',
           v_mw, v_dates),
    jsonb_build_object(
      'daily_kpi_id',
      format('(select nk.id from public.daily_kpi ok join public.daily_kpi nk on nk.business_date = ok.business_date and nk.location_id = %L where ok.id = src.daily_kpi_id)',
             v_vs)));

  perform pg_temp.pgw_copy_rows('store_category_goals',
    format('src.location_id = %L', v_mw),
    jsonb_build_object('location_id', v_loc_vs));

  perform pg_temp.pgw_copy_rows('store_tic_goals',
    format('src.location_id = %L', v_mw),
    jsonb_build_object('location_id', v_loc_vs));

  -- -------------------------------------------------------------------
  -- 4. HORIZON SLOTS — the July workbook's layout
  -- -------------------------------------------------------------------
  -- Unoccupied history first, mirrored from Millwood.
  update public.location_horizon_slots v
     set ever_used        = m.ever_used,
         last_released_at = m.last_released_at
    from public.location_horizon_slots m
   where m.location_id = v_mw
     and v.location_id = v_vs
     and v.slot_number = m.slot_number
     and not v.is_reserved;

  for r in
    select s.slot_number, s.full_name
      from (values (1::smallint, 'Phillip Brayboy'),
                   (2::smallint, 'Alan Barron'),
                   (4::smallint, 'Cash Cantrell'),
                   (7::smallint, 'Joseph Fabre'),
                   (8::smallint, 'Bradley Jones')) as s(slot_number, full_name)
  loop
    select count(*) into v_n from pgw_map_emp where full_name = r.full_name;
    if v_n <> 1 then
      raise exception 'Expected exactly one Millwood employee named %, found %. Nothing changed.',
        r.full_name, v_n;
    end if;

    update public.location_horizon_slots
       set current_technician_id = (select new_id from pgw_map_emp where full_name = r.full_name),
           ever_used             = true,
           last_released_at      = null
     where location_id = v_vs
       and slot_number = r.slot_number
       and not is_reserved;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'Value Service slot % could not be seated. Nothing changed.', r.slot_number;
    end if;
  end loop;

  drop table pgw_map_emp;
  drop table pgw_map_slot;

  raise notice 'Value Service now holds a copy of Millwood''s July 2026.';
end
$$;

drop function if exists pg_temp.pgw_copy_rows(text, text, jsonb);


-- =====================================================================
-- VERIFY — in the SQL Editor. Each pair of numbers must match.
--
--  [1] Row counts, Millwood vs Value Service:
--        with l as (
--          select (select id from public.locations where store_number = '3303') mw,
--                 (select id from public.locations where is_sandbox)            vs)
--        select 'employees', (select count(*) from public.employees e, l where e.location_id = l.mw),
--                            (select count(*) from public.employees e, l where e.location_id = l.vs)
--        union all
--        select 'tech_slots', (select count(*) from public.tech_slots t, l where t.location_id = l.mw),
--                             (select count(*) from public.tech_slots t, l where t.location_id = l.vs)
--        union all
--        select 'tech_daily July', (select count(*) from public.tech_daily t, l where t.location_id = l.mw and t.work_date between '2026-07-01' and '2026-07-31'),
--                                  (select count(*) from public.tech_daily t, l where t.location_id = l.vs)
--        union all
--        select 'daily_kpi July', (select count(*) from public.daily_kpi k, l where k.location_id = l.mw and k.business_date between '2026-07-01' and '2026-07-31'),
--                                 (select count(*) from public.daily_kpi k, l where k.location_id = l.vs)
--        union all
--        select 'service units July', (select count(*) from public.daily_service_units u join public.daily_kpi k on k.id = u.daily_kpi_id, l where k.location_id = l.mw and k.business_date between '2026-07-01' and '2026-07-31'),
--                                     (select count(*) from public.daily_service_units u join public.daily_kpi k on k.id = u.daily_kpi_id, l where k.location_id = l.vs)
--        union all
--        select 'category goals', (select count(*) from public.store_category_goals g, l where g.location_id = l.mw),
--                                 (select count(*) from public.store_category_goals g, l where g.location_id = l.vs);
--      Expect 5/5, 9/9, 83/83, 26/26, 237/237, 30/30.
--
--  [2] July totals match to the cent:
--        select l.name, sum(t.hours_worked), sum(t.flag_hours), sum(t.labor_sales)
--          from public.tech_daily t join public.locations l on l.id = t.location_id
--         where (l.store_number = '3303' or l.is_sandbox)
--           and t.work_date between '2026-07-01' and '2026-07-31'
--         group by l.name;
--      Two identical rows (741.65 hours, 370.33 flag, 58,582.50 labor as
--      of 2026-09-16).
--
--  [3] The sandbox slots:
--        select s.slot_number, e.full_name, s.ever_used, s.reservation_kind
--          from public.location_horizon_slots s
--          join public.locations l on l.id = s.location_id
--          left join public.employees e on e.id = s.current_technician_id
--         where l.is_sandbox and (s.current_technician_id is not null or s.is_reserved)
--         order by s.slot_number;
--      1 Brayboy, 2 Barron, 4 Cantrell, 6 front_staff, 7 Fabre, 8 Jones.
--
--  [4] Millwood unchanged: its slots still show only Brayboy (1),
--      Jones (8) and Front Staff (6).
--
--  As teststore: Value Service's rows stay invisible (0 rows by id).
-- =====================================================================
