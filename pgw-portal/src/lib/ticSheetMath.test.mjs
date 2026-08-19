import { computeTicSheet, monthWeekBlocks, daySales } from "./ticSheetMath.js";
let pass = 0, fail = 0;
const close = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;
function ok(name, cond, got) { if (cond) pass++; else { fail++; console.log("FAIL", name, "got", got); } }

// =====================================================================
// Fixture: Millwood (#3303) July 2026, transcribed from the
// 'Maint Tic Sheet' + 'Summary' tabs of Millwood July 1.xlsm.
// Columns: date, ROs, zero-dollar tickets, labor (technician tracker),
//          parts, tires, supplies, groupon, discounts (signed),
//          declined, CC apps, credit $, { categoryId: units }
// Category ids here are the Midas display_order values 10..300, which run
// 1:1 with the source's category columns D..AG.
// =====================================================================
const DAYS = [
  ["2026-07-01",21,2,3887.98,2609.97,1313.47,517.91,0,-125,5568.03,0,0,{10:4,40:1,50:1,110:1,160:1,180:3,190:6,200:2,220:1,260:3,270:10,280:4,300:8}],
  ["2026-07-02",24,5,5238.35,7538.7,374.92,357.3,0,-396.53,5145.4,0,0,{10:3,30:1,40:1,50:1,70:1,80:1,100:2,110:1,170:1,180:2,190:11,200:1,220:1,260:3,270:12,280:2,300:4}],
  ["2026-07-03",19,3,2970.79,2728.2,544.53,373.33,0,-270.73,11393.44,0,0,{30:1,40:1,50:2,100:1,110:1,170:2,190:8,220:1,230:2,260:2,270:10,300:2}],
  ["2026-07-06",12,0,1527.26,1621.56,2796.82,301.89,0,0,7983.41,1,0,{10:2,70:2,100:2,180:1,190:6,260:2,300:8}],
  ["2026-07-07",12,1,1402.5,884.06,1966.56,291.04,0,0,5550.23,0,0,{40:1,50:1,70:1,100:1,190:4,260:2,270:1,300:7}],
  ["2026-07-08",10,2,2657.96,1933.24,159.92,222.95,0,-30,5418.28,0,0,{10:1,40:1,50:1,90:1,100:1,180:1,190:3,260:2,270:4,290:1,300:1}],
  ["2026-07-09",14,1,1829.82,1931.63,1777.33,378.17,0,-375,7854.84,0,0,{10:1,30:1,90:1,180:1,190:6,260:1,290:1,300:11}],
  ["2026-07-10",15,3,2184.38,2095.04,1581.8,311.48,0,-117,11483.78,0,0,{10:2,50:2,70:2,90:1,190:8,220:1,260:3,280:7,290:1,300:8}],
  ["2026-07-11",15,0,2126.79,2105.86,349.47,312.14,0,-185,10054.37,0,0,{20:1,40:1,50:2,70:1,100:1,190:11,260:3,280:4,300:3}],
  ["2026-07-13",15,1,1349.41,841.24,1211.62,212.83,0,-44,7550.27,2,0,{70:1,90:1,100:1,180:1,190:3,260:1,280:4,290:1,300:9}],
  ["2026-07-14",20,5,1586.65,1742.33,404.27,258,0,-30,6994.8,1,0,{10:2,40:2,50:1,70:1,170:1,180:1,190:9,260:2,270:4,280:2,300:5}],
  ["2026-07-15",11,2,1316.17,1593.85,578.46,265.16,0,-100,3569.57,0,0,{10:1,190:4,280:2,300:3}],
  ["2026-07-16",17,3,2420.13,1976.84,949.66,330.4,0,0,7704.85,0,0,{10:3,40:3,50:2,70:1,160:1,170:1,180:1,190:6,260:3,270:10,280:2,290:1,300:8}],
  ["2026-07-17",13,2,3564.09,2481.68,921.03,262.27,-942.44,-22,2560.24,2,0,{40:3,50:3,70:1,180:1,190:3,220:2,260:3,270:2,300:3}],
  ["2026-07-18",14,3,1521.24,1145.11,368.98,201.92,0,-97.4,6428.14,0,0,{10:2,40:1,50:2,100:1,170:1,190:7,260:2,270:6,300:2}],
  ["2026-07-20",11,3,1630.05,557.57,1403.92,197.27,0,107,2659.25,0,0,{10:1,50:1,190:3,260:2,280:2,300:9}],
  ["2026-07-21",15,2,2823.19,2811.57,1088.49,354.38,0,-60,8048.59,0,0,{10:3,100:3,160:1,180:1,190:5,260:2,280:4,290:1,300:7}],
  ["2026-07-22",13,3,489.86,667.64,565.98,144.11,0,-5,9208.05,0,0,{180:1,190:7,300:4}],
  ["2026-07-23",17,3,3196.36,2459.79,2457.72,399.52,0,0,2294.06,0,0,{10:1,40:1,50:1,70:1,80:1,110:1,180:1,190:8,220:1,260:3,290:1,300:13}],
  ["2026-07-24",13,2,1686.06,1910.19,0,258.54,0,0,9318.48,0,0,{10:2,40:1,50:2,100:2,170:1,190:5,270:4,280:2}],
  ["2026-07-25",12,0,1159.76,1621.35,1061.32,301.38,0,0,2944.68,1,0,{10:3,50:1,60:1,90:1,180:2,190:5,260:1,270:12,280:2,290:1,300:4}],
  ["2026-07-27",8,1,2477.02,2294.7,7.99,242.09,0,0,1004.25,0,0,{10:1,50:2,110:1,190:3,300:1}],
  ["2026-07-28",14,1,3990.12,2365.19,411.96,346.78,0,-30,8462.55,0,0,{10:1,40:2,50:3,100:1,170:3,190:8,220:2,260:2,280:2,300:6}],
  ["2026-07-29",11,2,2202.13,2221.3,1121.73,284.04,0,-197.25,2598,0,0,{10:2,40:1,50:1,70:2,180:1,190:2,260:1,270:4,280:2,290:1,300:7}],
  ["2026-07-30",18,5,1134.88,852.82,1945.77,235.29,0,-20,3115.89,0,0,{10:1,40:1,50:1,190:6,260:1,270:5,300:9}],
  ["2026-07-31",13,5,2209.55,1298.93,0,150.16,0,0,3241.91,0,0,{10:2,40:1,70:2,190:3,260:2}],
];

