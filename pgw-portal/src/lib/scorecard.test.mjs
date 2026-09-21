// Offline checks for Matt's reports, Phase 1 (numbers + colours).
// Run: node src/lib/scorecard.test.mjs
//
// Synthetic stores only. The full parity run against Matt's workbook
// (every cell he computes, 889 matching, every difference a named
// defect) lives outside the repo because it carries a day of real
// store sales; this file pins the rules that parity proved.
import {
  settingsFrom, storeRow, buildScorecard, buildMarkets, buildTires, tirePayout, bonusFor, sortRows, weeklyFigures,
} from "./scorecard.js";
import { evaluate, excelRules, RULES, PALETTE } from "./scorecardRules.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};
const near = (label, got, want, tol = 1e-6) => {
  if (got !== null && want !== null && Math.abs(got - want) <= tol) { pass++; return; }
  if (got === null && want === null) { pass++; return; }
  fail++; console.error(`FAIL ${label}\n  got  ${got}\n  want ${want}`);
};

const settings = settingsFrom([]);
const ctx = { elapsed: 16, daysOpen: 25, daysLeftInWeek: 1, daysElapsedInWeek: 6, settings, brackets: null };
const base = (over = {}) => ({
  id: "s1", sort: 1, name: "Two Notch", brand: "midas", marketId: "east", state: "SC",
  daysOpen: 25, gpBudget: 143025, salesBudget: 310000, bronzePct: 0.8,
  weeklyGoal: 75000, tireGoal: 25, tirePayoutMin: 4.9,
  yest: { cars: 14, sales: 1290, gp: 240, potential: 339 * 14, tires: 3, align: 4 },
  mtd: { cars: 362, sales: 100514, gp: 43513, tires: 161, battery: null },
  week: { sales: 37004, enteredDays: 6 },
  py: { sales: 418689, cars: 1063, tires: 603, daysOpen: 25 },
  ...over,
});

// --- Report 1: Matt's own Two Notch row (Current Month row 13) ---------
const r = storeRow(base(), ctx);
near("daily GP", r.dailyGp, 5721);
near("daily gold", r.dailyGold, 5434.95);
near("daily bronze", r.dailyBronze, 4576.8);
near("ARO", r.aro, 1290 / 14);
near("sales capture", r.capture, (1290 / 14) / 339);
near("GP %", r.gpPct, 240 / 1290);
near("projected monthly GP = MTD GP / 16 x 25", r.projGp, 67989.0625);
near("sales projection", r.salesProj, 157053.125);
near("% of goal", r.pctOfGoal, 157053.125 / 310000);
near("vs 2025", r.vs2025, 157053.125 - 418689);
near("sales goal today = (75,000 - 37,004) / max(1, days left)", r.salesGoalToday, 37996);
near("car goal today = (1063 + 2x25 - 362) / 9", r.carGoalToday, (1063 + 50 - 362) / 9);
near("cars/day vs 2025 derives 2025 per day (X-5)", r.carsPerDay - r.pyCarsPerDay, 362 / 16 - 1063 / 25);

// Not entered is null, never zero, and is never coloured.
const blank = storeRow(base({ yest: null }), ctx);
eq("no entry: cars null", blank.cars, null);
eq("no entry: ARO null", blank.aro, null);
eq("no entry: no colour", evaluate("scorecard", "gp", blank, settings), null);
eq("no elapsed days: no projection", storeRow(base(), { ...ctx, elapsed: 0 }).projGp, null);
eq("no weekly goal: no sales goal today", storeRow(base({ weeklyGoal: null }), ctx).salesGoalToday, null);
near("days left 3: shortfall over 3", storeRow(base(), { ...ctx, daysLeftInWeek: 3 }).salesGoalToday, 37996 / 3);

// Bronze override (Wesmark 85%)
near("bronze floor 85%", storeRow(base({ bronzePct: 0.85 }), ctx).bronzeGp, 143025 * 0.85);

