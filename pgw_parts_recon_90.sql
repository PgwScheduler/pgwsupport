-- =====================================================================
-- Migration 90 — Parts Recon: the monthly parts reconciliation in the portal
-- Run AFTER pgw_store_report_compare_89.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Why: the user, 2026-10-21 (briefs/2026-10-21_parts_recon_*.md,
-- Option 1). The Python recon scripts keep doing the matching exactly as
-- they do today. The portal takes over everything AFTER the run: the
-- store items and replies, AP's review, the AP to-do list and the
-- store x vendor tracker. It replaces the Store Response Tracker
-- workbook and the hand sync into management's shared tracker.
--
-- HOW DATA GETS IN. AP uploads the run's result workbooks on the Parts
-- Recon screen (RO Cost Breakdown, Parts Recon Detail, the filled
-- tracker, optionally the Store Response Tracker). The browser reads
-- them and sends rows here in chunks:
--     parts_recon_import_begin -> parts_recon_import_rows (xN) -> parts_recon_import_finish
-- Re-importing a month UPDATES the script's fields and KEEPS every reply,
-- review and done-flag. A row the new run no longer produces is marked
-- dropped (hidden, kept), and comes back if a later run produces it again.
--
-- WHO (defaults built for the boss's review, easy to change here):
--   AP team   master, admin, and anyone on parts_recon_ap_users (added by
--             master/admin on the screen). Imports, reviews, AP to-do,
--             tracker, release and close.
--   store     its own store's items, once the month is released; replies
--             and uploads credit memos.
--   district / regional   their stores' items; can reply for a store.
--   office    read-only, every store (released months).
--
-- STATUS of a store item
--   open             waiting on the store
--   answered         the store replied; waiting on AP's review
--   credit_received  AP confirmed the credit          -> left to deduct 0
--   partial_credit   AP confirmed part of it          -> amount - credit
--   explained        AP accepted the explanation      -> 0
--   deduct           AP says it stays a deduction     -> full amount
-- (the same rule as the Response Tracker's "Left to deduct" column)
--
-- Every read and write goes through the definer functions below; the
-- tables have RLS on and no policies.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

-- The recon scripts name stores their own way ("Decker", "Wesmark",
-- "SD North Charleston"). Mapped by store number, so a location rename
-- in the portal doesn't break it.
create table if not exists public.parts_recon_store_map (
  recon_name   text primary key,
  location_id  uuid not null references public.locations (id) on delete cascade
);

create table if not exists public.parts_recon_ap_users (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  added_by  uuid references auth.users (id) on delete set null,
  added_at  timestamptz not null default now()
);

create table if not exists public.parts_recon_months (
  month             date primary key check (extract(day from month) = 1),
  label             text not null,
  import_batch      uuid,
  imported_at       timestamptz,
  imported_by_name  text,
  files             jsonb not null default '[]'::jsonb,   -- [{name, size, modified}]
  check_totals      jsonb not null default '{}'::jsonb,   -- what the import checked
  released_at       timestamptz,                          -- stores can see it
  released_by_name  text,
  closed_at         timestamptz,                          -- replies and reviews locked
  closed_by_name    text
);

create table if not exists public.parts_recon_items (
  id                uuid primary key default gen_random_uuid(),
  month             date not null references public.parts_recon_months (month) on delete cascade,
  import_key        text not null,
  seen_batch        uuid,
  dropped_at        timestamptz,
  kind              text not null check (kind in ('ro_cost','divvy','arm')),
  recon_store       text not null,
  location_id       uuid references public.locations (id) on delete set null,
  vendor            text not null,
  tracker_vendor    text,                             -- the tracker row it rolls up to (Misc. for small vendors)
  ro                text,
  invoices          text,
  txn_date          date,
  billed            numeric(12,2),
  ro_cost           numeric(12,2),
  core              numeric(12,2),
  amount            numeric(12,2) not null default 0 check (amount >= 0),  -- amount in question
  ro_higher         numeric(12,2),                    -- RO is this much higher than the bill (no deduction)
  asked             text,                             -- what the store is asked to do
  why               text,                             -- what's causing it
  detail            jsonb not null default '{}'::jsonb, -- {parts:[...], lines:[...]}
  status            text not null default 'open'
                    check (status in ('open','answered','credit_received','partial_credit','explained','deduct')),
  store_action      text,
  store_credit_no   text,
  store_credit_amt  numeric(12,2),
  store_note        text,
  answered_at       timestamptz,
  answered_by_name  text,
  credit_no         text,
  credit_amt        numeric(12,2),
  credit_date       date,
  ap_note           text,
  reviewed_at       timestamptz,
  reviewed_by_name  text,
  updated_at        timestamptz not null default now(),
  unique (month, import_key)
);
create index if not exists parts_recon_items_loc on public.parts_recon_items (month, location_id);
-- Added while 90 was being written (a re-run on a copy that has the table).
alter table public.parts_recon_items add column if not exists tracker_vendor text;

create table if not exists public.parts_recon_item_files (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references public.parts_recon_items (id) on delete cascade,
  path              text not null unique,
  file_name         text not null,
  size_bytes        bigint,
  uploaded_by       uuid references auth.users (id) on delete set null,
  uploaded_by_name  text,
  uploaded_at       timestamptz not null default now()
);
create index if not exists parts_recon_item_files_item on public.parts_recon_item_files (item_id);

-- AP's work list: bills/credits to key, amount fixes, wrong supplier,
-- sales tax, AP-not-on-statement, unassigned charges, warranty add-backs,
-- and the RO questions the emails don't carry.
create table if not exists public.parts_recon_ap_tasks (
  id                uuid primary key default gen_random_uuid(),
  month             date not null references public.parts_recon_months (month) on delete cascade,
  import_key        text not null,
  seen_batch        uuid,
  dropped_at        timestamptz,
  kind              text not null check (kind in ('bill_not_in_ap','credit_not_in_ap','amount_diff','wrong_supplier',
                                                  'sales_tax','ap_not_on_statement','unassigned','warranty_addback',
                                                  'ro_not_on_parts_detail','no_ro_on_statement')),
  recon_store       text not null,
  location_id       uuid references public.locations (id) on delete set null,
  vendor            text,
  task              text not null,
  invoice           text,
  po                text,
  txn_date          date,
  stmt_amount       numeric(12,2),
  ap_amount         numeric(12,2),
  detail            text,
  done_at           timestamptz,
  done_by_name      text,
  note              text,
  unique (month, import_key)
);

-- Parts marked Stock on the RO but ordered on that RO's invoice: a note
-- for the store, never a deduction. Replaced on every import.
create table if not exists public.parts_recon_store_notes (
  id           bigint generated always as identity primary key,
  month        date not null references public.parts_recon_months (month) on delete cascade,
  recon_store  text not null,
  location_id  uuid references public.locations (id) on delete set null,
  vendor       text,
  ro           text,
  part         text,
  description  text,
  cost         numeric(12,2),
  ordered_on   text
);
create index if not exists parts_recon_store_notes_loc on public.parts_recon_store_notes (month, location_id);

-- Management's tracker, one row per Location x Vendor, as the run filled
-- it. The live amount and status are worked out from the items.
create table if not exists public.parts_recon_tracker_lines (
  month          date not null references public.parts_recon_months (month) on delete cascade,
  key            text not null,                       -- YYYY-MM|Location|Vendor (the tracker's Key column)
  sort           int not null default 0,
  region         text,
  recon_store    text not null,
  location_id    uuid references public.locations (id) on delete set null,
  vendor         text not null,
  script_status  text,
  script_amount  numeric(12,2),
  script_notes   text,
  primary key (month, key)
);

-- Credits that clear items from an EARLIER month (the Response
-- Tracker's Other Credits tab). Informational: they don't change this
-- month's left to deduct.
create table if not exists public.parts_recon_other_credits (
  id             uuid primary key default gen_random_uuid(),
  month          date not null references public.parts_recon_months (month) on delete cascade,
  recon_store    text not null,
  location_id    uuid references public.locations (id) on delete set null,
  vendor         text,
  credit_no      text,
  credit_date    date,
  orig_invoice   text,
  ro             text,
  parts          text,
  amount         numeric(12,2),
  for_month      text,
  notes          text,
  added_by_name  text,
  added_at       timestamptz not null default now()
);

alter table public.parts_recon_store_map     enable row level security;
alter table public.parts_recon_ap_users      enable row level security;
alter table public.parts_recon_months        enable row level security;
alter table public.parts_recon_items         enable row level security;
alter table public.parts_recon_item_files    enable row level security;
alter table public.parts_recon_ap_tasks      enable row level security;
alter table public.parts_recon_store_notes   enable row level security;
alter table public.parts_recon_tracker_lines enable row level security;
alter table public.parts_recon_other_credits enable row level security;

-- No table access for app users: every path is a definer function.
-- service_role for a later email function (explicit grants, 2026-10-30 rule).
grant all on public.parts_recon_store_map, public.parts_recon_ap_users, public.parts_recon_months,
             public.parts_recon_items, public.parts_recon_item_files, public.parts_recon_ap_tasks,
             public.parts_recon_store_notes, public.parts_recon_tracker_lines, public.parts_recon_other_credits
  to service_role;
revoke all on public.parts_recon_store_map, public.parts_recon_ap_users, public.parts_recon_months,
              public.parts_recon_items, public.parts_recon_item_files, public.parts_recon_ap_tasks,
              public.parts_recon_store_notes, public.parts_recon_tracker_lines, public.parts_recon_other_credits
  from anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. STORE MAP (from RUNBOOK.md section 6 and the store numbers)
-- ---------------------------------------------------------------------
insert into public.parts_recon_store_map (recon_name, location_id)
select v.recon_name, l.id
  from (values
    ('Decker','3984'), ('Millwood','3303'), ('Gervais','5254'), ('Bush River','3936'), ('Harbison','3229'),
    ('Hardscrabble','3937'), ('North Lake','3276'), ('Lake Murray','3979'), ('Knox Abbott','3278'),
    ('Two Notch','3935'), ('Greenville','3305'), ('Sam Ritt','3302'), ('Rivers','3385'), ('Mt Pleasant','3287'),
    ('Old Trolley','3182'), ('North Main','5253'), ('Florence','3377'), ('Wesmark','3938'), ('Beach','2321'),
    ('Sunbeam','3111'), ('Lem Turner','3136'), ('Atlantic','3548'), ('Orange Park','3292'), ('Gainesville','3211'),
    ('Oviedo','2322'), ('Semoran','2320'), ('Clinton','3923'), ('Temple Hills','3296'), ('Forestville','3593'),
    ('Capitol Heights','3485'), ('Duke','3473'), ('Rhode Island','3598'), ('Fairfax','3726'), ('Manassas','3831'),
    ('SD Lexington','3308'), ('SD Summerville','3009'), ('SD North Charleston','3029'), ('SD James Island','3025')
  ) v(recon_name, store_number)
  join public.locations l on l.store_number = v.store_number and not l.is_sandbox
on conflict (recon_name) do update set location_id = excluded.location_id;


-- ---------------------------------------------------------------------
-- 3. RULES
-- ---------------------------------------------------------------------
create or replace function public.parts_recon_is_ap()
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_user_role(), '') in ('master','admin')
      or exists (select 1 from public.parts_recon_ap_users u
                   join public.profiles p on p.id = u.user_id
                  where u.user_id = auth.uid() and coalesce(p.role, '') <> '');
$$;
revoke all on function public.parts_recon_is_ap() from public, anon, authenticated;

-- See a store's recon (released months only, for everyone but AP).
create or replace function public.parts_recon_can_see(p_loc uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select p_loc is not null
     and (public.parts_recon_is_ap() or public.can_access_location(p_loc) or public.office_can_read(p_loc));
$$;
revoke all on function public.parts_recon_can_see(uuid) from public, anon, authenticated;

-- Reply for a store: AP, the store itself, its DM or RM. Not office.
create or replace function public.parts_recon_can_answer(p_loc uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select p_loc is not null
     and (public.parts_recon_is_ap()
          or (coalesce(public.current_user_role(), '') in ('store','district','regional')
              and public.can_access_location(p_loc)));
$$;
revoke all on function public.parts_recon_can_answer(uuid) from public, anon, authenticated;

create or replace function public.parts_recon_month_visible(p_month date)
returns boolean
language sql stable security definer set search_path = '' as $$
  select public.parts_recon_is_ap()
      or exists (select 1 from public.parts_recon_months m where m.month = p_month and m.released_at is not null);
$$;
revoke all on function public.parts_recon_month_visible(date) from public, anon, authenticated;

-- What's still counted against the store (the Response Tracker formula).
create or replace function public.parts_recon_left(p_status text, p_amount numeric, p_credit numeric)
returns numeric
language sql immutable set search_path = '' as $$
  select case
           when p_status in ('credit_received','explained') then 0
           when p_status = 'partial_credit' then greatest(coalesce(p_amount, 0) - coalesce(p_credit, 0), 0)
           else coalesce(p_amount, 0)
         end;
$$;
revoke all on function public.parts_recon_left(text, numeric, numeric) from public, anon;
grant execute on function public.parts_recon_left(text, numeric, numeric) to authenticated;

create or replace function public.parts_recon_my_name()
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(trim(p.full_name), ''), p.email) from public.profiles p where p.id = auth.uid();
$$;
revoke all on function public.parts_recon_my_name() from public, anon, authenticated;

-- What the screen should offer the caller.
create or replace function public.parts_recon_access()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_ap',        public.parts_recon_is_ap(),
    'manages_team', coalesce(public.current_user_role(), '') in ('master','admin'),
    'can_answer',   public.parts_recon_is_ap()
                    or coalesce(public.current_user_role(), '') in ('store','district','regional'));
$$;
revoke all on function public.parts_recon_access() from public, anon;
grant execute on function public.parts_recon_access() to authenticated;


-- ---------------------------------------------------------------------
-- 4. AP TEAM (master/admin manage it)
-- ---------------------------------------------------------------------
create or replace function public.parts_recon_team()
returns table (user_id uuid, name text, email text, role text, added_at timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if coalesce(public.current_user_role(), '') not in ('master','admin') then
    raise exception 'Only master or admin can see the AP team.' using errcode = '42501';
  end if;
  return query
  select u.user_id, coalesce(nullif(trim(p.full_name), ''), p.email), p.email, p.role, u.added_at
    from public.parts_recon_ap_users u
    join public.profiles p on p.id = u.user_id
   order by 2;
end
$fn$;
revoke all on function public.parts_recon_team() from public, anon;
grant execute on function public.parts_recon_team() to authenticated;

create or replace function public.parts_recon_team_set(p_email text, p_on boolean)
returns void
language plpgsql security definer set search_path = '' as $fn$
declare v_uid uuid;
begin
  if coalesce(public.current_user_role(), '') not in ('master','admin') then
    raise exception 'Only master or admin can change the AP team.' using errcode = '42501';
  end if;
  select p.id into v_uid from public.profiles p where lower(p.email) = lower(trim(p_email));
  if v_uid is null then
    raise exception 'No portal login has the email %.', trim(p_email) using errcode = '22023';
  end if;
  if p_on then
    insert into public.parts_recon_ap_users (user_id, added_by) values (v_uid, auth.uid())
    on conflict (user_id) do nothing;
  else
    delete from public.parts_recon_ap_users where user_id = v_uid;
  end if;
end
$fn$;
revoke all on function public.parts_recon_team_set(text, boolean) from public, anon;
grant execute on function public.parts_recon_team_set(text, boolean) to authenticated;


-- ---------------------------------------------------------------------
-- 5. IMPORT (AP)
-- ---------------------------------------------------------------------
create or replace function public.parts_recon_import_begin(p_month date, p_label text, p_files jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_batch uuid := gen_random_uuid();
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can import a recon.' using errcode = '42501';
  end if;
  if exists (select 1 from public.parts_recon_months m where m.month = v_month and m.closed_at is not null) then
    raise exception 'That month is closed. Reopen it before importing again.' using errcode = '22023';
  end if;
  insert into public.parts_recon_months (month, label, import_batch, files)
  values (v_month, coalesce(nullif(trim(p_label), ''), to_char(v_month, 'FMMonth YYYY')), v_batch, coalesce(p_files, '[]'::jsonb))
  on conflict (month) do update
     set label = excluded.label, import_batch = excluded.import_batch, files = excluded.files;
  -- No reply state on these, so they're simply replaced.
  delete from public.parts_recon_store_notes   where month = v_month;
  delete from public.parts_recon_tracker_lines where month = v_month;
  return v_batch;
end
$fn$;
revoke all on function public.parts_recon_import_begin(date, text, jsonb) from public, anon;
grant execute on function public.parts_recon_import_begin(date, text, jsonb) to authenticated;

-- One chunk of rows. p_kind: items | tasks | notes | tracker | credits
create or replace function public.parts_recon_import_rows(p_month date, p_batch uuid, p_kind text, p_rows jsonb)
returns int
language plpgsql security definer set search_path = '' as $fn$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_n int;
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can import a recon.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.parts_recon_months m where m.month = v_month and m.import_batch = p_batch) then
    raise exception 'This import was replaced by a newer one. Start the import again.' using errcode = '22023';
  end if;

  if p_kind = 'items' then
    insert into public.parts_recon_items as i
      (month, import_key, seen_batch, dropped_at, kind, recon_store, location_id, vendor, tracker_vendor, ro, invoices, txn_date,
       billed, ro_cost, core, amount, ro_higher, asked, why, detail)
    select v_month, r.import_key, p_batch, null, r.kind, r.recon_store, sm.location_id, r.vendor,
           coalesce(nullif(trim(r.tracker_vendor), ''), r.vendor), r.ro, r.invoices, r.txn_date,
           r.billed, r.ro_cost, r.core, greatest(coalesce(r.amount, 0), 0), r.ro_higher, r.asked, r.why, coalesce(r.detail, '{}'::jsonb)
      from jsonb_to_recordset(p_rows) as r(import_key text, kind text, recon_store text, vendor text, tracker_vendor text, ro text, invoices text,
             txn_date date, billed numeric, ro_cost numeric, core numeric, amount numeric, ro_higher numeric,
             asked text, why text, detail jsonb)
      left join public.parts_recon_store_map sm on sm.recon_name = r.recon_store
    on conflict (month, import_key) do update
       set seen_batch = excluded.seen_batch, dropped_at = null, kind = excluded.kind,
           recon_store = excluded.recon_store, location_id = excluded.location_id, vendor = excluded.vendor,
           tracker_vendor = excluded.tracker_vendor, ro = excluded.ro, invoices = excluded.invoices, txn_date = excluded.txn_date, billed = excluded.billed,
           ro_cost = excluded.ro_cost, core = excluded.core, amount = excluded.amount, ro_higher = excluded.ro_higher,
           asked = excluded.asked, why = excluded.why, detail = excluded.detail,
           updated_at = case when i.amount is distinct from excluded.amount then now() else i.updated_at end;
  elsif p_kind = 'tasks' then
    insert into public.parts_recon_ap_tasks as t
      (month, import_key, seen_batch, dropped_at, kind, recon_store, location_id, vendor, task, invoice, po, txn_date,
       stmt_amount, ap_amount, detail)
    select v_month, r.import_key, p_batch, null, r.kind, r.recon_store, sm.location_id, r.vendor, r.task, r.invoice, r.po,
           r.txn_date, r.stmt_amount, r.ap_amount, r.detail
      from jsonb_to_recordset(p_rows) as r(import_key text, kind text, recon_store text, vendor text, task text,
             invoice text, po text, txn_date date, stmt_amount numeric, ap_amount numeric, detail text)
      left join public.parts_recon_store_map sm on sm.recon_name = r.recon_store
    on conflict (month, import_key) do update
       set seen_batch = excluded.seen_batch, dropped_at = null, kind = excluded.kind,
           recon_store = excluded.recon_store, location_id = excluded.location_id, vendor = excluded.vendor,
           task = excluded.task, invoice = excluded.invoice, po = excluded.po, txn_date = excluded.txn_date,
           stmt_amount = excluded.stmt_amount, ap_amount = excluded.ap_amount, detail = excluded.detail;
  elsif p_kind = 'notes' then
    insert into public.parts_recon_store_notes (month, recon_store, location_id, vendor, ro, part, description, cost, ordered_on)
    select v_month, r.recon_store, sm.location_id, r.vendor, r.ro, r.part, r.description, r.cost, r.ordered_on
      from jsonb_to_recordset(p_rows) as r(recon_store text, vendor text, ro text, part text, description text,
             cost numeric, ordered_on text)
      left join public.parts_recon_store_map sm on sm.recon_name = r.recon_store;
  elsif p_kind = 'tracker' then
    insert into public.parts_recon_tracker_lines
      (month, key, sort, region, recon_store, location_id, vendor, script_status, script_amount, script_notes)
    select v_month, r.key, r.sort, r.region, r.recon_store, sm.location_id, r.vendor, r.script_status, r.script_amount, r.script_notes
      from jsonb_to_recordset(p_rows) as r(key text, sort int, region text, recon_store text, vendor text,
             script_status text, script_amount numeric, script_notes text)
      left join public.parts_recon_store_map sm on sm.recon_name = r.recon_store
    on conflict (month, key) do update
       set sort = excluded.sort, region = excluded.region, recon_store = excluded.recon_store,
           location_id = excluded.location_id, vendor = excluded.vendor, script_status = excluded.script_status,
           script_amount = excluded.script_amount, script_notes = excluded.script_notes;
  elsif p_kind = 'credits' then
    -- Only on a month's first import, so credits AP added in the portal
    -- aren't duplicated by a re-import of the old workbook.
    if exists (select 1 from public.parts_recon_other_credits c where c.month = v_month) then
      return 0;
    end if;
    insert into public.parts_recon_other_credits
      (month, recon_store, location_id, vendor, credit_no, credit_date, orig_invoice, ro, parts, amount, for_month, notes, added_by_name)
    select v_month, r.recon_store, sm.location_id, r.vendor, r.credit_no, r.credit_date, r.orig_invoice, r.ro, r.parts,
           r.amount, r.for_month, r.notes, 'Response Tracker import'
      from jsonb_to_recordset(p_rows) as r(recon_store text, vendor text, credit_no text, credit_date date,
             orig_invoice text, ro text, parts text, amount numeric, for_month text, notes text)
      left join public.parts_recon_store_map sm on sm.recon_name = r.recon_store;
  else
    raise exception 'Unknown import part %.', p_kind using errcode = '22023';
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;
revoke all on function public.parts_recon_import_rows(date, uuid, text, jsonb) from public, anon;
grant execute on function public.parts_recon_import_rows(date, uuid, text, jsonb) to authenticated;

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
   where month = v_month and dropped_at is null and seen_batch is distinct from p_batch;
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
                                         where x.month = v_month and x.dropped_at is null and x.location_id is null), '[]'::jsonb))
    into v_out
    from public.parts_recon_items i where i.month = v_month;

  update public.parts_recon_months
     set imported_at = now(), imported_by_name = public.parts_recon_my_name(),
         check_totals = coalesce(p_check, '{}'::jsonb) || v_out
   where month = v_month;
  return v_out;
end
$fn$;
revoke all on function public.parts_recon_import_finish(date, uuid, jsonb) from public, anon;
grant execute on function public.parts_recon_import_finish(date, uuid, jsonb) to authenticated;

-- Carry over the statuses already worked in the Store Response Tracker
-- workbook. Only touches items the portal hasn't seen a reply or
-- review for, so it never overwrites work done here.
create or replace function public.parts_recon_apply_responses(p_month date, p_rows jsonb)
returns int
language plpgsql security definer set search_path = '' as $fn$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_n int;
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can import responses.' using errcode = '42501';
  end if;
  update public.parts_recon_items i
     set status = r.status, credit_no = nullif(trim(r.credit_no), ''), credit_amt = r.credit_amt,
         ap_note = nullif(trim(r.note), ''),
         reviewed_at = coalesce(r.answered::timestamptz, now()), reviewed_by_name = 'Response Tracker import',
         updated_at = now()
    from jsonb_to_recordset(p_rows) as r(import_key text, status text, credit_no text, credit_amt numeric,
           answered date, note text)
   where i.month = v_month and i.import_key = r.import_key
     and r.status in ('credit_received','partial_credit','explained','deduct')
     and i.status = 'open' and i.reviewed_at is null and i.answered_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;
revoke all on function public.parts_recon_apply_responses(date, jsonb) from public, anon;
grant execute on function public.parts_recon_apply_responses(date, jsonb) to authenticated;

-- Release to stores / close the month (and undo either).
create or replace function public.parts_recon_set_month(p_month date, p_released boolean, p_closed boolean)
returns void
language plpgsql security definer set search_path = '' as $fn$
declare v_month date := date_trunc('month', p_month)::date;
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can release or close a month.' using errcode = '42501';
  end if;
  update public.parts_recon_months m
     set released_at      = case when p_released then coalesce(m.released_at, now()) end,
         released_by_name = case when p_released then coalesce(m.released_by_name, public.parts_recon_my_name()) end,
         closed_at        = case when p_closed then coalesce(m.closed_at, now()) end,
         closed_by_name   = case when p_closed then coalesce(m.closed_by_name, public.parts_recon_my_name()) end
   where m.month = v_month;
  if not found then
    raise exception 'No recon for that month.' using errcode = '22023';
  end if;
end
$fn$;
revoke all on function public.parts_recon_set_month(date, boolean, boolean) from public, anon;
grant execute on function public.parts_recon_set_month(date, boolean, boolean) to authenticated;


-- ---------------------------------------------------------------------
-- 6. READING
-- ---------------------------------------------------------------------
-- Months the caller can see, with totals for the caller's stores.
drop function if exists public.parts_recon_months();
create or replace function public.parts_recon_months()
returns table (
  month         date,
  label         text,
  imported_at   timestamptz,
  imported_by_name text,
  released_at   timestamptz,
  closed_at     timestamptz,
  check_totals  jsonb,
  files         jsonb,
  items         int,
  open_items    int,
  to_review     int,
  amount        numeric,
  left_to_deduct numeric
)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_ap boolean := public.parts_recon_is_ap();
begin
  return query
  select m.month, m.label, m.imported_at, m.imported_by_name, m.released_at, m.closed_at,
         case when v_ap then m.check_totals else '{}'::jsonb end,
         case when v_ap then m.files else '[]'::jsonb end,
         count(i.id)::int,
         (count(i.id) filter (where i.status = 'open'))::int,
         (count(i.id) filter (where i.status = 'answered'))::int,
         coalesce(sum(i.amount), 0),
         coalesce(sum(public.parts_recon_left(i.status, i.amount, i.credit_amt)), 0)
    from public.parts_recon_months m
    left join public.parts_recon_items i
      on i.month = m.month and i.dropped_at is null
     and (v_ap or (i.kind <> 'arm' and public.parts_recon_can_see(i.location_id)))
   where v_ap or m.released_at is not null
   group by m.month
   order by m.month desc;
end
$fn$;
revoke all on function public.parts_recon_months() from public, anon;
grant execute on function public.parts_recon_months() to authenticated;

-- Store items for a month; p_location narrows to one store.
drop function if exists public.parts_recon_items(date, uuid);
create or replace function public.parts_recon_items(p_month date, p_location uuid default null)
returns table (
  id uuid, kind text, recon_store text, location_id uuid, store_number text, vendor text, ro text, invoices text,
  txn_date date, billed numeric, ro_cost numeric, core numeric, amount numeric, ro_higher numeric,
  asked text, why text, detail jsonb, status text, store_action text, store_credit_no text, store_credit_amt numeric,
  store_note text, answered_at timestamptz, answered_by_name text, credit_no text, credit_amt numeric,
  credit_date date, ap_note text, reviewed_at timestamptz, reviewed_by_name text, left_to_deduct numeric,
  files jsonb, can_answer boolean
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_ap boolean := public.parts_recon_is_ap();
  v_closed boolean;
begin
  if not public.parts_recon_month_visible(v_month) then
    return;
  end if;
  select m.closed_at is not null into v_closed from public.parts_recon_months m where m.month = v_month;
  return query
  select i.id, i.kind, i.recon_store, i.location_id, l.store_number::text, i.vendor, i.ro, i.invoices,
         i.txn_date, i.billed, i.ro_cost, i.core, i.amount, i.ro_higher,
         i.asked, i.why, i.detail, i.status, i.store_action, i.store_credit_no, i.store_credit_amt,
         i.store_note, i.answered_at, i.answered_by_name, i.credit_no, i.credit_amt,
         i.credit_date, i.ap_note, i.reviewed_at, i.reviewed_by_name,
         public.parts_recon_left(i.status, i.amount, i.credit_amt),
         coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'path', f.path, 'name', f.file_name,
                                                      'by', f.uploaded_by_name, 'at', f.uploaded_at) order by f.uploaded_at)
                     from public.parts_recon_item_files f where f.item_id = i.id), '[]'::jsonb),
         (not coalesce(v_closed, false)) and i.kind <> 'arm' and public.parts_recon_can_answer(i.location_id)
    from public.parts_recon_items i
    left join public.locations l on l.id = i.location_id
   where i.month = v_month and i.dropped_at is null
     and (p_location is null or i.location_id = p_location)
     and (v_ap or (i.kind <> 'arm' and public.parts_recon_can_see(i.location_id)))
   order by i.recon_store, i.vendor, i.amount desc, i.ro;
