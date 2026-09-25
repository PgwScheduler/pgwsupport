-- =====================================================================
-- PGW Support Portal — migration 69: "Call Out" shift type
-- Run in the Supabase SQL Editor. Safe to re-run.
-- =====================================================================
-- Asked for by the user 2026-09-25: a call-out label on the Employee
-- Schedule. It is one more row in the company-wide shift_types catalog
-- (migration 30); the legend, the shift dropdown, the weekly hours total
-- and the Excel export all read the catalog, so no screen code changes.
--
-- DECISIONS (user, 2026-09-25):
--   * NOT counted toward the weekly scheduled hours — the person did not
--     work it (same as Unpaid Time Off and Open). The shift keeps its
--     start/end times, so what was planned stays visible, tagged CO.
--   * Its OWN colour: new token shift-lime (#9BE06B on screen, defined in
--     index.css). Hue 95 — 53 degrees clear of the warning yellow and 74
--     of the accent orange, per the rule in migration 30 — and far lighter
--     than Holiday green. 10.73:1 on the weakest surface.
--
-- is_copyable = false: duplicating a month must never copy somebody's
-- call-out forward (same rule as PTO / Sick / Holiday).
-- Sorted right after Sick (40).
--
-- The frontend that knows 'shift-lime' can ship before or after this:
-- until it does, an unknown token falls back to the neutral colour and the
-- CO tag still shows (lib/shiftTypes.js).
-- =====================================================================

insert into public.shift_types
  (name, abbreviation, color_token, export_argb, counts_toward_hours, is_copyable, sort_order)
values
  ('Call Out', 'CO', 'shift-lime', 'FFE8F6D8', false, false, 45)
on conflict (name) do update set
  abbreviation        = excluded.abbreviation,
  color_token         = excluded.color_token,
  export_argb         = excluded.export_argb,
  counts_toward_hours = excluded.counts_toward_hours,
  is_copyable         = excluded.is_copyable,
  sort_order          = excluded.sort_order,
  active              = true;


-- ---------------------------------------------------------------------
-- CONFIRMATION (run after applying)
-- ---------------------------------------------------------------------
--  select name, abbreviation, color_token, export_argb, counts_toward_hours, is_copyable, sort_order, active
--    from public.shift_types order by sort_order;
--  Expect "Call Out | CO | shift-lime | FFE8F6D8 | false | false | 45 | true"
--  between Sick and Training.
