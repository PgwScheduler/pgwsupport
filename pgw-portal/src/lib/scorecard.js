// =====================================================================
// Matt's reports, Phase 1: the numbers.
//
//   Report 1 — Daily Scorecard   (Matt's Current Month A–AD, rows 7–45)
//   Report 2 — Market Summary    (Current Month rows 50–56)
//   Report 5 — Tire Contest      (Current Month rows 61–100, Midas only)
//
// Pure functions: facts in, rows out. No React, no Supabase, so every
// formula is tested offline against Matt's own workbook
// (scorecard.test.mjs replays his typed inputs and compares his cached
// results). The colours live in scorecardRules.js, which reads the rows
// built here.
//
// Every definition below is Part 3 of the brief. Where Matt's workbook
// does something else, the difference is a Part 9 defect and is named
// in the comment; the parity test lists each one as expected.
//
// A number that cannot be known is null, never 0: a store that has not
// entered yesterday has no ARO, not an ARO of zero, and a blank is never
// coloured.
// =====================================================================

const n = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const div = (a, b) => (n(a) === null || n(b) === null || Number(b) === 0 ? null : Number(a) / Number(b));
const mul = (a, b) => (n(a) === null || n(b) === null ? null : Number(a) * Number(b));
const sub = (a, b) => (n(a) === null || n(b) === null ? null : Number(a) - Number(b));
const sum = (xs) => { const v = xs.map(n).filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
const avg = (xs) => { const v = xs.map(n).filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// The settings the formulas read (report_settings). Defaults are the
// seeded values, so a missing row degrades to the documented number.
export const SETTING_DEFAULTS = {
  tier_gold_pct: 0.95, tier_silver_pct: 0.9, tier_bronze_pct: 0.8,
  aro_red_below: 275, aro_green_from: 299,
  gp_pct_red_below: 0.58, gp_pct_green_from: 0.6,
  goal_pct_red_below: 0.899, goal_pct_green_above: 0.999,
  align_yellow_from: 2, align_green_from: 3,
  tire_payout_ahead: 500, tire_payout_behind: 100,
  car_goal_extra_per_day: 2, weeks_per_month: 4.345, days_per_week: 6,
};
export const settingsFrom = (rows = []) => ({ ...SETTING_DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, Number(r.value)])) });

// ---------------------------------------------------------------------
// Report 1 — one row per store
// ---------------------------------------------------------------------
// f: one store's facts (see useScorecard). ctx: { elapsed, daysLeftInWeek,
// daysElapsedInWeek, settings }.
export function storeRow(f, ctx) {
  const s = ctx.settings;
  const D = n(f.daysOpen);
  const E = n(ctx.elapsed);
  const L = D !== null && E !== null ? D - E : null;
  const y = f.yest; // null when the store has not entered the report date
  const bronzePct = n(f.bronzePct) ?? s.tier_bronze_pct;

  const gpBudget = n(f.gpBudget);
  const goldGp = mul(gpBudget, s.tier_gold_pct);
  const silverGp = mul(gpBudget, s.tier_silver_pct);
  const bronzeGp = mul(gpBudget, bronzePct);

  const mtdSales = n(f.mtd?.sales);
  const mtdGp = n(f.mtd?.gp);
  const salesProj = E ? mul(div(mtdSales, E), D) : null;
  const projGp = E ? mul(div(mtdGp, E), D) : null;
  const salesBudget = n(f.salesBudget);
  const pySales = n(f.py?.sales);

  // Cars: goal for the month is last year's cars plus 2 a day; what is
  // left is spread over the days left. "Car Goal Today" colours Cars.
  const pyCars = n(f.py?.cars);
  const carGoal = pyCars === null || D === null ? null : pyCars + s.car_goal_extra_per_day * D;
  const carGoalToday = L ? div(sub(carGoal, n(f.mtd?.cars)), L) : null;

  // Sales Goal Today: what is still needed this week, over the days left
  // in it. Matt divides by a typed cell that is never below 1 (AS3), so
  // a completed week asks for the whole shortfall; the same floor here.
  const weeklyGoal = n(f.weeklyGoal);
  const weekSales = n(f.week?.sales);
  const salesGoalToday = weeklyGoal === null ? null
    : div(sub(weeklyGoal, weekSales ?? 0), Math.max(1, n(ctx.daysLeftInWeek) ?? 1));

  const cars = y ? n(y.cars) : null;
  const sales = y ? n(y.sales) : null;
  const gp = y ? n(y.gp) : null;
  const estPerCar = y ? div(y.potential, y.cars) : null;
  const aro = div(sales, cars);

  return {
    id: f.id, storeNumber: f.storeNumber, name: f.name, marketId: f.marketId, sort: f.sort,
    brand: f.brand, state: f.state, fill: f.fill, font: f.font,
    entered: !!y,
    dailyGp: div(gpBudget, D), dailyGold: div(goldGp, D), dailySilver: div(silverGp, D), dailyBronze: div(bronzeGp, D),
    dailySales: div(salesBudget, D),
    cars, estPerCar, aro, capture: div(aro, estPerCar),
    battery: n(f.mtd?.battery),
    sales, gp, gpPct: div(gp, sales),
    mtdSales, mtdGp, projGp,
    salesBudget, salesProj, pctOfGoal: div(salesProj, salesBudget),
    pySales, vs2025: sub(salesProj, pySales),
    gpBudget, goldGp, silverGp, bronzeGp,
    salesGoalToday,
    // helpers the rules and Reports 2/5 read
    carGoal, carGoalToday, mtdCars: n(f.mtd?.cars), pyCars, pyDaysOpen: n(f.py?.daysOpen),
    carsPerDay: E ? div(n(f.mtd?.cars), E) : null,
    pyCarsPerDay: div(pyCars, n(f.py?.daysOpen)),
    weeklyGoal, weekSales, weekEnteredDays: n(f.week?.enteredDays),
    tires: y ? n(y.tires) : null, align: y ? n(y.align) : null,
    mtdTires: n(f.mtd?.tires), pyTires: n(f.py?.tires),
    tireGoal: n(f.tireGoal), tirePayoutMin: n(f.tirePayoutMin),
  };
}

