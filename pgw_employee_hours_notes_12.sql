-- =====================================================================
-- PGW Support Portal — Add a notes field to employee_hours
-- Run AFTER pgw_drop_daily_closeouts_11.sql.
-- =====================================================================
-- WHAT THIS DOES: adds a free-text notes column to each employee-hours
-- row, so a manager can flag something like "covering from store #3936
-- Wed-Thu" when an employee works a shift at a store that isn't their
-- home store. Purely additive — no RLS changes needed, since notes is
-- just another column on a row that's already scoped by
-- can_access_location() like everything else on this table.
-- =====================================================================

alter table public.employee_hours
  add column if not exists notes text;

-- Verify:
--   select column_name, data_type from information_schema.columns
--     where table_name = 'employee_hours' order by ordinal_position;