const CATEGORY_GOALS = {
  10: { goal_pct_of_cars: 0.1, average_sale: 28.98 },
  20: { goal_pct_of_cars: 0.1, average_sale: 29.98 },
  30: { goal_pct_of_cars: 0.05, average_sale: 125.95 },
  40: { goal_pct_of_cars: 0.05, average_sale: 65.00 },
  50: { goal_pct_of_cars: 0.2, average_sale: 328.55 },
  60: { goal_pct_of_cars: 0.05, average_sale: 49.00 },
  70: { goal_pct_of_cars: 0.05, average_sale: 39.83 },
  80: { goal_pct_of_cars: 0.05, average_sale: 40.83 },
  90: { goal_pct_of_cars: 0.05, average_sale: 100.00 },
  100: { goal_pct_of_cars: 0.05, average_sale: 50.00 },
  110: { goal_pct_of_cars: 0.05, average_sale: 301.15 },
  120: { goal_pct_of_cars: 0.02, average_sale: 83.16 },
  130: { goal_pct_of_cars: 0.04, average_sale: 108.00 },
  140: { goal_pct_of_cars: 0.04, average_sale: 108.00 },
  150: { goal_pct_of_cars: 0.03, average_sale: 100.00 },
  160: { goal_pct_of_cars: 0.02, average_sale: 125.00 },
  170: { goal_pct_of_cars: 0.1, average_sale: 17.00 },
  180: { goal_pct_of_cars: 0.35, average_sale: 30.00 },
  190: { goal_pct_of_cars: 0.3, average_sale: 57.31 },
  200: { goal_pct_of_cars: 0.02, average_sale: 70.00 },
  210: { goal_pct_of_cars: 0.5, average_sale: 15.00 },
  220: { goal_pct_of_cars: 0.08, average_sale: 207.89 },
  230: { goal_pct_of_cars: 0.07, average_sale: 527.55 },
  240: { goal_pct_of_cars: 0.02, average_sale: 534.84 },
  250: { goal_pct_of_cars: 0.05, average_sale: 155.00 },
  260: { goal_pct_of_cars: 0.1, average_sale: 94.26 },
  270: { goal_pct_of_cars: 0.35, average_sale: 11.00 },
  280: { goal_pct_of_cars: 0.1, average_sale: 15.00 },
  290: { goal_pct_of_cars: 0.05, average_sale: 134.40 },
  300: { goal_pct_of_cars: 0.2, average_sale: 118.05 },
};

