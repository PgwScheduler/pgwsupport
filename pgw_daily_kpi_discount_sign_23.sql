-- =====================================================================
-- PGW Support Portal — Discounts are a negative amount (reduce Sales)
-- Run AFTER pgw_daily_kpi_sales_breakdown_22.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Sales sums all breakdown lines, so a discount must be stored NEGATIVE to
-- reduce Sales:
--   Sales = sales_labor + sales_parts + sales_tires
--         + sales_supplies + sales_groupon + sales_discounts   (discounts <= 0)
--
-- No schema change (the column already allows negatives). This just flips any
-- discounts that were entered as positive before the fix. Re-running is a
-- no-op — the WHERE only matches remaining positive values.
-- =====================================================================
update public.daily_kpi
   set sales_discounts = -abs(sales_discounts)
 where sales_discounts > 0;

-- =====================================================================
-- VERIFY (no positive discounts remain):
--   select count(*) from public.daily_kpi where sales_discounts > 0;   -- 0
-- =====================================================================
