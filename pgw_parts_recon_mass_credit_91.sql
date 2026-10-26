-- =====================================================================
-- Migration 91 — Parts Recon: Mass Credit Import
-- Run AFTER pgw_parts_recon_90.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Why: the user, 2026-10-26. A store enters one vendor credit invoice
-- once and applies it to every item it covers -- a BULK VERSION OF THE
-- STORE REPLY (parts_recon_respond). AP's review is unchanged: each item
-- still lands in "Needs AP review" and is reviewed with the existing
-- form, prefilled from the store's credit # and $.
--
-- WHO: exactly who can "Send reply" today -- parts_recon_can_answer()
-- (the AP team, or a store / DM / RM for its own stores). ARM items are
-- never included (stores can't see them).
--
-- TABLE DESIGN
--   parts_recon_credit_batches       one row per credit invoice entered:
--                                    the header (store, vendor, credit #,
--                                    date, total, action, note), the memo
--                                    file, submitted_by / _name / _at.
--                                    Its id is chosen by the browser so
--                                    the memo can be uploaded first under
--                                    batches/<id>/.
--   parts_recon_credit_batch_lines   one row per item in the batch: the
--                                    item, its month, the line $, and
--                                    what happened to it ('replied', or
--                                    'earlier_month' when its month was
--                                    already closed). A line table, not a
--                                    batch_id column on the item: an item
--                                    AP sends back to open can be credited
--                                    again later, and the first batch must
--                                    still show it.
--   parts_recon_other_credits        gains item_id and batch_id, so a
--                                    credit logged for an earlier month
--                                    points at the exact item it clears.
--
-- THE MEMO FILE is stored once, on the batch. parts_recon_item_files
-- can't hold one file for many items (item_id is NOT NULL, path is
-- UNIQUE, and its storage rule requires <YYYY-MM>/<item id>/...), so
-- every item reaches the memo through its batch line instead.
--
-- CLOSED MONTHS: a line whose item's month AP has closed does not touch
-- the item (status and left to deduct stay as they are). It is written
-- to parts_recon_other_credits ("Credits for earlier months") for the
-- newest month that is NOT closed. If every month is closed the submit
-- is refused with that reason.
--
-- RLS mirrors parts_recon_items: RLS on, no policies, no access for
-- anon or authenticated; every read and write is a definer function
-- below. The sandbox store is left out of every cross-store list.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------
create table if not exists public.parts_recon_credit_batches (
  id                 uuid primary key,
  location_id        uuid not null references public.locations (id) on delete cascade,
  recon_store        text not null,
  vendor             text not null,
  credit_no          text not null,
  credit_date        date,
  total_amt          numeric(12,2) not null check (total_amt > 0),
  store_action       text not null,
  note               text,
  file_path          text unique,
  file_name          text,
  size_bytes         bigint,
  submitted_by       uuid references auth.users (id) on delete set null,
  submitted_by_name  text,
  submitted_at       timestamptz not null default now()
);
create index if not exists parts_recon_credit_batches_loc on public.parts_recon_credit_batches (location_id, submitted_at desc);
create index if not exists parts_recon_credit_batches_no  on public.parts_recon_credit_batches (location_id, lower(credit_no));

create table if not exists public.parts_recon_credit_batch_lines (
  id               uuid primary key default gen_random_uuid(),
  batch_id         uuid not null references public.parts_recon_credit_batches (id) on delete cascade,
  item_id          uuid not null references public.parts_recon_items (id) on delete cascade,
  item_month       date not null,
  amount           numeric(12,2) not null check (amount > 0),
  outcome          text not null check (outcome in ('replied','earlier_month')),
  other_credit_id  uuid references public.parts_recon_other_credits (id) on delete set null,
  unique (batch_id, item_id)
);
create index if not exists parts_recon_credit_batch_lines_item on public.parts_recon_credit_batch_lines (item_id);

alter table public.parts_recon_other_credits
  add column if not exists item_id  uuid references public.parts_recon_items (id) on delete set null,
  add column if not exists batch_id uuid references public.parts_recon_credit_batches (id) on delete set null;

alter table public.parts_recon_credit_batches     enable row level security;
alter table public.parts_recon_credit_batch_lines enable row level security;