end
$fn$;
revoke all on function public.parts_recon_items(date, uuid) from public, anon;
grant execute on function public.parts_recon_items(date, uuid) to authenticated;

drop function if exists public.parts_recon_store_notes(date, uuid);
create or replace function public.parts_recon_store_notes(p_month date, p_location uuid default null)
returns table (recon_store text, location_id uuid, vendor text, ro text, part text, description text, cost numeric, ordered_on text)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_month date := date_trunc('month', p_month)::date;
begin
  if not public.parts_recon_month_visible(v_month) then
    return;
  end if;
  return query
  select n.recon_store, n.location_id, n.vendor, n.ro, n.part, n.description, n.cost, n.ordered_on
    from public.parts_recon_store_notes n
   where n.month = v_month
     and (p_location is null or n.location_id = p_location)
     and (public.parts_recon_is_ap() or public.parts_recon_can_see(n.location_id))
   order by n.recon_store, n.vendor, n.ro, n.part;
end
$fn$;
revoke all on function public.parts_recon_store_notes(date, uuid) from public, anon;
grant execute on function public.parts_recon_store_notes(date, uuid) to authenticated;

-- Management's tracker with live amounts: Amount = what's still left to
-- deduct on that Location x Vendor's items. Status: WAITING ON RESPONSE
-- while any item is open or waiting on review, otherwise what the run said.
drop function if exists public.parts_recon_tracker(date);
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
           count(*)::int n,
           (count(*) filter (where i.status = 'open'))::int n_open,
           (count(*) filter (where i.status = 'answered'))::int n_review,
           coalesce(sum(i.amount), 0) amt,
           coalesce(sum(i.amount - public.parts_recon_left(i.status, i.amount, i.credit_amt)), 0) cred,
           coalesce(sum(public.parts_recon_left(i.status, i.amount, i.credit_amt)), 0) lft
      from public.parts_recon_items i
     where i.month = v_month and i.dropped_at is null
     group by i.recon_store, coalesce(i.tracker_vendor, i.vendor)
  )
  select t.key, t.sort, t.region, t.recon_store, t.location_id, t.vendor,
         t.script_status, t.script_amount, t.script_notes,
         coalesce(a.n, 0), coalesce(a.n_open, 0), coalesce(a.n_review, 0),
         coalesce(a.amt, 0), coalesce(a.cred, 0),
         case when a.n is null then coalesce(t.script_amount, 0) else a.lft end,
         case when coalesce(a.n_open, 0) + coalesce(a.n_review, 0) > 0 then 'WAITING ON RESPONSE'
              else coalesce(t.script_status, '') end
    from public.parts_recon_tracker_lines t
    left join agg a on a.recon_store = t.recon_store and a.vendor = t.vendor
   where t.month = v_month
     and (v_ap or public.parts_recon_can_see(t.location_id))
   order by t.sort, t.key;
