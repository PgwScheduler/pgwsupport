-- =====================================================================
-- Migration 84 — Closeout "entered by" names for every role
--
-- Why: parked 2026-10-07, picked up 2026-10-09. The Cash Drawer detail
-- ("entered by ...") and the closeout Excel export's "Entered by" row
-- look the name up in public.profiles. profiles is readable only for
-- your own row (or by admin/master), so for store, district, regional
-- and office logins the name came back blank for everyone but
-- themselves.
--
-- Fix: closeout_submitter_names(p_ids) returns id + full_name and
-- NOTHING else -- not role, scope or email, which is why this is a
-- function and not a wider profiles policy. A name comes back only if
-- that person submitted a closeout the caller can already see:
--   can_access_location()  store / district / regional / admin / master
--   office_can_read()      office (migration 78: real stores only)
-- So an id that never submitted a visible closeout returns nothing --
-- the function can't be used to look up arbitrary users.
--
-- No table or policy changes. Safe to re-run.
-- =====================================================================

create or replace function public.closeout_submitter_names(p_ids uuid[])
returns table (id uuid, full_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.full_name
    from public.profiles p
   where p.id = any (p_ids)
     and cardinality(p_ids) <= 1000
     and exists (
       select 1 from public.cash_drawer_closeouts c
        where c.submitted_by = p.id
          and (public.can_access_location(c.location_id)
               or public.office_can_read(c.location_id)));
$$;

comment on function public.closeout_submitter_names(uuid[]) is
  'Migration 84: id + full_name of the people who submitted cash drawer closeouts the caller can see. Names only; ids with no visible closeout return nothing.';

-- `revoke ... from public` alone is a no-op on Supabase: name anon too.
revoke all on function public.closeout_submitter_names(uuid[]) from public, anon;
grant execute on function public.closeout_submitter_names(uuid[]) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- VERIFY (as a store / district login in the portal: Cash Drawer detail
-- now shows "entered by <name>" for closeouts other people entered)
-- ---------------------------------------------------------------------
-- select count(*) from public.closeout_submitter_names(
--   array(select distinct submitted_by from public.cash_drawer_closeouts where submitted_by is not null));
