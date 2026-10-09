// Missing tic sheet entries (migration 80). tic_entry_status() returns one
// row per store per working day, newest day first; this folds it into one
// row per store for the dashboard panel. What counts as "entered" is
// decided in SQL (tic_day_entered), not here.

// rows -> { latestDate, stores, missing, enteredCount }
//   stores: every store, missing-yesterday first, then by store number.
//   Each store's `days` runs oldest -> newest, so a strip reads left to right.
export function summarizeEntryStatus(rows) {
  const byStore = new Map();
  let latestDate = null;
  for (const r of rows ?? []) {
    if (!latestDate || r.business_date > latestDate) latestDate = r.business_date;
    let s = byStore.get(r.location_id);
    if (!s) {
      s = {
        location_id: r.location_id,
        store_number: r.store_number,
        store_name: r.store_name,
        district_name: r.district_name,
        region_name: r.region_name,
        last_entered: r.last_entered,
        days: [],
      };
      byStore.set(r.location_id, s);
    }
    s.days.push({ date: r.business_date, entered: r.entered === true });
  }
  const stores = [...byStore.values()].map((s) => {
    const days = s.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const latest = days.find((d) => d.date === latestDate);
    return {
      ...s,
      days,
      enteredLatest: latest?.entered === true,
      missedCount: days.filter((d) => !d.entered).length,
    };
  });
  const num = (s) => Number(s.store_number) || 0;
  stores.sort((a, b) =>
    (a.enteredLatest === b.enteredLatest ? 0 : a.enteredLatest ? 1 : -1)
    || num(a) - num(b));
  const missing = stores.filter((s) => !s.enteredLatest);
  return { latestDate, stores, missing, enteredCount: stores.length - missing.length };
}

// 'YYYY-MM-DD' -> 'Sat 10/10'. Calendar date, no timezone shift.
export function shortDayLabel(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()]} ${m}/${d}`;
}
