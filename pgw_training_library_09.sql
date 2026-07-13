-- =====================================================================
-- PGW Support Portal — Training file library (company-wide, shared)
-- Run AFTER pgw_cash_drawer_rewrite_08.sql.
-- =====================================================================
-- WHAT THIS DOES: adds a brand-new "training" table for the shared
-- training-material library. Unlike Documents (which is per-store), this
-- is ONE folder tree shared by all 36 stores — there's no location_id on
-- this table at all, on purpose.
--
-- item_type distinguishes a folder row from a file row, and parent_id
-- lets rows nest inside each other (a folder can contain files or more
-- folders). A null parent_id means "sits at the root."
--
-- Access: everyone who's logged in can READ the whole tree. Only
-- admin/master can add, rename, move, or delete anything in it — regular
-- store/district/regional users are read-only here, which matches
-- "Everyone reads; admin/master write" from the brief.
--
-- Also creates the 'training' storage bucket, with the same read-
-- everyone / write-admin-master split, since actual files need somewhere
-- to live.
-- =====================================================================

create table if not exists public.training (
  id           uuid primary key default gen_random_uuid(),
  parent_id    uuid references public.training (id) on delete cascade,
  item_type    text not null default 'file',
  title        text not null,
  doc_type     text,
  storage_path text,                     -- path in the 'training' bucket; null for folders
  uploaded_by  uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  constraint training_item_type_check check (item_type in ('folder','file'))
);

alter table public.training enable row level security;

drop policy if exists "training_select" on public.training;
create policy "training_select" on public.training for select to authenticated
  using (true);

drop policy if exists "training_write" on public.training;
create policy "training_write" on public.training for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- STORAGE: bucket 'training', flat (no per-location folder split needed).
insert into storage.buckets (id, name, public)
values ('training', 'training', false)
on conflict (id) do nothing;

drop policy if exists "training_bucket_select" on storage.objects;
create policy "training_bucket_select" on storage.objects for select to authenticated
  using (bucket_id = 'training');

drop policy if exists "training_bucket_write" on storage.objects;
create policy "training_bucket_write" on storage.objects for all to authenticated
  using (bucket_id = 'training' and public.current_user_role() in ('admin','master'))
  with check (bucket_id = 'training' and public.current_user_role() in ('admin','master'));

-- Verify:
--   select * from public.training;