-- Same grants as parts_recon_items (migration 90): service_role only.
grant all on public.parts_recon_credit_batches, public.parts_recon_credit_batch_lines to service_role;
revoke all on public.parts_recon_credit_batches, public.parts_recon_credit_batch_lines from anon, authenticated;


-- ---------------------------------------------------------------------
-- 2. RULES
-- ---------------------------------------------------------------------
-- Where a credit for a closed month is logged: the newest month AP
-- hasn't closed.
create or replace function public.parts_recon_open_month()
returns date
language sql stable security definer set search_path = '' as $$
  select max(m.month) from public.parts_recon_months m where m.closed_at is null;
$$;
revoke all on function public.parts_recon_open_month() from public, anon, authenticated;

-- An item the caller could credit: in the recon, not ARM, on a month
-- they can see (released, or AP), at a store they can reply for.
create or replace function public.parts_recon_creditable(p_item uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.parts_recon_items i
      join public.parts_recon_months m on m.month = i.month
      left join public.locations l on l.id = i.location_id
     where i.id = p_item and i.dropped_at is null and i.kind <> 'arm'
       and not coalesce(l.is_sandbox, false)
       and (m.released_at is not null or public.parts_recon_is_ap())
       and public.parts_recon_can_answer(i.location_id));
$$;
revoke all on function public.parts_recon_creditable(uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. PICKING (the store's entry screen)
-- ---------------------------------------------------------------------
-- Stores the caller can enter a credit for.
drop function if exists public.parts_recon_credit_stores();
create or replace function public.parts_recon_credit_stores()
returns table (location_id uuid, store_number text, recon_store text)
language sql stable security definer set search_path = '' as $$
  select distinct on (i.location_id) i.location_id, l.store_number::text, i.recon_store
    from public.parts_recon_items i
    join public.locations l on l.id = i.location_id
   where i.dropped_at is null and i.kind <> 'arm' and not l.is_sandbox
     and public.parts_recon_can_answer(i.location_id)
   order by i.location_id, i.recon_store;
$$;
revoke all on function public.parts_recon_credit_stores() from public, anon;
grant execute on function public.parts_recon_credit_stores() to authenticated;

-- Vendors at a store with something the caller could still credit.
drop function if exists public.parts_recon_credit_vendors(uuid);
create or replace function public.parts_recon_credit_vendors(p_location uuid)
returns table (vendor text, items int)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.parts_recon_can_answer(p_location) then
    raise exception 'You can''t enter credits for this store.' using errcode = '42501';
  end if;
  return query
  select i.vendor, count(*)::int
    from public.parts_recon_items i
   where i.location_id = p_location
     and public.parts_recon_creditable(i.id)
     and public.parts_recon_left(i.status, i.amount, i.credit_amt) > 0
   group by i.vendor
   order by i.vendor;
end
$fn$;
revoke all on function public.parts_recon_credit_vendors(uuid) from public, anon;
grant execute on function public.parts_recon_credit_vendors(uuid) to authenticated;

-- Items matching an RO # or an invoice number (inside the item's invoice
-- list), limited to the header's store and vendor and to items the
-- caller could credit. Closed months are included: their lines are
-- logged as earlier-month credits.
drop function if exists public.parts_recon_credit_candidates(uuid, text, text);
create or replace function public.parts_recon_credit_candidates(p_location uuid, p_vendor text, p_query text)
returns table (
  id uuid, month date, month_label text, month_closed boolean, ro text, invoices text,
  amount numeric, status text, credit_amt numeric, left_to_deduct numeric
)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_q text := lower(trim(coalesce(p_query, '')));
begin
  if not public.parts_recon_can_answer(p_location) then
    raise exception 'You can''t enter credits for this store.' using errcode = '42501';
  end if;
  if length(v_q) < 2 then
    return;
  end if;
  return query
  select i.id, i.month, m.label, m.closed_at is not null, i.ro, i.invoices,
         i.amount, i.status, i.credit_amt, public.parts_recon_left(i.status, i.amount, i.credit_amt)
    from public.parts_recon_items i
    join public.parts_recon_months m on m.month = i.month
   where i.location_id = p_location
     and i.vendor = p_vendor
     and public.parts_recon_creditable(i.id)
     and public.parts_recon_left(i.status, i.amount, i.credit_amt) > 0
     and (position(v_q in lower(coalesce(i.ro, ''))) > 0 or position(v_q in lower(coalesce(i.invoices, ''))) > 0)
   order by i.month desc, i.ro
   limit 50;
end
$fn$;
revoke all on function public.parts_recon_credit_candidates(uuid, text, text) from public, anon;
grant execute on function public.parts_recon_credit_candidates(uuid, text, text) to authenticated;

-- Has this credit # been used at this store already? (a warning, never a
-- block): store replies, AP reviews, earlier-month credits and batches.
drop function if exists public.parts_recon_credit_no_used(uuid, text);
create or replace function public.parts_recon_credit_no_used(p_location uuid, p_credit_no text)
returns table (source text, month date, ro text, amount numeric)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_no text := lower(trim(coalesce(p_credit_no, '')));
begin
  if not public.parts_recon_can_answer(p_location) then
    raise exception 'You can''t enter credits for this store.' using errcode = '42501';
  end if;
  if v_no = '' then
    return;
  end if;
  return query
  select 'store reply'::text, i.month, i.ro, i.store_credit_amt
    from public.parts_recon_items i
   where i.location_id = p_location and lower(trim(i.store_credit_no)) = v_no
  union all
  select 'AP review'::text, i.month, i.ro, i.credit_amt
    from public.parts_recon_items i
   where i.location_id = p_location and lower(trim(i.credit_no)) = v_no
  union all
  select 'credit for an earlier month'::text, c.month, c.ro, c.amount
    from public.parts_recon_other_credits c
   where c.location_id = p_location and lower(trim(c.credit_no)) = v_no
  order by 2, 3;
