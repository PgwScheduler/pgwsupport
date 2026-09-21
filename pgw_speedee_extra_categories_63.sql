-- =====================================================================
-- 63 -- SPEEDEE: FOUR MORE TIC-SHEET CATEGORIES
-- Run AFTER pgw_speedee_service_categories_19.sql and pgw_tic_sheet_grid_21.sql.
-- Independent of 61 and 62. Re-runnable.
--
-- The SpeeDee tic sheets (Master Tic Sheet 2026) count four services the
-- portal's SpeeDee list did not have. Decided by the user 2026-09-21 while
-- importing the Charleston SpeeDee stores (#3009, #3025, #3029):
--
--   * 15K Critical Sys Treatment -- the EXISTING Midas-only category
--     (local_su_15k_critical_sys, migration 21) is switched on for SpeeDee.
--   * $40 Misc Inspection, Spark Plugs, AC Odor Service -- NEW, SpeeDee only.
--
-- All four are portal-only: their keys start with local_, and the Horizon
-- upload sends kpi_su_* keys only (payload.ts), so nothing sent to Horizon
-- changes. display_order slots them between the existing SpeeDee rows
-- (which use 10, 20, 30 ...), so no existing row is renumbered.
-- =====================================================================

insert into public.service_categories (horizon_key, display_name) values
  ('local_su_ac_odor',         'AC Odor Service'),
  ('local_su_misc_inspection', 'Misc Inspection'),
  ('local_su_spark_plugs',     'Spark Plugs')
on conflict (horizon_key) do update set display_name = excluded.display_name;

insert into public.brand_service_categories (brand, service_category_id, display_order, active)
select 'speedee', sc.id, v.display_order, true
from (values
  ('local_su_ac_odor',           15),   -- after A/C (10)
  ('local_su_15k_critical_sys', 145),   -- after Fuel Injection Flush (140), as on Midas
  ('local_su_misc_inspection',  195),   -- after LOF Premium (190)
  ('local_su_spark_plugs',      235)    -- after Shocks & Struts (230)
) as v(horizon_key, display_order)
join public.service_categories sc on sc.horizon_key = v.horizon_key
on conflict (brand, service_category_id)
  do update set display_order = excluded.display_order, active = true;


-- =====================================================================
-- VERIFY -- the SpeeDee list is now 35, in this order:
--   select bsc.display_order, sc.horizon_key, sc.display_name
--     from public.brand_service_categories bsc
--     join public.service_categories sc on sc.id = bsc.service_category_id
--    where bsc.brand = 'speedee' and bsc.active
--    order by bsc.display_order;
-- The Midas list is unchanged (30):
--   select count(*) from public.brand_service_categories where brand = 'midas' and active;
-- =====================================================================