// --- totals ----------------------------------------------------------
const facts = [
  base({ id: "a", sort: 2, state: "SC", marketId: "east" }),
  base({ id: "b", sort: 1, state: "VA", marketId: "north", gpBudget: 75000 }),
  base({ id: "c", sort: 3, state: "SC", marketId: "east", yest: null }),
];
const sc = buildScorecard(facts, ctx);
eq("rows in report order", sc.rows.map((x) => x.id), ["b", "a", "c"]);
near("PGW total sums GP budgets over every store", sc.total.gpBudget, 143025 * 2 + 75000);
eq("SC subtotal covers only SC stores", sc.scTotal.storeCount, 2);
near("total GP% re-derived from sums, not averaged", sc.total.gpPct, (240 * 2) / (1290 * 2));
eq("no SC subtotal when every store is SC", buildScorecard([facts[0]], ctx).scTotal, null);

// --- rollups count only stores that have reported --------------------
const quiet = base({ id: "q", sort: 9, state: "SC", marketId: "east", gpBudget: 1000000, yest: null,
  mtd: { cars: null, sales: null, gp: null, tires: null, battery: null } });
const partial = buildScorecard([...facts, quiet], ctx);
eq("a store with no month yet is left out of the total", partial.total.reporting, 3);
eq("…and the total says so", partial.total.name, "PGW Total (3 of 4 reporting)");
near("…its budget stays out of the denominator", partial.total.gpBudget, 143025 * 2 + 75000);
const pm = buildMarkets(partial.rows, [{ id: "east", name: "East", sort_order: 1 }], ctx).rows[0];
eq("market row names its coverage", pm.name, "East (2 of 3 reporting)");
near("market % to budget over the reporting stores only", pm.pctToBudget, (67989.0625 * 2) / (143025 * 2));
near("market GP per store divides by the reporting count", pm.gpYesterdayPerStore, 240 / 2);
eq("every store reporting: the plain market name", buildMarkets(sc.rows, [{ id: "east", name: "East", sort_order: 1 }], ctx).rows[0].name, "East");

// --- Report 2 --------------------------------------------------------
const markets = [{ id: "north", name: "North", sort_order: 1 }, { id: "east", name: "East", sort_order: 2 }, { id: "empty", name: "Empty", sort_order: 3 }];
const mk = buildMarkets(sc.rows, markets, { ...ctx, brackets: [{ min_pct_to_budget: 1, payout_pct: 0.65, improvement_share: 0.05 }, { min_pct_to_budget: 0.8, payout_pct: 0.25 }] });
eq("markets in market order, empty market dropped", mk.rows.map((m) => m.name), ["North", "East"]);
eq("store count comes from membership (CM-5)", mk.rows[1].storeCount, 2);
near("GP yesterday per store divides by the real count", mk.rows[1].gpYesterdayPerStore, 240 / 2);
near("weekly goal per store", mk.rows[1].weeklyGoalPerStore, 75000);
near("market daily budget per store", mk.rows[1].dailyBudgetPerStore, (143025 * 2 / 25) / 2);
near("PGW cars/day is over every store, not an average of markets (X-4)", mk.total.carsPerDayPerStore, 362 / 16);
near("market % to budget", mk.rows[1].pctToBudget, (67989.0625 * 2) / (143025 * 2));
eq("bonus bracket from % to budget (47.5% is below every rung)", mk.rows[1].bonus.payoutPct, 0);
eq("bonus bracket at 85%", bonusFor(0.85, [{ min_pct_to_budget: 1, payout_pct: 0.65 }, { min_pct_to_budget: 0.8, payout_pct: 0.25 }]).payoutPct, 0.25);
eq("bonus hidden without brackets (admin-only data)", buildMarkets(sc.rows, markets, ctx).rows[0].bonus, null);
eq("top rung carries improvement share as a number", bonusFor(1.02, [{ min_pct_to_budget: 1, payout_pct: 0.65, improvement_share: 0.05 }]), { payoutPct: 0.65, improvementShare: 0.05 });
eq("below every rung pays 0", bonusFor(0.5, [{ min_pct_to_budget: 0.8, payout_pct: 0.25 }]), { payoutPct: 0, improvementShare: null });
const wf = weeklyFigures(sc.rows[1], ctx);
near("weekly projection = average entered day x 6", wf.weeklyProj, 37004 / 6 * 6);
near("2025 per week = month / 4.345", wf.pyWeek, 418689 / 4.345);

