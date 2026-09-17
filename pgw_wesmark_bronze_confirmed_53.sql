-- =====================================================================
-- PGW Support Portal — Wesmark's Bronze at 85% is correct
-- Run AFTER pgw_kicker_at_gold_52.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Confirmed by the user, 2026-09-17: Wesmark (#3938 Midas Sumter) keeps
-- Bronze at 85% of GP budget where every other store uses 80%, and the
-- REASON is that the store was acquired earlier in 2026. Its plan was
-- built differently because the store is new to the company, not because
-- its sheet is wrong.
--
-- The only thing that WAS wrong on that sheet was the tire overage line,
-- corrected in migration 51. Everything else stands as written:
--   * Bronze = budget * 0.85 (Gold 95%, Silver 90% match everyone else);
--   * the plan is built from a GP BUDGET rather than last year's
--     actuals -- which follows from the acquisition, since the company
--     has no trading history of its own for 2025.
--
-- SO THIS IS THE WHOLE ANSWER TO MIGRATION 28'S "worth a look at the
-- sheet as a whole": one real defect, and the rest explained.
--
-- NOT CHANGED HERE, and worth knowing: `prior_year_actuals` holds twelve
-- 2025 rows for this store whose gross profit is exactly 0.39245 x sales
-- every month -- derived, not measured, loaded by BDC decision. Under
-- the acquisition that makes sense (no measured history to load), and it
-- means the store's vs-2025 report columns compare against a modelled
-- baseline. Left as loaded; raise it separately if those columns should
-- read as unavailable instead.
-- =====================================================================

update public.bonus_flags
   set resolved_at   = coalesce(resolved_at, now()),
       resolved_note = 'Confirmed by the user 2026-09-17: Bronze at 85% of budget is correct and stays. Wesmark (#3938 Midas Sumter) was acquired earlier in 2026, which is why its plan differs from every other store -- including being built from a GP budget rather than last year''s actuals. The tire overage line (migration 51) was the only real error on that sheet.'
 where code = 'wesmark_bronze_85';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Seven answered; the three still open are duplicate_handouts,
--      untracked_inputs and penalty_never_applied:
--        select code, resolved_at is not null as answered
--          from public.bonus_flags order by answered, code;
--
--  [2] Wesmark's targets are untouched -- 95 / 90 / 85% of budget,
--      twelve months:
--        select t.month,
--               round(t.gold_threshold   / t.gp_budget * 100, 1) as gold,
--               round(t.silver_threshold / t.gp_budget * 100, 1) as silver,
--               round(t.bronze_threshold / t.gp_budget * 100, 1) as bronze
--          from public.bonus_monthly_targets t
--          join public.locations l on l.id = t.location_id
--         where l.store_number = '3938' and t.plan_year = 2026
--         order by t.month;
-- =====================================================================
