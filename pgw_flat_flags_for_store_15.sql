-- =====================================================================
-- PGW Support Portal — expose the FLAT flag (only) to store users
-- Run AFTER pgw_employee_hours_payroll_rebuild_14.sql. Safe to re-run.
-- =====================================================================
-- The master grid computes the FLAT flag client-side from pay rates,
-- which store users can't read. To show store users just the flag (a
-- single boolean per employee) WITHOUT leaking the underlying rates or
-- dollars, we compute it inside a SECURITY DEFINER function and return
-- only employee_id + boolean — same pattern as payroll_pct_summary.
--
-- flat_flag = total_flat_rate_pay > total_hourly_pay  (excludes bonus/
-- incentives, which apply equally to both sides). Managers are salaried,
-- so their flag is always false. The formula MUST match computePayRow()
-- in lib/payrollMath.js.
-- =====================================================================
create or replace function public.flat_flags_for_week(loc uuid, wk date)
returns table (employee_id uuid, flat_flag boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc;
  end if;

  return query
  select
    te.employee_id,
    case
      when e.position = 'manager' then false
      else
        (coalesce(r.flat_rate_per_hour, 0) * (te.hrs_turned_other + te.hrs_turned_here))
        >
        (coalesce(r.hourly_rate, 0) * least(te.clock_hours_other + te.clock_hours, 40)
         + coalesce(r.hourly_rate, 0) * 1.5
             * greatest(te.clock_hours_other + te.clock_hours - 40, 0))
    end
  from public.timesheet_entries te
  join public.employees e on e.id = te.employee_id
  left join public.employee_pay_rates r on r.employee_id = te.employee_id
  where te.location_id = loc and te.week_start = wk;
end;
$$;

grant execute on function public.flat_flags_for_week(uuid, date) to authenticated;

-- VERIFY (as a store user, through the app):
--   select * from public.flat_flags_for_week('LOCATION-ID', '2026-07-13');
--   -> returns only (employee_id, flat_flag); no rate or dollar columns.
