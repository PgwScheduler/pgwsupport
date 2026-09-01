-- =====================================================================
-- PGW Support Portal — Seed store 2320 (Semoran)            (Brief 38a)
-- Run AFTER pgw_horizon_slots_38.sql, in the Supabase SQL Editor.
-- Safe to re-run (upserts throughout).
-- =====================================================================
-- NAME CONFIRMED: "Midas Semoran". READY TO RUN.
--
-- This file was held back from migration 38 because the name was not
-- settled — the bonus sheet tab read "Semoran" while BDC referred to the
-- store as "Orlando". Every later artefact (handout tabs, bonus CSVs,
-- prior-year imports) matches stores by name or by store number, so a
-- guessed name is one that fails to match later. Confirmed as
-- "Midas Semoran"; the prefix follows the existing convention set by
-- rows like 'Midas Bush River'.
--
-- If the name is ever revised, it is still a one-line change to v_name
-- below, and re-running this file updates the existing row in place
-- rather than creating a second store.
--
-- Everything else about 2320 is settled and is reproduced here exactly
-- as it is for 2322 in migration 38: Florida district, $200 float,
-- Model A, 11 cars/day, four months of goals (Sep–Dec 2026 only), the
-- standard Model A incentive scale, and a null horizon_shop_number until
-- credentials are loaded.
--
-- Store 2320 was acquired from a non-Midas operator and is NEW TO
-- HORIZON ENTIRELY. It has no prior slot history: migration 38's trigger
-- provisions its 20 slot rows empty with ever_used = false, and its
-- first technician takes slot 1 from the normal queue. It is not part of
-- the Millwood slot collection.
-- =====================================================================

do $seed$
declare
  -- Confirmed with BDC. Matched by store_number everywhere downstream,
  -- so this is the display name, not a key.
  v_name text := 'Midas Semoran';
  v_loc  uuid;
  v_dist uuid;
