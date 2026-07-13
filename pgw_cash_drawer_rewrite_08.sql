-- =====================================================================
-- PGW Support Portal — Rewrite cash_drawer_closeouts: full deposit sheet
-- Run AFTER pgw_employee_hours_weekly_07.sql.
-- =====================================================================
-- WHAT THIS DOES: the old table only stored a few totals. The real
-- deposit sheet has a lot more on it, and a manager needs to be able to
-- audit a shortage later — which means storing EVERYTHING the store
-- typed, not just the totals. This drops the old table (empty, no real
-- data yet) and rebuilds it with:
--
--   - open_counts / close_counts (jsonb): the denomination-by-denomination
--     drawer count (pennies through hundreds) for open and close.
--   - the typed-in daily sales summary fields (cash, checks, bread,
--     synchrony, cards, american_first, koalifi, snap, advance_pay,
--     prior_advance, sales_tax).
--   - overage_why / shortage_why: the explanation text, when there is one.
--   - four variable-length line-item lists stored as jsonb arrays:
--     poa_cards, poa_checks, fleet, payouts. Each row can have any number
--     of entries, so a fixed set of columns wouldn't work.
--   - submitted_by + created_at: who entered it and when.
--
-- All the derived numbers (cash to deposit, over/short, total sales,
-- store deposit to bank, etc.) are NOT stored — they get computed from
-- these raw inputs when the record is read, per the brief. That also
-- means the two "known quirks" from the original Excel (poa_checks_total
-- feeding nothing, sales_tax not flowing into total_sales) live entirely
-- in that read-time calculation, not in the schema.
--
-- RLS is unchanged in shape from the old table: view/add/edit scoped by
-- can_access_location(), delete stays master-only (the brief only asked
-- to loosen delete on employee_hours, not here).
-- =====================================================================

drop table if exists public.cash_drawer_closeouts cascade;

create table public.cash_drawer_closeouts (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references public.locations (id) on delete cascade,
  business_date  date not null,

  open_counts    jsonb not null default '{}'::jsonb,   -- {"pennies": 50, "nickels": 20, ...}
  close_counts   jsonb not null default '{}'::jsonb,

  cash           numeric(12,2) not null default 0,
  checks         numeric(12,2) not null default 0,
  bread          numeric(12,2) not null default 0,       -- Midas CC
  synchrony      numeric(12,2) not null default 0,        -- Sync Car Care
  cards          numeric(12,2) not null default 0,        -- Visa/Disc/Amex/Debit/MC
  american_first numeric(12,2) not null default 0,
  koalifi        numeric(12,2) not null default 0,
  snap           numeric(12,2) not null default 0,
  advance_pay    numeric(12,2) not null default 0,
  prior_advance  numeric(12,2) not null default 0,
  sales_tax      numeric(12,2) not null default 0,

  overage_why    text,
  shortage_why   text,

  poa_cards      jsonb not null default '[]'::jsonb,   -- [{customer, invoice, amount}]
  poa_checks     jsonb not null default '[]'::jsonb,   -- [{invoice, account, amount}]
  fleet          jsonb not null default '[]'::jsonb,   -- [{invoice, account, amount, auth}]
  payouts        jsonb not null default '[]'::jsonb,   -- [{vendor, ro, description, amount}]

  submitted_by   uuid references auth.users (id),
  created_at     timestamptz not null default now()
);

alter table public.cash_drawer_closeouts enable row level security;

drop policy if exists "cash_drawer_select" on public.cash_drawer_closeouts;
create policy "cash_drawer_select" on public.cash_drawer_closeouts for select to authenticated
  using (public.can_access_location(location_id));

drop policy if exists "cash_drawer_insert" on public.cash_drawer_closeouts;
create policy "cash_drawer_insert" on public.cash_drawer_closeouts for insert to authenticated
  with check (public.can_access_location(location_id));

drop policy if exists "cash_drawer_update" on public.cash_drawer_closeouts;
create policy "cash_drawer_update" on public.cash_drawer_closeouts for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));

drop policy if exists "cash_drawer_delete" on public.cash_drawer_closeouts;
create policy "cash_drawer_delete" on public.cash_drawer_closeouts for delete to authenticated
  using (public.current_user_role() = 'master');

-- Verify:
--   select column_name, data_type from information_schema.columns
--     where table_name = 'cash_drawer_closeouts' order by ordinal_position;
