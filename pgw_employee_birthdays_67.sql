-- =====================================================================
-- 67 -- Employee birthdays and work anniversaries on the schedule
--
-- Why: the user, 2026-09-24. Birthdays and hire-date anniversaries
-- appear on the Employee Schedule calendar, loaded from the ADP
-- Employee Census.
--
--   birth_month, birth_day   NEW. Month and day ONLY -- the birth YEAR
--                            is deliberately not stored. The calendar
--                            needs no more, and the portal then never
--                            holds anyone's full date of birth or age.
--   rehire_date              NEW. ADP's rehire date. When set, the work
--                            anniversary counts from it (user decision);
--                            hire_date stays the ORIGINAL hire date.
--   hire_date                unchanged (migration 56).
--
-- No new policies: employees is already location-scoped by
-- can_access_location(), so the people who can see a store's schedule
-- see its birthdays, and a store manager can correct their own people's
-- dates the same way they already edit name and hire date.
--
-- Feb 29 is a valid birthday; the calendar shows it on Feb 28 in
-- non-leap years.
--
-- Run in the Supabase SQL Editor, AFTER migration 56. Repeatable.
-- =====================================================================

alter table public.employees
  add column if not exists birth_month smallint null,
  add column if not exists birth_day   smallint null,
  add column if not exists rehire_date date     null;

-- Both halves or neither, and a real calendar day (leap day allowed).
-- The explicit NOT NULLs matter: a check that evaluates to NULL PASSES,
-- so without them a month with no day would slip through.
alter table public.employees drop constraint if exists employees_birthday_valid;
alter table public.employees add constraint employees_birthday_valid
  check (
    (birth_month is null and birth_day is null)
    or (birth_month is not null and birth_day is not null
        and birth_month between 1 and 12
        and birth_day between 1 and
          case when birth_month = 2 then 29
               when birth_month in (4, 6, 9, 11) then 30
               else 31 end)
  );

alter table public.employees drop constraint if exists employees_rehire_after_hire;
alter table public.employees add constraint employees_rehire_after_hire
  check (rehire_date is null or hire_date is null or rehire_date >= hire_date);

comment on column public.employees.birth_month is
  'Birthday month (1-12), for the schedule calendar. The birth YEAR is deliberately never stored.';
comment on column public.employees.birth_day is
  'Birthday day of month, paired with birth_month.';
comment on column public.employees.rehire_date is
  'ADP rehire date. When set, the work anniversary counts from this instead of hire_date (the original hire).';

notify pgrst, 'reload schema';


-- =====================================================================
-- VERIFY -- in the SQL Editor
--
--  [1] Three new columns:
--        select column_name, data_type from information_schema.columns
--         where table_name = 'employees'
--           and column_name in ('birth_month','birth_day','rehire_date');
--
--  [2] An impossible birthday is refused (expect 23514; nothing changes):
--        update public.employees set birth_month = 2, birth_day = 30
--         where id = (select id from public.employees limit 1);
-- =====================================================================