const CATEGORIES = Object.keys(CATEGORY_GOALS).map((id) => ({ id: Number(id) }));
const DAYS_OPEN = 26; // July 2026: 31 days - 4 Sundays - July 4

function fixture(rows = DAYS) {
  const kpiByDate = {}, unitsByDate = {}, laborByDate = {};
  for (const [date, ro, zero, labor, parts, tires, supplies, groupon, discounts, declined, ccApps, credit, units] of rows) {
    kpiByDate[date] = {
      ro_count: ro, zero_dollar_tickets: zero, sales_parts: parts, sales_tires: tires,
      sales_supplies: supplies, sales_groupon: groupon, sales_discounts: discounts,
      declined_sales: declined, credit_apps: ccApps, credit_dollars: credit,
    };
    unitsByDate[date] = units;
    laborByDate[date] = labor;
  }
  return { year: 2026, month: 7, categories: CATEGORIES, kpiByDate, unitsByDate, laborByDate,
           daysOpen: DAYS_OPEN, categoryGoals: CATEGORY_GOALS };
}

const R = computeTicSheet(fixture());

// --- Part 6.1 — monthly category totals -------------------------------
ok("1.ro",         R.month.ro_count === 377, R.month.ro_count);
ok("1.tires",      R.month.units[300] === 142, R.month.units[300]);
ok("1.lofPrem",    R.month.units[190] === 150, R.month.units[190]);
ok("1.wheelBal",   R.month.units[270] === 84, R.month.units[270]);
ok("1.wheelAlign", R.month.units[260] === 46, R.month.units[260]);
ok("1.airFilter",  R.month.units[10] === 38, R.month.units[10]);
ok("1.brake",      R.month.units[50] === 30, R.month.units[50]);

// --- Part 6.2 — monthly money -----------------------------------------
// Sales excludes Groupon, exactly as the source's Sales column does.
ok("2.sales",     close(R.month.sales, 141749.02, 0.011), R.month.sales);
ok("2.declined",  close(R.month.declined_sales, 158155.36, 0.011), R.month.declined_sales);
ok("2.potential", close(R.month.total_potential, 299904.38, 0.011), R.month.total_potential);
ok("2.aveEst",    close(R.month.ave_estimate, 795.50), R.month.ave_estimate);
ok("2.capture",   close(R.month.capture_rate, 0.4726, 0.00005), R.month.capture_rate);

// --- Part 6.3 — zero dollar tickets -----------------------------------
ok("3.zeroMtd",  R.month.zero_dollar_tickets === 60, R.month.zero_dollar_tickets);
ok("3.zeroPct",  close(R.month.zero_dollar_tickets / R.month.ro_count, 0.15915, 0.00001),
                 R.month.zero_dollar_tickets / R.month.ro_count);
ok("3.zeroPace", close(R.pace.zero_dollar_tickets, 60), R.pace.zero_dollar_tickets);
// zero dollar tickets never reduce the repair order count
ok("3.roUntouched", R.month.ro_count === 377, R.month.ro_count);