end
$fn$;
revoke all on function public.parts_recon_tracker(date) from public, anon;
grant execute on function public.parts_recon_tracker(date) to authenticated;


-- ---------------------------------------------------------------------
-- 7. STORE REPLY, AP REVIEW, FILES
-- ---------------------------------------------------------------------
create or replace function public.parts_recon_respond(
  p_item uuid, p_action text, p_credit_no text, p_credit_amt numeric, p_note text)
returns void
language plpgsql security definer set search_path = '' as $fn$
declare r record;
begin
  select i.*, m.released_at, m.closed_at into r
    from public.parts_recon_items i join public.parts_recon_months m on m.month = i.month
   where i.id = p_item and i.dropped_at is null;
  if not found or not public.parts_recon_can_answer(r.location_id) or r.kind = 'arm'
     or (r.released_at is null and not public.parts_recon_is_ap()) then
    raise exception 'You can''t reply to this item.' using errcode = '42501';
  end if;
  if r.closed_at is not null then
    raise exception 'This month is closed.' using errcode = '22023';
  end if;
  if r.status in ('credit_received','explained') then
    raise exception 'AP has already cleared this item.' using errcode = '22023';
  end if;
  if p_action not in ('returned','core_returned','other_vendor','explained','entered_in_ap','other') then
    raise exception 'Pick what you did.' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_credit_no, '')), '') is null and nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'Enter the credit # or a note.' using errcode = '22023';
  end if;
  if p_credit_amt is not null and p_credit_amt < 0 then
    raise exception 'Enter the credit amount as a positive number.' using errcode = '22023';
  end if;
  update public.parts_recon_items
     set status = 'answered', store_action = p_action,
         store_credit_no = nullif(trim(coalesce(p_credit_no, '')), ''), store_credit_amt = p_credit_amt,
         store_note = nullif(trim(coalesce(p_note, '')), ''),
         answered_at = now(), answered_by_name = public.parts_recon_my_name(), updated_at = now()
   where id = p_item;
