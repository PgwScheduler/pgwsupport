-- =====================================================================
-- PGW Support Portal — Drop the unused daily_closeouts table
-- Run AFTER pgw_documents_folders_10.sql. Last of the six.
-- =====================================================================
-- WHAT THIS DOES: daily_closeouts was built for a "daily closeout" tab
-- that has since become the Training tab. Nothing in the app reads or
-- writes this table anymore, so this drops it (and its policies, which
-- go with it automatically). Safe to re-run — if it's already gone,
-- this is a no-op.
-- =====================================================================

drop table if exists public.daily_closeouts cascade;

-- Verify:
--   select table_name from information_schema.tables
--     where table_schema = 'public' and table_name = 'daily_closeouts';
--   (should return zero rows)
