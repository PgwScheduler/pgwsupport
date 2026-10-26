-- =====================================================================
-- Migration 92 — Parts Recon: "Other bill" items
-- Run AFTER pgw_parts_recon_mass_credit_91.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Why: the user, 2026-10-26. Bills that never come in on a vendor
-- statement (e.g. an Allegro Towing charge to a store) need to count as
-- Parts Recon deductions, for the current month and for months ahead.
--
-- An Other bill is a NEW KIND of parts_recon_items row ('other'), so it
-- flows through everything that already reads items with no separate
-- math: parts_recon_left(), the store's item list and "Send reply",
-- AP's review form, Mass Credit Import, the Tracker and the Deduction
-- Report.
--
-- WHO ENTERS THEM: the AP team only (master, admin, parts_recon_ap_users).
-- The tables still have RLS on and no policies; the only write path is
-- the definer functions below, which refuse anyone else.
--
-- WHICH MONTH: a month that exists and AP hasn't closed, or -- when there
-- is no recon for it yet -- the current calendar month or a later one.
-- Never a closed month, never a past month with no recon.
--
-- FUTURE MONTHS: when a bill's month has no parts_recon_months row yet,
-- an empty placeholder row is created for it (label only; not imported,
-- not released, so stores don't see it). When AP later imports that
-- month, parts_recon_import_begin() fills in the same row (it already
-- upserts on month), and the bill is simply there. Deleting the last
-- Other bill in a placeholder month that was never imported removes the
-- placeholder again.
--
-- IMPORTS NEVER TOUCH THEM, two ways: every Other bill's import_key is
-- 'other|<uuid>', which no recon row can produce (so the import upsert
-- can't match, overwrite or duplicate it), AND parts_recon_import_finish
-- now leaves kind 'other' out of "drop what this run didn't produce"
-- and out of the run's item counts.
--
-- TRACKER: parts_recon_tracker() listed only the Location x Vendor lines
-- the run put on the tracker, so items at a store x vendor with no line
-- (any Other bill vendor) never showed there. It now also returns a row
-- for every store x vendor that has items but no line, so the Tracker's
-- left to deduct always includes every item. A store x vendor that
-- already has a hand-keyed line with no items (e.g. Agero Towing) starts
-- counting its items instead of the keyed amount once an Other bill is
-- entered for it -- the Tracker's existing rule for a line with items.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. THE KIND, and who made it
-- ---------------------------------------------------------------------
alter table public.parts_recon_items drop constraint if exists parts_recon_items_kind_check;
alter table public.parts_recon_items
  add constraint parts_recon_items_kind_check check (kind in ('ro_cost','divvy','arm','other'));

alter table public.parts_recon_items
  add column if not exists created_by       uuid references auth.users (id) on delete set null,
  add column if not exists created_by_name  text,
  add column if not exists created_at       timestamptz,
  add column if not exists series_id        uuid;   -- one "repeat monthly" entry across its months


-- ---------------------------------------------------------------------
-- 2. RULES
-- ---------------------------------------------------------------------
-- Why a month can't take an Other bill, or null when it can.
create or replace function public.parts_recon_other_month_problem(p_month date)
returns text
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_month date := date_trunc('month', p_month)::date;
  m record;
begin
  select * into m from public.parts_recon_months x where x.month = v_month;
  if found then
    if m.closed_at is not null then
      return to_char(v_month, 'FMMonth YYYY') || ' is closed.';
    end if;
    return null;
  end if;
  if v_month < date_trunc('month', current_date)::date then
    return to_char(v_month, 'FMMonth YYYY') || ' is in the past and has no recon.';
  end if;
  return null;
end
$fn$;
revoke all on function public.parts_recon_other_month_problem(date) from public, anon, authenticated;

-- The recon's own name for a store (its tracker name), else the portal's.
create or replace function public.parts_recon_store_name(p_location uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select min(sm.recon_name) from public.parts_recon_store_map sm where sm.location_id = p_location),
                  (select l.name from public.locations l where l.id = p_location));
$$;
revoke all on function public.parts_recon_store_name(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. AP: STORES, LIST, CREATE, EDIT, DELETE
-- ---------------------------------------------------------------------
-- The store picker: every store but the sandbox and the Home Office.
drop function if exists public.parts_recon_other_bill_stores();
create or replace function public.parts_recon_other_bill_stores()
returns table (location_id uuid, store_number text, recon_store text)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can enter other bills.' using errcode = '42501';
  end if;
  return query
  select l.id, l.store_number::text, public.parts_recon_store_name(l.id)
    from public.locations l
   where not l.is_sandbox and not l.is_home_office
   order by l.store_number;
end
$fn$;
revoke all on function public.parts_recon_other_bill_stores() from public, anon;
grant execute on function public.parts_recon_other_bill_stores() to authenticated;

-- Every Other bill (sandbox left out), newest month first.
drop function if exists public.parts_recon_other_bills();
create or replace function public.parts_recon_other_bills()
returns table (
  id uuid, month date, month_label text, month_closed boolean, month_released boolean, month_imported boolean,
  location_id uuid, store_number text, recon_store text, vendor text, bill_no text, ro text, description text,
  amount numeric, status text, credit_amt numeric, left_to_deduct numeric, series_id uuid,
  created_by_name text, created_at timestamptz, files int
)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can see other bills.' using errcode = '42501';
  end if;
  return query
  select i.id, i.month, m.label, m.closed_at is not null, m.released_at is not null, m.imported_at is not null,
         i.location_id, l.store_number::text, i.recon_store, i.vendor, i.invoices, i.ro, i.asked,
         i.amount, i.status, i.credit_amt, public.parts_recon_left(i.status, i.amount, i.credit_amt), i.series_id,
         i.created_by_name, i.created_at,
         (select count(*)::int from public.parts_recon_item_files f where f.item_id = i.id)
    from public.parts_recon_items i
    join public.parts_recon_months m on m.month = i.month
    left join public.locations l on l.id = i.location_id
   where i.kind = 'other' and i.dropped_at is null and not coalesce(l.is_sandbox, false)
   order by i.month desc, l.store_number, i.vendor, i.created_at;
end
$fn$;
revoke all on function public.parts_recon_other_bills() from public, anon;
grant execute on function public.parts_recon_other_bills() to authenticated;

-- Create one bill, or the same bill in every month from p_start through
-- p_end ("repeat monthly"): one item per month, all or nothing.
drop function if exists public.parts_recon_other_bill_create(uuid, text, date, date, numeric, text, text, text);
create or replace function public.parts_recon_other_bill_create(
  p_location uuid, p_vendor text, p_start date, p_end date, p_amount numeric,
  p_bill_no text, p_ro text, p_description text)
returns table (id uuid, month date)
language plpgsql security definer set search_path = '' as $fn$
declare
  v_start   date := date_trunc('month', p_start)::date;
  v_end     date := date_trunc('month', coalesce(p_end, p_start))::date;
  v_vendor  text := nullif(trim(coalesce(p_vendor, '')), '');
  v_bill    text := nullif(trim(coalesce(p_bill_no, '')), '');
  v_name    text := public.parts_recon_my_name();
  v_store   text;
  v_series  uuid;
  v_month   date;
  v_problem text;
  v_id      uuid;
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can enter other bills.' using errcode = '42501';
  end if;
  if p_location is null or not exists (select 1 from public.locations l
                                        where l.id = p_location and not l.is_sandbox and not l.is_home_office) then
    raise exception 'Pick the store.' using errcode = '22023';
  end if;
  if v_vendor is null then
    raise exception 'Enter the vendor.' using errcode = '22023';
  end if;
  if v_bill is null then
    raise exception 'Enter the bill / invoice #.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter the amount as a positive dollar amount.' using errcode = '22023';
  end if;
  if p_start is null then
    raise exception 'Pick the month.' using errcode = '22023';
  end if;
  if v_end < v_start then
    raise exception 'The last month is before the first.' using errcode = '22023';
  end if;
  if (extract(year from v_end) * 12 + extract(month from v_end)) - (extract(year from v_start) * 12 + extract(month from v_start)) >= 24 then
    raise exception 'Repeat for at most 24 months at a time.' using errcode = '22023';
  end if;

  v_store  := public.parts_recon_store_name(p_location);
  v_series := case when v_end > v_start then gen_random_uuid() end;

  v_month := v_start;
  while v_month <= v_end loop
    v_problem := public.parts_recon_other_month_problem(v_month);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '22023';
    end if;
    -- A month with no recon yet: an empty placeholder the import fills in later.
    insert into public.parts_recon_months (month, label)
    values (v_month, to_char(v_month, 'FMMonth YYYY'))
    on conflict on constraint parts_recon_months_pkey do nothing;

    insert into public.parts_recon_items
      (month, import_key, kind, recon_store, location_id, vendor, tracker_vendor, ro, invoices,
       amount, asked, detail, created_by, created_by_name, created_at, series_id)
    values (v_month, 'other|' || gen_random_uuid()::text, 'other', v_store, p_location, v_vendor, v_vendor,
            nullif(trim(coalesce(p_ro, '')), ''), v_bill, p_amount,
            coalesce(nullif(trim(coalesce(p_description, '')), ''), 'Other bill'), '{}'::jsonb,
            auth.uid(), v_name, now(), v_series)
    returning parts_recon_items.id into v_id;
    id := v_id; month := v_month;
    return next;
    v_month := (v_month + interval '1 month')::date;
  end loop;
end
$fn$;
revoke all on function public.parts_recon_other_bill_create(uuid, text, date, date, numeric, text, text, text) from public, anon;
grant execute on function public.parts_recon_other_bill_create(uuid, text, date, date, numeric, text, text, text) to authenticated;

-- Edit one bill (its month and store stay; delete and re-enter to move it).
drop function if exists public.parts_recon_other_bill_update(uuid, text, numeric, text, text, text);
create or replace function public.parts_recon_other_bill_update(
  p_id uuid, p_vendor text, p_amount numeric, p_bill_no text, p_ro text, p_description text)
returns void
language plpgsql security definer set search_path = '' as $fn$
declare r record;
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can edit other bills.' using errcode = '42501';
  end if;
  select i.*, m.closed_at into r
    from public.parts_recon_items i join public.parts_recon_months m on m.month = i.month
   where i.id = p_id and i.kind = 'other';
  if not found then
    raise exception 'Not found.' using errcode = '22023';
  end if;
  if r.closed_at is not null then
    raise exception 'That month is closed.' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_vendor, '')), '') is null or nullif(trim(coalesce(p_bill_no, '')), '') is null then
    raise exception 'Enter the vendor and the bill / invoice #.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter the amount as a positive dollar amount.' using errcode = '22023';
  end if;
  update public.parts_recon_items
     set vendor = trim(p_vendor), tracker_vendor = trim(p_vendor), amount = p_amount,
         invoices = trim(p_bill_no), ro = nullif(trim(coalesce(p_ro, '')), ''),
         asked = coalesce(nullif(trim(coalesce(p_description, '')), ''), 'Other bill'),
         updated_at = now()
   where id = p_id;
