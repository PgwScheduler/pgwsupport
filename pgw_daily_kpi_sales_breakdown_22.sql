-- =====================================================================
-- PGW Support Portal — daily_kpi: Supplies + Groupon sales lines
-- Run AFTER pgw_tic_sheet_grid_21.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- The per-day Sales breakdown (entered in the tic sheet's Sales panel) gains
-- two revenue lines. Parts Cost / Tire Cost already exist (cost_parts,
-- cost_tires); this only adds Supplies and Groupon.
--
--   Sales (grid) = sales_labor + sales_parts + sales_tires
--                + sales_supplies + sales_groupon + sales_discounts
--   Gross profit = Sales − cost_parts − cost_tires   (goals strip "GP before labor")
--
-- daily_kpi's existing RLS covers the new columns (row-level, not column-level).
-- =====================================================================
alter table public.daily_kpi
  add column if not exists sales_supplies numeric(12,2) not null default 0,
  add column if not exists sales_groupon  numeric(12,2) not null default 0;

-- =====================================================================
-- VERIFY
--   select column_name from information_schema.columns
--     where table_name = 'daily_kpi'
--       and column_name in ('sales_supplies','sales_groupon');
-- =====================================================================
