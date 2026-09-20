-- =====================================================================
-- PGW Support Portal — Company Directory v1.1
-- Run AFTER pgw_employee_profile_pay_history_56.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- BDC supplied Store_Phone_Numbers_Main_and_Marchex.xlsx (2026-09-20)
-- with a Marchex tracking number per store, and a starting list of
-- service types a store may offer. The data seed arrives separately, in
-- pgw_directory_seed_phones_57a.sql; this file is schema only.
--
-- WHAT THIS ADDS
--
-- 1. locations.marchex_phone -- the tracking number, beside main_phone.
--    Both are stored as the source holds them; the UI formats for
--    display (lib/directory.js formatPhone) and builds the tel: link.
--
-- 2. locations.updated_at, maintained by a trigger. The seed BDC's tool
--    produced sets it, and it was the one column in that file with no
--    home. Every other directory table already had one.
--
-- 3. service_types -- a catalogue admins extend in the portal at
--    runtime. `code` is the stable key and CANNOT be changed after
--    creation (a guard enforces it); `label` is display text and is
--    freely editable. Rows are deactivated, never deleted, so a code
--    that stores already point at cannot vanish.
--
-- 4. location_service_types -- which services each store offers.
--    UNLIKE the other directory tables this one DOES allow delete: a
--    store that stops offering alignments is not history worth keeping,
--    the row means "offers it today" and nothing points at it.
--
-- 5. directory_stores() gains marchex_phone and a `services` array, so
--    the directory still reads stores through ONE whitelisted function.
--    directory_update_store() gains p_marchex_phone -- its signature
--    changes, so the frontend must be deployed with it.
--
-- The sandbox is excluded here as everywhere else: it cannot be given
-- services, and directory_stores() still filters it out.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LOCATIONS: MARCHEX NUMBER + updated_at
-- ---------------------------------------------------------------------
alter table public.locations
  add column if not exists marchex_phone text null,
  add column if not exists updated_at    timestamptz not null default now();

comment on column public.locations.marchex_phone is
  'Marchex call-tracking number. Beside main_phone, never instead of it: the tracking line is what marketing publishes, the main line is the shop''s own.';

-- directory_touch_updated_at() is migration 55's.
drop trigger if exists locations_touch on public.locations;
create trigger locations_touch before update on public.locations
  for each row execute function public.directory_touch_updated_at();


-- ---------------------------------------------------------------------
-- 2. SERVICE TYPE CATALOGUE
-- ---------------------------------------------------------------------
create table if not exists public.service_types (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  label      text not null,
  sort_order int not null default 100,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_types_code_shape check (code ~ '^[a-z0-9_]+$'),
  constraint service_types_label_nonblank check (btrim(label) <> '')
);

comment on table public.service_types is
  'Directory service catalogue (ADAS recalibration, alignments, ...). Readable by every signed-in user; admin/master write. code is immutable once created; label is display text. Deactivate rather than delete.';

create table if not exists public.location_service_types (
  location_id     uuid not null references public.locations (id) on delete cascade,
  service_type_id uuid not null references public.service_types (id) on delete restrict,
  created_at      timestamptz not null default now(),
  primary key (location_id, service_type_id)
);

comment on table public.location_service_types is
  'Which services a store offers TODAY. Rows are added and removed as that changes -- no history is intended. Never points at a sandbox store.';

create index if not exists location_service_types_service_idx
  on public.location_service_types (service_type_id);

drop trigger if exists service_types_touch on public.service_types;
create trigger service_types_touch before update on public.service_types
  for each row execute function public.directory_touch_updated_at();

-- A code is a contract: seeds, and anything that later keys off it, must
-- keep meaning the same thing. Renaming is what `label` is for.
create or replace function public.service_types_code_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.code is distinct from old.code then
    raise exception 'A service type code cannot be changed (% -> %); edit the label instead', old.code, new.code
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists service_types_code_immutable on public.service_types;
create trigger service_types_code_immutable before update on public.service_types
  for each row execute function public.service_types_code_immutable();

-- The sandbox never appears in the directory, so it offers nothing.
create or replace function public.location_service_no_sandbox()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.locations l where l.id = new.location_id and l.is_sandbox) then
    raise exception 'A sandbox store cannot appear in the directory' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists location_service_no_sandbox on public.location_service_types;
create trigger location_service_no_sandbox before insert or update on public.location_service_types
  for each row execute function public.location_service_no_sandbox();

revoke all on function public.location_service_no_sandbox() from public, anon, authenticated;
revoke all on function public.service_types_code_immutable() from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 3. RLS  (the directory rule: everyone reads, admin/master writes)
-- ---------------------------------------------------------------------
alter table public.service_types          enable row level security;
alter table public.location_service_types enable row level security;

