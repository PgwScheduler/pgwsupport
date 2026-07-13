-- =====================================================================
-- PGW Support Portal — Add per-store drawer float
-- Run AFTER the first five files (schema, regions upgrade, seed, store
-- number files). Safe to re-run.
-- =====================================================================
-- WHAT THIS DOES: every store keeps a fixed cash amount in the drawer
-- at all times (the "float") that never gets deposited. Almost every
-- store floats $200, but store #3935 (Two Notch) floats $400. This adds
-- a drawer_float column to locations so that amount is data you can look
-- up per store, not a number baked into the app. New stores default to
-- $200 and can be changed individually later without touching any code.
-- =====================================================================

alter table public.locations
  add column if not exists drawer_float numeric(12,2) not null default 200;

update public.locations
  set drawer_float = 400
  where store_number = '3935';

-- Verify:
--   select store_number, name, drawer_float from public.locations order by store_number;
