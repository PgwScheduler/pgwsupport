// Offline checks for the single-store payroll CSV / Print header.
// Run: node src/lib/payrollExport.test.mjs
import { storeHeadFor, storeCells, headFor } from "./payrollExport.js";
import { daysForWeek, weekDates, isSundayWeek } from "./weekUtils.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const CUTOVER = "2026-08-30";
// The arguments HoursView passes: dayLabels from daysForWeek (never
// empty), dates only on a daily week.
const argsFor = (week) => {
  const daily = isSundayWeek(week, CUTOVER);
  return { dates: daily ? weekDates(week, CUTOVER) : [], dayLabels: daysForWeek(week, CUTOVER) };
};

const row = {
  employee: { position: "tech", full_name: "Test Tech" },
  entry: { pto_days: 0, clock_hours: 40, clock_hours_other: 2, hrs_turned_here: 30, hrs_turned_other: 1, actual_sales: 0, work_orders: 0 },
  days: {},
  flatFlag: false,
};

// Pre-cutover (Monday) week: weekly header, weekly cells, same width.
const old = argsFor("2026-08-24");
eq("old week labels are not empty", old.dayLabels.length, 6);
eq("old week has no dates", old.dates.length, 0);
const oldHead = storeHeadFor(old.dates, old.dayLabels);
eq("old week gets the weekly header", oldHead, headFor([]));
eq("old week header has Clock Hrs Here", oldHead.includes("Clock Hrs Here"), true);
eq("old week header has no day columns", oldHead.includes("Mon"), false);
const oldCells = storeCells(row, old.dates);
eq("old week header/cells same width", oldHead.length, oldCells.length);
eq("old week Clock Hrs Here lines up", oldCells[oldHead.indexOf("Clock Hrs Here")], 40);

// Daily (Sunday) week: day header, day cells, same width.
const now = argsFor("2026-09-27");
const nowHead = storeHeadFor(now.dates, now.dayLabels);
eq("daily week gets the day header", nowHead, headFor(now.dayLabels));
eq("daily week header starts days at Sun", nowHead[3], "Sun");
eq("daily week header/cells same width", nowHead.length, storeCells(row, now.dates).length);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
