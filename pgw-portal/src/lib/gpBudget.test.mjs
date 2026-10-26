// Offline checks for GP vs Budget.
// Run: node src/lib/gpBudget.test.mjs
// The fixture is the slide "2026 Gross Profit vs Budget — Through May":
// its Palm rows (budget, YTD GP) must reproduce its daily GP, projection,
// Track % and division total. 128 open days to May 31, 308 in 2026.
import { buildGpBudget, completedMonths, trackTone } from "./gpBudget.js";
import { annualTier } from "./bonusTiers.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};
const r0 = (v) => (v == null ? v : Math.round(v));
const r1 = (v) => (v == null ? v : Math.round(v * 1000) / 10);

// name, full-year budget, YTD GP, slide daily, slide projection, slide track
const PALM = [
  ["Sunbeam Rd", 817732, 188525, 1473, 453638, 55.5],
  ["Orange Park", 1118323, 469832, 3671, 1130533, 101.1],
  ["Lem Turner", 898788, 261980, 2047, 630389, 70.1],
  ["Gainesville", 958832, 426572, 3333, 1026439, 107.0],
  ["Beach Blvd", 878082, 330905, 2585, 796240, 90.7],
  ["Atlantic Blvd", 768818, 216828, 1694, 521742, 67.8],
];

// Spread each store's budget over 12 months and its YTD GP over Jan–May,
// with the remainder in the last month so the sums are exact.
const spread = (total, n) => { const p = Math.floor(total / n); return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - p * (n - 1) : p)); };

const raw = {
  regions: [{ id: "r1", name: "Florida & North" }],
  districts: [{ id: "d1", name: "Florida", regionId: "r1" }],
  stores: [
    ...PALM.map(([name], i) => ({ id: `s${i}`, storeNumber: `${i}`, name, brand: "midas", districtId: "d1", sort: i })),
    { id: "spd", storeNumber: "9", name: "SpeeDee X", brand: "speedee", districtId: "d1", sort: 9 },
    { id: "ho", storeNumber: "1515", name: "Home Office", brand: "midas", districtId: null, sort: null },
    { id: "nob", storeNumber: "8", name: "No Budget", brand: "midas", districtId: "d1", sort: 8 },
  ],
  budgets: PALM.flatMap(([, budget], i) => spread(budget, 12).map((b, m) => ({ location_id: `s${i}`, month: m + 1, gp_budget: b })))
    .concat(spread(500000, 12).map((b, m) => ({ location_id: "spd", month: m + 1, gp_budget: b }))),
  gp: PALM.flatMap(([, , ytd], i) => spread(ytd, 5).map((g, m) => ({ store_id: `s${i}`, month: m + 1, gp: g })))
    .concat([{ store_id: "nob", month: 1, gp: 100000 }]),
  elapsed: 128, yearDays: 308, through: "2026-05-31",
};

const rep = buildGpBudget(raw);
const D = rep.leads[0].divisions[0];
const byName = Object.fromEntries(D.stores.map((s) => [s.name, s]));

for (const [name, budget, ytd, daily, proj, track] of PALM) {
  const s = byName[name];
  eq(`${name} budget`, r0(s.budget), budget);
  eq(`${name} ytd`, r0(s.ytd), ytd);
  eq(`${name} daily`, r0(s.daily), daily);
  // The slide rounds daily first in places; allow a dollar either way.
  eq(`${name} proj ±1`, Math.abs(r0(s.proj) - proj) <= 1, true);
  // The slide's Track % is not rounded consistently (Gainesville 107.05%
  // shows 107.0, Atlantic 67.86% shows 67.8), so allow 0.1.
  eq(`${name} track ±0.1`, Math.abs(r1(s.track) - track) <= 0.1001, true);
}

// Division total: the slide's Palm TOTAL. The no-budget store adds GP but
// not Track %, so the budgeted stores alone give 83.8%.
eq("Palm budget", r0(D.total.budget), 5440575);
eq("Palm track", r1(D.total.track), 83.8);
eq("Palm ytd incl. no-budget store", r0(D.total.ytd), 1894642 + 100000);

// Who is in: SpeeDee out by default, Home Office never (no budget, no GP).
eq("stores (6 + no-budget)", rep.storeCount, 7);
eq("with budget", rep.withBudget, 6);
eq("speedee opt-in", buildGpBudget(raw, { includeSpeedee: true }).storeCount, 8);
eq("no-budget track blank", byName["No Budget"].track, null);

