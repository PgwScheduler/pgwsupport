-- =====================================================================
-- PGW Support Portal — Company Directory (v1)
-- Run AFTER pgw_duplicate_handouts_confirmed_54.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- A company-wide directory with two tabs, Stores and People. EVERY
-- signed-in user reads ALL of it, whatever their location scope. Only
-- admin/master write it.
--
-- That is a deliberate exception to the portal's can_access_location()
-- read scoping, and it is built so it cannot become a side door into the
-- location-scoped tables:
--
--   * Stores are read through directory_stores(), a SECURITY DEFINER
--     function returning a fixed WHITELIST of columns. The locations
--     table's RLS is NOT touched -- a store user still sees exactly one
--     row when they select from locations directly.
--   * People live in their own table, directory_contacts, carrying their
--     own display name and title. The optional employee_id link is for
--     admin convenience only and nothing user-facing ever follows it;
--     employees and employee_pay_rates keep their policies unchanged.
--
-- DECISIONS THAT LOOK WRONG WITHOUT THE REASON
--
-- 1. The brief numbered this "40 if nothing has landed since 39c". 40-54
--    have all landed, so it is 55.
--
-- 2. Admins edit store fields through directory_update_store(), NOT an
--    UPDATE policy on locations. Postgres RLS is row-level: an admin
--    UPDATE policy would let an admin rewrite store_number,
--    horizon_shop_number and is_sandbox too -- the last of which is the
--    only thing keeping fake data out of every rollup. The function IS
--    the column whitelist. Master keeps its existing full write policy.
--
-- 3. locations already had `address` (one free-text line, seeded for
--    every store in migration 3) and `phone` (migration 38, set for
--    Oviedo and Semoran only). Neither is read by the app. The brief's
--    structured columns are added as specified and BACKFILLED from them
--    once, below; the two old columns are left in place and commented
--    as superseded rather than dropped. BDC's seed spreadsheet (open
--    decision 1) overwrites the backfill.
--
-- 4. Coverage rows are never deleted either. The brief gives no DELETE
--    policy on either table, but an admin still has to be able to move
--    a DM from one district to another. So coverage carries its own
--    `active` flag: taking a row off the contact form deactivates it,
--    putting it back reactivates the same row. Deactivating a CONTACT
--    leaves its coverage rows exactly as they were (acceptance check 6).
--
-- 5. Inactive contacts are hidden from non-admins at the RLS level, not
--    just in the UI. The brief says "SELECT for any authenticated user";
--    this is strictly narrower (a former employee's work phone is not
--    part of the directory), and admins still see them to reactivate.
--
-- 6. "Inactive/divested stores" are excluded by is_sandbox only, the
--    same test every other cross-location scope site uses. There is NO
--    divested/inactive mechanism on locations: Rabon Rd, Broad River and
--    Old Bush were never seeded (see pgw_seed_bonus_2026.sql), so they
--    cannot appear. When a divested flag is added, directory_stores() is
--    one more site that must learn it. (#3936 Midas Bush River is a LIVE
--    store and is NOT "Old Bush".)
--
-- 7. The store count is 38, not the brief's 36. Migration 38 added
--    #2322 Midas Oviedo and 38a #2320 Midas Semoran after the 36-store
--    seed; both are real stores with districts. Value Service is the
--    39th location and is the one excluded.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'public' and t.typname = 'directory_role_category') then
    create type public.directory_role_category as enum
      ('store_manager', 'district_manager', 'regional_director', 'office');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where n.nspname = 'public' and t.typname = 'directory_scope_type') then
    create type public.directory_scope_type as enum
      ('store', 'district', 'region', 'company');
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 2. LOCATIONS: DIRECTORY COLUMNS
-- ---------------------------------------------------------------------