end
$fn$;
revoke all on function public.parts_recon_respond(uuid, text, text, numeric, text) from public, anon;
grant execute on function public.parts_recon_respond(uuid, text, text, numeric, text) to authenticated;

create or replace function public.parts_recon_review(
  p_item uuid, p_status text, p_credit_no text, p_credit_amt numeric, p_credit_date date, p_note text)
returns void
language plpgsql security definer set search_path = '' as $fn$
declare r record;
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can review replies.' using errcode = '42501';
  end if;
  select i.*, m.closed_at into r
    from public.parts_recon_items i join public.parts_recon_months m on m.month = i.month
   where i.id = p_item;
  if not found then
    raise exception 'Not found.' using errcode = '22023';
  end if;
  if r.closed_at is not null then
    raise exception 'This month is closed. Reopen it to change a review.' using errcode = '22023';
  end if;
  if p_status not in ('open','answered','credit_received','partial_credit','explained','deduct') then
    raise exception 'Unknown status %.', p_status using errcode = '22023';
  end if;
  if p_status = 'partial_credit' and coalesce(p_credit_amt, 0) <= 0 then
    raise exception 'Enter how much was credited.' using errcode = '22023';
  end if;
  if p_credit_amt is not null and p_credit_amt < 0 then
    raise exception 'Enter the credit amount as a positive number.' using errcode = '22023';
  end if;
  update public.parts_recon_items
     set status = p_status,
         credit_no   = nullif(trim(coalesce(p_credit_no, '')), ''),
         credit_amt  = case when p_status = 'credit_received' then coalesce(p_credit_amt, amount) else p_credit_amt end,
         credit_date = p_credit_date,
         ap_note     = nullif(trim(coalesce(p_note, '')), ''),
         reviewed_at      = case when p_status in ('open','answered') then null else now() end,
         reviewed_by_name = case when p_status in ('open','answered') then null else public.parts_recon_my_name() end,
         updated_at = now()
   where id = p_item;
