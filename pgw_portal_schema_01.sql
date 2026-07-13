-- =====================================================================
-- PGW Support Portal — Supabase schema & security
-- HOW TO RUN: Supabase Dashboard > SQL Editor > New query > paste all >
-- Run. Then do the three "Get started" steps at the very bottom.
-- =====================================================================
-- Roles:
--   store  : sees & edits ONLY their own store's records
--   admin  : sees & edits EVERY store's records (no user mgmt, no deletes)
--   master : everything admin can, PLUS manage logins/roles & delete records
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

create table if not exists public.locations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text,
  created_at  timestamptz not null default now()
);

-- One row per login; links to Supabase Auth.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  role        text check (role in ('store','admin','master')),
  location_id uuid references public.locations (id) on delete set null,
  created_at  timestamptz not null default now()
);
-- role is intentionally nullable: a brand-new signup has NO access until
-- a master assigns them a role.

create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations (id) on delete cascade,
  title        text not null,
  doc_type     text,
  storage_path text,                 -- path to the file in the 'documents' bucket
  uploaded_by  uuid references auth.users (id),
  created_at   timestamptz not null default now()
);

create table if not exists public.daily_closeouts (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations (id) on delete cascade,
  business_date date not null,
  notes         text,
  details       jsonb,               -- flexible bucket for any extra fields
  submitted_by  uuid references auth.users (id),
  created_at    timestamptz not null default now()
);

create table if not exists public.cash_drawer_closeouts (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations (id) on delete cascade,
  business_date   date not null,
  opening_amount  numeric(12,2),
  counted_amount  numeric(12,2),
  expected_amount numeric(12,2),
  variance        numeric(12,2) generated always as (counted_amount - expected_amount) stored,
  notes           text,
  submitted_by    uuid references auth.users (id),
  created_at      timestamptz not null default now()
);

create table if not exists public.employee_hours (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations (id) on delete cascade,
  employee_name text not null,
  business_date date not null,
  hours_worked  numeric(6,2) not null,
  notes         text,
  submitted_by  uuid references auth.users (id),
  created_at    timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 2. HELPER FUNCTIONS
--    Read the current user's role/location. SECURITY DEFINER lets them
--    read 'profiles' without tripping RLS (avoids infinite recursion).
-- ---------------------------------------------------------------------

create or replace function public.current_user_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_user_location()
returns uuid language sql stable security definer set search_path = '' as $$
  select location_id from public.profiles where id = auth.uid();
$$;

grant execute on function public.current_user_role()     to authenticated;
grant execute on function public.current_user_location() to authenticated;


-- ---------------------------------------------------------------------
-- 3. AUTO-CREATE A PROFILE ON SIGNUP (starts with NO role)
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------
-- 4. ENABLE ROW LEVEL SECURITY (safe even if already on)
-- ---------------------------------------------------------------------

alter table public.locations             enable row level security;
alter table public.profiles              enable row level security;
alter table public.documents             enable row level security;
alter table public.daily_closeouts       enable row level security;
alter table public.cash_drawer_closeouts enable row level security;
alter table public.employee_hours        enable row level security;


-- ---------------------------------------------------------------------
-- 5. POLICIES  (drop-then-create so the script is safe to re-run)
-- ---------------------------------------------------------------------

-- LOCATIONS: store sees only its own store; admin/master see all.
-- Only master can add/edit/remove stores.
drop policy if exists "locations_select" on public.locations;
create policy "locations_select" on public.locations
  for select to authenticated
  using (
    public.current_user_role() in ('admin','master')
    or id = public.current_user_location()
  );

drop policy if exists "locations_master_write" on public.locations;
create policy "locations_master_write" on public.locations
  for all to authenticated
  using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');


-- PROFILES: read own; admin/master read all. Only master writes
-- (this is how roles get assigned; users cannot change their own role).
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_user_role() in ('admin','master'));

drop policy if exists "profiles_master_write" on public.profiles;
create policy "profiles_master_write" on public.profiles
  for all to authenticated
  using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');


-- The four data tables all share the same rule:
--   store  -> own location only    admin/master -> all    delete -> master only