end
$fn$;
revoke all on function public.parts_recon_credit_no_used(uuid, text) from public, anon;
grant execute on function public.parts_recon_credit_no_used(uuid, text) to authenticated;


-- ---------------------------------------------------------------------
-- 4. SUBMIT -- one transaction, all or nothing
-- ---------------------------------------------------------------------
-- p_lines: [{"item_id": "...", "amount": 12.34}, ...]
-- Every rule is checked again here; the screen's checks are only a
-- convenience. Each open-month line is exactly parts_recon_respond():
-- store_action, store_credit_no, store_credit_amt, store_note,
-- status = answered. Each closed-month line leaves the item alone and
-- is logged to parts_recon_other_credits for the newest open month.
drop function if exists public.parts_recon_credit_batch_submit(uuid, uuid, text, text, date, numeric, text, text, text, text, bigint, jsonb);
create or replace function public.parts_recon_credit_batch_submit(
  p_batch uuid, p_location uuid, p_vendor text, p_credit_no text, p_credit_date date, p_total numeric,
  p_action text, p_note text, p_file_path text, p_file_name text, p_file_size bigint, p_lines jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_no      text := nullif(trim(coalesce(p_credit_no, '')), '');
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
  v_name    text := public.parts_recon_my_name();
  v_open    date := public.parts_recon_open_month();
  v_store   text;
  v_n       int;
  v_sum     numeric;
  v_left    numeric;
  v_oc      uuid;
  v_replied int := 0;
  v_earlier int := 0;
  ln        record;
  it        record;
begin
  -- Header
  if p_batch is null then
    raise exception 'Missing the batch id.' using errcode = '22023';
  end if;
  if not public.parts_recon_can_answer(p_location) then
    raise exception 'You can''t enter credits for this store.' using errcode = '42501';
  end if;
  if exists (select 1 from public.locations l where l.id = p_location and l.is_sandbox) then
    raise exception 'Not for the sandbox store.' using errcode = '22023';
  end if;
  if exists (select 1 from public.parts_recon_credit_batches b where b.id = p_batch) then
    raise exception 'This credit was already submitted.' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_vendor, '')), '') is null then
    raise exception 'Pick the vendor.' using errcode = '22023';
  end if;
  if v_no is null then
    raise exception 'Enter the credit #.' using errcode = '22023';
  end if;
  if p_total is null or p_total <= 0 or p_total <> round(p_total, 2) then
    raise exception 'Enter the credit total as a positive dollar amount.' using errcode = '22023';
  end if;
  if p_action not in ('returned','core_returned','other') then
    raise exception 'Pick what the credit is for.' using errcode = '22023';
  end if;
  if p_file_path is not null then
    if p_file_path not like 'batches/' || p_batch::text || '/%' then
      raise exception 'The credit memo is in the wrong place.' using errcode = '22023';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'parts-recon' and o.name = p_file_path) then
      raise exception 'Upload the credit memo first.' using errcode = '22023';
    end if;
  end if;

  -- Lines: present, well formed, no item twice, adding up to the total
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one item.' using errcode = '22023';
  end if;
  create temp table if not exists _credit_lines (n int, item_id uuid, amount numeric) on commit drop;
  delete from _credit_lines where true;
  insert into _credit_lines (n, item_id, amount)
  select x.n::int, (x.v ->> 'item_id')::uuid, (x.v ->> 'amount')::numeric
    from jsonb_array_elements(p_lines) with ordinality as x(v, n);
  if exists (select 1 from _credit_lines where item_id is null) then
    raise exception 'Every line needs an item.' using errcode = '22023';
  end if;
  if exists (select 1 from _credit_lines group by item_id having count(*) > 1) then
    raise exception 'An item is on the credit twice.' using errcode = '22023';
  end if;
  select count(*), sum(amount) into v_n, v_sum from _credit_lines;
  if v_sum is distinct from p_total then
    raise exception 'The lines add up to %, not the credit total of %.', v_sum, p_total using errcode = '22023';
  end if;

  -- Hold the items until the end, so two submits can't both use the
  -- same left to deduct.
  perform 1 from public.parts_recon_items i where i.id in (select item_id from _credit_lines) for update;

  select coalesce(min(i.recon_store), (select min(sm.recon_name) from public.parts_recon_store_map sm where sm.location_id = p_location))
    into v_store
    from public.parts_recon_items i where i.id in (select item_id from _credit_lines);

  insert into public.parts_recon_credit_batches
    (id, location_id, recon_store, vendor, credit_no, credit_date, total_amt, store_action, note,
     file_path, file_name, size_bytes, submitted_by, submitted_by_name)
  values (p_batch, p_location, coalesce(v_store, ''), trim(p_vendor), v_no, p_credit_date, p_total, p_action, v_note,
          p_file_path, left(coalesce(nullif(trim(p_file_name), ''), case when p_file_path is null then null else 'credit memo' end), 200),
          p_file_size, auth.uid(), v_name);

  for ln in select * from _credit_lines order by n loop
    select i.*, m.label as month_label, m.released_at, m.closed_at into it
      from public.parts_recon_items i join public.parts_recon_months m on m.month = i.month
     where i.id = ln.item_id;
    if not found or it.dropped_at is not null then
      raise exception 'Line %: that item is no longer in the recon.', ln.n using errcode = '22023';
    end if;
    if not public.parts_recon_creditable(it.id) or it.location_id is distinct from p_location then
      raise exception 'Line %: RO % isn''t one you can credit at this store.', ln.n, coalesce(it.ro, '—') using errcode = '42501';
    end if;
    if it.vendor <> trim(p_vendor) then
      raise exception 'Line %: RO % is a % item, not %.', ln.n, coalesce(it.ro, '—'), it.vendor, trim(p_vendor) using errcode = '22023';
    end if;
    if ln.amount is null or ln.amount <= 0 or ln.amount <> round(ln.amount, 2) then
      raise exception 'Line %: enter a credit above $0 for RO %.', ln.n, coalesce(it.ro, '—') using errcode = '22023';
    end if;
    v_left := public.parts_recon_left(it.status, it.amount, it.credit_amt);
    if ln.amount > v_left then
      raise exception 'Line %: $% is more than the $% left to deduct on RO %.', ln.n, ln.amount, v_left, coalesce(it.ro, '—') using errcode = '22023';
    end if;

    if it.closed_at is null then
      -- Exactly what Send reply does (parts_recon_respond).
      update public.parts_recon_items
         set status = 'answered', store_action = p_action,
             store_credit_no = v_no, store_credit_amt = ln.amount, store_note = v_note,
             answered_at = now(), answered_by_name = v_name, updated_at = now()
       where id = it.id;
      insert into public.parts_recon_credit_batch_lines (batch_id, item_id, item_month, amount, outcome)
      values (p_batch, it.id, it.month, ln.amount, 'replied');
      v_replied := v_replied + 1;
    else
      -- The item's month is closed: the item stays as it is; AP gets the
      -- credit under "Credits for earlier months".
      if v_open is null then
        raise exception 'Line %: RO % is in a closed month (%) and there is no open month to log the credit in. Ask AP.', ln.n, coalesce(it.ro, '—'), it.month_label using errcode = '22023';
      end if;
      insert into public.parts_recon_other_credits
        (month, recon_store, location_id, vendor, credit_no, credit_date, orig_invoice, ro, parts, amount, for_month, notes,
         added_by_name, item_id, batch_id)
      values (v_open, it.recon_store, it.location_id, it.vendor, v_no, p_credit_date, it.invoices, it.ro, null, ln.amount, it.month_label,
              'Mass credit entered by the store' || coalesce(': ' || v_note, ''), v_name, it.id, p_batch)
      returning id into v_oc;
      insert into public.parts_recon_credit_batch_lines (batch_id, item_id, item_month, amount, outcome, other_credit_id)
      values (p_batch, it.id, it.month, ln.amount, 'earlier_month', v_oc);
      v_earlier := v_earlier + 1;
    end if;
  end loop;

  return jsonb_build_object('batch_id', p_batch, 'lines', v_n, 'replied', v_replied, 'earlier_month', v_earlier, 'total', p_total);