// --- Report 5 --------------------------------------------------------
const ti = buildTires(buildScorecard([...facts, base({ id: "sd", brand: "speedee", marketId: "east" })], ctx).rows, markets, ctx);
eq("SpeeDee excluded from the tire contest", ti.rows.some((x) => x.id === "sd"), false);
const t = ti.rows.find((x) => x.id === "a");
near("tires/day MTD", t.tiresPerDay, 161 / 16);
near("MTD projection", t.mtdProjection, 161 / 16 * 25);
near("month tire goal", t.monthGoal, 625);
const pay = (perDay, vs) => tirePayout({ tiresPerDay: perDay, tirePayoutMin: 4.9, vs2025: vs }, settings);
eq("payout: above min, ahead of 2025", pay(5.2, 100), 500);
eq("payout: above min, behind 2025", pay(5.2, -100), 100);
eq("payout: above min, exactly level pays behind (user 2026-09-21)", pay(5.2, 0), 100);
eq("payout: at the min is not above it", pay(4.9, 100), 0);
eq("payout: below min", pay(3, 100), 0);
eq("payout: unknown tires", pay(null, 100), null);

// --- sorting ---------------------------------------------------------
eq("sort desc, blanks last", sortRows([{ id: 1, gp: 5 }, { id: 2, gp: null }, { id: 3, gp: 9 }], "gp").map((x) => x.id), [3, 1, 2]);

// --- colours: the tier ladder ----------------------------------------
const row = { v: 0, budget: 100, gold: 95, silver: 90, bronze: 80 };
const tier = (v) => evaluate("scorecard", "projGp", { projGp: v, gpBudget: 100, goldGp: 95, silverGp: 90, bronzeGp: 80 }, settings);
eq("tier: above budget = green", tier(100.01), "green");
eq("tier: exactly budget = gold", tier(100), "gold");
eq("tier: gold floor = gold", tier(95), "gold");
eq("tier: just under gold = silver", tier(94.99), "silver");
eq("tier: bronze floor = bronze (CM-12 cannot happen)", tier(80), "bronze");
eq("tier: under bronze = red", tier(79.99), "red");
eq("aro 274.99 red", evaluate("scorecard", "aro", { aro: 274.99 }, settings), "red");
eq("aro 275 yellow", evaluate("scorecard", "aro", { aro: 275 }, settings), "yellow");
eq("aro 299 green", evaluate("scorecard", "aro", { aro: 299 }, settings), "green");
eq("% of goal 0.999 is yellow, above it green", [0.999, 0.9991].map((v) => evaluate("scorecard", "pctOfGoal", { pctOfGoal: v }, settings)), ["yellow", "green"]);
eq("sales exactly at goal is uncoloured", evaluate("scorecard", "sales", { sales: 100, salesGoalToday: 100 }, settings), null);
eq("cars at goal is green", evaluate("scorecard", "cars", { cars: 10, carGoalToday: 10 }, settings), "green");
eq("each row against ITS OWN goal (CM-9)", ["a", "b"].map((id) => evaluate("scorecard", "sales", { sales: 100, salesGoalToday: id === "a" ? 90 : 110 }, settings)), ["green", "red"]);
eq("market % to budget bands", [1, 0.96, 0.92, 0.85, 0.7].map((v) => evaluate("markets", "pctToBudget", { pctToBudget: v }, settings)), ["green", "gold", "silver", "bronze", "red"]);
eq("palette is the brief's exact fills", [PALETTE.green.fill, PALETTE.gold.fill, PALETTE.bronze.fill], ["C6EFCE", "FFE699", "F8CBAD"]);

