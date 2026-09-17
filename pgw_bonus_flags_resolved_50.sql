-- =====================================================================
-- PGW Support Portal — two Model B questions are answered
-- Run AFTER pgw_dashboard_gp_adjustments_49.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Migration 26 seeded `bonus_flags` with the conflicts and open
-- questions found in the bonus handouts. The Bonus Tracker shows them as
-- "open questions on this plan". Two of them are now answered by the
-- user (2026-09-17):
--
--   model_b_improvement_recipient
--     "***PLUS 6% OF ALL GP IMPROVEMENT OVER LAST YEAR***" named no
--     recipient. Migration 26 assigned it to the STORE MANAGER and
--     flagged the guess. CONFIRMED: the store manager receives it.
--     Nothing about the payout changes -- bonusMath.js already pays
--     base_manager + improvement + half the Google incentive.
--
--   model_b_double_condition
--     "grow GP by 10.01%" is read as clearing the seeded "+10.01% LY"
--     threshold, which the handout floors at $35,000 -- so in a weak
--     month that column is more than a literal 10.01% over last year,
--     and the doubled credit-app and tire bonuses trigger on the same
--     threshold that pays the 3% rate. CONFIRMED: that reading is right.
--
-- WHY RESOLVE RATHER THAN DELETE. Migration 26 re-seeds every flag with
-- `on conflict (code) do update`, so a deleted row comes back the next
-- time anyone re-runs it. Marking the row resolved survives that: 26's
-- upsert does not touch these two columns. It also keeps the decision
-- where the question was asked, instead of only in a commit message.
--
-- The Bonus Tracker reads unresolved flags only (`resolved_at is null`,
-- useBonusTracker.js in the same PR), so both rows stop appearing on
-- screen while the record of the answer stays in the table.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. COLUMNS
-- ---------------------------------------------------------------------
alter table public.bonus_flags
  add column if not exists resolved_at   timestamptz,
  add column if not exists resolved_note text;

comment on column public.bonus_flags.resolved_at is
  'When the question was answered. A resolved flag is history: the Bonus Tracker shows only rows where this is null.';
comment on column public.bonus_flags.resolved_note is
  'The answer, and who gave it.';


-- ---------------------------------------------------------------------
-- 2. THE TWO ANSWERS
--    `resolved_at` is only set the first time, so a re-run does not move
--    the date. The note is refreshed either way.
-- ---------------------------------------------------------------------
update public.bonus_flags
   set resolved_at   = coalesce(resolved_at, now()),
       resolved_note = 'Confirmed by the user 2026-09-17: the STORE MANAGER receives the 6% of GP improvement over last year. This is what migration 26 assumed and what the tracker already pays.'
 where code = 'model_b_improvement_recipient';

update public.bonus_flags
   set resolved_at   = coalesce(resolved_at, now()),
       resolved_note = 'Confirmed by the user 2026-09-17: "grow GP by 10.01%" means clearing the seeded "+10.01% LY" threshold (floored at $35,000), and the doubled credit-app and tire bonuses trigger on that same threshold.'
 where code = 'model_b_double_condition';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Both rows are resolved and carry their answer (2 rows):
--        select code, resolved_at, left(resolved_note, 60)
--          from public.bonus_flags where resolved_at is not null;
--
--  [2] Nothing else was touched (7 rows, all the other conflicts):
--        select count(*) from public.bonus_flags where resolved_at is null;
--
--  [3] On screen: open the Bonus Tracker on a Model B store (#3984
--      Decker or #3305 Pleasantburg). The "open questions" panel no
--      longer lists either Model B question, and the Model B payout
--      figures are unchanged.
-- =====================================================================
