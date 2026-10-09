-- =====================================================================
-- Migration 82 -- Employee column guard
--
-- Why: employees RLS (migration 14) lets anyone who can access a store
-- insert and update ANY column of that store's employees. Only the UI
-- hid the salaried switch, labor % fields and reactivate, so a store
-- login could set them straight through the REST API.
--
-- WHAT A STORE USER MAY STILL DO (the user, 2026-10-09):
--   * edit name, hire / rehire date, birthday, Employee / ADP ID and
--     ADP Position ID (the profile's Details form);
--   * add a person, with a starting position (the brand trigger still
--     checks it), as active, not salaried, no labor % settings;
--   * END employment: an active row with no last day -> active = false
--     with a last day. Exactly what "End employment" writes.
--
-- WHAT IS NOW DISTRICT / REGIONAL / ADMIN / MASTER ONLY:
--   position (after the row exists), is_store_manager, labor_pct_eligible,
--   labor_pct_rate, sales_expectation_flat, transferred_from_id,
--   transfer_date, and any other change to active / termination_date
--   (reactivating, clearing or moving a last day).
--
-- Everyone else who can write (district/regional/admin/master) is not
-- checked here; RLS still limits them to their own stores. With no
-- signed-in user (SQL Editor, service role) the guard steps aside, so
-- roster loads keep working.
--
-- transfer_employee() (migration 76) is SECURITY DEFINER, but auth.uid()
-- is still the caller, so a DM's transfer reads as 'district' and
-- passes; store users can't call it at all.
--
-- Office logins (migration 78) have no write policy on employees, so
-- they never reach this trigger.
--
-- Run after 76. Independent of 80 and 81. Safe to re-run.
-- =====================================================================

create or replace function public.employees_column_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if auth.uid() is null
     or public.current_user_role() in ('district','regional','admin','master') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.is_store_manager
       or new.labor_pct_eligible
       or new.labor_pct_rate is not null
       or new.sales_expectation_flat is not null
       or new.active is distinct from true
       or new.termination_date is not null
       or new.transferred_from_id is not null
       or new.transfer_date is not null then
      raise exception 'A new employee starts active, not salaried and with no labor %% settings; a district manager or administrator sets the rest'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- The profile saves the whole Details form, so an untouched value
  -- arrives unchanged and passes. Only an actual edit is refused.
  if new.position is distinct from old.position then
    raise exception 'Only a district manager or administrator can change a position'
      using errcode = '42501';
  end if;
  if new.is_store_manager is distinct from old.is_store_manager then
    raise exception 'Only a district manager or administrator can set the store-manager (salaried) flag'
      using errcode = '42501';
  end if;
  if new.labor_pct_eligible     is distinct from old.labor_pct_eligible
     or new.labor_pct_rate         is distinct from old.labor_pct_rate
     or new.sales_expectation_flat is distinct from old.sales_expectation_flat then
    raise exception 'Only a district manager or administrator can change labor %% settings'
      using errcode = '42501';
  end if;
  if new.transferred_from_id is distinct from old.transferred_from_id
     or new.transfer_date    is distinct from old.transfer_date then
    raise exception 'Transfers are made with Transfer to another store'
      using errcode = '42501';
  end if;

  -- Ending employment is the one change allowed here: an active row
  -- with no last day becomes inactive with one.
  if new.active is distinct from old.active
     or new.termination_date is distinct from old.termination_date then
    if not (old.active and old.termination_date is null
            and not new.active and new.termination_date is not null) then
      raise exception 'Only a district manager or administrator can reactivate someone or change a last day worked'
        using errcode = '42501';
    end if;
  end if;

  return new;
end
$fn$;

drop trigger if exists employees_column_guard on public.employees;
create trigger employees_column_guard
  before insert or update on public.employees
  for each row execute function public.employees_column_guard();


-- =====================================================================
-- VERIFY
--   [1] In the SQL Editor:
--         select tgname from pg_trigger
--          where tgrelid = 'public.employees'::regclass and not tgisinternal;
--       -> employees_adp_position_id_norm, employees_column_guard,
--          trg_enforce_position_brand (plus audit_row_change once 81 is in).
--   [2] As a STORE user on their own store: changing position,
--       is_store_manager, labor_pct_* or sales_expectation_flat is
--       refused 42501; reactivating is refused 42501; saving the
--       Details form (name, dates, IDs) still works; End employment
--       still works.
--   [3] As a DISTRICT user: all of the above save; Transfer works.
--   [4] As MASTER: all of the above save.
-- =====================================================================
