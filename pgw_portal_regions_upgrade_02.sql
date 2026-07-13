-- =====================================================================
-- PGW Support Portal — Regional / District layer (UPGRADE)
-- Run this AFTER the first schema file, in the same SQL Editor.
-- Safe to re-run.
-- =====================================================================
-- Store hierarchy added:  Region  ->  District  ->  Store (location)
-- New roles:
--   regional : sees every store in their assigned REGION
--   district : sees every store in their assigned DISTRICT
-- (store / admin / master are unchanged)
--
-- By default, regional & district managers can VIEW and EDIT within
-- their area (a narrower admin). To make them VIEW-ONLY, see the note
-- in section 5.
-- =====================================================================


-- 1. HIERARCHY TABLES --------------------------------------------------
create table if not exists public.regions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.districts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  region_id  uuid references public.regions (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Attach each store to a district.
alter table public.locations
  add column if not exists district_id uuid references public.districts (id) on delete set null;


-- 2. EXTEND PROFILES ---------------------------------------------------
alter table public.profiles
  add column if not exists region_id   uuid references public.regions (id)   on delete set null,
  add column if not exists district_id uuid references public.districts (id) on delete set null;

-- Allow the two new roles.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('store','district','regional','admin','master'));


-- 3. ACCESS HELPER -----------------------------------------------------
-- One place that decides whether the current user may touch a given
-- store. Every data policy below just calls this.
create or replace function public.can_access_location(loc uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (
        p.role in ('admin','master')
        or (p.role = 'store'    and p.location_id = loc)
        or (p.role = 'district' and p.district_id =
              (select l.district_id from public.locations l where l.id = loc))
        or (p.role = 'regional' and p.region_id =
              (select d.region_id
                 from public.districts d
                 join public.locations l on l.district_id = d.id
                where l.id = loc))
      )
  );
$$;
grant execute on function public.can_access_location(uuid) to authenticated;


-- 4. RLS ON THE NEW TABLES --------------------------------------------
alter table public.regions   enable row level security;
alter table public.districts enable row level security;

drop policy if exists "regions_select" on public.regions;
create policy "regions_select" on public.regions for select to authenticated using (true);
drop policy if exists "regions_master_write" on public.regions;
create policy "regions_master_write" on public.regions for all to authenticated
  using (public.current_user_role() = 'master') with check (public.current_user_role() = 'master');

drop policy if exists "districts_select" on public.districts;
create policy "districts_select" on public.districts for select to authenticated using (true);
drop policy if exists "districts_master_write" on public.districts;
create policy "districts_master_write" on public.districts for all to authenticated
  using (public.current_user_role() = 'master') with check (public.current_user_role() = 'master');


-- 5. RE-POINT THE DATA POLICIES AT THE NEW HELPER ---------------------
-- These replace the earlier versions so the middle-tier roles work.
-- Managers view AND edit within their area. To make them VIEW-ONLY,
-- change the _insert and _update policies below to use this instead:
--     public.current_user_role() in ('admin','master')
--       or location_id = public.current_user_location()

-- LOCATIONS (a store row is visible if you can access that store)
drop policy if exists "locations_select" on public.locations;
create policy "locations_select" on public.locations for select to authenticated
  using (public.can_access_location(id));

-- DOCUMENTS
drop policy if exists "documents_select" on public.documents;
create policy "documents_select" on public.documents for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "documents_insert" on public.documents;
create policy "documents_insert" on public.documents for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "documents_update" on public.documents;
create policy "documents_update" on public.documents for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));

-- DAILY CLOSEOUTS
drop policy if exists "daily_closeouts_select" on public.daily_closeouts;
create policy "daily_closeouts_select" on public.daily_closeouts for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "daily_closeouts_insert" on public.daily_closeouts;
create policy "daily_closeouts_insert" on public.daily_closeouts for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "daily_closeouts_update" on public.daily_closeouts;
create policy "daily_closeouts_update" on public.daily_closeouts for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));

-- CASH DRAWER CLOSEOUTS
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

-- EMPLOYEE HOURS
drop policy if exists "employee_hours_select" on public.employee_hours;
create policy "employee_hours_select" on public.employee_hours for select to authenticated
  using (public.can_access_location(location_id));
drop policy if exists "employee_hours_insert" on public.employee_hours;
create policy "employee_hours_insert" on public.employee_hours for insert to authenticated
  with check (public.can_access_location(location_id));
drop policy if exists "employee_hours_update" on public.employee_hours;
create policy "employee_hours_update" on public.employee_hours for update to authenticated
  using (public.can_access_location(location_id))
  with check (public.can_access_location(location_id));
-- (delete policies stay master-only from the first file — unchanged)


-- 6. STORAGE: repoint document-folder access at the helper ------------
-- Files still live under <location_id>/<filename>.
drop policy if exists "documents_bucket_select" on storage.objects;
create policy "documents_bucket_select" on storage.objects for select to authenticated
  using (bucket_id = 'documents'
    and public.can_access_location( ((storage.foldername(name))[1])::uuid ));
drop policy if exists "documents_bucket_insert" on storage.objects;
create policy "documents_bucket_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents'
    and public.can_access_location( ((storage.foldername(name))[1])::uuid ));
drop policy if exists "documents_bucket_update" on storage.objects;
create policy "documents_bucket_update" on storage.objects for update to authenticated
  using (bucket_id = 'documents'
    and public.can_access_location( ((storage.foldername(name))[1])::uuid ));
-- delete stays master-only (unchanged from first file)


-- =====================================================================
-- ASSIGNING THE NEW ROLES (after regions/districts/stores are loaded)
-- =====================================================================
-- District manager (sees one district):
--   update public.profiles set role='district', district_id='DISTRICT-ID'
--     where id = (select id from auth.users where email='dm@example.com');
--
-- Regional manager (sees one region):
--   update public.profiles set role='regional', region_id='REGION-ID'
--     where id = (select id from auth.users where email='rm@example.com');
