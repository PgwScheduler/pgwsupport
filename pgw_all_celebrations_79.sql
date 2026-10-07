-- =====================================================================
-- Migration 79 -- Every store's birthdays and anniversaries, for the office
--
-- Why: the user, 2026-10-07. Office staff want one calendar of everyone's
-- birthdays and work anniversaries instead of clicking store by store.
-- Stores keep seeing only their own.
--
-- WHO (decided by the user, 2026-10-07):
--   * logins assigned to the Home Office (#1515, migration 68) -- role
--     'store' with location_id = the Home Office;
--   * the read-only 'office' role (migration 78), which cannot open
--     #1515 but sees every store;
--   * admin and master.
--   Every other store, district and regional login is refused (42501).
--
-- WHAT: company_celebrations() returns, for each ACTIVE employee at a
-- real location (no sandbox; the Home Office's own staff are included),
-- only what the calendar shows: name, birthday month/day (no birth year
-- is stored -- migration 67), hire / rehire date, and the store they
-- are at. Nothing else from the employee record.
--
-- It checks the role itself and reads as its owner, so it does not go
-- through can_access_location() and needs none of migration 78's opt-in
-- lines.
--
-- Run AFTER 78. Safe to re-run.
-- =====================================================================

create or replace function public.company_celebrations()
returns table (
  id            uuid,
  full_name     text,
  birth_month   smallint,
  birth_day     smallint,
  hire_date     date,
  rehire_date   date,
  store_number  text,
  store_name    text
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_role text := public.current_user_role();
begin
  if not (
       coalesce(v_role, '') in ('admin', 'master', 'office')
    or (v_role = 'store' and exists (
          select 1
            from public.profiles p
            join public.locations l on l.id = p.location_id
           where p.id = auth.uid()
             and l.is_home_office))
  ) then
    raise exception 'Everyone''s birthdays and anniversaries are for the Home Office and the office.'
      using errcode = '42501';
  end if;

  return query
  select e.id, e.full_name, e.birth_month, e.birth_day, e.hire_date, e.rehire_date,
         l.store_number::text, l.name
    from public.employees e
    join public.locations l on l.id = e.location_id
   where e.active
     and not l.is_sandbox
     and (e.birth_month is not null or e.hire_date is not null or e.rehire_date is not null)
   order by e.full_name;
end
$fn$;

comment on function public.company_celebrations() is
  'Employee Schedule "all stores" toggle (migration 79): every active employee''s name, birthday month/day, hire/rehire date and store. Home Office logins, office, admin, master only.';

revoke all on function public.company_celebrations() from public, anon;
grant execute on function public.company_celebrations() to authenticated;

notify pgrst, 'reload schema';