// ROLLUPS COUNT ONLY THE STORES THAT HAVE REPORTED. A store with no tic
// sheet this month has no projection, and adding its budget to the
// denominator would read as the market falling short -- the same "not
// entered is not zero" rule as a single cell, applied to a total. Every
// column in a rollup row (budgets and tiers included) is taken over the
// same reporting stores, so the row's own numbers divide into its
// percentages, and the row says how many stores it covers. With every
// store reporting it is exactly Matt's rollup.
export const reportingOf = (rows) => rows.filter((r) => n(r.mtdSales) !== null);
const withCoverage = (label, rep, all) => (rep < all ? `${label} (${rep} of ${all} reporting)` : label);

// A total row: sums where Matt sums, averages where he averages, ratios
// re-derived from the summed parts (never the average of the ratios).
export function totalRow(allRows, label) {
  const rows = reportingOf(allRows);
  const S = (k) => sum(rows.map((r) => r[k]));
  const A = (k) => avg(rows.map((r) => r[k]));
  const salesProj = S("salesProj"), salesBudget = S("salesBudget"), sales = S("sales"), gp = S("gp");
  return {
    isTotal: true, name: withCoverage(label, rows.length, allRows.length), storeCount: allRows.length, reporting: rows.length,
    dailyGp: A("dailyGp"), dailyGold: A("dailyGold"), dailySilver: A("dailySilver"), dailyBronze: A("dailyBronze"),
    dailySales: A("dailySales"),
    cars: S("cars"), sales, gp, gpPct: div(gp, sales),
    mtdSales: S("mtdSales"), mtdGp: S("mtdGp"), projGp: S("projGp"),
    salesBudget, salesProj, pctOfGoal: div(salesProj, salesBudget),
    pySales: S("pySales"), vs2025: S("vs2025"),
    gpBudget: S("gpBudget"), goldGp: S("goldGp"), silverGp: S("silverGp"), bronzeGp: S("bronzeGp"),
    battery: S("battery"),
  };
}

// Report 1 in full: store rows in Matt's order, the true PGW total, and
// his South Carolina subtotal (CM-16: his "PGW Total" was only ever the
// 22 SC stores, so it is kept -- labelled honestly -- beside the real one).
export function buildScorecard(facts, ctx) {
  const rows = facts.map((f) => storeRow(f, ctx)).sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999));
  const sc = rows.filter((r) => r.state === "SC");
  return {
    rows,
    total: totalRow(rows, "PGW Total"),
    scTotal: sc.length && sc.length < rows.length ? totalRow(sc, "SC (Matt's region)") : null,
  };
}