-- Weekly hours: an object with EXACTLY the seven keys mon..sun, each
-- either null (closed) or {"open":"HH:MM","close":"HH:MM"} in 24-hour
-- local store time with open < close. All seven keys are required so
-- "closed" (null) can never be confused with "not entered" (key
-- missing); a store whose hours nobody has entered has hours = null.
create or replace function public.directory_hours_valid(h jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select h is null or (
    jsonb_typeof(h) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(h) k)
        = array['fri','mon','sat','sun','thu','tue','wed']
    and not exists (
      select 1
        from jsonb_each(h) e(day, v)
       where not (
         jsonb_typeof(v) = 'null'
         or (    jsonb_typeof(v) = 'object'
             and (select array_agg(k order by k) from jsonb_object_keys(v) k) = array['close','open']
             and jsonb_typeof(v->'open')  = 'string'
             and jsonb_typeof(v->'close') = 'string'
             and (v->>'open')  ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
             and (v->>'close') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
             and (v->>'open') < (v->>'close'))
       )
    )
  );
$$;

alter table public.locations
  add column if not exists address_line1 text null,
  add column if not exists address_line2 text null,
  add column if not exists city          text null,
  add column if not exists state         text null,
  add column if not exists postal_code   text null,
  add column if not exists main_phone    text null,
  add column if not exists hours         jsonb null,
  add column if not exists hours_note    text null;

alter table public.locations drop constraint if exists locations_hours_shape;
alter table public.locations add constraint locations_hours_shape
  check (public.directory_hours_valid(hours));

alter table public.locations drop constraint if exists locations_state_format;
alter table public.locations add constraint locations_state_format
  check (state is null or state ~ '^[A-Z]{2}$');

alter table public.locations drop constraint if exists locations_postal_code_format;
alter table public.locations add constraint locations_postal_code_format
  check (postal_code is null or postal_code ~ '^[0-9]{5}(-[0-9]{4})?$');

comment on column public.locations.hours is
  'Directory weekly hours: {mon..sun: null (closed) | {"open":"HH:MM","close":"HH:MM"}}, 24-hour local store time. NULL = not entered. Shape enforced by directory_hours_valid().';
comment on column public.locations.hours_note is
  'Free-text hours note shown under the weekly hours (e.g. "Closed Sundays", seasonal changes). Holiday hours are out of scope for v1.';
comment on column public.locations.main_phone is
  'Directory main phone. Supersedes locations.phone (migration 38), which is no longer read.';
comment on column public.locations.address is
  'LEGACY one-line address from the migration 3 seed. Superseded by address_line1/address_line2/city/state/postal_code (migration 55); not read by the app.';
comment on column public.locations.phone is
  'LEGACY (migration 38). Superseded by main_phone (migration 55); not read by the app.';

-- One-time backfill from the legacy columns, only into rows the
-- directory has not been given data for yet, so a re-run never
-- clobbers an admin's edit. Every seeded address has the shape
-- "street, city, ST 12345"; anything that does not parse is left null.
update public.locations l
   set address_line1 = m[1],
       city          = m[2],
       state         = m[3],
       postal_code   = m[4]
  from (select id, regexp_match(btrim(address),
                 '^(.+),\s*([^,]+),\s*([A-Z]{2})\s+([0-9]{5}(?:-[0-9]{4})?)$') m
          from public.locations) p
 where p.id = l.id
   and p.m is not null
   and l.address_line1 is null and l.city is null and l.state is null and l.postal_code is null;

update public.locations
   set main_phone = btrim(phone)
 where main_phone is null and nullif(btrim(phone), '') is not null;


