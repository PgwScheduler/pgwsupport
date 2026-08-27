// =====================================================================
// The shared date range. One definition, used by the Dashboard, the Tech
// Tracker and Payroll.
//
// TIMEZONE-NAIVE, like every other date in the portal. Dates are built
// and compared as local calendar Y-M-D strings and never converted to
// UTC — `toISOString()` shifts a local-midnight Date backwards or
// forwards depending on the offset, so a store in Maryland and a store
// in Florida would disagree about which day "yesterday" was. Everything
// here goes through `iso()`, which reads the local calendar fields.
//
// WEEKS START SUNDAY, matching Payroll after migration 32, the Tech
// Tracker and the tic sheet. The Employee Schedule's Monday grid is a
// planning display, not a pay period, and is unrelated.
// =====================================================================

const pad2 = (n) => String(n).padStart(2, "0");

export const iso = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export const asDate = (s) => new Date(s + "T00:00:00");

export const addDays = (s, n) => {
  const d = asDate(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};

// Month arithmetic that never rolls over. Adding -1 month to the 31st of
// a month whose predecessor is shorter clamps to that month's last day
// instead of silently landing in the month after.
export function addMonths(s, n) {
  const d = asDate(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return iso(d);
}

export const startOfMonth = (s) => s.slice(0, 8) + "01";
export const endOfMonth = (s) => {
  const d = asDate(s);
  return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
};

// Sunday opening the week containing s.
export const sundayOf = (s) => addDays(s, -asDate(s).getDay());

export const startOfQuarter = (s) => {
  const d = asDate(s);
  return iso(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1));
};

export const startOfYear = (s) => s.slice(0, 4) + "-01-01";

export const today = () => iso(new Date());

export const daysBetween = (from, to) =>
  Math.round((asDate(to) - asDate(from)) / 86400000) + 1;

// Presets, in the order they appear in the menu.
//
// The rolling ones ("Last 7 days", "Last 2 weeks", "Last 3 months") all
// INCLUDE today and count backwards, so "Last 7 days" is seven days
// ending today, not seven days ending yesterday. The to-date ones run
// from a period boundary through today.
export const PRESETS = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["wtd", "Week to date"],
  ["last7", "Last 7 days"],
  ["mtd", "Month to date"],
  ["last_month", "Last month"],
  ["last_2_weeks", "Last 2 weeks"],
  ["last_3_months", "Last 3 months"],
  ["qtd", "Quarter to date"],
  ["ytd", "Year to date"],
  ["custom", "Custom"],
];

export const DEFAULT_PRESET = "mtd";

export const presetLabel = (key) =>
  PRESETS.find(([k]) => k === key)?.[1] ?? key;

// Resolve a preset to { from, to }. `ref` is the day to treat as today,
// injectable so the behaviour is testable without touching the clock.
export function rangeFor(preset, ref = today()) {
  switch (preset) {
    case "today":
      return { from: ref, to: ref };
    case "yesterday": {
      const y = addDays(ref, -1);
      return { from: y, to: y };
    }
    case "wtd":
      return { from: sundayOf(ref), to: ref };
    case "last7":
      return { from: addDays(ref, -6), to: ref };
    case "mtd":
      return { from: startOfMonth(ref), to: ref };
    case "last_month": {
      const inPrev = addMonths(startOfMonth(ref), -1);
      return { from: startOfMonth(inPrev), to: endOfMonth(inPrev) };
    }
    case "last_2_weeks":
      return { from: addDays(ref, -13), to: ref };
    case "last_3_months":
      return { from: addDays(addMonths(ref, -3), 1), to: ref };
    case "qtd":
      return { from: startOfQuarter(ref), to: ref };
    case "ytd":
      return { from: startOfYear(ref), to: ref };
    default:
      return { from: startOfMonth(ref), to: ref };
  }
}

// A range is exactly one calendar month when it runs from the 1st to the
// last day of the same month. The Tech Tracker keeps its five-block
// layout only in that case; anything else gets a flat day list, because
// an arbitrary range does not fit a month of Sunday–Saturday blocks.
export function isWholeCalendarMonth(from, to) {
  if (!from || !to) return false;
  return from === startOfMonth(from) && to === endOfMonth(from) && from.slice(0, 7) === to.slice(0, 7);
}

// The whole Sunday–Saturday weeks a range touches. The pay engine always
// runs over these, never over the displayed slice, so a range cutting a
// week in half cannot produce half-week overtime. `partial` marks a week
// the range only covers part of, so the UI can label its totals.
export function weeksTouching(from, to) {
  const weeks = [];
  let wk = sundayOf(from);
  while (wk <= to) {
    const end = addDays(wk, 6);
    weeks.push({
      weekStart: wk,
      weekEnd: end,
      partial: wk < from || end > to,
      // The part of this week that the range actually covers.
      from: wk < from ? from : wk,
      to: end > to ? to : end,
    });
    wk = addDays(wk, 7);
  }
  return weeks;
}

// Every date in the range, in order. Used for flat day lists.
export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function rangeLabel(from, to) {
  if (!from || !to) return "—";
  const a = asDate(from);
  const b = asDate(to);
  const fmt = (x, withYear) =>
    x.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
    });
  if (from === to) return fmt(a, a.getFullYear() !== new Date().getFullYear());
  const sameYear = a.getFullYear() === b.getFullYear();
  const showYear = !sameYear || b.getFullYear() !== new Date().getFullYear();
  return `${fmt(a, !sameYear)} – ${fmt(b, showYear)}`;
}