// Months on budget: GP is behind budget pace every month -> 0 of 5.
eq("completed through May 31", completedMonths("2026-05-31"), 5);
eq("completed through May 30", completedMonths("2026-05-30"), 4);
eq("completed through Feb 28", completedMonths("2026-02-28"), 2);
eq("grid done", D.grid.done, 5);
eq("grid future", D.grid.cells.slice(5).every((c) => c.state === "future"), true);
eq("grid hits (Palm GP < budget each month)", D.grid.hits, 0);
const hitRaw = { ...raw, gp: raw.gp.map((g) => ({ ...g, gp: g.gp * 10 })) };
eq("grid hits when far ahead", buildGpBudget(hitRaw).leads[0].divisions[0].grid.hits, 5);
const noneRaw = { ...raw, gp: raw.gp.filter((g) => g.month !== 3) };
eq("month nobody entered = none", buildGpBudget(noneRaw).leads[0].divisions[0].grid.cells[2].state, "none");

eq("tone over", trackTone(1.0), "over");
eq("tone under at exactly 80%", trackTone(0.80), "under");
eq("tone low", trackTone(0.799), "low");
eq("tone none", trackTone(null), null);

// Projected Trend: cutoffs from bonusTiers.js, on the row's own Track %.
eq("tier gold at 95%", annualTier(0.95)?.key, "gold");
eq("tier silver just under 95%", annualTier(0.9499)?.key, "silver");
eq("tier silver at 90%", annualTier(0.90)?.key, "silver");
eq("tier bronze at 80%", annualTier(0.80)?.key, "bronze");
eq("tier below under 80%", annualTier(0.7999)?.key, "below");
eq("tier none without a Track %", annualTier(null), null);
eq("Orange Park (101.1%) gold", byName["Orange Park"].trend, "gold");
eq("Beach Blvd (90.7%) silver", byName["Beach Blvd"].trend, "silver");
eq("Palm TOTAL (83.8%) bronze", D.total.trend, "bronze");
eq("Sunbeam (55.5%) below", byName["Sunbeam Rd"].trend, "below");
eq("no-budget store -", byName["No Budget"].trend, null);
const modelRep = buildGpBudget({ ...raw, models: { s1: "B", s3: "D", s4: "C" } });
const mByName = Object.fromEntries(modelRep.leads[0].divisions[0].stores.map((s) => [s.name, s]));
eq("Model B N/A", mByName["Orange Park"].trend, "na");
eq("Model D N/A", mByName["Gainesville"].trend, "na");
eq("Model C keeps its tier", mByName["Beach Blvd"].trend, "silver");
eq("total still tiered from its Track %", modelRep.leads[0].divisions[0].total.trend, "bronze");

// Florida & North: two groups of their own, combined total kept unchanged.
const north = [{ id: "n1", storeNumber: "71", name: "Clinton", brand: "midas", districtId: "d2", sort: 1 }];
const splitRaw = {
  ...raw,
  regions: [...raw.regions, { id: "r0", name: "Charleston" }],
  districts: [...raw.districts, { id: "d2", name: "North", regionId: "r1" }, { id: "d0", name: "Charleston", regionId: "r0" }],
  stores: [...raw.stores, ...north, { id: "c1", storeNumber: "61", name: "Rivers", brand: "midas", districtId: "d0", sort: 1 }],
  budgets: [...raw.budgets, ...spread(900000, 12).map((b, m) => ({ location_id: "n1", month: m + 1, gp_budget: b })),
    ...spread(600000, 12).map((b, m) => ({ location_id: "c1", month: m + 1, gp_budget: b }))],
  gp: [...raw.gp, ...spread(400000, 5).map((g, m) => ({ store_id: "n1", month: m + 1, gp: g })),
    ...spread(200000, 5).map((g, m) => ({ store_id: "c1", month: m + 1, gp: g }))],
};
const sp = buildGpBudget(splitRaw);
eq("groups", sp.leads.map((L) => L.name), ["Charleston", "Florida", "North"]);
eq("each split group has its own division", sp.leads.map((L) => L.divisions.map((d) => d.name)), [["Charleston"], ["Florida"], ["North"]]);
eq("one combined total", sp.combinedTotals.map((t) => t.label), ["Florida & North TOTAL"]);
const fl = sp.leads[1].divisions[0].total, no = sp.leads[2].divisions[0].total, comb = sp.combinedTotals[0];
eq("combined budget = Florida + North", r0(comb.budget), r0(fl.budget + no.budget));
eq("combined ytd = Florida + North", r0(comb.ytd), r0(fl.ytd + no.ytd));
eq("combined total has a trend", typeof comb.trend, "string");
eq("unsplit report has no combined totals", rep.combinedTotals, []);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
