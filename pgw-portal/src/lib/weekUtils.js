export const DAYS = [
  ["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"],
];

export const iso = (d) => d.toISOString().slice(0, 10);

export function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return iso(d);
}

export function thisWeekStart() {
  return mondayOf(iso(new Date()));
}

export function weekLabel(weekStart) {
  const a = new Date(weekStart + "T00:00:00");
  const b = new Date(a);
  b.setDate(a.getDate() + 5);
  const m = (x) => x.toLocaleDateString(undefined, { month: "short" });
  return `${m(a)} ${a.getDate()} – ${a.getMonth() === b.getMonth() ? "" : m(b) + " "}${b.getDate()}`;
}

export function shiftWeek(weekStart, delta) {
  const d = new Date(weekStart + "T00:00:00");
  d.setDate(d.getDate() + delta * 7);
  return iso(d);
}

export const sumDays = (row) => DAYS.reduce((a, [k]) => a + (Number(row[k]) || 0), 0);
