-- =====================================================================
-- PGW Support Portal — migration 72: ADP Position ID on the employee
-- Run in the Supabase SQL Editor. Safe to re-run.
-- =====================================================================
-- Asked for by the user 2026-09-25: "add the ADP position id to the
-- employee profile ... so that way we don't have the 'Duplicate' problem
-- again." The 68b roster load matched people by NAME and created 10
-- duplicates (spelling variants, first/last swapped, nicknames). ADP's
-- Position ID (e.g. MWT000084, 04G101176, LT7101095) is the key a load
-- should match on instead.
--
--   * employees.adp_position_id — three letters/digits then six digits,
--     stored upper-case and trimmed (a trigger normalises what is typed).
--   * NO TWO ACTIVE EMPLOYEES may share one. Active only, on purpose: a
--     transfer ends the row at the old store and keeps the person active
--     at the new one, and ADP may keep the same Position ID across that
--     move -- the ended row keeping it is history, not a duplicate.
--     Reactivating a row whose ID another active employee now holds is
--     refused, which is exactly the duplicate this exists to stop.
--   * employee_number ("Employee / ADP ID", migration 56) is unchanged.
--
-- No policy changes: employees is already location-scoped, and whoever
-- may edit an employee's profile may set this field.
-- =====================================================================

alter table public.employees
  add column if not exists adp_position_id text null;

alter table public.employees drop constraint if exists employees_adp_position_id_format;
alter table public.employees add constraint employees_adp_position_id_format
  check (adp_position_id is null or adp_position_id ~ '^[A-Z0-9]{3}[0-9]{6}$');

comment on column public.employees.adp_position_id is
  'ADP Position ID (migration 72), e.g. MWT000084. Unique among ACTIVE employees; roster loads match on it before names.';

-- Normalise what people type: trim, upper-case, blank -> null.
create or replace function public.employees_adp_position_id_norm()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.adp_position_id is not null then
    new.adp_position_id := nullif(upper(btrim(new.adp_position_id)), '');
  end if;
  return new;
end;
$$;
drop trigger if exists employees_adp_position_id_norm on public.employees;
create trigger employees_adp_position_id_norm
  before insert or update of adp_position_id on public.employees
  for each row execute function public.employees_adp_position_id_norm();

create unique index if not exists employees_adp_position_id_active_key
  on public.employees (adp_position_id)
  where adp_position_id is not null and active;

create index if not exists employees_adp_position_id_idx
  on public.employees (adp_position_id) where adp_position_id is not null;


-- ---------------------------------------------------------------------
-- CONFIRMATIONS (run after applying)
-- ---------------------------------------------------------------------
--  1) select column_name, data_type from information_schema.columns
--      where table_name = 'employees' and column_name = 'adp_position_id';
--     Expect one row, text.
--  2) select indexdef from pg_indexes where indexname = 'employees_adp_position_id_active_key';
--     Expect ... WHERE ((adp_position_id IS NOT NULL) AND active)
