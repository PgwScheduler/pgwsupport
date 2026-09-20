-- =====================================================================
-- PGW Support Portal — Directory: contact photos
-- Run AFTER pgw_directory_drop_hours_59.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Asked for by the user 2026-09-20: pictures on the people side of the
-- directory. Office staff are who prompted it; the user chose to allow
-- a photo for ANY directory contact, so a store manager or DM can have
-- one as they are collected.
--
-- WHERE THE FILE LIVES. A private storage bucket, `directory-photos`,
-- following the `training` bucket's shape (migration 9): every signed-in
-- user may read it, only admin/master may write it. Private, not
-- public: a public bucket hands anyone with the URL a photograph of a
-- named employee, forever, with no login. The app reads them through
-- short-lived signed URLs, as the document library already does.
--
-- directory_contacts.photo_path holds the object path, not a URL: a URL
-- would go stale the moment it expired, and the path is what the bucket
-- is actually keyed by.
--
-- The bucket carries its own limits -- 5 MB, and only JPEG, PNG or WebP
-- -- so a wrong file is refused by storage itself rather than by the
-- form alone.
-- =====================================================================

alter table public.directory_contacts
  add column if not exists photo_path text null;

alter table public.directory_contacts drop constraint if exists directory_contacts_photo_path_shape;
alter table public.directory_contacts add constraint directory_contacts_photo_path_shape
  check (photo_path is null or photo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]+$');

comment on column public.directory_contacts.photo_path is
  'Object path inside the private `directory-photos` bucket, as "<contact id>/<file>". NOT a URL -- the app mints a short-lived signed URL when it renders. Null = no photo, and the card shows initials.';


-- ---------------------------------------------------------------------
-- THE BUCKET
--   Kept private. The size and type limits live here as well as in the
--   form, so an upload that dodges the UI is still refused.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('directory-photos', 'directory-photos', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ---------------------------------------------------------------------
-- BUCKET POLICIES  (the training bucket's shape: all read, admins write)
-- ---------------------------------------------------------------------
drop policy if exists "directory_photos_select" on storage.objects;
create policy "directory_photos_select" on storage.objects for select to authenticated
  using (bucket_id = 'directory-photos');

drop policy if exists "directory_photos_write" on storage.objects;
create policy "directory_photos_write" on storage.objects for all to authenticated
  using (bucket_id = 'directory-photos' and public.current_user_role() in ('admin','master'))
  with check (bucket_id = 'directory-photos' and public.current_user_role() in ('admin','master'));

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] The bucket exists, is PRIVATE, and carries its limits:
--        select id, public, file_size_limit, allowed_mime_types
--          from storage.buckets where id = 'directory-photos';
--
--  [2] Both policies are in place:
--        select policyname, cmd from pg_policies
--         where tablename = 'objects' and policyname like 'directory_photos%';
--
--  [3] A path must look like "<contact id>/<file>" (expect 23514):
--        update public.directory_contacts set photo_path = 'anywhere.jpg'
--         where id = (select id from public.directory_contacts limit 1);
-- =====================================================================
