// Pure helpers for the Employee Schedule calendar. Dates are handled as local
// "YYYY-MM-DD" strings and times as "HH:MM[:SS]" wall-clock strings — never
// Date/timestamptz — so a 7:00 AM shift renders as 7:00 AM in every timezone.
// This module is independent of Employee Hours and never touches pay data.

// Local ISO date. Built from local components (not toISOString) to avoid the
// UTC rollover that can shift the calendar day for viewers west of GMT.
export const isoLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const asDate = (dateStr) => new Date(dateStr + "T00:00:00");

export const todayStr = () => isoLocal(new Date());

export const addDays = (dateStr, n) => {
  const d = asDate(dateStr);
  d.setDate(d.getDate() + n);
  return isoLocal(d);
};

// Monday-based weekday index: Mon=0 … Sun=6.
const mondayIndex = (d) => (d.getDay() + 6) % 7;

// The Monday (as a date string) of the week containing dateStr.
export const mondayOf = (dateStr) => addDays(dateStr, -mondayIndex(asDate(dateStr)));

// Month grid: array of weeks, each an array of 7 "YYYY-MM-DD" (Mon..Sun),
// covering the whole month plus the leading/trailing days that fill full
// Monday–Sunday weeks. Weekly totals span these full weeks, month boundary or not.
export function monthGrid(year, month /* 0-based */) {
  const firstOfMonth = isoLocal(new Date(year, month, 1));
  const lastOfMonth = isoLocal(new Date(year, month + 1, 0));
  const lastMonday = mondayOf(lastOfMonth);
  const weeks = [];
  let cursor = mondayOf(firstOfMonth);
  while (cursor <= lastMonday) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cursor, i)));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

// Does a date string fall in the given 0-based month?
export const inMonth = (dateStr, month) => asDate(dateStr).getMonth() === month;

// "HH:MM[:SS]" -> minutes since midnight.
export const toMinutes = (t) => {
  if (!t) return 0;
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};

// Decimal hours between two wall-clock times: 7:00–15:30 -> 8.5.
export const shiftHours = (start, end) =>
  Math.round(((toMinutes(end) - toMinutes(start)) / 60) * 100) / 100;

// Compact 12-hour label: "7:00a", "3:30p", "12:00p", "12:00a".
export function fmtTime(t) {
  const mins = toMinutes(t);
  let h = Math.floor(mins / 60);
  const m = mins % 60;
  const ap = h < 12 ? "a" : "p";
  h %= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")}${ap}`;
}

// Trim decimal hours for display: 8 -> "8", 8.5 -> "8.5", 8.25 -> "8.25".
export const fmtHours = (n) => String(Math.round(n * 100) / 100);

// "Marcus Thompson" -> "Marcus T." for the compact day-cell rows.
export function shortName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

// Two shifts overlap if each starts before the other ends (minute-based).
export const overlaps = (aStart, aEnd, bStart, bEnd) =>
  toMinutes(aStart) < toMinutes(bEnd) && toMinutes(bStart) < toMinutes(aEnd);

// Total scheduled hours for a Mon–Sun week plus a per-employee breakdown.
// byDate: { "YYYY-MM-DD": [shift, ...] }. Sums the full week regardless of
// which days fall outside the displayed month.
export function weekSummary(weekDates, byDate) {
  const perEmp = new Map(); // employee_id -> { id, name, hours }
  let total = 0;
  for (const date of weekDates) {
    for (const s of byDate[date] ?? []) {
      const h = shiftHours(s.start_time, s.end_time);
      total += h;
      const cur = perEmp.get(s.employee_id) ?? { id: s.employee_id, name: s.employee?.full_name || "—", hours: 0 };
      cur.hours = Math.round((cur.hours + h) * 100) / 100;
      perEmp.set(s.employee_id, cur);
    }
  }
  const employees = [...perEmp.values()].sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
  return { total: Math.round(total * 100) / 100, employees };
}