end
$fn$;
revoke all on function public.parts_recon_other_bill_update(uuid, text, numeric, text, text, text) from public, anon;
grant execute on function public.parts_recon_other_bill_update(uuid, text, numeric, text, text, text) to authenticated;

-- Delete one bill while its month is open. Not once it's on a store's
-- mass credit (the credit's history needs it). The last bill in a
-- placeholder month that was never imported takes the placeholder too.
drop function if exists public.parts_recon_other_bill_delete(uuid);
create or replace function public.parts_recon_other_bill_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $fn$
declare r record;
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can delete other bills.' using errcode = '42501';
  end if;
  select i.id, i.month, m.closed_at into r
    from public.parts_recon_items i join public.parts_recon_months m on m.month = i.month
   where i.id = p_id and i.kind = 'other';
  if not found then
    raise exception 'Not found.' using errcode = '22023';
  end if;
  if r.closed_at is not null then
    raise exception 'That month is closed.' using errcode = '22023';
  end if;
  if exists (select 1 from public.parts_recon_credit_batch_lines ln where ln.item_id = p_id) then
    raise exception 'The store already put this bill on a vendor credit, so it can''t be deleted. Edit it instead.' using errcode = '22023';
  end if;
  delete from public.parts_recon_items where id = p_id;
  delete from public.parts_recon_months m
   where m.month = r.month and m.imported_at is null and m.released_at is null and m.closed_at is null
     and not exists (select 1 from public.parts_recon_items i where i.month = m.month)
     and not exists (select 1 from public.parts_recon_other_credits c where c.month = m.month)
     and not exists (select 1 from public.parts_recon_tracker_lines t where t.month = m.month)
     and not exists (select 1 from public.parts_recon_ap_tasks t where t.month = m.month)
     and not exists (select 1 from public.parts_recon_store_notes n where n.month = m.month);
end
$fn$;
revoke all on function public.parts_recon_other_bill_delete(uuid) from public, anon;
grant execute on function public.parts_recon_other_bill_delete(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 4. IMPORT: never drop or count an Other bill
-- ---------------------------------------------------------------------
-- As in migration 90, with kind 'other' left out of the drop and the
-- run's counts. (Their 'other|' keys already keep the upsert off them.)
create or replace function public.parts_recon_import_finish(p_month date, p_batch uuid, p_check jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_month   date := date_trunc('month', p_month)::date;
  v_dropped int;
  v_tdrop   int;
  v_out     jsonb;
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can import a recon.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.parts_recon_months m where m.month = v_month and m.import_batch = p_batch) then
    raise exception 'This import was replaced by a newer one. Start the import again.' using errcode = '22023';
  end if;
  update public.parts_recon_items set dropped_at = now()
   where month = v_month and dropped_at is null and kind <> 'other' and seen_batch is distinct from p_batch;
  get diagnostics v_dropped = row_count;
  update public.parts_recon_ap_tasks set dropped_at = now()
   where month = v_month and dropped_at is null and seen_batch is distinct from p_batch;
  get diagnostics v_tdrop = row_count;

  select jsonb_build_object(
           'items',          count(*) filter (where i.dropped_at is null),
           'items_amount',   coalesce(sum(i.amount) filter (where i.dropped_at is null), 0),
           'items_dropped',  v_dropped,
           'tasks_dropped',  v_tdrop,
           'unmapped_stores', coalesce((select jsonb_agg(distinct x.recon_store order by x.recon_store)
                                          from public.parts_recon_items x
                                         where x.month = v_month and x.dropped_at is null and x.location_id is null
                                           and x.kind <> 'other'), '[]'::jsonb))
    into v_out
    from public.parts_recon_items i where i.month = v_month and i.kind <> 'other';

  update public.parts_recon_months
     set imported_at = now(), imported_by_name = public.parts_recon_my_name(),
         check_totals = coalesce(p_check, '{}'::jsonb) || v_out
   where month = v_month;
  return v_out;
end
$fn$;
revoke all on function public.parts_recon_import_finish(date, uuid, jsonb) from public, anon;
grant execute on function public.parts_recon_import_finish(date, uuid, jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 5. TRACKER: every item counted, line or no line
-- ---------------------------------------------------------------------
-- As in migration 90, plus one row for each store x vendor that has
-- items but no tracker line (sorted after the run's lines).
create or replace function public.parts_recon_tracker(p_month date)
returns table (
  key text, sort int, region text, recon_store text, location_id uuid, vendor text,
  script_status text, script_amount numeric, script_notes text,
  items int, open_items int, to_review int, amount numeric, credited numeric, left_to_deduct numeric,
  status text
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_ap boolean := public.parts_recon_is_ap();
begin
  if not public.parts_recon_month_visible(v_month) then
    return;
  end if;
  return query
  with agg as (
    select i.recon_store, coalesce(i.tracker_vendor, i.vendor) vendor,
           (array_agg(i.location_id) filter (where i.location_id is not null))[1] location_id,
           count(*)::int n,
           (count(*) filter (where i.status = 'open'))::int n_open,
           (count(*) filter (where i.status = 'answered'))::int n_review,
           coalesce(sum(i.amount), 0) amt,
           coalesce(sum(i.amount - public.parts_recon_left(i.status, i.amount, i.credit_amt)), 0) cred,
           coalesce(sum(public.parts_recon_left(i.status, i.amount, i.credit_amt)), 0) lft
      from public.parts_recon_items i
     where i.month = v_month and i.dropped_at is null
     group by i.recon_store, coalesce(i.tracker_vendor, i.vendor)
  ),
  lines as (
    select t.key, t.sort, t.region, t.recon_store, t.location_id, t.vendor,
           t.script_status, t.script_amount, t.script_notes,
           coalesce(a.n, 0) n, coalesce(a.n_open, 0) n_open, coalesce(a.n_review, 0) n_review,
           coalesce(a.amt, 0) amt, coalesce(a.cred, 0) cred,
           case when a.n is null then coalesce(t.script_amount, 0) else a.lft end lft,
           case when coalesce(a.n_open, 0) + coalesce(a.n_review, 0) > 0 then 'WAITING ON RESPONSE'
                else coalesce(t.script_status, '') end st
      from public.parts_recon_tracker_lines t
      left join agg a on a.recon_store = t.recon_store and a.vendor = t.vendor
     where t.month = v_month
  ),
  extra as (
    select to_char(v_month, 'YYYY-MM') || '|' || a.recon_store || '|' || a.vendor key,
           100000 + (row_number() over (order by a.recon_store, a.vendor))::int sort,
           (select min(t.region) from public.parts_recon_tracker_lines t
             where t.month = v_month and t.recon_store = a.recon_store) region,
           a.recon_store, a.location_id, a.vendor,
           null::text script_status, null::numeric script_amount, null::text script_notes,
           a.n, a.n_open, a.n_review, a.amt, a.cred, a.lft,
           case when a.n_open + a.n_review > 0 then 'WAITING ON RESPONSE' else '' end st
      from agg a
     where not exists (select 1 from public.parts_recon_tracker_lines t
                        where t.month = v_month and t.recon_store = a.recon_store and t.vendor = a.vendor)
  ),
  every as (
    select * from lines
    union all
    select * from extra
  )
  select e.key, e.sort, e.region, e.recon_store, e.location_id, e.vendor,
         e.script_status, e.script_amount, e.script_notes,
         e.n, e.n_open, e.n_review, e.amt, e.cred, e.lft, e.st
    from every e
   where v_ap or public.parts_recon_can_see(e.location_id)
   order by e.sort, e.key;
end
$fn$;
revoke all on function public.parts_recon_tracker(date) from public, anon;
grant execute on function public.parts_recon_tracker(date) to authenticated;

notify pgrst, 'reload schema';
