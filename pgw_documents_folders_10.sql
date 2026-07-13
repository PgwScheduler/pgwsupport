-- =====================================================================
-- PGW Support Portal — Add folders to Documents (per-store)
-- Run AFTER pgw_training_library_09.sql.
-- =====================================================================
-- WHAT THIS DOES: the existing "documents" table was a flat list of
-- files per store. This adds the same folder-tree shape used by
-- Training: parent_id (self-referencing, null = root) and item_type
-- (folder vs file), so a store's Documents tab can have nested folders.
--
-- No RLS changes needed here — documents is still per-store, and the
-- existing policies already scope every row by location_id via
-- can_access_location(). A folder row is just a row with item_type =
-- 'folder' and no storage_path; it follows the same access rules as
-- any file row in that store.
-- =====================================================================

alter table public.documents
  add column if not exists parent_id uuid references public.documents (id) on delete cascade;

alter table public.documents
  add column if not exists item_type text not null default 'file';

alter table public.documents drop constraint if exists documents_item_type_check;
alter table public.documents add constraint documents_item_type_check
  check (item_type in ('folder','file'));

-- Verify:
--   select column_name, data_type from information_schema.columns
--     where table_name = 'documents' order by ordinal_position;