end
$fn$;
revoke all on function public.parts_recon_credit_batch_submit(uuid, uuid, text, text, date, numeric, text, text, text, text, bigint, jsonb) from public, anon;
grant execute on function public.parts_recon_credit_batch_submit(uuid, uuid, text, text, date, numeric, text, text, text, text, bigint, jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 5. READING BATCHES (no edit or delete: a batch is history)
-- ---------------------------------------------------------------------
-- One batch with every line, for whoever can see the store's recon.
drop function if exists public.parts_recon_credit_batch(uuid);
create or replace function public.parts_recon_credit_batch(p_batch uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare b record;
begin
  select cb.*, l.store_number::text as store_number into b
    from public.parts_recon_credit_batches cb join public.locations l on l.id = cb.location_id
   where cb.id = p_batch;
  if not found or not public.parts_recon_can_see(b.location_id) then
    return null;
  end if;
  return jsonb_build_object(
    'id', b.id, 'location_id', b.location_id, 'store_number', b.store_number, 'recon_store', b.recon_store,
    'vendor', b.vendor, 'credit_no', b.credit_no, 'credit_date', b.credit_date, 'total', b.total_amt,
    'store_action', b.store_action, 'note', b.note, 'file_path', b.file_path, 'file_name', b.file_name,
    'submitted_by_name', b.submitted_by_name, 'submitted_at', b.submitted_at,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'item_id', ln.item_id, 'month', ln.item_month, 'month_label', m.label, 'amount', ln.amount,
               'outcome', ln.outcome, 'ro', i.ro, 'invoices', i.invoices, 'item_amount', i.amount,
               'status', i.status, 'left_to_deduct', public.parts_recon_left(i.status, i.amount, i.credit_amt))
             order by ln.item_month desc, i.ro)
        from public.parts_recon_credit_batch_lines ln
        join public.parts_recon_items i on i.id = ln.item_id
        join public.parts_recon_months m on m.month = ln.item_month
       where ln.batch_id = b.id), '[]'::jsonb));