end
$fn$;
revoke all on function public.parts_recon_review(uuid, text, text, numeric, date, text) from public, anon;
grant execute on function public.parts_recon_review(uuid, text, text, numeric, date, text) to authenticated;

-- Storage path: <YYYY-MM>/<item id>/<anything>. Read = can see the item;
-- write = can reply to it while the month is open.
create or replace function public.parts_recon_file_ok(p_name text, p_write boolean)
returns boolean
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_item text := split_part(p_name, '/', 2);
  r record;
begin
  if v_item !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  select i.location_id, i.month, i.kind, m.released_at, m.closed_at into r
    from public.parts_recon_items i join public.parts_recon_months m on m.month = i.month
   where i.id = v_item::uuid;
  if not found or split_part(p_name, '/', 1) <> to_char(r.month, 'YYYY-MM') then
    return false;
  end if;
  if public.parts_recon_is_ap() then
    return not p_write or r.closed_at is null;
  end if;
  if r.released_at is null or r.kind = 'arm' then
    return false;
  end if;
  if p_write then
    return r.closed_at is null and public.parts_recon_can_answer(r.location_id);
  end if;
  return public.parts_recon_can_see(r.location_id);
end
$fn$;
revoke all on function public.parts_recon_file_ok(text, boolean) from public, anon;
grant execute on function public.parts_recon_file_ok(text, boolean) to authenticated;