// --- Part 6.4 — week 4 totals ------------------------------------------
ok("4.wk4ro",      R.weeks[3].totals.ro_count === 81, R.weeks[3].totals.ro_count);
ok("4.wk4tires",   R.weeks[3].totals.units[300] === 37, R.weeks[3].totals.units[300]);
ok("4.wk4capture", close(R.weeks[3].totals.capture_rate, 0.4593, 0.00005), R.weeks[3].totals.capture_rate);
ok("4.weekRos",    JSON.stringify(R.weeks.map((w) => w.totals.ro_count)) === "[64,78,90,81,64]",
                   R.weeks.map((w) => w.totals.ro_count));

// --- Part 6.5 — self-correcting New Goal, negatives preserved ----------
ok("5.projectedRo",  close(R.projectedRo, 377), R.projectedRo);
ok("5.tireGoal",     close(R.monthlyGoal[300], 75.4), R.monthlyGoal[300]);
ok("5.tireChain",    JSON.stringify(R.weeks.map((w) => Math.round(w.newGoal[300] * 10) / 10)) === "[61.4,23.4,-6.6,-43.6,-66.6]",
                     R.weeks.map((w) => w.newGoal[300]));
ok("5.wk4tireGoal",  close(R.weeks[3].newGoal[300], -43.6), R.weeks[3].newGoal[300]);
ok("5.lofPremAhead", close(R.weeks[4].newGoal[190], -36.9), R.weeks[4].newGoal[190]);
ok("5.notClamped",   R.weeks[3].newGoal[300] < 0, R.weeks[3].newGoal[300]);

// --- Part 6.6 — the three categories the source leaves at zero ---------
ok("6.acRefresh",  close(R.monthlyGoal[20], 37.7), R.monthlyGoal[20]);
ok("6.catConv",    close(R.monthlyGoal[80], 18.85), R.monthlyGoal[80]);
ok("6.crit15k",    close(R.monthlyGoal[140], 15.08), R.monthlyGoal[140]);
ok("6.allNonZero", CATEGORIES.every((c) => R.monthlyGoal[c.id] > 0), CATEGORIES.filter((c) => !(R.monthlyGoal[c.id] > 0)));

// --- Part 6.7 — a signed discount moves that day's sales ---------------
const F = fixture();
const jul2 = F.kpiByDate["2026-07-02"];
ok("7.negDiscount", close(daySales(jul2, 5238.35), 5238.35 + 7538.7 + 374.92 + 357.3 - 396.53), daySales(jul2, 5238.35));
// +107.00 on 2026-07-20 is a discount reversal and RAISES that day's sales
const jul20 = F.kpiByDate["2026-07-20"];
ok("7.posDiscount", jul20.sales_discounts === 107, jul20.sales_discounts);
ok("7.posRaises",   daySales(jul20, 0) > jul20.sales_parts + jul20.sales_tires + jul20.sales_supplies,
                    daySales(jul20, 0));
const monthDiscounts = DAYS.reduce((s, r) => s + r[8], 0);
ok("7.monthDiscounts", close(monthDiscounts, -1997.91), monthDiscounts);

// --- Part 6.8 — PACE ---------------------------------------------------
// Month complete: every planned day entered, so PACE equals the total.
ok("8.paceEqualsMonth", close(R.pace.ro_count, 377) && close(R.pace.sales, R.month.sales), R.pace.ro_count);
ok("8.paceTires",       close(R.pace.units[300], 142), R.pace.units[300]);
// Mid-month: through 2026-07-15 (12 entered days -- Jul 4 is a holiday,
// Jul 5 and 12 are Sundays) PACE must exceed MTD.
const mid = computeTicSheet(fixture(DAYS.filter((r) => r[0] <= "2026-07-15")));
ok("8.midElapsed",   mid.daysElapsed === 12, mid.daysElapsed);
ok("8.midPaceUp",    mid.pace.ro_count > mid.month.ro_count, [mid.pace.ro_count, mid.month.ro_count]);
ok("8.midPaceMath",  close(mid.pace.ro_count, mid.month.ro_count / (12 / 26)), mid.pace.ro_count);
ok("8.midProjected", close(mid.projectedRo, (mid.month.ro_count / 12) * 26), mid.projectedRo);
// Ratio columns are never paced.
ok("8.paceRatiosNull", R.pace.ave_estimate === null && R.pace.capture_rate === null, R.pace);

