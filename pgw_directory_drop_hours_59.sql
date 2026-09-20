-- =====================================================================
-- PGW Support Portal — Directory: hours come off the store card
-- Run AFTER pgw_directory_store_email_58.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- The user, 2026-09-20: "get rid of the Hours option, I don't want that
-- listed." Weekly hours and the hours note come off the directory --
-- both the card and the admin form. Nobody had entered any (every
-- store's hours were null), so no information is lost.
--
-- THE COLUMNS STAY. locations.hours, locations.hours_note and
-- directory_hours_valid() are left in place, unused and commented as
-- such. Dropping them would be the one step that cannot be undone, and
-- they cost nothing empty; if hours are wanted back, the shape and its
-- check constraint are still here and only the two functions below and
-- the frontend have to come back with them.
--
-- directory_stores() and directory_update_store() are regenerated, the
-- update function DROPPED and recreated at 9 arguments (it loses
-- p_hours and p_hours_note) rather than widened, for the same reason as
-- 57 and 58: a defaulted argument leaves an overload PostgREST picks
-- from at random. So, as before, the deployed frontend cannot save a
-- store edit between this migration and its deploy.
-- =====================================================================

comment on column public.locations.hours is
  'UNUSED since migration 59: the directory no longer lists store hours. Shape and check constraint kept in case hours are wanted back. Nothing reads this.';
comment on column public.locations.hours_note is
  'UNUSED since migration 59 -- see locations.hours.';


-- ---------------------------------------------------------------------
-- directory_stores()  -- whitelist without hours
-- ---------------------------------------------------------------------
drop function if exists public.directory_stores();
create function public.directory_stores()
returns table (
  location_id   uuid,
  store_number  text,
  name          text,
  brand         text,
  shop_number   text,
  region_id     uuid,
  region_name   text,
  district_id   uuid,
  district_name text,
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  postal_code   text,
  main_phone    text,
  marchex_phone text,
  store_email   text,
  services      jsonb
)
language sql stable security definer set search_path = '' as $$
  select l.id, l.store_number, l.name, l.brand, l.horizon_shop_number,
         r.id, r.name, d.id, d.name,
         l.address_line1, l.address_line2, l.city, l.state, l.postal_code,
         l.main_phone, l.marchex_phone, l.store_email,
         coalesce(
           (select jsonb_agg(jsonb_build_object('code', st.code, 'label', st.label)
                             order by st.sort_order, st.label)
              from public.location_service_types lst
              join public.service_types st on st.id = lst.service_type_id
             where lst.location_id = l.id and st.active),
           '[]'::jsonb)
    from public.locations l
    left join public.districts d on d.id = l.district_id
    left join public.regions   r on r.id = d.region_id
   where not l.is_sandbox
     and auth.uid() is not null
   order by r.name nulls last, d.name nulls last, l.store_number nulls last, l.name;
$$;

revoke all on function public.directory_stores() from public, anon;
grant execute on function public.directory_stores() to authenticated;


-- ---------------------------------------------------------------------
-- directory_update_store()  -- without the two hours arguments
-- ---------------------------------------------------------------------
drop function if exists public.directory_update_store(uuid, text, text, text, text, text, text, text, text, jsonb, text);
drop function if exists public.directory_update_store(uuid, text, text, text, text, text, text, text, text);
create function public.directory_update_store(
  p_location_id   uuid,
  p_address_line1 text,
  p_address_line2 text,
  p_city          text,
  p_state         text,
  p_postal_code   text,
  p_main_phone    text,
  p_marchex_phone text,
  p_store_email   text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.current_user_role(), '') not in ('admin', 'master') then
    raise exception 'Only an admin can edit the directory' using errcode = '42501';
  end if;

  update public.locations
     set address_line1 = nullif(btrim(p_address_line1), ''),
         address_line2 = nullif(btrim(p_address_line2), ''),
         city          = nullif(btrim(p_city), ''),
         state         = upper(nullif(btrim(p_state), '')),
         postal_code   = nullif(btrim(p_postal_code), ''),
         main_phone    = nullif(btrim(p_main_phone), ''),
         marchex_phone = nullif(btrim(p_marchex_phone), ''),
         store_email   = nullif(lower(btrim(p_store_email)), '')
   where id = p_location_id
     and not is_sandbox;

  if not found then
    raise exception 'No directory store with id %', p_location_id using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.directory_update_store(uuid, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.directory_update_store(uuid, text, text, text, text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Hours are gone from the whitelist (expect no `hours` entry):
--        select proargnames from pg_proc where proname = 'directory_stores';
--
--  [2] Exactly one update function, taking 9 arguments:
--        select pronargs from pg_proc where proname = 'directory_update_store';
--
--  [3] Nothing was holding hours anyway (expect 0):
--        select count(*) from public.locations
--         where hours is not null or hours_note is not null;
-- =====================================================================
