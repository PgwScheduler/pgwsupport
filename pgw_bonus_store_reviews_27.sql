-- =====================================================================
-- PGW Support Portal — store managers enter their own review count
-- Run AFTER pgw_bonus_tracker_26.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Migration 26 put bonus_monthly_inputs on admin/master write, matching
-- the other goal tables. But a five-star review count is something the
-- store reports about itself, and making a manager phone an admin to log
-- it is how the field stays empty forever.
--
-- The table is NOT simply opened up, because two of its three columns are
-- not the store's to set:
--
--   referral_gp_credit    Model D's Midas referral credit adds directly
--                         into the gross profit the bonus is calculated
--                         on. A store that could type its own number
--                         could inflate its own payout.
--   phone_conversion_pct  waives the Model A credit-app penalty.
--
-- So writes are opened at the row level and a trigger holds the line at
-- the column level: anyone with access to the location may insert or
-- update the row, but only admin/master may move those two columns.
-- A store user's insert has them forced to their defaults, and an update
-- that tries to change them is refused with 42501 — the same code RLS
-- itself raises, so the app surfaces it identically.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ROW-LEVEL: anyone who can see the store can write its inputs row.
--    Delete stays admin/master — clearing a month is not routine.
-- ---------------------------------------------------------------------
drop policy if exists "bonus_monthly_inputs_write" on public.bonus_monthly_inputs;

drop policy if exists "bonus_monthly_inputs_insert" on public.bonus_monthly_inputs;
create policy "bonus_monthly_inputs_insert" on public.bonus_monthly_inputs
  for insert to authenticated
  with check (public.can_access_location(location_id));

drop policy if exists "bonus_monthly_inputs_update" on public.bonus_monthly_inputs;
create policy "bonus_monthly_inputs_update" on public.bonus_monthly_inputs
  for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));

drop policy if exists "bonus_monthly_inputs_delete" on public.bonus_monthly_inputs;
create policy "bonus_monthly_inputs_delete" on public.bonus_monthly_inputs
  for delete to authenticated
  using (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 2. COLUMN-LEVEL: the two money-moving fields stay admin/master.
--    Runs as the invoker — public.current_user_role() is already
--    SECURITY DEFINER (migration 01), so the role resolves correctly
--    without this function needing elevated rights of its own.
--    search_path is pinned anyway so the lookup cannot be redirected at
--    a shadowed function.
-- ---------------------------------------------------------------------
create or replace function public.bonus_inputs_column_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if public.current_user_role() in ('admin','master') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A store creating the row gets the defaults, whatever it sent.
    new.referral_gp_credit   := 0;
    new.phone_conversion_pct := null;
    return new;
  end if;

  -- The app upserts the whole row, so an untouched value arrives
  -- unchanged and passes. Only an actual edit is refused.
  if new.referral_gp_credit is distinct from old.referral_gp_credit then
    raise exception 'Only an admin can set the referral GP credit'
      using errcode = '42501';
  end if;
  if new.phone_conversion_pct is distinct from old.phone_conversion_pct then
    raise exception 'Only an admin can set phone conversion'
      using errcode = '42501';
  end if;

  return new;
end
$fn$;

drop trigger if exists bonus_inputs_column_guard on public.bonus_monthly_inputs;
create trigger bonus_inputs_column_guard
  before insert or update on public.bonus_monthly_inputs
  for each row execute function public.bonus_inputs_column_guard();


-- =====================================================================
-- VERIFY  (as a STORE user, on their own store)
--   1) Logging a review count now works:
--        insert into public.bonus_monthly_inputs
--               (location_id, plan_year, month, google_reviews)
--        values (<own store>, 2026, 7, 22)
--        on conflict (location_id, plan_year, month)
--          do update set google_reviews = excluded.google_reviews;
--   2) Setting the referral credit is refused with 42501:
--        update public.bonus_monthly_inputs set referral_gp_credit = 5000
--          where location_id = <own store> and plan_year = 2026 and month = 7;
--   3) Another store's row is still invisible and unwritable (0 rows / 42501).
--   4) As MASTER, both columns still move normally.
-- =====================================================================