-- DOCUMENTS
drop policy if exists "documents_select" on public.documents;
create policy "documents_select" on public.documents for select to authenticated
  using (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "documents_insert" on public.documents;
create policy "documents_insert" on public.documents for insert to authenticated
  with check (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "documents_update" on public.documents;
create policy "documents_update" on public.documents for update to authenticated
  using (public.current_user_role() in ('admin','master') or location_id = public.current_user_location())
  with check (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "documents_delete" on public.documents;
create policy "documents_delete" on public.documents for delete to authenticated
  using (public.current_user_role() = 'master');

-- DAILY CLOSEOUTS
drop policy if exists "daily_closeouts_select" on public.daily_closeouts;
create policy "daily_closeouts_select" on public.daily_closeouts for select to authenticated
  using (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "daily_closeouts_insert" on public.daily_closeouts;
create policy "daily_closeouts_insert" on public.daily_closeouts for insert to authenticated
  with check (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "daily_closeouts_update" on public.daily_closeouts;
create policy "daily_closeouts_update" on public.daily_closeouts for update to authenticated
  using (public.current_user_role() in ('admin','master') or location_id = public.current_user_location())
  with check (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "daily_closeouts_delete" on public.daily_closeouts;
create policy "daily_closeouts_delete" on public.daily_closeouts for delete to authenticated
  using (public.current_user_role() = 'master');

-- CASH DRAWER CLOSEOUTS
drop policy if exists "cash_drawer_select" on public.cash_drawer_closeouts;
create policy "cash_drawer_select" on public.cash_drawer_closeouts for select to authenticated
  using (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "cash_drawer_insert" on public.cash_drawer_closeouts;
create policy "cash_drawer_insert" on public.cash_drawer_closeouts for insert to authenticated
  with check (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "cash_drawer_update" on public.cash_drawer_closeouts;
create policy "cash_drawer_update" on public.cash_drawer_closeouts for update to authenticated
  using (public.current_user_role() in ('admin','master') or location_id = public.current_user_location())
  with check (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "cash_drawer_delete" on public.cash_drawer_closeouts;
create policy "cash_drawer_delete" on public.cash_drawer_closeouts for delete to authenticated
  using (public.current_user_role() = 'master');

-- EMPLOYEE HOURS
drop policy if exists "employee_hours_select" on public.employee_hours;
create policy "employee_hours_select" on public.employee_hours for select to authenticated
  using (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "employee_hours_insert" on public.employee_hours;
create policy "employee_hours_insert" on public.employee_hours for insert to authenticated
  with check (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "employee_hours_update" on public.employee_hours;
create policy "employee_hours_update" on public.employee_hours for update to authenticated
  using (public.current_user_role() in ('admin','master') or location_id = public.current_user_location())
  with check (public.current_user_role() in ('admin','master') or location_id = public.current_user_location());
drop policy if exists "employee_hours_delete" on public.employee_hours;
create policy "employee_hours_delete" on public.employee_hours for delete to authenticated
  using (public.current_user_role() = 'master');


-- ---------------------------------------------------------------------
-- 6. FILE STORAGE (for location documents)
--    Bucket 'documents', organised one folder per location:
--    <location_id>/<filename>. Same store/admin/master rules apply.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "documents_bucket_select" on storage.objects;
create policy "documents_bucket_select" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (
    public.current_user_role() in ('admin','master')
    or (storage.foldername(name))[1] = public.current_user_location()::text));

drop policy if exists "documents_bucket_insert" on storage.objects;
create policy "documents_bucket_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (
    public.current_user_role() in ('admin','master')
    or (storage.foldername(name))[1] = public.current_user_location()::text));

drop policy if exists "documents_bucket_update" on storage.objects;
create policy "documents_bucket_update" on storage.objects for update to authenticated
  using (bucket_id = 'documents' and (
    public.current_user_role() in ('admin','master')
    or (storage.foldername(name))[1] = public.current_user_location()::text));

drop policy if exists "documents_bucket_delete" on storage.objects;
create policy "documents_bucket_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.current_user_role() = 'master');


-- =====================================================================
-- 7. GET STARTED  (run these AFTER the script above succeeds)
-- =====================================================================

-- 7a. Add your stores — one line per location:
--     insert into public.locations (name, address) values ('Columbia', '123 Main St');

-- 7b. Sign up your OWN login (via the app or Auth dashboard), then make
--     yourself master by running this with YOUR email:
--     update public.profiles set role = 'master'
--       where id = (select id from auth.users where email = 'you@example.com');

-- 7c. From then on, you (master) assign everyone else. Grab a location id:
--     select id, name from public.locations;
--     ...then tie a store manager to it:
--     update public.profiles set role = 'store', location_id = 'PASTE-LOCATION-ID'
--       where id = (select id from auth.users where email = 'manager@example.com');