-- ---------------------------------------------------------------------
-- 3. DIRECTORY CONTACTS
--    Work contact info only -- never a personal cell number.
-- ---------------------------------------------------------------------
create table if not exists public.directory_contacts (
  id            uuid primary key default gen_random_uuid(),
  -- Admin convenience only. NEVER followed in a user-facing query:
  -- employees is location-scoped and the directory is not.
  employee_id   uuid null references public.employees (id) on delete set null,
  display_name  text not null,
  title         text not null,
  role_category public.directory_role_category not null,
  work_phone    text null,
  work_email    text null,
  active        boolean not null default true,
  sort_order    int null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint directory_contacts_name_nonblank  check (btrim(display_name) <> ''),
  constraint directory_contacts_title_nonblank check (btrim(title) <> ''),
  constraint directory_contacts_email_format
    check (work_email is null or work_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

comment on table public.directory_contacts is
  'Company directory people. Readable by every signed-in user (active rows; admins also see inactive). Written by admin/master only; never deleted -- deactivate with active = false.';

-- ---------------------------------------------------------------------
-- 4. COVERAGE
--    Scope references reuse the existing hierarchy (locations,
--    districts, regions) -- no parallel district/region list. Exactly
--    the reference matching scope_type is set; company has none.
-- ---------------------------------------------------------------------
create table if not exists public.directory_contact_coverage (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references public.directory_contacts (id),
  scope_type  public.directory_scope_type not null,
  location_id uuid null references public.locations (id),
  district_id uuid null references public.districts (id),
  region_id   uuid null references public.regions (id),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint directory_coverage_scope_ref check (
       (scope_type = 'store'    and location_id is not null and district_id is null     and region_id is null)
    or (scope_type = 'district' and location_id is null     and district_id is not null and region_id is null)
    or (scope_type = 'region'   and location_id is null     and district_id is null     and region_id is not null)
    or (scope_type = 'company'  and location_id is null     and district_id is null     and region_id is null)
  )
);

-- One row per (contact, scope). NULLS NOT DISTINCT or two identical
-- "company" rows would both be allowed (three nulls never compare
-- equal) -- and the save function's upsert relies on this conflicting.
create unique index if not exists directory_coverage_one_per_scope
  on public.directory_contact_coverage (contact_id, scope_type, location_id, district_id, region_id)
  nulls not distinct;

create index if not exists directory_coverage_location_idx
  on public.directory_contact_coverage (location_id) where location_id is not null;
create index if not exists directory_coverage_district_idx
  on public.directory_contact_coverage (district_id) where district_id is not null;

comment on table public.directory_contact_coverage is
  'Which stores/districts/regions a directory contact covers (company = everyone). Readable by every signed-in user. Rows are deactivated (active = false), never deleted, and survive their contact being deactivated.';

-- updated_at bookkeeping for both tables.
create or replace function public.directory_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists directory_contacts_touch on public.directory_contacts;
create trigger directory_contacts_touch before update on public.directory_contacts
  for each row execute function public.directory_touch_updated_at();

drop trigger if exists directory_coverage_touch on public.directory_contact_coverage;
create trigger directory_coverage_touch before update on public.directory_contact_coverage
  for each row execute function public.directory_touch_updated_at();

-- The sandbox never appears in the directory, so nobody may be recorded
-- as covering it. Definer so the check sees the sandbox row whatever the
-- caller's own scope is.
create or replace function public.directory_coverage_no_sandbox()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.location_id is not null
     and exists (select 1 from public.locations l where l.id = new.location_id and l.is_sandbox) then
    raise exception 'A sandbox store cannot appear in the directory'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists directory_coverage_no_sandbox on public.directory_contact_coverage;
create trigger directory_coverage_no_sandbox before insert or update on public.directory_contact_coverage
  for each row execute function public.directory_coverage_no_sandbox();

revoke all on function public.directory_coverage_no_sandbox() from public, anon, authenticated;
revoke all on function public.directory_touch_updated_at()     from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- 5. RLS
--    Admin check is the one employee_pay_rates uses:
--      public.current_user_role() in ('admin','master')
--    No DELETE policy, and DELETE/TRUNCATE are revoked outright so a
--    direct delete raises 42501 instead of quietly matching zero rows.
-- ---------------------------------------------------------------------
alter table public.directory_contacts         enable row level security;
alter table public.directory_contact_coverage enable row level security;

revoke all on public.directory_contacts, public.directory_contact_coverage from anon;
revoke delete, truncate on public.directory_contacts, public.directory_contact_coverage from authenticated;
grant select, insert, update on public.directory_contacts, public.directory_contact_coverage to authenticated;

drop policy if exists "directory_contacts_select" on public.directory_contacts;
create policy "directory_contacts_select" on public.directory_contacts for select to authenticated
  using (active or public.current_user_role() in ('admin','master'));

drop policy if exists "directory_contacts_admin_insert" on public.directory_contacts;
create policy "directory_contacts_admin_insert" on public.directory_contacts for insert to authenticated
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "directory_contacts_admin_update" on public.directory_contacts;
create policy "directory_contacts_admin_update" on public.directory_contacts for update to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "directory_coverage_select" on public.directory_contact_coverage;
create policy "directory_coverage_select" on public.directory_contact_coverage for select to authenticated
  using (true);

drop policy if exists "directory_coverage_admin_insert" on public.directory_contact_coverage;
create policy "directory_coverage_admin_insert" on public.directory_contact_coverage for insert to authenticated
  with check (public.current_user_role() in ('admin','master'));

drop policy if exists "directory_coverage_admin_update" on public.directory_contact_coverage;
create policy "directory_coverage_admin_update" on public.directory_contact_coverage for update to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 6. directory_stores() -- the ONLY way the directory reads locations
--    Whitelist: store number, name, brand, shop number, region,
--    district, address fields, main phone, hours. The ids are returned
--    as well because coverage rows reference stores, districts and
--    regions by id; they reveal nothing the regions/districts tables
--    (readable by everyone since migration 2) do not already.
--    Excludes the sandbox. Deliberately NOT exposed: drawer_float,
--    is_sandbox, the legacy address/phone, anything bonus/Horizon.
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
  hours         jsonb,
  hours_note    text
)
language sql stable security definer set search_path = '' as $$
  select l.id, l.store_number, l.name, l.brand, l.horizon_shop_number,
         r.id, r.name, d.id, d.name,
         l.address_line1, l.address_line2, l.city, l.state, l.postal_code,
         l.main_phone, l.hours, l.hours_note
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
-- 7. directory_update_store() -- admin edits of the directory columns
--    SECURITY DEFINER because locations has no admin write policy (see
--    decision 2). It re-checks the role itself and writes only the
--    directory columns. Blank strings are stored as null.
-- ---------------------------------------------------------------------
drop function if exists public.directory_update_store(uuid, text, text, text, text, text, text, jsonb, text);
create function public.directory_update_store(
  p_location_id   uuid,
  p_address_line1 text,
  p_address_line2 text,
  p_city          text,
  p_state         text,
  p_postal_code   text,
  p_main_phone    text,
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
         hours         = case when jsonb_typeof(p_hours) = 'null' then null else p_hours end,
         hours_note    = nullif(btrim(p_hours_note), '')
   where id = p_location_id
     and not is_sandbox;

  if not found then
    raise exception 'No directory store with id %', p_location_id using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.directory_update_store(uuid, text, text, text, text, text, text, jsonb, text) from public, anon;
grant execute on function public.directory_update_store(uuid, text, text, text, text, text, text, jsonb, text) to authenticated;


-- ---------------------------------------------------------------------
-- 8. directory_save_contact() -- create/update a contact + its coverage
--    SECURITY INVOKER on purpose: the caller's own RLS applies, so the
--    table policies stay the real boundary and this is only what makes
--    the contact and its coverage save atomically. The role check at the
--    top just turns an RLS refusal into a readable message.
--
--    p_coverage is a JSON array of
--      {"scope_type":"store|district|region|company",
--       "location_id":..., "district_id":..., "region_id":...}
--    and is the COMPLETE desired set: rows not in it are deactivated,
--    rows in it are inserted or reactivated. Nothing is deleted.
-- ---------------------------------------------------------------------
drop function if exists public.directory_save_contact(uuid, text, text, public.directory_role_category, text, text, int, jsonb);
create function public.directory_save_contact(
  p_id            uuid,
  p_display_name  text,
  p_title         text,
  p_role_category public.directory_role_category,
  p_work_phone    text,
  p_work_email    text,
  p_sort_order    int,
  p_coverage      jsonb
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  if coalesce(public.current_user_role(), '') not in ('admin', 'master') then
    raise exception 'Only an admin can edit the directory' using errcode = '42501';
  end if;
  if p_coverage is null or jsonb_typeof(p_coverage) <> 'array' then
    raise exception 'Coverage must be a JSON array (empty for none)' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.directory_contacts
      (display_name, title, role_category, work_phone, work_email, sort_order)
    values (btrim(p_display_name), btrim(p_title), p_role_category,
            nullif(btrim(p_work_phone), ''), nullif(lower(btrim(p_work_email)), ''), p_sort_order)
    returning id into v_id;
  else
    update public.directory_contacts
       set display_name  = btrim(p_display_name),
           title         = btrim(p_title),
           role_category = p_role_category,
           work_phone    = nullif(btrim(p_work_phone), ''),
           work_email    = nullif(lower(btrim(p_work_email)), ''),
           sort_order    = p_sort_order
     where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'No directory contact with id %', p_id using errcode = 'P0002';
    end if;
  end if;

  -- Off the form -> deactivated.
  update public.directory_contact_coverage c
     set active = false
   where c.contact_id = v_id
     and c.active
     and not exists (
       select 1
         from jsonb_to_recordset(p_coverage)
              as w(scope_type text, location_id uuid, district_id uuid, region_id uuid)
        where w.scope_type = c.scope_type::text
          and w.location_id is not distinct from c.location_id
          and w.district_id is not distinct from c.district_id
          and w.region_id   is not distinct from c.region_id);

  -- On the form -> inserted, or the old row reactivated.
  insert into public.directory_contact_coverage as c
         (contact_id, scope_type, location_id, district_id, region_id)
  select distinct v_id, w.scope_type::public.directory_scope_type, w.location_id, w.district_id, w.region_id
    from jsonb_to_recordset(p_coverage)
         as w(scope_type text, location_id uuid, district_id uuid, region_id uuid)
  on conflict (contact_id, scope_type, location_id, district_id, region_id)
  do update set active = true
        where not c.active;

  return v_id;
end;
$$;

revoke all on function public.directory_save_contact(uuid, text, text, public.directory_role_category, text, text, int, jsonb) from public, anon;
grant execute on function public.directory_save_contact(uuid, text, text, public.directory_role_category, text, text, int, jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 9. directory_set_contact_active() -- deactivate / reactivate
--    Invoker, like the save. Raises when no row changed, so a refusal
--    can never look like success (a bare PATCH that RLS filters to zero
--    rows returns 200 with an empty body).
-- ---------------------------------------------------------------------
drop function if exists public.directory_set_contact_active(uuid, boolean);
create function public.directory_set_contact_active(p_id uuid, p_active boolean)
returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if coalesce(public.current_user_role(), '') not in ('admin', 'master') then
    raise exception 'Only an admin can edit the directory' using errcode = '42501';
  end if;
  update public.directory_contacts set active = p_active where id = p_id;
  if not found then
    raise exception 'No directory contact with id %', p_id using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.directory_set_contact_active(uuid, boolean) from public, anon;
grant execute on function public.directory_set_contact_active(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] 38 directory stores, no sandbox, addresses backfilled:
--        select count(*) as stores,
--               count(*) filter (where address_line1 is not null) as with_address,
--               count(*) filter (where main_phone is not null)    as with_phone
--          from public.locations where not is_sandbox;
--      expect 38 / 38 / 2 (phones arrive with BDC's spreadsheet).
--
--  [2] Nothing failed to parse (expect zero rows; Value Service has no
--      address and is excluded):
--        select store_number, name, address from public.locations
--         where not is_sandbox and address is not null and address_line1 is null;
--
--  [3] The two tables, both RLS-on, with no DELETE policy:
--        select tablename, policyname, cmd from pg_policies
--         where tablename like 'directory_%' order by 1, 3;
--
--  [4] directory_stores() columns are exactly the whitelist:
--        select string_agg(a, ', ' order by o) from unnest(
--          (select proargnames from pg_proc where proname = 'directory_stores')
--        ) with ordinality u(a, o);
-- =====================================================================
