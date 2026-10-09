// Offline checks for the missing-entry panel (migration 80).
// Run: node src/lib/ticEntry.test.mjs
import { summarizeEntryStatus, shortDayLabel } from "./ticEntry.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const row = (loc, num, date, entered, last = null) => ({
  location_id: loc, store_number: num, store_name: "S" + num, district_name: "D", region_name: "R",
  business_date: date, entered, ro_count: entered ? 10 : 0, last_entered: last,
});
// Newest first, as the RPC returns them.
const rows = [
  row("a", "3303", "2026-10-10", true, "2026-10-10"), row("a", "3303", "2026-10-09", false, "2026-10-10"),
  row("b", "5254", "2026-10-10", false, "2026-10-08"), row("b", "5254", "2026-10-09", false, "2026-10-08"),
  row("c", "3229", "2026-10-10", false), row("c", "3229", "2026-10-09", false),
];
const s = summarizeEntryStatus(rows);
eq("latest date", s.latestDate, "2026-10-10");
eq("missing first, then store number", s.stores.map((x) => x.store_number), ["3229", "5254", "3303"]);
eq("missing list", s.missing.map((x) => x.store_number), ["3229", "5254"]);
eq("entered count", s.enteredCount, 1);
eq("days oldest -> newest", s.stores[2].days.map((d) => d.date), ["2026-10-09", "2026-10-10"]);
eq("missed count", s.stores.map((x) => x.missedCount), [2, 2, 1]);
eq("last entered carried", s.stores[1].last_entered, "2026-10-08");
eq("empty", summarizeEntryStatus([]), { latestDate: null, stores: [], missing: [], enteredCount: 0 });
eq("null rows", summarizeEntryStatus(null).stores, []);
eq("label Sat", shortDayLabel("2026-10-10"), "Sat 10/10");
eq("label Mon", shortDayLabel("2026-10-12"), "Mon 10/12");
eq("label blank", shortDayLabel(null), "");

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
