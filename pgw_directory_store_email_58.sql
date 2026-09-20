-- =====================================================================
-- PGW Support Portal — Directory: store email address
-- Run AFTER pgw_directory_v11_57.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Asked for by the user 2026-09-20: the store directory needs a slot for
-- the STORE's own email address -- the shop mailbox, not a person's.
-- People's work emails already live on directory_contacts.
--
-- One address per store, like main_phone. A loose format check only
-- (something@something.something, no spaces): the portal must not be
-- the thing that refuses a real address because it looks unusual.
--
-- directory_stores() and directory_update_store() are regenerated; the
-- update function is DROPPED and recreated rather than widened, because
-- a defaulted argument leaves an overload PostgREST picks from at
-- random (migration 36's lesson, same as 57). The old 10-argument form
-- goes with it, so the frontend must ship alongside this.
-- =====================================================================

alter table public.locations
  add column if not exists store_email text null;

alter table public.locations drop constraint if exists locations_store_email_format;
alter table public.locations add constraint locations_store_email_format
  check (store_email is null or store_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

comment on column public.locations.store_email is
  'The store''s own mailbox, shown on its directory card. A person''s work email belongs on directory_contacts, not here.';


-- ---------------------------------------------------------------------
-- directory_stores()  -- whitelist + store_email
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
  hours         jsonb,
  hours_note    text,
  services      jsonb
)
language sql stable security definer set search_path = '' as $$
  select l.id, l.store_number, l.name, l.brand, l.horizon_shop_number,
         r.id, r.name, d.id, d.name,
         l.address_line1, l.address_line2, l.city, l.state, l.postal_code,
         l.main_phone, l.marchex_phone, l.store_email, l.hours, l.hours_note,
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
-- directory_update_store()  -- + p_store_email
-- ---------------------------------------------------------------------
drop function if exists public.directory_update_store(uuid, text, text, text, text, text, text, text, jsonb, text);
drop function if exists public.directory_update_store(uuid, text, text, text, text, text, text, text, text, jsonb, text);
create function public.directory_update_store(
  p_location_id   uuid,
  p_address_line1 text,
  p_address_line2 text,
  p_city          text,
  p_state         text,
  p_postal_code   text,
  p_main_phone    text,
  p_marchex_phone text,
  p_store_email   text,
  p_hours         jsonb,
  p_hours_note    text
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
         store_email   = nullif(lower(btrim(p_store_email)), ''),
         hours         = case when jsonb_typeof(p_hours) = 'null' then null else p_hours end,
         hours_note    = nullif(btrim(p_hours_note), '')
   where id = p_location_id
     and not is_sandbox;

  if not found then
    raise exception 'No directory store with id %', p_location_id using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.directory_update_store(uuid, text, text, text, text, text, text, text, text, jsonb, text) from public, anon;
grant execute on function public.directory_update_store(uuid, text, text, text, text, text, text, text, text, jsonb, text) to authenticated;

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] The whitelist gained exactly store_email:
--        select proargnames from pg_proc where proname = 'directory_stores';
--
--  [2] Exactly one update function, taking 11 arguments:
--        select pronargs from pg_proc where proname = 'directory_update_store';
--
--  [3] A nonsense address is refused (expect 23514):
--        update public.locations set store_email = 'not an email'
--         where store_number = '3303';
-- =====================================================================
