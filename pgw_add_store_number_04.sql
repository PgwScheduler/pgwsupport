-- =====================================================================
-- PGW Support Portal — Add Store Number to each location
-- Run in SQL Editor. Safe to re-run.
-- =====================================================================

alter table public.locations
  add column if not exists store_number text;

-- Then populate. Send me your store numbers and I'll generate the full
-- set of updates. They'll look like this (one per store):
--
--   update public.locations set store_number = '1024'
--     where name = 'Midas Gervais St';
--
-- (Using text lets you keep any format — leading zeros, letters, etc.)
