// =====================================================================
// Tic sheet totals — the month grid's week blocks, totals rows, header
// band and self-correcting goals. Mirrors `Maint Tic Sheet` in the
// Millwood workbook; every formula below cites the cell it comes from.
//
// LAYOUT (source rows 10-61)
//   five Sunday-Saturday blocks, each followed by three rows:
//     Weekly Totals     column sums for that week          (R17/27/37/47/57)
//     New Goal          cumulative remaining units         (R18/28/38/48/58)
//     Weekly % of Cars  weekly units / weekly repair orders (R19/29/39/49/59)
//   then Monthly Total (R60) and PACE (R61).
//
// The two ratio columns never sum — they recompute from the block's own
// figures (source AO17 = AN17/AH17, AP17 = AJ17/AN17):
//   Ave Estimate / Car = Total Potential / Repair Orders
//   Sales Capture Rate = Sales / Total Potential
//
// DELIBERATE DIVERGENCES FROM THE SOURCE
//   * The source hardcodes five week blocks. Five is right whenever the
//     month starts on Sun-Wed, but a 31-day month starting Saturday
//     (e.g. August 2026) needs six — the spreadsheet silently drops its
//     last two days from every total. monthWeekBlocks() emits as many
//     blocks as the month actually needs, so Monthly Total always equals
//     the sum of the day rows.
//   * A/C Refresh, Catalytic Converters and 15K Critical Sys Treatment
//     have their goal formula pointed at an empty cell in the source
//     (=Summary!$T$17 instead of $T$16), so their goals read zero
//     forever. Here every category reads the same projected-RO figure.
//   * The source's PACE row covers only categories, ROs, First Time
//     Customers, Sales and Declined. Pace is defined for any additive
//     column, so it is emitted for CC Apps, Credit $ and Total Potential
//     too. The two ratio columns stay blank, as in the source — scaling
//     numerator and denominator by the same factor cannot move a ratio.
//   * Sales EXCLUDES Groupon, matching the source's Sales column
//     (AJ13 = Summary G+H+J+L+N, no M). Groupon is still entered in the
//     breakdown panel and still feeds gross profit, where the source
//     splits it 50/50 across labor and parts (see lib/grossProfit.js).
// =====================================================================

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const ratio = (n, d) => (num(d) === 0 ? null : num(n) / num(d));
const pad2 = (n) => String(n).padStart(2, "0");

// Revenue lines that live on daily_kpi. Labor comes from the technician
// tracker; Groupon is deliberately absent (see header).
const SALES_KEYS = ["sales_parts", "sales_tires", "sales_supplies", "sales_discounts"];

// Sales for one day = tech-tracker labor + the daily_kpi revenue lines.
// sales_discounts is signed as entered and added algebraically, so a
// +107.00 discount reversal raises the day's sales.
export const daySales = (row, laborSales) =>
  num(laborSales) + SALES_KEYS.reduce((s, k) => s + num(row?.[k]), 0);

export const dayPotential = (row, laborSales) =>
  daySales(row, laborSales) + num(row?.declined_sales);

// Sunday-Saturday blocks covering every day of the month. The first block
// starts on the Sunday on-or-before the 1st, so its leading days may fall
// in the previous month — `days` lists only the days inside this month.
export function monthWeekBlocks(year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay(); // Sun = 0
  const blocks = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const i = Math.floor((firstDow + d - 1) / 7);
    (blocks[i] ??= []).push(`${year}-${pad2(month)}-${pad2(d)}`);
  }
  return blocks.map((days, index) => ({ index, days, startIso: days[0], endIso: days[days.length - 1] }));
}

const blankTotals = () => ({
  units: {},
  ro_count: 0,
  zero_dollar_tickets: 0,
  sales: 0,
  declined_sales: 0,
  credit_apps: 0,
  credit_dollars: 0,
  total_potential: 0,
});
// Ratio columns recompute; they are never summed.
const closeTotals = (t) => ({
  ...t,
  ave_estimate: ratio(t.total_potential, t.ro_count),
  capture_rate: ratio(t.sales, t.total_potential),
});

function addDay(t, row, labor, categories, units) {
  t.ro_count += num(row?.ro_count);
  t.zero_dollar_tickets += num(row?.zero_dollar_tickets);
  t.credit_apps += num(row?.credit_apps);
  t.credit_dollars += num(row?.credit_dollars);
  t.declined_sales += num(row?.declined_sales);
  t.sales += daySales(row, labor);
  t.total_potential += dayPotential(row, labor);
  for (const c of categories) t.units[c.id] = num(t.units[c.id]) + num(units?.[c.id]);
}

