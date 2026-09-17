-- =====================================================================
-- PGW Support Portal — the credit-app kicker IS paid at Gold
-- Run AFTER pgw_wesmark_tire_overage_51.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Confirmed by the user, 2026-09-17: a store that clears Gold still gets
-- the credit-app kicker.
--
-- The Millwood workbook's Gold formula zeroes the kicker whenever
-- projected GP clears Gold, so the best-performing stores lose it.
-- Migration 26 called that a defect rather than policy, paid the kicker
-- at Gold, and flagged the decision. The decision stands, so nothing
-- recalculates -- bonusMath.js already pays it (the kicker needs Silver
-- and is deliberately not withdrawn at Gold).
--
-- This only closes the question.
-- =====================================================================

update public.bonus_flags
   set resolved_at   = coalesce(resolved_at, now()),
       resolved_note = 'Confirmed by the user 2026-09-17: the credit-app kicker IS paid at Gold. The Millwood workbook zeroing it above Gold is a defect and is not replicated. This is what the portal already does.'
 where code = 'credit_kicker_at_gold';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Six answered; the three still open are duplicate_handouts,
--      untracked_inputs and penalty_never_applied:
--        select code, resolved_at is not null as answered
--          from public.bonus_flags order by answered, code;
--
--  [2] On screen: the Bonus Tracker's "open questions" panel no longer
--      lists the kicker-at-Gold entry, and every bonus figure is
--      unchanged.
-- =====================================================================
