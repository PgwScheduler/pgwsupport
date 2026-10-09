-- =====================================================================
-- Migration 83 — Only admin/master can hard-delete an employee row
--
-- Why: the user, 2026-10-09. Since migration 14 "employees_delete" was
-- location-only (can_access_location), so any store, office, district or
-- regional user could DELETE their stores' employees straight through
-- the REST API. The portal never does this -- people leave via "End
-- employment" (active = false + termination_date) -- so the policy was
-- an open door, not a feature.
--
-- What a delete does today. Hours and payroll are safe either way:
-- timesheet_entries and payroll_daily are ON DELETE RESTRICT, so anyone
-- with hours cannot be deleted. Someone WITHOUT them (a new hire, a
-- payroll placeholder) can be, and that:
--   * CASCADES: employee_pay_rates, employee_pay_rate_history,
--     tech_pay_rates (all master/admin-only -- RI ignores RLS, so a
--     store user was erasing rows it cannot even read) and
--     employee_schedules;
--   * SETS NULL: tech_daily.employee_id (tech hours lose their tech,
--     which Tech Ranks reads), tech_slots, location_horizon_slots
--     .current_technician_id, horizon_slot_import.resolved_employee_id,
--     directory_contacts.employee_id and employees.transferred_from_id
--     (breaks a transfer chain).
--
-- Now: DELETE is admin/master only. Everyone else gets 0 rows deleted
-- (RLS filters, no error). SQL Editor is unaffected. The audit log (81)
-- still records any delete that does happen.
-- Select/insert/update policies are unchanged. Safe to re-run.
-- =====================================================================

drop policy if exists "employees_delete" on public.employees;
create policy "employees_delete" on public.employees for delete to authenticated
  using (public.current_user_role() in ('admin', 'master'));