// Sum the already-closed week totals rather than re-summing the day rows —
// Monthly Total is "the sum of the Weekly Totals rows" (source R60).
function sumWeeks(weeks, categories) {
  const t = blankTotals();
  for (const c of categories) t.units[c.id] = 0;
  for (const w of weeks) {
    t.ro_count += w.totals.ro_count;
    t.zero_dollar_tickets += w.totals.zero_dollar_tickets;
    t.credit_apps += w.totals.credit_apps;
    t.credit_dollars += w.totals.credit_dollars;
    t.declined_sales += w.totals.declined_sales;
    t.sales += w.totals.sales;
    t.total_potential += w.totals.total_potential;
    for (const c of categories) t.units[c.id] += num(w.totals.units[c.id]);
  }
  return closeTotals(t);
}

// PACE — where the month lands if nothing changes (source R61):
//   pace = month_to_date / (days_elapsed / days_open)
// Ratio columns stay null. Returns null when the month has no entered
// days or the store has no planned days.
function paceOf(month, categories, factor) {
  if (factor == null) return null;
  const t = blankTotals();
  for (const k of ["ro_count", "zero_dollar_tickets", "credit_apps", "credit_dollars", "declined_sales", "sales", "total_potential"])
    t[k] = month[k] / factor;
  for (const c of categories) t.units[c.id] = num(month.units[c.id]) / factor;
  return { ...t, ave_estimate: null, capture_rate: null };
}

// ---------------------------------------------------------------------
// The whole grid, in one pass.
//
//   categories    [{ id }] in display order
//   kpiByDate     dateIso -> daily_kpi row
//   unitsByDate   dateIso -> { [categoryId]: units }
//   laborByDate   dateIso -> labor sales (technician tracker)
//   daysOpen      the store's planned days for the month
//   categoryGoals categoryId -> { goal_pct_of_cars, average_sale }
// ---------------------------------------------------------------------
export function computeTicSheet({ year, month, categories = [], kpiByDate = {}, unitsByDate = {}, laborByDate = {}, daysOpen = 0, categoryGoals = {} }) {
  const blocks = monthWeekBlocks(year, month);

  // days_elapsed counts entered days, not calendar days (source Summary
  // R6 = COUNT of the RO column). A day counts once it has repair orders.
  let daysElapsed = 0;
  for (const b of blocks)
    for (const iso of b.days)
      if (num(kpiByDate[iso]?.ro_count) > 0) daysElapsed += 1;

  const weeks = blocks.map((b) => {
    const t = blankTotals();
    for (const c of categories) t.units[c.id] = 0;
    for (const iso of b.days) addDay(t, kpiByDate[iso], laborByDate[iso], categories, unitsByDate[iso]);
    return { ...b, totals: closeTotals(t) };
  });

  const monthTotals = sumWeeks(weeks, categories);

  // projected_repair_orders moves with the store's actual traffic — that
  // is what makes the goals self-correcting (source Summary T16).
  const projectedRo = daysElapsed > 0 && daysOpen > 0 ? (monthTotals.ro_count / daysElapsed) * daysOpen : 0;

  const monthlyGoal = {};
  const actualPct = {};
  const actualSales = {};
  for (const c of categories) {
    const g = categoryGoals[c.id] || {};
    monthlyGoal[c.id] = num(g.goal_pct_of_cars) * projectedRo;
    actualPct[c.id] = ratio(monthTotals.units[c.id], monthTotals.ro_count);
    actualSales[c.id] = num(monthTotals.units[c.id]) * num(g.average_sale);
  }

  // New Goal is cumulative remaining units: each week subtracts its own
  // total from the previous week's remainder, so a shortfall in week one
  // raises week two's target. Negative is correct and must display — it
  // means the category is ahead.
  const running = {};
  for (const c of categories) running[c.id] = monthlyGoal[c.id];
  for (const w of weeks) {
    w.newGoal = {};
    w.pctOfCars = {};
    for (const c of categories) {
      running[c.id] -= num(w.totals.units[c.id]);
      w.newGoal[c.id] = running[c.id];
      w.pctOfCars[c.id] = ratio(w.totals.units[c.id], w.totals.ro_count);
    }
  }

  const factor = daysElapsed > 0 && daysOpen > 0 ? daysElapsed / daysOpen : null;

  return {
    weeks,
    month: monthTotals,
    pace: paceOf(monthTotals, categories, factor),
    daysElapsed,
    daysOpen,
    projectedRo,
    monthlyGoal,   // also the header band's "Goal Units" row
    actualPct,
    actualSales,
  };
}
