-- =====================================================================
-- PGW Support Portal — migration 73: a position can be "not set yet"
-- Run in the Supabase SQL Editor. Safe to re-run.
-- =====================================================================
-- Asked for by the user 2026-09-25 while adding the ADP census people who
-- were missing from the portal: the census has no job titles, so "leave
-- job title blank until it can be confirmed".
--
-- employees.position was NOT NULL (default 'tech', migration 14). It now
-- allows NULL = not confirmed yet. Nothing else changes:
--   * the position list check and enforce_position_brand() already let a
--     NULL through (a NULL comparison never fails a check or raises);
--   * the default stays 'tech', so an insert that names no position
--     behaves exactly as before -- blank has to be asked for explicitly;
--   * payroll: CST is manager + front and VST is total minus CST, in both
--     payroll_pct_summary() and lib/payrollMath.js -- so a person with no
--     position counts in total payroll and in VST until one is set, the
--     same as every other non-manager / non-front position.
-- The screens show "— Not set —" until someone picks a real position.
-- =====================================================================

alter table public.employees alter column position drop not null;

comment on column public.employees.position is
  'Job position. NULL = not confirmed yet (migration 73); shown as "Not set" until someone picks one. Valid values depend on brand / Home Office (enforce_position_brand).';


-- ---------------------------------------------------------------------
-- CONFIRMATION (run after applying)
-- ---------------------------------------------------------------------
--  select is_nullable, column_default from information_schema.columns
--   where table_schema = 'public' and table_name = 'employees' and column_name = 'position';
--  Expect YES | 'tech'::text
