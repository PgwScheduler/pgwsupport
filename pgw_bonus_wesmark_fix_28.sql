-- =====================================================================
-- PGW Support Portal — fix Wesmark's (#3938) corrupt 2026 bonus targets
-- Run AFTER pgw_seed_bonus_2026.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- bonus_seed_2026.csv is column-shifted for Wesmark and ONLY for Wesmark.
-- Its handout carries three columns the standard Model A sheet does not:
--
--   Wesmark:  A Days | B CarGoal | C Month | D SalesGoal | E 2025 Sales
--             F GP Budget | G "vs 25" | H Gold | I "vs 25" | J Silver | K Bronze
--   Standard: A Days | B CarGoal | C Month | D SalesGoal | E GP Budget
--             F Gold | G Silver | H Bronze
--
-- Whoever produced the CSV read it positionally, so every value after
-- sales_goal landed one column to the left of where it belonged:
--
--   gp_budget  <- 2025 Sales   (183,634 for July, not a GP figure at all)
--   gold       <- GP Budget    (92,857.14)
--   silver     <- "vs 25"      (0.2634 — a RATIO, not a dollar amount)
--   bronze     <- Gold         (88,214.29)
--
-- The damage: silver_threshold of $0.26 meant any store month with more
-- than twenty-six cents of projected gross profit resolved to Silver and
-- paid 5%, while bronze at $88,214 sat ABOVE it and was unreachable. A
-- weak month was paid a tier it had not earned, and a strong month that
-- cleared the real Gold of $88,214 was held at Silver because the corrupt
-- gold sat at $92,857. Wrong in both directions.
--
-- Every other store is clean: 312 of the 324 non-Model-B rows are exactly
-- 95% / 90% / 80% of gp_budget, and the twelve that are not are Wesmark's.
--
-- The values below are read straight from the Wesmark handout's own
-- columns F / H / J / K. They sum to 1,100,000 — exactly the Yearly GP
-- the sheet states — which is the check that they are the right columns.
--
-- NOTE: Wesmark's bronze is 85% of budget, not the 80% every other store
-- uses. That is in the handout as written (K = F * 0.85) and is preserved
-- here, flagged for BDC alongside its already-flagged tire scale.
--
-- days_open and daily_car_goal were NOT shifted and are unchanged in
-- substance. January's car goal reads 22.954177753412935 in the handout;
-- daily_car_goal is numeric(6,1), so it already stored as 23.0 and is
-- restated as 23.0 here rather than silently re-rounded.
-- =====================================================================

do $$
declare
  v_loc uuid;
begin
  select id into v_loc from public.locations where store_number = '3938';
  if v_loc is null then raise exception 'Wesmark (store_number=3938) not found'; end if;

  update public.bonus_monthly_targets t
     set days_open        = v.days_open,
         daily_car_goal   = v.daily_car_goal,
         sales_goal       = v.sales_goal,
         gp_budget        = v.gp_budget,
         gold_threshold   = v.gold,
         silver_threshold = v.silver,
         bronze_threshold = v.bronze
    from (values
      (1, 26,23.0,185714.29,92857.14,88214.29,83571.43,78928.57),
      (2, 24,22.0,171428.57,85714.29,81428.57,77142.86,72857.14),
      (3, 26,22.0,185714.29,92857.14,88214.29,83571.43,78928.57),
      (4, 26,24.0,185714.29,92857.14,88214.29,83571.43,78928.57),
      (5, 26,22.0,185714.29,92857.14,88214.29,83571.43,78928.57),
      (6, 26,27.0,185714.29,92857.14,88214.29,83571.43,78928.57),
      (7, 26,25.0,185714.29,92857.14,88214.29,83571.43,78928.57),
      (8, 26,27.0,185714.29,92857.14,88214.29,83571.43,78928.57),
      (9, 25,22.0,178571.43,89285.71,84821.43,80357.14,75892.86),
      (10,27,25.0,192857.14,96428.57,91607.14,86785.71,81964.29),
      (11,24,24.0,171428.57,85714.29,81428.57,77142.86,72857.14),
      (12,26,23.0,185714.29,92857.14,88214.29,83571.43,78928.57)
    ) as v(month, days_open, daily_car_goal, sales_goal, gp_budget, gold, silver, bronze)
   where t.location_id = v_loc
     and t.plan_year   = 2026
     and t.month       = v.month;
end $$;


-- ---------------------------------------------------------------------
-- Guard the whole class of defect, not just this instance. A tier ladder
-- that is out of order is always wrong, whatever produced it — this
-- would have rejected the Wesmark rows at seed time instead of paying
-- them out. Model B legitimately has a null bronze and can have gold =
-- silver in a weak month (both floor at 35,000), so the checks only
-- apply where both sides are present.
-- ---------------------------------------------------------------------
alter table public.bonus_monthly_targets
  drop constraint if exists bonus_targets_tier_order;
alter table public.bonus_monthly_targets
  add constraint bonus_targets_tier_order check (
    (gold_threshold   is null or silver_threshold is null or gold_threshold   >= silver_threshold) and
    (silver_threshold is null or bronze_threshold is null or silver_threshold >= bronze_threshold)
  );


-- ---------------------------------------------------------------------
-- Flag Wesmark's 85% bronze so nobody "corrects" it back to 80% later.
-- ---------------------------------------------------------------------
insert into public.bonus_flags (code, scope_location_id, severity, summary, detail)
select 'wesmark_bronze_85', l.id, 'warn',
       'Wesmark''s Bronze is 85% of GP budget, not the 80% every other store uses',
       'Its handout reads Bronze = Budget * 0.85 (Gold 95%, Silver 90% match everyone else). Preserved as written. Wesmark''s 2026 sheet is also the only one built from a budget rather than last year''s actuals, and the only one whose tire overage line disagrees with its own tiers — worth a look at the sheet as a whole.'
from public.locations l where l.store_number = '3938'
on conflict (code) do update set
  scope_location_id = excluded.scope_location_id,
  severity = excluded.severity,
  summary  = excluded.summary,
  detail   = excluded.detail;


-- =====================================================================
-- VERIFY
--   1) No tier ladder is out of order anywhere:
--        select count(*) from public.bonus_monthly_targets
--          where plan_year = 2026
--            and (gold_threshold < silver_threshold
--                 or silver_threshold < bronze_threshold);     -- 0
--   2) Wesmark's year now sums to its stated 1,100,000 budget:
--        select round(sum(gp_budget),2) from public.bonus_monthly_targets
--          where location_id = (select id from public.locations where store_number='3938')
--            and plan_year = 2026;                             -- 1100000.00
--   3) Wesmark July reads 92,857.14 / 88,214.29 / 83,571.43 / 78,928.57:
--        select gp_budget, gold_threshold, silver_threshold, bronze_threshold
--          from public.bonus_monthly_targets
--          where location_id = (select id from public.locations where store_number='3938')
--            and plan_year = 2026 and month = 7;
--   4) No silver threshold is a stray ratio anywhere:
--        select count(*) from public.bonus_monthly_targets
--          where plan_year = 2026 and silver_threshold < 1;    -- 0
-- =====================================================================