// --- colours: the Excel rules land on the same colour ------------------
// A tiny evaluator for the formulas excelRules() writes: AND of
// ISNUMBER(ref) and comparisons of refs / numbers. If the generated rule
// and the screen ever disagree for any value in the grid, this fails.
function excelEval(formula, cells) {
  const inner = formula.match(/^AND\((.*)\)$/)[1].split(",");
  const val = (x) => (/^\$?[A-Z]+\d+$/.test(x) ? cells[x.replace(/\$/g, "")] : Number(x));
  return inner.every((part) => {
    const isn = part.match(/^ISNUMBER\((.+)\)$/);
    if (isn) { const v = val(isn[1]); return typeof v === "number" && Number.isFinite(v); }
    const m = part.match(/^(.+?)(>=|<=|>|<)(.+)$/);
    const a = val(m[1]), b = val(m[3]);
    return { ">": a > b, ">=": a >= b, "<": a < b, "<=": a <= b }[m[2]];
  });
}
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
for (const report of Object.keys(RULES)) {
  for (const key of Object.keys(RULES[report])) {
    // place every row key the rule reads in its own column
    const keys = [key, "carGoalToday", "salesGoalToday", "dailyGp", "dailyGold", "dailySilver", "dailyBronze",
      "gpBudget", "goldGp", "silverGp", "bronzeGp", "dailyBudgetPerStore", "dailyGoldPerStore", "dailySilverPerStore",
      "dailyBronzePerStore", "dailyGoal"].filter((k, i, a) => a.indexOf(k) === i);
    const colOf = (k) => letters[keys.indexOf(k)] ?? null;
    const spec = excelRules(report, key, { colOf, firstRow: 7, lastRow: 7, settings });
    const refs = { carGoalToday: 10, salesGoalToday: 10, dailyGp: 100, dailyGold: 95, dailySilver: 90, dailyBronze: 80,
      gpBudget: 100, goldGp: 95, silverGp: 90, bronzeGp: 80, dailyBudgetPerStore: 100, dailyGoldPerStore: 95,
      dailySilverPerStore: 90, dailyBronzePerStore: 80, dailyGoal: 5 };
    let agree = true;
    for (const v of [-5, 0, 0.5, 0.79, 0.8, 0.85, 0.9, 0.93, 0.95, 0.999, 1, 1.5, 2, 2.5, 3, 4.99, 5, 9.99, 10, 10.01, 79.99, 80, 85, 90, 94.99, 95, 99, 100, 100.01, 274.99, 275, 298.99, 299, 400, null]) {
      const row = { ...refs, [key]: v };
      const screen = evaluate(report, key, row, settings);
      const cells = {}; for (const k of keys) cells[`${colOf(k)}7`] = row[k] === null ? "" : row[k];
      const hits = spec.rules.filter((ru) => excelEval(ru.formulae[0], cells)).map((ru) => ru.token);
      const excel = hits.length ? hits : [null];
      if (hits.length > 1 || excel[0] !== screen) { agree = false; console.error(`  ${report}.${key} v=${v}: screen ${screen}, excel ${JSON.stringify(hits)}`); }
    }
    eq(`Excel rules match the screen, one colour at most: ${report}.${key}`, agree, true);
  }
}
eq("an Excel rule compares with its OWN row ($A7, not $A$7)", excelRules("scorecard", "gp", {
  colOf: (k) => ({ gp: "O", dailyGp: "A", dailyGold: "B", dailySilver: "C", dailyBronze: "D" })[k], firstRow: 7, lastRow: 42, settings,
}).rules[0].formulae[0], "AND(ISNUMBER(O7),ISNUMBER($A7),O7>$A7)");

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