end
$fn$;
revoke all on function public.parts_recon_credit_batch(uuid) from public, anon;
grant execute on function public.parts_recon_credit_batch(uuid) to authenticated;

-- For a month's item list: the latest batch each item is on.
drop function if exists public.parts_recon_item_batches(date, uuid);
create or replace function public.parts_recon_item_batches(p_month date, p_location uuid default null)
returns table (item_id uuid, batch_id uuid, credit_no text, lines int, total numeric, outcome text)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_month date := date_trunc('month', p_month)::date;
begin
  if not public.parts_recon_month_visible(v_month) then
    return;
  end if;
  return query
  select distinct on (ln.item_id) ln.item_id, b.id, b.credit_no,
         (select count(*)::int from public.parts_recon_credit_batch_lines x where x.batch_id = b.id),
         b.total_amt, ln.outcome
    from public.parts_recon_credit_batch_lines ln
    join public.parts_recon_credit_batches b on b.id = ln.batch_id
    join public.parts_recon_items i on i.id = ln.item_id
   where ln.item_month = v_month
     and (p_location is null or i.location_id = p_location)
     and (public.parts_recon_is_ap() or (i.kind <> 'arm' and public.parts_recon_can_see(i.location_id)))
   order by ln.item_id, b.submitted_at desc;
