-- =====================================================================
-- PGW Support Portal — Add email to profiles, for the User Management screen
-- Run AFTER pgw_employee_hours_notes_12.sql.
-- =====================================================================
-- WHAT THIS DOES: the new User Management screen needs to list every
-- login (email + role + assigned store/district/region). profiles never
-- stored email — only auth.users does, and reading auth.users from the
-- client requires Supabase's admin API (a service-role secret we do NOT
-- want anywhere in this app). Instead, this mirrors email onto profiles
-- at signup time, so listing users is just an ordinary, RLS-scoped
-- `select * from profiles` like everything else in this app.
--
-- 1. Adds profiles.email.
-- 2. Updates the new-user trigger to also copy auth.users.email in.
-- 3. Backfills email for any profiles created before this migration.
-- 4. Re-affirms (unchanged, just re-run for safety) that only master
--    can write to profiles — this is what actually enforces "only
--    master can manage users," not the UI.
-- =====================================================================

alter table public.profiles
  add column if not exists email text;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.email);
  return new;
end;
$$;

update public.profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email is null;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_user_role() in ('admin','master'));

drop policy if exists "profiles_master_write" on public.profiles;
create policy "profiles_master_write" on public.profiles
  for all to authenticated
  using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');

-- Verify:
--   select email, full_name, role from public.profiles order by email;
