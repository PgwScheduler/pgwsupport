-- =====================================================================
-- SEED — Millwood July 2026 Technician Tracker data (Task 4 verification)
-- Run AFTER pgw_tech_time_tracker_24.sql. Idempotent-ish: clears this
-- store's tech rows first, then re-inserts. SET THE STORE NUMBER BELOW.
-- =====================================================================
do $$
declare
  v_store_number text := '3303';  -- Midas Millwood Ave (from pgw_populate_store_numbers_05.sql)
  v_loc  uuid;
  v_emp  uuid;
  v_slot uuid;
begin
  select id into v_loc from public.locations where store_number = v_store_number;
  if v_loc is null then raise exception 'Millwood location (store_number=%) not found', v_store_number; end if;

  -- wipe any prior tech data for this store so the seed is repeatable
  delete from public.tech_daily  where location_id = v_loc;
  delete from public.tech_weekly where tech_slot_id in (select id from public.tech_slots where location_id = v_loc);
  delete from public.tech_slots  where location_id = v_loc;

  -- ---- slot 1: Phillip Brayboy ----
  select id into v_emp from public.employees where location_id = v_loc and full_name = 'Phillip Brayboy' limit 1;
  if v_emp is null then
    insert into public.employees (location_id, full_name, position) values (v_loc, 'Phillip Brayboy', 'tech') returning id into v_emp;
  end if;
  insert into public.tech_slots (location_id, slot_index, employee_id, is_manager_or_sa) values (v_loc, 1, v_emp, false) returning id into v_slot;
  insert into public.tech_pay_rates (employee_id, effective_date, flat_rate, guarantee_rate) values (v_emp, '2026-01-01', 36, 16) on conflict (employee_id, effective_date) do update set flat_rate=excluded.flat_rate, guarantee_rate=excluded.guarantee_rate;
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-01', 10.5, 6.8, 1135.01);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-02', 10.45, 4.5, 202.18);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-03', 10, 3.9, 439.11);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-06', 10, 2.42, 97.28);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-07', 10.5, 2.3, 444.3);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-08', 10.65, 3.5, 690.96);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-10', 10.47, 4.2, 812.49);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-11', 9.48, 2.56, 457.96);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-13', 10.45, 3.35, 723.37);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-14', 10.38, 0.4, 22.79);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-15', 10.27, 4.22, 875.89);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-16', 0, 1.3, 287.87);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-17', 10.37, 2.95, 594.01);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-18', 9.2, 1, 229.99);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-20', 10.22, 3.2, 806.53);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-21', 10.25, 5.45, 1094.58);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-22', 10.55, 0.8, 75.03);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-23', 0, 4.8, 524.12);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-24', 10.3, 3.9, 889.74);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-25', 9.22, 2.1, 422.85);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-27', 10.47, 2.31, 614.11);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-28', 10.28, 3.3, 826.18);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-29', 10.02, 4.75, 926.49);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-31', 10.17, 7.1, 1641.31);

  -- ---- slot 2: BRADLEY JONES ----
  select id into v_emp from public.employees where location_id = v_loc and full_name = 'Bradley Jones' limit 1;
  if v_emp is null then
    insert into public.employees (location_id, full_name, position) values (v_loc, 'Bradley Jones', 'tech') returning id into v_emp;
  end if;
  insert into public.tech_slots (location_id, slot_index, employee_id, is_manager_or_sa) values (v_loc, 2, v_emp, false) returning id into v_slot;
  insert into public.tech_pay_rates (employee_id, effective_date, flat_rate, guarantee_rate) values (v_emp, '2026-01-01', 40, 20) on conflict (employee_id, effective_date) do update set flat_rate=excluded.flat_rate, guarantee_rate=excluded.guarantee_rate;
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-01', 10.05, 4.1, 630.93);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-02', 9.75, 18.39, 3566.04);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-03', 10.22, 3.4, 274.76);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-07', 10.17, 2.95, 292.24);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-08', 10.13, 6.82, 1009.73);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-09', 10.15, 4.85, 587.79);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-10', 9.77, 6.4, 708.87);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-11', 9.23, 7.6, 995.98);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-14', 10.13, 5.8, 941.77);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-15', 10.1, 3.6, 440.28);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-16', 10.25, 5.57, 975.27);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-17', 10.17, 11.75, 2040.22);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-18', 9.05, 3.17, 185.48);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-21', 0, 0.3, 42.83);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-22', 10.32, 4.1, 374.18);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-23', 10.23, 13.88, 2481.96);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-24', 10.25, 3.53, 531.24);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-25', 9.07, 3.82, 399.47);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-27', 0, 3.3, 864.8);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-28', 10.13, 12.15, 2386.34);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-29', 10.02, 7.07, 1159.37);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-30', 9.9, 5, 615.08);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-31', 10.12, 2.82, 369.6);

  -- ---- slot 3: Cash Cantrell ----
  select id into v_emp from public.employees where location_id = v_loc and full_name = 'Cash Cantrell' limit 1;
  if v_emp is null then
    insert into public.employees (location_id, full_name, position) values (v_loc, 'Cash Cantrell', 'tech') returning id into v_emp;
  end if;
  insert into public.tech_slots (location_id, slot_index, employee_id, is_manager_or_sa) values (v_loc, 3, v_emp, false) returning id into v_slot;
  insert into public.tech_pay_rates (employee_id, effective_date, flat_rate, guarantee_rate) values (v_emp, '2026-01-01', 34, 17) on conflict (employee_id, effective_date) do update set flat_rate=excluded.flat_rate, guarantee_rate=excluded.guarantee_rate;
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-01', 10.43, 5.97, 582.28);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-02', 9.75, 2.96, 214.45);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-03', 10.42, 4, 840.52);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-06', 10.25, 3.8, 421.03);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-07', 10.28, 2.25, 208.09);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-09', 10.53, 4.02, 663.79);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-10', 10.47, 5.07, 663.02);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-11', 9.1, 6.05, 672.85);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-13', 10.45, 5.3, 626.04);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-14', 10.12, 6.47, 582.1);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-16', 10.03, 9.34, 1141.23);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-17', 10.17, 6.25, 929.86);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-18', 9.02, 6.78, 1065.78);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-20', 9.63, 5.82, 753.53);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-21', 9.85, 5.91, 655.98);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-23', 10.2, 2.75, 190.28);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-24', 9.68, 2.02, 265.08);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-25', 9, 4.79, 337.44);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-27', 9.97, 5.27, 998.11);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-28', 10.03, 5.52, 777.6);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-29', 0, 0.53, 116.27);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-30', 10.2, 4.37, 519.8);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-31', 9.87, 2.02, 198.64);

  -- ---- slot 4: Alan Barron ----
  select id into v_emp from public.employees where location_id = v_loc and full_name = 'Alan Barron' limit 1;
  if v_emp is null then
    insert into public.employees (location_id, full_name, position) values (v_loc, 'Alan Barron', 'tech') returning id into v_emp;
  end if;
  insert into public.tech_slots (location_id, slot_index, employee_id, is_manager_or_sa) values (v_loc, 4, v_emp, false) returning id into v_slot;
  insert into public.tech_pay_rates (employee_id, effective_date, flat_rate, guarantee_rate) values (v_emp, '2026-01-01', 45, 20) on conflict (employee_id, effective_date) do update set flat_rate=excluded.flat_rate, guarantee_rate=excluded.guarantee_rate;
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-20', 9.95, 0.5, 69.99);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-21', 9.65, 5.9, 1029.8);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-22', 6.35, 0.8, 40.65);

  -- ---- slot 5: Joseph Fabre ----
  select id into v_emp from public.employees where location_id = v_loc and full_name = 'Joseph Fabre' limit 1;
  if v_emp is null then
    insert into public.employees (location_id, full_name, position) values (v_loc, 'Joseph Fabre', 'tech') returning id into v_emp;
  end if;
  insert into public.tech_slots (location_id, slot_index, employee_id, is_manager_or_sa) values (v_loc, 5, v_emp, false) returning id into v_slot;
  insert into public.tech_pay_rates (employee_id, effective_date, flat_rate, guarantee_rate) values (v_emp, '2026-01-01', 40, 20) on conflict (employee_id, effective_date) do update set flat_rate=excluded.flat_rate, guarantee_rate=excluded.guarantee_rate;
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-01', 10.37, 6.92, 1539.76);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-02', 10.45, 5.95, 1255.68);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-03', 10.55, 6.25, 1416.4);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-06', 10.32, 6.02, 1008.95);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-07', 10.52, 2, 457.87);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-08', 10.63, 4.4, 957.27);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-09', 0, 2.85, 578.24);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-16', 0, 0, 15.76);

  -- ---- slot 6: tech ----
  insert into public.tech_slots (location_id, slot_index, employee_id, label, is_manager_or_sa) values (v_loc, 6, null, 'tech', false) returning id into v_slot;

  -- ---- slot 7: tech 2 ----
  insert into public.tech_slots (location_id, slot_index, employee_id, label, is_manager_or_sa) values (v_loc, 7, null, 'Rick Schroeder', false) returning id into v_slot;

  -- ---- slot 8: tech 3 ----
  insert into public.tech_slots (location_id, slot_index, employee_id, label, is_manager_or_sa) values (v_loc, 8, null, 'tech 3', false) returning id into v_slot;

  -- ---- slot 9: MANAGER OR SA ----
  insert into public.tech_slots (location_id, slot_index, employee_id, label, is_manager_or_sa) values (v_loc, 9, null, 'MANAGER OR SA', true) returning id into v_slot;
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-14', 0, 0, 39.99);
  insert into public.tech_daily (location_id, tech_slot_id, work_date, hours_worked, flag_hours, labor_sales) values (v_loc, v_slot, '2026-07-18', 0, 0, 39.99);

  raise notice 'Millwood July tech data seeded for location %', v_loc;
end $$;
