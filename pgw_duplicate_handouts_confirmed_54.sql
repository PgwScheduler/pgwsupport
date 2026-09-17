-- =====================================================================
-- PGW Support Portal — Decker and Pleasantburg are Model B, confirmed
-- Run AFTER pgw_wesmark_bronze_confirmed_53.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Confirmed by the user, 2026-09-17: Model B is right for BOTH #3984
-- Midas Decker and #3305 Midas Pleasantburg.
--
-- Each of the two stores has two handout sheets, one in Model A format
-- and one in Model B. Migration 26 seeded both as B -- which is also
-- what makes the plan counts work -- and flagged the duplicates as an
-- INFO note rather than a conflict. Both are already B, so nothing
-- changes; this closes the note.
--
-- With this, the flags that remain are the two that cannot be closed by
-- a decision, because they need something built:
--   untracked_inputs      -- five-star review counts and phone
--                            conversion feed real money and no system
--                            records them.
--   penalty_never_applied -- the credit-app penalty is shown but never
--                            deducted, because Model A's waiver depends
--                            on the phone conversion nobody tracks.
-- They are one problem in two rows: the second cannot be settled until
-- the first is.
-- =====================================================================

update public.bonus_flags
   set resolved_at   = coalesce(resolved_at, now()),
       resolved_note = 'Confirmed by the user 2026-09-17: Model B is correct for both #3984 Decker and #3305 Pleasantburg. The Model A sheets are stale. Both were already seeded as B.'
 where code = 'duplicate_handouts';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Eight answered; only untracked_inputs and penalty_never_applied
--      remain open:
--        select code, resolved_at is not null as answered
--          from public.bonus_flags order by answered, code;
--
--  [2] Both stores are still Model B:
--        select l.store_number, l.name, p.model
--          from public.bonus_plans p
--          join public.locations l on l.id = p.location_id
--         where l.store_number in ('3984', '3305');
-- =====================================================================
