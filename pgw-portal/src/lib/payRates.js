// =====================================================================
// Effective-dated pay rates and "who is on this pay week" — the JS
// mirror of migration 56. Both rules live in SQL too and the two MUST
// agree:
//
//   ratesOn()        <->  public._pay_rate_at(employee, date)
//   employedDuring() <->  public._employed_during(active, hire, term, from, to)
//
// THE RATE RULE: a pay week is paid, per rate type, at the row with the
// latest effective_date ON OR BEFORE THE WEEK'S START. Callers pass the
// week start, so a change dated mid-week first applies to the NEXT pay
// week (overtime is a whole-week figure and cannot be priced at two
// rates). firstPayWeek() tells the person entering a change which week
// that is.
//
// The three types have independent histories; a type with no row reads
// 0, which is what the old single employee_pay_rates row produced for a
// missing value.
// =====================================================================
import { shiftWeek, thisWeekStart, weekStartOf } from "./weekUtils.js";

// The date migration 56 gave the single pre-history rate it copied in.
export const LEGACY_DATE = "2000-01-01";

export const RATE_TYPES = [
  { key: "hourly", field: "hourly_rate", label: "Hourly", unit: "per hour" },
  { key: "flat", field: "flat_rate_per_hour", label: "Flat rate", unit: "per turned hour" },
  { key: "salary", field: "manager_salary", label: "Salary", unit: "per week" },
];

// The rate of one type in force on `date` (ISO yyyy-mm-dd), or 0.
export function rateOn(history, type, date) {
  let best = null;
  for (const h of history ?? []) {
    if (h.rate_type !== type || h.effective_date > date) continue;
    if (!best || h.effective_date > best.effective_date) best = h;
  }
  return best ? Number(best.amount) : 0;
}

// All three, in the shape payrollMath's computePayRow already reads.
export function ratesOn(history, date) {
  return Object.fromEntries(RATE_TYPES.map((t) => [t.field, rateOn(history, t.key, date)]));
}

// The row in force on `date` for a type (for "since <date>" labels).
export function rowOn(history, type, date) {
  let best = null;
  for (const h of history ?? []) {
    if (h.rate_type !== type || h.effective_date > date) continue;
    if (!best || h.effective_date > best.effective_date) best = h;
  }
  return best;
}

// Employed at any point in [from, to]? With no termination date the
// active flag decides, so a legacy "Remove" (active = false, no date)
// still hides someone from weeks where they have no data.
export function employedDuring(emp, from, to) {
  if (emp.hire_date && emp.hire_date > to) return false;
  if (emp.termination_date) return emp.termination_date >= from;
  return !!emp.active;
}

// The first pay week a change dated `date` applies to: that date's own
// week if it IS the week start, otherwise the next week.
export function firstPayWeek(date, cutover) {
  const ws = weekStartOf(date, cutover);
  return ws === date ? date : shiftWeek(ws, 1, cutover);
}

// How many pay weeks that have already started a change dated `date`
// would re-price (0 = it only affects the future). `today` is injectable
// for tests.
export function weeksAlreadyStarted(date, cutover, today) {
  const first = firstPayWeek(date, cutover);
  const current = today ? weekStartOf(today, cutover) : thisWeekStart(cutover);
  let n = 0;
  for (let w = first; w <= current; w = shiftWeek(w, 1, cutover)) n++;
  return n;
}
