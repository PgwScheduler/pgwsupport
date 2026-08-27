// =====================================================================
// Pay-week helpers.
//
// The pay week runs SUNDAY–SATURDAY from the cutover date (migration 32,
// payroll_config.daily_cutover_date), matching the tic sheet, the tech
// tracker and the bonus math. Before the cutover it ran MONDAY–SATURDAY,
// and those weeks still have to render, so every helper here takes the
// cutover and picks the right basis by date.
//
// Both bases END on a Saturday — Mon+5 and Sun+6 are the same day — so a
// week label is always "<start> – <that Saturday>".
//
// NOT to be confused with lib/scheduleMath.js, which keeps its own
// Monday-start grid. That is a display choice on a planning screen, not
// a pay period, and it is deliberately unchanged.
// =====================================================================

const pad2 = (n) => String(n).padStart(2, "0");

// Local-calendar ISO. NOT toISOString(), which converts to UTC and can
// land on the previous day for a local-midnight Date.
export const iso = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export const asDate = (dateStr) => new Date(dateStr + "T00:00:00");

export const addDays = (dateStr, n) => {
  const d = asDate(dateStr);
  d.setDate(d.getDate() + n);
  return iso(d);
};

export const dowOf = (dateStr) => asDate(dateStr).getDay(); // Sun = 0

// Seven day columns, Sunday first. Pre-cutover weeks have no Sunday
// column: that basis started on Monday and never held one.
export const SUNDAY_DAYS = [
  ["sun", "Sun"], ["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"],
  ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"],
];
export const MONDAY_DAYS = SUNDAY_DAYS.slice(1);

export const isSundayWeek = (weekStart, cutover) =>
  !!cutover && weekStart >= cutover;

export const daysForWeek = (weekStart, cutover) =>
  isSundayWeek(weekStart, cutover) ? SUNDAY_DAYS : MONDAY_DAYS;

// The dates a week covers, in column order.
export function weekDates(weekStart, cutover) {
  return daysForWeek(weekStart, cutover).map((_, i) => addDays(weekStart, i));
}

// The week_start containing dateStr, on whichever basis applies.
//
// Resolved Sunday-first, then demoted: if the Sunday that would open the
// week falls before the cutover, that date still belongs to a Monday
// week. Worked examples with a 2026-08-30 cutover —
//   Aug 27 -> Sunday basis gives Aug 23, before cutover -> Monday Aug 24
//   Aug 30 -> Sunday basis gives Aug 30, on cutover      -> Aug 30
//   Sep 01 -> Sunday basis gives Aug 30                  -> Aug 30
// so no date falls in two weeks and none falls in neither.
export function weekStartOf(dateStr, cutover) {
  const sunday = addDays(dateStr, -dowOf(dateStr));
  if (!cutover || sunday >= cutover) return sunday;
  const d = asDate(dateStr);
  return addDays(dateStr, -((d.getDay() + 6) % 7)); // Monday basis
}

export const thisWeekStart = (cutover) => weekStartOf(iso(new Date()), cutover);

// Step a whole week in either direction, crossing the cutover cleanly.
// Forward lands inside the next week and re-resolves; backward lands on
// the day before this week opens, which is the last day of the previous
// week whichever basis it used.
export function shiftWeek(weekStart, delta, cutover) {
  if (delta === 0) return weekStart;
  const probe = delta > 0 ? addDays(weekStart, 7) : addDays(weekStart, -1);
  const next = weekStartOf(probe, cutover);
  return Math.abs(delta) > 1 ? shiftWeek(next, delta - Math.sign(delta), cutover) : next;
}

// Every pay week ends on a Saturday, on either basis.
export const weekEndOf = (weekStart, cutover) =>
  addDays(weekStart, daysForWeek(weekStart, cutover).length - 1);

export function weekLabel(weekStart, cutover) {
  const a = asDate(weekStart);
  const b = asDate(weekEndOf(weekStart, cutover));
  const m = (x) => x.toLocaleDateString(undefined, { month: "short" });
  return `${m(a)} ${a.getDate()} – ${a.getMonth() === b.getMonth() ? "" : m(b) + " "}${b.getDate()}`;
}