begin
  select id into v_dist from public.districts where name = 'Florida';
  if v_dist is null then
    raise exception 'District "Florida" not found — run the seed migrations first'
      using errcode = '42704';
  end if;

  -- ---- the store ----------------------------------------------------
  insert into public.locations
    (name, store_number, address, phone, drawer_float, district_id, brand)
  select v_name, '2320',
         '1222 North Semoran Boulevard, Orlando, FL 32807',
         '689.285.2049', 200.00, v_dist, 'midas'
  where not exists (select 1 from public.locations where store_number = '2320');

  update public.locations
     set name         = v_name,
         address      = '1222 North Semoran Boulevard, Orlando, FL 32807',
         phone        = '689.285.2049',
         drawer_float = 200.00,
         district_id  = v_dist
   where store_number = '2320';

  select id into v_loc from public.locations where store_number = '2320';

  -- ---- bonus plan: Model A ------------------------------------------
  insert into public.bonus_plans (location_id, plan_year, model)
  values (v_loc, 2026, 'A')
  on conflict (location_id, plan_year) do update
    set model = excluded.model, updated_at = now();

  -- ---- goals: SEPTEMBER THROUGH DECEMBER 2026 ONLY -------------------
  -- A four-month set, not an annual one. Expires 2026-12-31; 2027 needs
  -- a new sheet.
  --
  -- *** DO NOT CREATE A store_annual_goals ROW FOR THIS STORE. ***
  -- v_store_monthly_gp_target is driven by store_annual_goals: it
  -- divides gp_target by annual_days_open(2026) and spreads it across
  -- twelve months, which would invent Jan–Aug targets for a store that
  -- was not open. With no annual row the view yields nothing and
  -- _report_store_scalars falls through to these four rows for Sep–Dec,
  -- returning null for Jan–Aug. That is correct.
  --
  -- days_open is stored alongside the goals because the PACE row needs
  -- it, and all four agree with derived_days_open(2026, m): Sep 25
  -- (Labor Day), Oct 27, Nov 24 (Thanksgiving), Dec 26 (Christmas).
  -- Derived from $952,314 sales / $512,269 GP annualized over the 308
  -- days annual_days_open(2026) computes -> $3,091.9286 and $1,663.2110
  -- per day. Gold/Silver/Bronze are 95/90/80% of GP budget. Seeded as
  -- given, never recomputed.
  insert into public.bonus_monthly_targets
    (location_id, plan_year, month, days_open, daily_car_goal,
     sales_goal, gp_budget, gold_threshold, silver_threshold, bronze_threshold, last_year_gp)
  select v_loc, 2026, v.month, v.days_open, v.daily_car_goal,
         v.sales_goal, v.gp_budget, v.gold, v.silver, v.bronze, null::numeric
  from (values
    ( 9, 25, 11.0, 77298.21, 41580.28, 39501.26, 37422.25, 33264.22),
    (10, 27, 11.0, 83482.07, 44906.70, 42661.36, 40416.03, 35925.36),
    (11, 24, 11.0, 74206.29, 39917.06, 37921.21, 35925.36, 31933.65),
    (12, 26, 11.0, 80390.14, 43243.49, 41081.31, 38919.14, 34594.79)
  ) as v(month, days_open, daily_car_goal, sales_goal, gp_budget, gold, silver, bronze)
  on conflict (location_id, plan_year, month) do update set
    days_open        = excluded.days_open,
    daily_car_goal   = excluded.daily_car_goal,
    sales_goal       = excluded.sales_goal,
    gp_budget        = excluded.gp_budget,
    gold_threshold   = excluded.gold_threshold,
    silver_threshold = excluded.silver_threshold,
    bronze_threshold = excluded.bronze_threshold,
    last_year_gp     = excluded.last_year_gp;

  -- ---- cars/day on the goals strip, same four months -----------------
  insert into public.store_monthly_goals
    (location_id, goal_year, goal_month, days_open_override, cars_per_day_goal)
  select v_loc, 2026, v.m, v.d, 11.0
  from (values (9,25),(10,27),(11,24),(12,26)) as v(m, d)
  on conflict (location_id, goal_year, goal_month) do update set
    days_open_override = excluded.days_open_override,
    cars_per_day_goal  = excluded.cars_per_day_goal,
    updated_at         = now();

  -- ---- incentive scale ----------------------------------------------
  -- The company-wide scalars already live in bonus_policy (migration 26)
  -- and match this brief exactly — google_per_review 10,
  -- google_min_reviews 15, credit_penalty_per_app 75,
  -- credit_penalty_floor 35, phone_conversion_waiver 0.40. Only the
  -- per-store scale is seeded, and it is the standard Model A shape,
  -- identical to Millwood #3303 and to 2322.
  insert into public.bonus_incentive_tiers
    (location_id, plan_year, kind, tier_index, threshold, payout, increment_above)
  select v_loc, 2026, v.kind, v.tier_index, v.threshold, v.payout, v.increment_above
  from (values
    ('tire',       1,  5.00, 1250.00, null),
    ('tire',       2,  6.00, 1500.00, null),
    ('tire',       3,  7.00, 2000.00, null),
    ('tire',       4,  8.00, 2500.00, 500.00),
    ('credit_app', 1, 50.00,  500.00, null),
    ('credit_app', 2,100.00, 1500.00, null)
  ) as v(kind, tier_index, threshold, payout, increment_above)
  on conflict (location_id, plan_year, kind, tier_index) do update set
    threshold       = excluded.threshold,
    payout          = excluded.payout,
    increment_above = excluded.increment_above;

  raise notice 'Store 2320 seeded as "%".', v_name;
end
$seed$;

-- =====================================================================
-- VERIFY
--   1) select store_number, name, address, phone, drawer_float, brand,
--             district_id, horizon_shop_number, is_sandbox
--        from public.locations where store_number = '2320';
--      -- confirmed name, Florida district, $200, midas, shop number null
--
--   2) Twenty empty slots, first assignment is slot 1:
--        select count(*), count(*) filter (where ever_used)
--          from public.location_horizon_slots
--         where location_id = (select id from public.locations where store_number='2320');
--        -- 20, 0
--        select public.next_horizon_slot(
--          (select id from public.locations where store_number='2320'));   -- 1
--
--   3) Four months, no padding:
--        select month, days_open, daily_car_goal, sales_goal, gp_budget
--          from public.bonus_monthly_targets
--         where location_id = (select id from public.locations where store_number='2320')
--         order by month;                                   -- 9,10,11,12
--
--   4) No annual row, so Jan–Aug stays null:
--        select count(*) from public.store_annual_goals
--         where location_id = (select id from public.locations where store_number='2320');
--        -- 0, and must stay 0
-- =====================================================================