insert into storage.buckets (id, name, public)
values ('parts-recon', 'parts-recon', false)
on conflict (id) do nothing;

drop policy if exists "parts_recon_bucket_select" on storage.objects;
create policy "parts_recon_bucket_select" on storage.objects for select to authenticated
  using (bucket_id = 'parts-recon' and public.parts_recon_file_ok(name, false));

drop policy if exists "parts_recon_bucket_insert" on storage.objects;
create policy "parts_recon_bucket_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'parts-recon' and public.parts_recon_file_ok(name, true));
-- No update/delete policy: an uploaded credit memo stays.

create or replace function public.parts_recon_file_added(p_item uuid, p_path text, p_name text, p_size bigint)
returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare v_id uuid;
begin
  if split_part(p_path, '/', 2) <> p_item::text or not public.parts_recon_file_ok(p_path, true) then
    raise exception 'You can''t add a file to this item.' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'parts-recon' and o.name = p_path) then
    raise exception 'Upload the file first.' using errcode = '22023';
  end if;
  insert into public.parts_recon_item_files (item_id, path, file_name, size_bytes, uploaded_by, uploaded_by_name)
  values (p_item, p_path, left(coalesce(nullif(trim(p_name), ''), 'file'), 200), p_size, auth.uid(), public.parts_recon_my_name())
  on conflict (path) do nothing
  returning id into v_id;
  return v_id;
