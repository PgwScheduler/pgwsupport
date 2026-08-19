-- =====================================================================
-- SEED -- Millwood (#3303) July 2026 tic-sheet data (Task 5 verification)
-- Run AFTER pgw_tic_sheet_totals_25.sql. Repeatable: clears this store's
-- July 2026 daily_kpi rows (units cascade) and re-inserts them.
--
-- Transcribed from 'Maint Tic Sheet' + 'Summary' in Millwood July 1.xlsm.
-- sales_labor is deliberately left at 0: the grid reads Labor Sales from
-- the technician tracker (tech_store_daily), seeded by
-- pgw_seed_millwood_july_tech.sql. Run that first or Sales will be short
-- by the labor line.
--
-- Discounts are stored signed as entered -- 18 days carry one, including
-- 2026-07-02 at -396.53 and 2026-07-20 at +107.00 (a discount reversal).
-- Month total -1,997.91.
-- =====================================================================
do $$
declare
  v_store_number text := '3303';
  v_loc  uuid;
  v_kpi  bigint;
begin
  select id into v_loc from public.locations where store_number = v_store_number;
  if v_loc is null then raise exception 'Millwood location (store_number=%) not found', v_store_number; end if;

  delete from public.daily_kpi
   where location_id = v_loc
     and business_date between date '2026-07-01' and date '2026-07-31';

  -- 2026-07-01
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-01', 21, 2,
      2609.97, 1083.40, 1313.47, 1099.50, 517.91, 0.00,
      -125.00, 5568.03, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 4),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 1),
    ('kpi_su_exhaust', 1),
    ('kpi_su_hoses', 1),
    ('kpi_su_lof', 3),
    ('kpi_su_lof_premium', 6),
    ('kpi_su_power_steering_flush', 2),
    ('kpi_su_steering_suspension', 1),
    ('kpi_su_wheel_alignments', 3),
    ('kpi_su_wheel_balances', 10),
    ('kpi_su_wiper_blades', 4),
    ('kpi_su_tires', 8)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-02
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-02', 24, 5,
      7538.70, 3663.98, 374.92, 315.62, 357.30, 0.00,
      -396.53, 5145.40, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 3),
    ('kpi_su_belts', 1),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 1),
    ('kpi_su_cabin_filter', 1),
    ('kpi_su_engine_performance', 1),
    ('kpi_su_diagnosis', 2),
    ('kpi_su_exhaust', 1),
    ('kpi_su_lights', 1),
    ('kpi_su_lof', 2),
    ('kpi_su_lof_premium', 11),
    ('kpi_su_power_steering_flush', 1),
    ('kpi_su_steering_suspension', 1),
    ('kpi_su_wheel_alignments', 3),
    ('kpi_su_wheel_balances', 12),
    ('kpi_su_wiper_blades', 2),
    ('kpi_su_tires', 4)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-03
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-03', 19, 3,
      2728.20, 1183.64, 544.53, 379.65, 373.33, 0.00,
      -270.73, 11393.44, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_belts', 1),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 2),
    ('kpi_su_diagnosis', 1),
    ('kpi_su_exhaust', 1),
    ('kpi_su_lights', 2),
    ('kpi_su_lof_premium', 8),
    ('kpi_su_steering_suspension', 1),
    ('kpi_su_shocks_struts', 2),
    ('kpi_su_wheel_alignments', 2),
    ('kpi_su_wheel_balances', 10),
    ('kpi_su_tires', 2)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-06
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-06', 12, 0,
      1621.56, 549.67, 2796.82, 1046.67, 301.89, 0.00,
      0.00, 7983.41, 1, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 2),
    ('kpi_su_cabin_filter', 2),
    ('kpi_su_diagnosis', 2),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 6),
    ('kpi_su_wheel_alignments', 2),
    ('kpi_su_tires', 8)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-07
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-07', 12, 1,
      884.06, 334.11, 1966.56, 709.11, 291.04, 0.00,
      0.00, 5550.23, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 1),
    ('kpi_su_cabin_filter', 1),
    ('kpi_su_diagnosis', 1),
    ('kpi_su_lof_premium', 4),
    ('kpi_su_wheel_alignments', 2),
    ('kpi_su_wheel_balances', 1),
    ('kpi_su_tires', 7)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-08
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-08', 10, 2,
      1933.24, 894.51, 159.92, 133.50, 222.95, 0.00,
      -30.00, 5418.28, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 1),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 1),
    ('kpi_su_coolant_flush', 1),
    ('kpi_su_diagnosis', 1),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 3),
    ('kpi_su_wheel_alignments', 2),
    ('kpi_su_wheel_balances', 4),
    ('kpi_su_battery', 1),
    ('kpi_su_tires', 1)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-09
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-09', 14, 1,
      1931.63, 802.01, 1777.33, 1308.82, 378.17, 0.00,
      -375.00, 7854.84, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 1),
    ('kpi_su_belts', 1),
    ('kpi_su_coolant_flush', 1),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 6),
    ('kpi_su_wheel_alignments', 1),
    ('kpi_su_battery', 1),
    ('kpi_su_tires', 11)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-10
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-10', 15, 3,
      2095.04, 908.83, 1581.80, 1173.36, 311.48, 0.00,
      -117.00, 11483.78, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 2),
    ('kpi_su_brakes', 2),
    ('kpi_su_cabin_filter', 2),
    ('kpi_su_coolant_flush', 1),
    ('kpi_su_lof_premium', 8),
    ('kpi_su_steering_suspension', 1),
    ('kpi_su_wheel_alignments', 3),
    ('kpi_su_wiper_blades', 7),
    ('kpi_su_battery', 1),
    ('kpi_su_tires', 8)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-11
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-11', 15, 0,
      2105.86, 967.76, 349.47, 247.50, 312.14, 0.00,
      -185.00, 10054.37, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_ac_heat', 1),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 2),
    ('kpi_su_cabin_filter', 1),
    ('kpi_su_diagnosis', 1),
    ('kpi_su_lof_premium', 11),
    ('kpi_su_wheel_alignments', 3),
    ('kpi_su_wiper_blades', 4),
    ('kpi_su_tires', 3)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-13
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-13', 15, 1,
      841.24, 423.53, 1211.62, 885.42, 212.83, 0.00,
      -44.00, 7550.27, 2, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_cabin_filter', 1),
    ('kpi_su_coolant_flush', 1),
    ('kpi_su_diagnosis', 1),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 3),
    ('kpi_su_wheel_alignments', 1),
    ('kpi_su_wiper_blades', 4),
    ('kpi_su_battery', 1),
    ('kpi_su_tires', 9)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-14
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-14', 20, 5,
      1742.33, 804.63, 404.27, 324.83, 258.00, 0.00,
      -30.00, 6994.80, 1, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 2),
    ('kpi_su_brake_flush', 2),
    ('kpi_su_brakes', 1),
    ('kpi_su_cabin_filter', 1),
    ('kpi_su_lights', 1),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 9),
    ('kpi_su_wheel_alignments', 2),
    ('kpi_su_wheel_balances', 4),
    ('kpi_su_wiper_blades', 2),
    ('kpi_su_tires', 5)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-15
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-15', 11, 2,
      1593.85, 604.65, 578.46, 438.00, 265.16, 0.00,
      -100.00, 3569.57, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 1),
    ('kpi_su_lof_premium', 4),
    ('kpi_su_wiper_blades', 2),
    ('kpi_su_tires', 3)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-16
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-16', 17, 3,
      1976.84, 891.42, 949.66, 783.73, 330.40, 0.00,
      0.00, 7704.85, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 3),
    ('kpi_su_brake_flush', 3),
    ('kpi_su_brakes', 2),
    ('kpi_su_cabin_filter', 1),
    ('kpi_su_hoses', 1),
    ('kpi_su_lights', 1),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 6),
    ('kpi_su_wheel_alignments', 3),
    ('kpi_su_wheel_balances', 10),
    ('kpi_su_wiper_blades', 2),
    ('kpi_su_battery', 1),
    ('kpi_su_tires', 8)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-17
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-17', 13, 2,
      2481.68, 1529.44, 921.03, 767.36, 262.27, -942.44,
      -22.00, 2560.24, 2, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_brake_flush', 3),
    ('kpi_su_brakes', 3),
    ('kpi_su_cabin_filter', 1),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 3),
    ('kpi_su_steering_suspension', 2),
    ('kpi_su_wheel_alignments', 3),
    ('kpi_su_wheel_balances', 2),
    ('kpi_su_tires', 3)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-18
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-18', 14, 3,
      1145.11, 463.89, 368.98, 300.08, 201.92, 0.00,
      -97.40, 6428.14, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 2),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 2),
    ('kpi_su_diagnosis', 1),
    ('kpi_su_lights', 1),
    ('kpi_su_lof_premium', 7),
    ('kpi_su_wheel_alignments', 2),
    ('kpi_su_wheel_balances', 6),
    ('kpi_su_tires', 2)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-20
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-20', 11, 3,
      557.57, 310.57, 1403.92, 1110.08, 197.27, 0.00,
      107.00, 2659.25, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 1),
    ('kpi_su_brakes', 1),
    ('kpi_su_lof_premium', 3),
    ('kpi_su_wheel_alignments', 2),
    ('kpi_su_wiper_blades', 2),
    ('kpi_su_tires', 9)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-21
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-21', 15, 2,
      2811.57, 1370.23, 1088.49, 860.45, 354.38, 0.00,
      -60.00, 8048.59, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 3),
    ('kpi_su_diagnosis', 3),
    ('kpi_su_hoses', 1),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 5),
    ('kpi_su_wheel_alignments', 2),
    ('kpi_su_wiper_blades', 4),
    ('kpi_su_battery', 1),
    ('kpi_su_tires', 7)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-22
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-22', 13, 3,
      667.64, 255.10, 565.98, 462.00, 144.11, 0.00,
      -5.00, 9208.05, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 7),
    ('kpi_su_tires', 4)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-23
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-23', 17, 3,
      2459.79, 1233.04, 2457.72, 2002.88, 399.52, 0.00,
      0.00, 2294.06, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 1),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 1),
    ('kpi_su_cabin_filter', 1),
    ('kpi_su_engine_performance', 1),
    ('kpi_su_exhaust', 1),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 8),
    ('kpi_su_steering_suspension', 1),
    ('kpi_su_wheel_alignments', 3),
    ('kpi_su_battery', 1),
    ('kpi_su_tires', 13)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-24
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-24', 13, 2,
      1910.19, 763.62, 0.00, 0.00, 258.54, 0.00,
      0.00, 9318.48, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 2),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 2),
    ('kpi_su_diagnosis', 2),
    ('kpi_su_lights', 1),
    ('kpi_su_lof_premium', 5),
    ('kpi_su_wheel_balances', 4),
    ('kpi_su_wiper_blades', 2)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-25
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-25', 12, 0,
      1621.35, 679.89, 1061.32, 902.12, 301.38, 0.00,
      0.00, 2944.68, 1, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 3),
    ('kpi_su_brakes', 1),
    ('kpi_su_brake_maintenance', 1),
    ('kpi_su_coolant_flush', 1),
    ('kpi_su_lof', 2),
    ('kpi_su_lof_premium', 5),
    ('kpi_su_wheel_alignments', 1),
    ('kpi_su_wheel_balances', 12),
    ('kpi_su_wiper_blades', 2),
    ('kpi_su_battery', 1),
    ('kpi_su_tires', 4)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-27
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-27', 8, 1,
      2294.70, 1160.86, 7.99, 2.75, 242.09, 0.00,
      0.00, 1004.25, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 1),
    ('kpi_su_brakes', 2),
    ('kpi_su_exhaust', 1),
    ('kpi_su_lof_premium', 3),
    ('kpi_su_tires', 1)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-28
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-28', 14, 1,
      2365.19, 1305.79, 411.96, 309.36, 346.78, 0.00,
      -30.00, 8462.55, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 1),
    ('kpi_su_brake_flush', 2),
    ('kpi_su_brakes', 3),
    ('kpi_su_diagnosis', 1),
    ('kpi_su_lights', 3),
    ('kpi_su_lof_premium', 8),
    ('kpi_su_steering_suspension', 2),
    ('kpi_su_wheel_alignments', 2),
    ('kpi_su_wiper_blades', 2),
    ('kpi_su_tires', 6)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-29
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-29', 11, 2,
      2221.30, 1079.15, 1121.73, 898.00, 284.04, 0.00,
      -197.25, 2598.00, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 2),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 1),
    ('kpi_su_cabin_filter', 2),
    ('kpi_su_lof', 1),
    ('kpi_su_lof_premium', 2),
    ('kpi_su_wheel_alignments', 1),
    ('kpi_su_wheel_balances', 4),
    ('kpi_su_wiper_blades', 2),
    ('kpi_su_battery', 1),
    ('kpi_su_tires', 7)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-30
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-30', 18, 5,
      852.82, 512.74, 1945.77, 1501.99, 235.29, 0.00,
      -20.00, 3115.89, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 1),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_brakes', 1),
    ('kpi_su_lof_premium', 6),
    ('kpi_su_wheel_alignments', 1),
    ('kpi_su_wheel_balances', 5),
    ('kpi_su_tires', 9)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

  -- 2026-07-31
  insert into public.daily_kpi (location_id, business_date, ro_count, zero_dollar_tickets,
      sales_parts, cost_parts, sales_tires, cost_tires, sales_supplies, sales_groupon,
      sales_discounts, declined_sales, credit_apps, credit_dollars)
    values (v_loc, date '2026-07-31', 13, 5,
      1298.93, 201.15, 0.00, 0.00, 150.16, 0.00,
      0.00, 3241.91, 0, 0.00)
    returning id into v_kpi;
  insert into public.daily_service_units (daily_kpi_id, service_category_id, units)
  select v_kpi, sc.id, v.units from (values
    ('kpi_su_air_filter', 2),
    ('kpi_su_brake_flush', 1),
    ('kpi_su_cabin_filter', 2),
    ('kpi_su_lof_premium', 3),
    ('kpi_su_wheel_alignments', 2)
  ) as v(horizon_key, units)
  join public.service_categories sc on sc.horizon_key = v.horizon_key;

end $$;

-- =====================================================================
-- VERIFY (Millwood #3303, July 2026)
--   select sum(ro_count)            -- 377
--        , sum(zero_dollar_tickets)  -- 60
--        , sum(sales_discounts)      -- -1997.91
--        , sum(declined_sales)       -- 158155.36
--        , sum(credit_apps)          -- 7
--     from public.daily_kpi
--    where location_id = (select id from public.locations where store_number='3303')
--      and business_date between date '2026-07-01' and date '2026-07-31';
--
--   select sc.display_name, sum(u.units)
--     from public.daily_service_units u
--     join public.daily_kpi k on k.id = u.daily_kpi_id
--     join public.service_categories sc on sc.id = u.service_category_id
--    where k.location_id = (select id from public.locations where store_number='3303')
--      and k.business_date between date '2026-07-01' and date '2026-07-31'
--    group by 1 order by 2 desc;
--   -- Tires 142, LOF Premium 150, Wheel Balances 84, Wheel Alignments 46,
--   -- Air Filter 38, Brakes 30
-- =====================================================================