revoke all on public.service_types, public.location_service_types from anon;
revoke truncate on public.service_types, public.location_service_types from authenticated;
-- service_types is never deleted (a store may point at it); the link
-- table IS deleted, which is how a store stops offering something.
revoke delete on public.service_types from authenticated;
grant select, insert, update on public.service_types to authenticated;
grant select, insert, update, delete on public.location_service_types to authenticated;

drop policy if exists "service_types_select" on public.service_types;
create policy "service_types_select" on public.service_types for select to authenticated
  using (active or public.current_user_role() in ('admin','master'));

drop policy if exists "service_types_admin_insert" on public.service_types;
create policy "service_types_admin_insert" on public.service_types for insert to authenticated
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "service_types_admin_update" on public.service_types;
create policy "service_types_admin_update" on public.service_types for update to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "location_service_types_select" on public.location_service_types;
create policy "location_service_types_select" on public.location_service_types for select to authenticated
  using (true);

drop policy if exists "location_service_types_admin_write" on public.location_service_types;
create policy "location_service_types_admin_write" on public.location_service_types for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 4. directory_stores() -- now carrying the Marchex number and services
--    Still the ONLY way the directory reads locations, and still a
--    fixed whitelist. `services` is an ARRAY OF OBJECTS (code, label)
--    rather than ids, so the card renders without a second lookup;
--    inactive service types drop out here, not in the UI.
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
  hours         jsonb,
  hours_note    text,
  services      jsonb
)
language sql stable security definer set search_path = '' as $$
  select l.id, l.store_number, l.name, l.brand, l.horizon_shop_number,
         r.id, r.name, d.id, d.name,
         l.address_line1, l.address_line2, l.city, l.state, l.postal_code,
         l.main_phone, l.marchex_phone, l.hours, l.hours_note,
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
-- 5. directory_update_store() -- gains the Marchex number
--    DROPPED and recreated rather than widened: a defaulted argument
--    would create an OVERLOAD and PostgREST would pick one at random
--    (the lesson from report_build in migration 36).
-- ---------------------------------------------------------------------
drop function if exists public.directory_update_store(uuid, text, text, text, text, text, text, jsonb, text);
drop function if exists public.directory_update_store(uuid, text, text, text, text, text, text, text, jsonb, text);
create function public.directory_update_store(
  p_location_id   uuid,
  p_address_line1 text,
  p_address_line2 text,
  p_city          text,
  p_state         text,
  p_postal_code   text,
  p_main_phone    text,
  p_marchex_phone text,
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
         hours         = case when jsonb_typeof(p_hours) = 'null' then null else p_hours end,
         hours_note    = nullif(btrim(p_hours_note), '')
   where id = p_location_id
     and not is_sandbox;

  if not found then
    raise exception 'No directory store with id %', p_location_id using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.directory_update_store(uuid, text, text, text, text, text, text, text, jsonb, text) from public, anon;
grant execute on function public.directory_update_store(uuid, text, text, text, text, text, text, text, jsonb, text) to authenticated;


-- ---------------------------------------------------------------------
-- 6. directory_set_store_services() -- replace a store's service list
--    One call, so the store is never briefly half-updated, and the
--    admin check reads the same as everywhere else.
-- ---------------------------------------------------------------------
drop function if exists public.directory_set_store_services(uuid, uuid[]);
create function public.directory_set_store_services(p_location_id uuid, p_service_type_ids uuid[])
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(public.current_user_role(), '') not in ('admin', 'master') then
    raise exception 'Only an admin can edit the directory' using errcode = '42501';
  end if;
  if not exists (select 1 from public.locations l where l.id = p_location_id and not l.is_sandbox) then
    raise exception 'No directory store with id %', p_location_id using errcode = 'P0002';
  end if;

  delete from public.location_service_types lst
   where lst.location_id = p_location_id
     and not (lst.service_type_id = any(coalesce(p_service_type_ids, '{}'::uuid[])));

  insert into public.location_service_types (location_id, service_type_id)
  select p_location_id, s
    from unnest(coalesce(p_service_type_ids, '{}'::uuid[])) s
  on conflict do nothing;
end;
$$;

revoke all on function public.directory_set_store_services(uuid, uuid[]) from public, anon;
grant execute on function public.directory_set_store_services(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] The whitelist gained exactly two columns (marchex_phone, services):
--        select proargnames from pg_proc where proname = 'directory_stores';
--
--  [2] A code cannot be rewritten, a label can:
--        update public.service_types set code = 'x' where code = 'alignments';  -- 42501
--        update public.service_types set label = 'Alignments ' where code = 'alignments';
--
--  [3] The sandbox cannot be given a service (expect 22023):
--        insert into public.location_service_types (location_id, service_type_id)
--        select l.id, s.id from public.locations l, public.service_types s
--         where l.is_sandbox limit 1;
--
--  [4] Nothing else reads the old 9-argument update function:
--        select count(*) from pg_proc where proname = 'directory_update_store';  -- 1
-- =====================================================================