// --- Part 6.9 — Monthly Total is the sum of the weekly totals ----------
const weekSum = R.weeks.reduce((s, w) => s + w.totals.sales, 0);
ok("9.salesSum", close(R.month.sales, weekSum, 0.0001), [R.month.sales, weekSum]);
ok("9.roSum",    R.month.ro_count === R.weeks.reduce((s, w) => s + w.totals.ro_count, 0), R.month.ro_count);
ok("9.tireSum",  R.month.units[300] === R.weeks.reduce((s, w) => s + w.totals.units[300], 0), R.month.units[300]);
ok("9.zeroSum",  R.month.zero_dollar_tickets === R.weeks.reduce((s, w) => s + w.totals.zero_dollar_tickets, 0), R.month.zero_dollar_tickets);

// --- Weekly % of Cars ---------------------------------------------------
const EMPTY_ARGS = { year: 2026, month: 7, categories: CATEGORIES, daysOpen: 26 };
ok("W.pctOfCars",   close(R.weeks[0].pctOfCars[300], 14 / 64), R.weeks[0].pctOfCars[300]);
ok("W.pctNullNoRo", computeTicSheet(EMPTY_ARGS).weeks[0].pctOfCars[300] === null, "expected null");

// --- Header band --------------------------------------------------------
ok("H.actualPct",   close(R.actualPct[300], 142 / 377), R.actualPct[300]);
ok("H.actualSales", close(R.actualSales[300], 142 * 118.05), R.actualSales[300]);
ok("H.goalUnits",   close(R.monthlyGoal[180], 0.35 * 377), R.monthlyGoal[180]);

// --- Week blocks --------------------------------------------------------
const jul = monthWeekBlocks(2026, 7);
ok("B.julyFive",    jul.length === 5, jul.length);
ok("B.julyDay1",    jul[0].days[0] === "2026-07-01" && jul[0].days.length === 4, jul[0].days);
ok("B.julyLast",    jul[4].days[jul[4].days.length - 1] === "2026-07-31", jul[4].days);
ok("B.julyAllDays", jul.reduce((s, b) => s + b.days.length, 0) === 31, jul.map((b) => b.days.length));
// A 31-day month starting Saturday needs SIX blocks. The source hardcodes
// five and silently drops its last two days; this must not.
const aug = monthWeekBlocks(2026, 8);
ok("B.augSix",     aug.length === 6, aug.length);
ok("B.augAllDays", aug.reduce((s, b) => s + b.days.length, 0) === 31, aug.map((b) => b.days.length));

// --- Degenerate input ----------------------------------------------------
const E = computeTicSheet(EMPTY_ARGS);
ok("E.noDays",     E.daysElapsed === 0, E.daysElapsed);
ok("E.noPace",     E.pace === null, E.pace);
ok("E.zeroGoal",   E.projectedRo === 0 && E.monthlyGoal[300] === 0, [E.projectedRo, E.monthlyGoal[300]]);
ok("E.ratiosNull", E.month.ave_estimate === null && E.month.capture_rate === null, E.month);
ok("E.finite",     Object.values(E.month.units).every(Number.isFinite), E.month.units);
const NO_OPEN = computeTicSheet({ ...fixture(), daysOpen: 0 });
ok("E.noDaysOpen", NO_OPEN.pace === null && NO_OPEN.projectedRo === 0, [NO_OPEN.pace, NO_OPEN.projectedRo]);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
