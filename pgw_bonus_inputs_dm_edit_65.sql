-- =====================================================================
-- 65 -- Bonus monthly inputs: reviews + phone conversion are a DM edit
--
-- Why: the user, 2026-09-24. Migration 27 let any store user log its own
-- five-star review count and kept phone conversion admin-only. Both are
-- now set at district-manager level and above:
--
--   google_reviews         store -> district / regional / admin / master
--   phone_conversion_pct   admin -> district / regional / admin / master
--   referral_gp_credit     unchanged: admin / master only
--
-- Store users keep READ access (select policy untouched) and lose write
-- access to the row entirely -- the insert/update policies now require
-- the DM tier as well as access to the store. can_access_location()
-- already scopes a district user to their district and a regional user
-- to their region, so a DM can only edit their own stores.
--
-- The column guard stays for the one field DMs may not move: the referral
-- GP credit adds straight into Model D's bonus gross profit.
--
-- Review counts stores already entered are left as they are.
--
-- Run in the Supabase SQL Editor, AFTER migration 27. Repeatable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ROW-LEVEL: DM tier and above, on a store they can access.
--    Delete stays admin/master (migration 27, not touched).
-- ---------------------------------------------------------------------
drop policy if exists "bonus_monthly_inputs_insert" on public.bonus_monthly_inputs;
create policy "bonus_monthly_inputs_insert" on public.bonus_monthly_inputs
  for insert to authenticated
  with check (public.current_user_role() in ('district','regional','admin','master')
              and public.can_access_location(location_id));

drop policy if exists "bonus_monthly_inputs_update" on public.bonus_monthly_inputs;
create policy "bonus_monthly_inputs_update" on public.bonus_monthly_inputs
  for update to authenticated
  using      (public.current_user_role() in ('district','regional','admin','master')
              and public.can_access_location(location_id))
  with check (public.current_user_role() in ('district','regional','admin','master')
              and public.can_access_location(location_id));


-- ---------------------------------------------------------------------
-- 2. COLUMN-LEVEL: only the referral GP credit is still admin/master.
--    Phone conversion drops out of the guard.
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
    -- A DM creating the row gets the default credit, whatever it sent.
    new.referral_gp_credit := 0;
    return new;
  end if;

  -- The app upserts the whole row, so an untouched value arrives
  -- unchanged and passes. Only an actual edit is refused.
  if new.referral_gp_credit is distinct from old.referral_gp_credit then
    raise exception 'Only an admin can set the referral GP credit'
      using errcode = '42501';
  end if;

  return new;
end
$fn$;

-- Trigger from migration 27 already points at this function; recreated
-- anyway so this file stands on its own.
drop trigger if exists bonus_inputs_column_guard on public.bonus_monthly_inputs;
create trigger bonus_inputs_column_guard
  before insert or update on public.bonus_monthly_inputs
  for each row execute function public.bonus_inputs_column_guard();


-- =====================================================================
-- VERIFY
--   1) As a STORE user on their own store: an upsert of google_reviews is
--      refused (42501, row-level security) and the row still reads.
--   2) As a DISTRICT user on a store in their district: google_reviews and
--      phone_conversion_pct both save.
--   3) As that DISTRICT user: changing referral_gp_credit is refused 42501;
--      a store outside their district is invisible / unwritable.
--   4) As MASTER: all three columns move.
-- =====================================================================
