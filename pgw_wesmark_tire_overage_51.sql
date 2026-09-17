-- =====================================================================
-- PGW Support Portal — Wesmark's tire overage moves to "above 11",
--                      and three more bonus questions are answered
-- Run AFTER pgw_bonus_flags_resolved_50.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Answered by the user, 2026-09-17:
--
--   1. CREDIT APP KICKER — the HANDOUT amounts are right: $500 at 50
--      apps and $1,500 at 100, minimum Silver GP to qualify. That is
--      what migration 26 seeded, so no amount changes. Millwood's
--      workbook ($500 over 50, $1,000 over 90) was the stale one.
--
--   2. SPEEDEE LEXINGTON (#3308) is Model D, as seeded. BDC's earlier
--      word of Model C is superseded. No change.
--
--   3. TIRE SCALES at Lake Murray (16/17/18/19), Two Notch
--      (25/26/27/28) and Wesmark (8/9/10/11) are deliberate, not data
--      errors. They stay as seeded.
--
--      BUT Wesmark's OVERAGE LINE IS CORRECTED. Its handout read
--      "above 8" while its tiers run 8/9/10/11, so migration 26 seeded
--      the $500-per-unit increment on Wesmark's BOTTOM row and flagged
--      it. The user gives the correct line:
--
--        "Each unit per day above 11 will add an additional $500
--         to the pool."
--
--      So the increment moves to the TOP row (threshold 11), which is
--      where every other store carries it. Wesmark stops being the
--      exception the seed and lib/bonusMath.js both had to describe.
--
-- THIS CHANGES MONEY, and only at Wesmark. The old anchor paid 500 for
-- every whole tire per day above 8 -- on top of the 9, 10 and 11 rungs
-- that already pay for those same tires. Per day averaged over a month:
--
--     tires/day   anchored at 8 (old)      anchored at 11 (new)
--        9.0      1,500 + 500 =  2,000     1,500
--       11.0      2,500 + 1,500 = 4,000    2,500
--       11.9      2,500 + 1,500 = 4,000    2,500
--       12.0      2,500 + 2,000 = 4,500    2,500 + 500 = 3,000
--
-- So the overage now starts where the ladder ends, which is how every
-- other store reads. No Wesmark tire data exists yet, so no figure
-- already shown to anyone changes today.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. WESMARK'S TIRE OVERAGE: bottom row -> top row
--    Written as "clear every increment on this store's tire ladder,
--    then set it on the highest threshold", so it lands correctly
--    whatever state the rows are in, and re-running changes nothing.
-- ---------------------------------------------------------------------
do $$
declare
  v_loc  uuid;
  v_year int;
begin
  select id into v_loc from public.locations where store_number = '3938';
  if v_loc is null then
    raise notice 'Wesmark (#3938) not found; nothing to do.';
    return;
  end if;

  for v_year in
    select distinct plan_year from public.bonus_incentive_tiers
     where location_id = v_loc and kind = 'tire'
  loop
    update public.bonus_incentive_tiers
       set increment_above = null
     where location_id = v_loc and kind = 'tire' and plan_year = v_year
       and increment_above is not null;

    update public.bonus_incentive_tiers t
       set increment_above = 500.00
     where t.location_id = v_loc and t.kind = 'tire' and t.plan_year = v_year
       and t.threshold = (
         select max(x.threshold) from public.bonus_incentive_tiers x
          where x.location_id = v_loc and x.kind = 'tire' and x.plan_year = v_year);
  end loop;
end
$$;


-- ---------------------------------------------------------------------
-- 2. THE ANSWERS (migration 50's resolved_at / resolved_note)
-- ---------------------------------------------------------------------
update public.bonus_flags
   set resolved_at   = coalesce(resolved_at, now()),
       resolved_note = 'Confirmed by the user 2026-09-17: the HANDOUT amounts govern -- $500 at 50 apps, $1,500 at 100, minimum Silver GP. Millwood''s workbook ($500 over 50, $1,000 over 90) was stale. Seeded values were already correct.'
 where code = 'credit_kicker_amounts';

update public.bonus_flags
   set resolved_at   = coalesce(resolved_at, now()),
       resolved_note = 'Confirmed by the user 2026-09-17: SpeeDee Lexington (#3308) is Model D, as seeded. BDC''s earlier word of Model C is superseded.'
 where code = 'speedee_lexington_model';

update public.bonus_flags
   set resolved_at   = coalesce(resolved_at, now()),
       resolved_note = 'Confirmed by the user 2026-09-17: the unusual scales at Lake Murray (16/17/18/19), Two Notch (25/26/27/28) and Wesmark (8/9/10/11) are deliberate and stay. Wesmark''s overage line is corrected in migration 51 to "Each unit per day above 11 will add an additional $500 to the pool", so its increment now sits on the top row like every other store.'
 where code = 'tire_scale_unusual';


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] Wesmark's increment is on 11 and nowhere else (one row: 11.00, 500.00):
--        select t.threshold, t.payout, t.increment_above
--          from public.bonus_incentive_tiers t
--          join public.locations l on l.id = t.location_id
--         where l.store_number = '3938' and t.kind = 'tire'
--         order by t.tier_index;
--
--  [2] Every store now anchors the overage on its TOP tire row (0 rows):
--        select l.store_number, t.threshold, t.increment_above
--          from public.bonus_incentive_tiers t
--          join public.locations l on l.id = t.location_id
--         where t.kind = 'tire' and t.increment_above is not null
--           and t.threshold < (select max(x.threshold)
--                                from public.bonus_incentive_tiers x
--                               where x.location_id = t.location_id
--                                 and x.kind = 'tire' and x.plan_year = t.plan_year);
--
--  [3] Five flags answered; the four still open are credit_kicker_at_gold,
--      duplicate_handouts, untracked_inputs and penalty_never_applied:
--        select code, resolved_at is not null as answered
--          from public.bonus_flags order by answered, code;
--
--  [4] On screen: the Bonus Tracker's "open questions" panel drops the
--      credit-kicker-amounts, SpeeDee-Lexington and tire-scale entries.
-- =====================================================================
