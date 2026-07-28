// Working-day helpers for the goals strip. Mirror the database's
// derived_days_open(): a working day is Mon–Sat (dow != Sunday) and not a
// holiday. Holidays come from the `holidays` table, so nothing is hardcoded.

const pad2 = (n) => String(n).padStart(2, "0");
export const isoOf = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// Count working days in [startIso, endIso] inclusive, excluding Sundays and
// any date in holidaySet (a Set of 'YYYY-MM-DD'). Returns 0 if start > end.
export function countWorkdays(startIso, endIso, holidaySet) {
  if (!startIso || !endIso || startIso > endIso) return 0;
  const [ys, ms, ds] = startIso.split("-").map(Number);
  const [ye, me, de] = endIso.split("-").map(Number);
  const cur = new Date(ys, ms - 1, ds);
  const end = new Date(ye, me - 1, de);
  let n = 0;
  while (cur <= end) {
    if (cur.getDay() !== 0 && !holidaySet.has(isoOf(cur))) n += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

// First and last calendar day of a 1-based month, as ISO strings.
export const monthStartIso = (year, month) => `${year}-${pad2(month)}-01`;
export const monthEndIso = (year, month) =>
  `${year}-${pad2(month)}-${pad2(new Date(year, month, 0).getDate())}`;