end
$fn$;
revoke all on function public.parts_recon_file_added(uuid, text, text, bigint) from public, anon;
grant execute on function public.parts_recon_file_added(uuid, text, text, bigint) to authenticated;


-- ---------------------------------------------------------------------
-- 8. AP TO-DO and OTHER CREDITS (AP only)
-- ---------------------------------------------------------------------
drop function if exists public.parts_recon_tasks(date);
create or replace function public.parts_recon_tasks(p_month date)
returns table (
  id uuid, kind text, recon_store text, location_id uuid, vendor text, task text, invoice text, po text,
  txn_date date, stmt_amount numeric, ap_amount numeric, detail text, done_at timestamptz, done_by_name text, note text
)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can see the AP to-do list.' using errcode = '42501';
  end if;
  return query
  select t.id, t.kind, t.recon_store, t.location_id, t.vendor, t.task, t.invoice, t.po,
         t.txn_date, t.stmt_amount, t.ap_amount, t.detail, t.done_at, t.done_by_name, t.note
    from public.parts_recon_ap_tasks t
   where t.month = date_trunc('month', p_month)::date and t.dropped_at is null
   order by t.recon_store, t.vendor, t.kind, t.txn_date nulls last, t.invoice;
end
$fn$;
revoke all on function public.parts_recon_tasks(date) from public, anon;
grant execute on function public.parts_recon_tasks(date) to authenticated;

