-- =====================================================================
-- 66 -- Directory: district managers and up can edit store phone numbers
--
-- Why: the user, 2026-09-24. Store phone numbers (main + Marchex) were an
-- admin/master edit only (migration 55/57). They are now a DM-tier edit:
--
--   main_phone, marchex_phone   admin -> district / regional / admin / master
--   address, store email,
--   services offered            unchanged: admin / master only
--
-- A NEW definer function, directory_update_store_phones(), carries the
-- DM edit. directory_update_store() is left exactly as it is, so admins
-- keep their full editor and nothing already deployed breaks between
-- this migration and the frontend deploy.
--
-- Scope: can_access_location() already confines a district user to their
-- district and a regional user to their region (and keeps every non-admin
-- off the sandbox store), so a DM can only change their own stores.
-- Store users are refused.
--
-- Authorization runs BEFORE anything else (39c's lesson): a refused
-- caller gets 42501, never a "no such store" that confirms an id.
--
-- Run in the Supabase SQL Editor, AFTER migration 59. Repeatable.
-- =====================================================================

drop function if exists public.directory_update_store_phones(uuid, text, text);
create function public.directory_update_store_phones(
  p_location_id   uuid,
  p_main_phone    text,
  p_marchex_phone text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.current_user_role(), '') not in ('district', 'regional', 'admin', 'master')
     or not public.can_access_location(p_location_id) then
    raise exception 'You can only edit phone numbers for your own stores' using errcode = '42501';
  end if;

  update public.locations
     set main_phone    = nullif(btrim(p_main_phone), ''),
         marchex_phone = nullif(btrim(p_marchex_phone), '')
   where id = p_location_id
     and not is_sandbox;

  if not found then
    raise exception 'No directory store with id %', p_location_id using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.directory_update_store_phones(uuid, text, text) from public, anon;
grant execute on function public.directory_update_store_phones(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY -- in the SQL Editor
--
--  [1] The new function exists, 3 arguments, definer:
--        select pronargs, prosecdef from pg_proc
--         where proname = 'directory_update_store_phones';
--
--  [2] The admin editor is untouched (still 9 arguments):
--        select pronargs from pg_proc where proname = 'directory_update_store';
-- =====================================================================