// ---------------------------------------------------------------------
// Weekly figures Report 2 reads (Matt's Report 4 block, BK–CC)
// ---------------------------------------------------------------------
// Weekly projection = average entered day this week x days per week.
// Projection vs 2025 = days gone this week x (that average - 2025's
// average day), as a share of 2025's week. Matt multiplies by
// (6 - AS3), and AS3 is typed 1 even when the week is over, so on a
// Saturday report he counts 5 days gone instead of 6 (parity X-3).
export function weeklyFigures(r, ctx) {
  const s = ctx.settings;
  const avgDay = r.weekEnteredDays ? div(r.weekSales, r.weekEnteredDays) : null;
  const weeklyProj = mul(avgDay, s.days_per_week);
  const pyWeek = div(r.pySales, s.weeks_per_month);
  const pyDay = div(pyWeek, s.days_per_week);
  const vsPyDollars = mul(n(ctx.daysElapsedInWeek), sub(avgDay, pyDay));
  return { weeklyProj, pyWeek, pyDay, vsPyDollars };
}

// ---------------------------------------------------------------------
// Report 2 — one row per market
// ---------------------------------------------------------------------
// Every "per store" figure divides by the market's ACTUAL member count
// in this report (CM-5: Matt divides Columbia West by 4.5, 4.9 and 4.8).
export function bonusFor(pct, brackets) {
  if (!brackets || pct === null) return null;
  const sorted = [...brackets].sort((a, b) => Number(b.min_pct_to_budget) - Number(a.min_pct_to_budget));
  const hit = sorted.find((b) => pct >= Number(b.min_pct_to_budget));
  return hit
    ? { payoutPct: Number(hit.payout_pct), improvementShare: hit.improvement_share == null ? null : Number(hit.improvement_share) }
    : { payoutPct: 0, improvementShare: null };
}

function marketRow(label, allMembers, ctx, extra = {}) {
  const members = reportingOf(allMembers);
  const S = (k) => sum(members.map((r) => r[k]));
  const count = members.length;
  const wk = members.map((r) => weeklyFigures(r, ctx));
  const D = n(ctx.daysOpen);
  const gpBudget = S("gpBudget");
  const projGp = S("projGp");
  const pct = div(projGp, gpBudget);
  const vsPy = sum(wk.map((w) => w.vsPyDollars));
  const pyWeek = sum(wk.map((w) => w.pyWeek));
  return {
    name: withCoverage(label, count, allMembers.length), storeCount: allMembers.length, reporting: count, ...extra,
    gpBudget,
    carsPerDayPerStore: avg(members.map((r) => r.carsPerDay)),
    carsVs2025: avg(members.map((r) => sub(r.carsPerDay, r.pyCarsPerDay))),
    weeklyGoalPerStore: div(S("weeklyGoal"), count),
    weeklyProjPerStore: div(sum(wk.map((w) => w.weeklyProj)), count),
    weeklyProjVs2025: div(vsPy, pyWeek),
    gpYesterdayPerStore: div(S("gp"), count),
    // The market's daily tiers, per store, for colouring yesterday's GP
    // (CM-13: Matt typed these thresholds by hand and they drifted).
    dailyBudgetPerStore: D ? div(div(gpBudget, D), count) : null,
    dailyGoldPerStore: D ? div(div(S("goldGp"), D), count) : null,
    dailySilverPerStore: D ? div(div(S("silverGp"), D), count) : null,
    dailyBronzePerStore: D ? div(div(S("bronzeGp"), D), count) : null,
    pctOfBudget: pct,
    projGp,
    goldGp: S("goldGp"), silverGp: S("silverGp"), bronzeGp: S("bronzeGp"),
    pctToBudget: pct,
    bonus: bonusFor(pct, ctx.brackets),
  };
}

// markets: [{ id, name, sort_order }]. The PGW row is computed over every
// store, not as an average of the market averages (Matt's H56 averages
// the six market rows, so a 1-store market counts as much as a 10-store
// one: parity X-4).
export function buildMarkets(scorecardRows, markets, ctx) {
  const rows = [...markets].sort((a, b) => a.sort_order - b.sort_order).map((m) => {
    const members = scorecardRows.filter((r) => r.marketId === m.id);
    return members.length ? marketRow(m.name, members, ctx, { marketId: m.id }) : null;
  }).filter(Boolean);
  return { rows, total: marketRow("PGW", scorecardRows, ctx, { isTotal: true }) };
}