create or replace function public.parts_recon_task_done(p_id uuid, p_done boolean, p_note text)
returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can work the AP to-do list.' using errcode = '42501';
  end if;
  update public.parts_recon_ap_tasks
     set done_at      = case when p_done then coalesce(done_at, now()) end,
         done_by_name = case when p_done then coalesce(done_by_name, public.parts_recon_my_name()) end,
         note         = nullif(trim(coalesce(p_note, '')), '')
   where id = p_id;
end
$fn$;
revoke all on function public.parts_recon_task_done(uuid, boolean, text) from public, anon;
grant execute on function public.parts_recon_task_done(uuid, boolean, text) to authenticated;

drop function if exists public.parts_recon_other_credits(date);
create or replace function public.parts_recon_other_credits(p_month date)
returns table (id uuid, recon_store text, vendor text, credit_no text, credit_date date, orig_invoice text, ro text,
               parts text, amount numeric, for_month text, notes text, added_by_name text, added_at timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can see other credits.' using errcode = '42501';
  end if;
  return query
  select c.id, c.recon_store, c.vendor, c.credit_no, c.credit_date, c.orig_invoice, c.ro, c.parts, c.amount,
         c.for_month, c.notes, c.added_by_name, c.added_at
    from public.parts_recon_other_credits c
   where c.month = date_trunc('month', p_month)::date
   order by c.recon_store, c.credit_date nulls last, c.added_at;
end
$fn$;
revoke all on function public.parts_recon_other_credits(date) from public, anon;
grant execute on function public.parts_recon_other_credits(date) to authenticated;

create or replace function public.parts_recon_other_credit_save(
  p_month date, p_store text, p_vendor text, p_credit_no text, p_credit_date date, p_orig_invoice text,
  p_ro text, p_parts text, p_amount numeric, p_for_month text, p_notes text)
returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare v_id uuid;
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can log credits.' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_store, '')), '') is null then
    raise exception 'Pick the store.' using errcode = '22023';
  end if;
  insert into public.parts_recon_other_credits
    (month, recon_store, location_id, vendor, credit_no, credit_date, orig_invoice, ro, parts, amount, for_month, notes, added_by_name)
  select date_trunc('month', p_month)::date, trim(p_store), sm.location_id, nullif(trim(p_vendor), ''),
         nullif(trim(p_credit_no), ''), p_credit_date, nullif(trim(p_orig_invoice), ''), nullif(trim(p_ro), ''),
         nullif(trim(p_parts), ''), p_amount, nullif(trim(p_for_month), ''), nullif(trim(p_notes), ''),
         public.parts_recon_my_name()
    from (select 1) one
    left join public.parts_recon_store_map sm on sm.recon_name = trim(p_store)
  returning id into v_id;
  return v_id;
end
$fn$;
revoke all on function public.parts_recon_other_credit_save(date, text, text, text, date, text, text, text, numeric, text, text) from public, anon;
grant execute on function public.parts_recon_other_credit_save(date, text, text, text, date, text, text, text, numeric, text, text) to authenticated;

create or replace function public.parts_recon_other_credit_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can remove credits.' using errcode = '42501';
  end if;
  delete from public.parts_recon_other_credits where id = p_id;
end
$fn$;
revoke all on function public.parts_recon_other_credit_delete(uuid) from public, anon;
grant execute on function public.parts_recon_other_credit_delete(uuid) to authenticated;

-- Not attached to the audit log (81): the rows carry who answered,
-- reviewed and imported, and when.

notify pgrst, 'reload schema';
