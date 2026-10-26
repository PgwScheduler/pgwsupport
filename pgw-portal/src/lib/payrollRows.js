import { weekEndOf } from "./weekUtils.js";
import { employedDuring } from "./payRates.js";

// One merged payroll row per employee on the week -- the rule the Payroll
// grid uses (hooks/usePayroll.js) and the all-stores export reuses, so the
// two can never disagree about who is on a week or what their totals are.
//
//   employees  every employee at the location (active or not)
//   entries    timesheet_entries rows for the week
//   ext        employee_id -> brand extension row (timesheet_midas/_speedee)
//   rates      employee_id -> rates in force at the week start (privileged)
//   pays       entry_id    -> timesheet_pay row (privileged)
//   roleRates  position    -> sales_rate_per_hour (SpeeDee)
//   days       employee_id -> date -> resolved day row (daily era)
//   dates      the week's dates (daily era), else []
export function buildPayrollRows({
  employees, entries, ext, rates, pays, roleRates, days, dates,
  isDaily, isSpeedee, privileged, weekStart, cutover,
}) {
  const byEmp = {};
  for (const e of entries) byEmp[e.employee_id] = e;
  const weekEnd = weekEndOf(weekStart, cutover);
  // Mirrors payroll_pct_summary's filter: data in the week, or employed
  // during it. Data is never dropped, whatever the dates say.
  const onWeek = (emp) =>
    !!byEmp[emp.id] || Object.keys(days[emp.id] ?? {}).length > 0 || employedDuring(emp, weekStart, weekEnd);
  return employees.filter(onWeek).map((emp) => {
    const entry = byEmp[emp.id] ?? null;
    const x = ext[emp.id] ?? null;
    const empDays = days[emp.id] ?? {};

    // A week is technician-sourced when ANY of its days came from the
    // Tech Tracker. Resolution is per DAY, so someone who was a tech
    // for part of the week has some days locked and some typed here —
    // the row is marked read-only for the days that are, not wholesale.
    const techDates = dates.filter((d) => empDays[d]?.source === "tech");

    // Weekly totals, summed across whichever source each day resolved
    // to. Overtime is computed from these downstream, once, on the
    // week — never per day.
    const totals = dates.reduce(
      (a, d) => {
        const r = empDays[d];
        if (!r) return a;
        a.total_hours += r.hours_worked + r.hours_worked_other;
        a.total_hours_other += r.hours_worked_other;
        a.total_turned += r.hours_turned;
        return a;
      },
      { total_hours: 0, total_hours_other: 0, total_turned: 0 }
    );

    const base = {
      position: emp.position,
      is_store_manager: emp.is_store_manager,
      pto_days: entry?.pto_days ?? 0,
      clock_hours_other: entry?.clock_hours_other ?? 0,
      clock_hours: entry?.clock_hours ?? 0,
      // Present ONLY in the daily era. payrollMath falls back to the
      // frozen weekly columns when these are absent, which is what
      // makes a pre-cutover week still render correctly.
      ...(isDaily ? totals : {}),
    };
    const mergedEntry = isSpeedee
      ? {
          ...base,
          spiffs: x?.spiffs ?? 0,
          labor_sales: x?.labor_sales ?? null,
          labor_pct_eligible: emp.labor_pct_eligible,
          labor_pct_rate: emp.labor_pct_rate,
          sales_expectation_flat: emp.sales_expectation_flat,
        }
      : {
          ...base,
          hrs_turned_other: x?.hrs_turned_other ?? 0,
          hrs_turned_here: x?.hrs_turned_here ?? 0,
          actual_sales: x?.actual_sales ?? 0,
          work_orders: x?.work_orders ?? 0,
          sales_required: x?.sales_required ?? null,
        };
    return {
      employee: emp,
      entry: mergedEntry,
      entryId: entry?.id ?? null,
      rate: privileged ? rates[emp.id] ?? null : null,
      pay: entry ? (privileged ? pays[entry.id] ?? null : null) : null,
      roleSalesRate: isSpeedee ? roleRates[emp.position] ?? 0 : null,
      days: empDays,
      techDates,
      techSourced: techDates.length > 0,
    };
  });
}