end
$fn$;
revoke all on function public.parts_recon_item_batches(date, uuid) from public, anon;
grant execute on function public.parts_recon_item_batches(date, uuid) to authenticated;

-- Credits entered, newest first (sandbox left out).
drop function if exists public.parts_recon_credit_batch_list(uuid);
create or replace function public.parts_recon_credit_batch_list(p_location uuid default null)
returns table (
  id uuid, location_id uuid, store_number text, recon_store text, vendor text, credit_no text, credit_date date,
  total numeric, lines int, earlier_month int, submitted_by_name text, submitted_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select b.id, b.location_id, l.store_number::text, b.recon_store, b.vendor, b.credit_no, b.credit_date, b.total_amt,
         (select count(*)::int from public.parts_recon_credit_batch_lines x where x.batch_id = b.id),
         (select count(*)::int from public.parts_recon_credit_batch_lines x where x.batch_id = b.id and x.outcome = 'earlier_month'),
         b.submitted_by_name, b.submitted_at
    from public.parts_recon_credit_batches b
    join public.locations l on l.id = b.location_id
   where not l.is_sandbox
     and (p_location is null or b.location_id = p_location)
     and public.parts_recon_can_see(b.location_id)
   order by b.submitted_at desc
   limit 200;
$$;
revoke all on function public.parts_recon_credit_batch_list(uuid) from public, anon;
grant execute on function public.parts_recon_credit_batch_list(uuid) to authenticated;

-- AP's "Credits for earlier months" list, now with the item and batch.
drop function if exists public.parts_recon_other_credits(date);
create or replace function public.parts_recon_other_credits(p_month date)
returns table (id uuid, recon_store text, vendor text, credit_no text, credit_date date, orig_invoice text, ro text,
               parts text, amount numeric, for_month text, notes text, added_by_name text, added_at timestamptz,
               item_id uuid, batch_id uuid)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.parts_recon_is_ap() then
    raise exception 'Only the AP team can see other credits.' using errcode = '42501';
  end if;
  return query
  select c.id, c.recon_store, c.vendor, c.credit_no, c.credit_date, c.orig_invoice, c.ro, c.parts, c.amount,
         c.for_month, c.notes, c.added_by_name, c.added_at, c.item_id, c.batch_id
    from public.parts_recon_other_credits c
   where c.month = date_trunc('month', p_month)::date
   order by c.recon_store, c.credit_date nulls last, c.added_at;
end
$fn$;
revoke all on function public.parts_recon_other_credits(date) from public, anon;
grant execute on function public.parts_recon_other_credits(date) to authenticated;


-- ---------------------------------------------------------------------
-- 6. THE MEMO FILE: batches/<batch id>/<anything> in the parts-recon bucket
-- ---------------------------------------------------------------------
-- Upload: before the batch exists, by someone who can reply for a store.
-- Read: once the batch exists, by whoever can see that store's recon.
create or replace function public.parts_recon_batch_file_ok(p_name text, p_write boolean)
returns boolean
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_id text := split_part(p_name, '/', 2);
  b record;
begin
  if split_part(p_name, '/', 1) <> 'batches'
     or v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  select cb.location_id, cb.file_path into b from public.parts_recon_credit_batches cb where cb.id = v_id::uuid;
  if p_write then
    return not found
       and (public.parts_recon_is_ap() or coalesce(public.current_user_role(), '') in ('store','district','regional'));
  end if;
  return found and b.file_path = p_name and public.parts_recon_can_see(b.location_id);
end
$fn$;
revoke all on function public.parts_recon_batch_file_ok(text, boolean) from public, anon;
grant execute on function public.parts_recon_batch_file_ok(text, boolean) to authenticated;

drop policy if exists "parts_recon_batch_file_select" on storage.objects;
create policy "parts_recon_batch_file_select" on storage.objects for select to authenticated
  using (bucket_id = 'parts-recon' and public.parts_recon_batch_file_ok(name, false));

drop policy if exists "parts_recon_batch_file_insert" on storage.objects;
create policy "parts_recon_batch_file_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'parts-recon' and public.parts_recon_batch_file_ok(name, true));
-- No update/delete policy: a submitted memo stays.

notify pgrst, 'reload schema';