// ---------------------------------------------------------------------
// Report 5 — tire contest, Midas stores only
// ---------------------------------------------------------------------
// AM Payout: tires/day above the store's payout minimum earns the ahead
// amount when the sales projection is ahead of 2025, and the behind
// amount otherwise -- EXACTLY level pays the behind amount too (the
// user, 2026-09-21). Matt's second branch tests tires/day >= goal
// instead of > the minimum, which differs only between the two.
// CM-17: one rule for every Midas store, including the four North
// stores Matt's file gives no formula at all.
export function tirePayout(r, s) {
  const perDay = r.tiresPerDay;
  if (perDay === null || r.tirePayoutMin === null) return null;
  if (!(perDay > r.tirePayoutMin)) return 0;
  if (r.vs2025 === null) return null;
  return r.vs2025 > 0 ? s.tire_payout_ahead : s.tire_payout_behind;
}

export function tireRow(r, ctx) {
  const D = n(ctx.daysOpen ?? r.daysOpen);
  const E = n(ctx.elapsed);
  const tiresPerDay = E ? div(r.mtdTires, E) : null;
  const mtdProjection = mul(tiresPerDay, D);
  const row = {
    id: r.id, name: r.name, marketId: r.marketId, sort: r.sort, fill: r.fill, font: r.font,
    pySold: r.pyTires, mtd: r.mtdTires,
    monthGoal: mul(r.tireGoal, D), dailyGoal: r.tireGoal,
    tiresYest: r.tires, alignYest: r.align,
    tiresPerDay, mtdProjection, projVsLy: sub(mtdProjection, r.pyTires),
    vs2025: r.vs2025,
    carsVs2025: sub(r.carsPerDay, r.pyCarsPerDay),
    tirePayoutMin: r.tirePayoutMin,
  };
  row.payout = tirePayout(row, ctx.settings);
  return row;
}

function tireGroup(label, allRows, ctx, extra = {}) {
  const D = n(ctx.daysOpen);
  const rows = allRows.filter((r) => n(r.mtd) !== null);
  const count = rows.length;
  const S = (k) => sum(rows.map((r) => r[k]));
  const A = (k) => avg(rows.map((r) => r[k]));
  const perDay = A("tiresPerDay");
  const proj = extra.perStore ? mul(perDay, D) : mul(mul(perDay, D), count);
  const py = extra.perStore ? div(S("pySold"), count) : S("pySold");
  return {
    name: withCoverage(label, count, allRows.length), storeCount: allRows.length, reporting: count, isTotal: true, ...extra,
    pySold: py,
    mtd: extra.perStore ? div(S("mtd"), count) : S("mtd"),
    monthGoal: extra.perStore ? div(S("monthGoal"), count) : S("monthGoal"),
    dailyGoal: extra.perStore ? div(S("dailyGoal"), count) : S("dailyGoal"),
    tiresYest: A("tiresYest"), alignYest: A("alignYest"), tiresPerDay: perDay,
    mtdProjection: proj, projVsLy: sub(proj, py),
  };
}

export function buildTires(scorecardRows, markets, ctx) {
  const midas = scorecardRows.filter((r) => r.brand === "midas");
  const rows = midas.map((r) => tireRow(r, ctx));
  const byMarket = [...markets].sort((a, b) => a.sort_order - b.sort_order).map((m) => {
    const members = rows.filter((r) => r.marketId === m.id);
    return members.length ? tireGroup(m.name, members, ctx, { marketId: m.id }) : null;
  }).filter(Boolean);
  // PGW: a per-store average over every Midas store (Matt: SUM/32).
  return { rows, markets: byMarket, total: tireGroup("PGW (per store)", rows, ctx, { perStore: true }) };
}

// ---------------------------------------------------------------------
// The five presets (they replace Task 10's): each is a view of 1, 2 or 5
// ---------------------------------------------------------------------
export const PRESETS = [
  { key: "market_review", label: "Market Review", report: "markets" },
  { key: "gp_yesterday", label: "Sorted by Total GP $ Yesterday", report: "scorecard", sort: "gp" },
  { key: "tires_yesterday", label: "Sorted by Tires Yesterday", report: "tires", sort: "tiresYest" },
  { key: "sales_vs_ly", label: "Sales Projection vs Last Year", report: "scorecard", sort: "vs2025" },
  { key: "monthly_gp", label: "Sorted by Monthly GP", report: "scorecard", sort: "projGp" },
];

// Descending, blanks last: a store that entered nothing never outranks
// one that did.
export function sortRows(rows, key) {
  if (!key) return rows;
  return [...rows].sort((a, b) => {
    const x = n(a[key]), y = n(b[key]);
    if (x === null && y === null) return (a.sort ?? 0) - (b.sort ?? 0);
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  });
}
