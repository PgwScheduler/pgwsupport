// Offline checks for Who Sold What (migration 70).
// Run: node src/lib/whoSoldWhat.test.mjs
import {
  buildWhoSoldWhat, valuesOf, rankOf, tokenFor, sectionsOf, pool, measuresFor, prevMonth, monthBounds, CLOSE,
} from "./whoSoldWhat.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};
const near = (label, got, want) => eq(label, got === null ? null : Math.round(got * 1e6) / 1e6, want === null ? null : Math.round(want * 1e6) / 1e6);

// The migration 70 layout (goals as seeded).
const G = (service_key, section, sort_order, label, measure, goal, in_average) =>
  ({ service_key, section, sort_order, label, measure, goal, in_average });
const goals = [
  G("kpi_su_ac_heat", 1, 10, "A/C - Heating", "count", null, false),
  G("kpi_su_lof", 1, 20, "LOF / day", "per_day", 7, false),
  G("kpi_su_lof_premium", 1, 30, "Prem Oil", "pct", 0.4, false),
  G("kpi_su_air_filter", 1, 40, "Air", "pct", 0.1, true),
  G("kpi_su_cabin_filter", 1, 50, "Cabin", "pct", 0.05, true),
  G("kpi_su_wiper_blades", 1, 60, "Wipers", "pct", 0.1, true),
  G("kpi_su_battery", 1, 70, "Battery", "pct", 0.05, true),
  G("kpi_su_lights", 1, 80, "Lights", "pct", 0.08, true),
  G("kpi_su_brake_flush", 2, 10, "Brake", "pct", 0.05, true),
  G("kpi_su_coolant_flush", 2, 20, "Coolant", "pct", 0.03, true),
  G("kpi_su_gear_box_flush", 2, 30, "Diff", "pct", 0.03, true),
  G("kpi_su_fuel_injection_flush", 2, 40, "Fuel", "pct", 0.05, true),
  G("kpi_su_power_steering_flush", 2, 50, "PS", "pct", 0.03, true),
  G("kpi_su_tires", 3, 10, "Tires", "pct", 0.2, true),
  G("kpi_su_brakes", 3, 40, "Brakes", "pct", 0.15, true),
  G("kpi_su_wheel_alignments", 3, 50, "Alignment", "pct", 0.1, true),
  G("kpi_su_shocks_struts", 3, 60, "Struts", "pct", 0.03, true),
  G("kpi_su_steering_suspension", 3, 70, "Suspension", "pct", 0.08, true),
];

// Template row 4 (Main St SV) and row 25 (its counts): 91 cars.
const mainSt = {
  ro_count: 91, gross_sales: 8556, days_with_data: 13,
  cat_units_kpi_su_lof_premium: 20, cat_units_kpi_su_air_filter: 4, cat_units_kpi_su_cabin_filter: 1,
  cat_units_kpi_su_wiper_blades: 2, cat_units_kpi_su_battery: 2, // lights: no unit row -> 0
  cat_units_kpi_su_brake_flush: 2, cat_units_kpi_su_coolant_flush: 1, cat_units_kpi_su_fuel_injection_flush: 3,
  cat_units_kpi_su_power_steering_flush: 1,
  cat_units_kpi_su_tires: 37, cat_units_kpi_su_brakes: 9, cat_units_kpi_su_wheel_alignments: 15,
  cat_units_kpi_su_shocks_struts: 2, cat_units_kpi_su_steering_suspension: 13,
  cat_units_kpi_su_lof: 65,
};
const v = valuesOf(mainSt, goals);
near("Prem Oil = L25/H4 (template 0.2198)", v.values.kpi_su_lof_premium, 20 / 91);
near("Air = M25/H4 (template 0.04396)", v.values.kpi_su_air_filter, 4 / 91);
eq("missing unit row on an entered month is 0", v.values.kpi_su_lights, 0);
near("section 1 average = (M+N+O+P+Q)/5 (template R4 0.01978)", v.avg[1], (4 + 1 + 2 + 2 + 0) / 91 / 5);
near("section 2 average (template AJ4 0.01538)", v.avg[2], (2 + 1 + 0 + 3 + 1) / 91 / 5);
near("section 3 average (template AY4 0.16703)", v.avg[3], (37 + 9 + 15 + 2 + 13) / 91 / 5);
near("LOF per day = units / days entered", v.values.kpi_su_lof, 5);
eq("no cars = not entered (null, not zeros)", valuesOf({ ro_count: 0 }, goals), null);
eq("missing measures = not entered", valuesOf(null, goals), null);

// Sections: counts, average goal = mean of the averaged goals.
const secs = sectionsOf(goals);
eq("three sections", secs.map((s) => [s.section, s.cols.length, s.avgCount]), [[1, 8, 5], [2, 5, 5], [3, 5, 5]]);
near("section 1 average goal", secs[0].avgGoal, (0.1 + 0.05 + 0.1 + 0.05 + 0.08) / 5);

// Ranks: highest first, ties share, nulls unranked.
eq("rank with a tie", rankOf([{ id: "a", value: 0.2 }, { id: "b", value: 0.3 }, { id: "c", value: 0.2 }, { id: "d", value: 0.1 }, { id: "e", value: null }]),
  { b: 1, a: 2, c: 2, d: 4 });

// Colour bands.
eq("at goal is green", tokenFor(0.1, 0.1), "green");
eq("just under is yellow", tokenFor(0.1 * CLOSE, 0.1), "yellow");
eq("well under is red", tokenFor(0.01, 0.1), "red");
eq("no goal, no colour", tokenFor(5, null), null);
eq("blank is never coloured", tokenFor(null, 0.1), null);

// Pooling: units and cars summed, never an average of percentages.
const small = { ro_count: 9, cat_units_kpi_su_tires: 9, days_with_data: 1 };
const p = valuesOf(pool([mainSt, small, { ro_count: 0 }, null], goals), goals);
near("pooled tires = (37+9)/(91+9), not mean of 40.7% and 100%", p.values.kpi_su_tires, 46 / 100);

// The whole report: two markets, ranks across both, deltas vs last month.
const markets = [{ id: "m2", name: "Charleston", sort_order: 4 }, { id: "m1", name: "North", sort_order: 1 }];
const stores = [
  { id: "s1", name: "Main St", marketId: "m2", sort: 1, cur: mainSt, prev: { ...mainSt, cat_units_kpi_su_tires: 10 } },
  { id: "s2", name: "Duke", marketId: "m1", sort: 1, cur: { ...mainSt, cat_units_kpi_su_tires: 80 }, prev: null },
  { id: "s3", name: "Clinton", marketId: "m1", sort: 2, cur: null, prev: mainSt },
];
const r = buildWhoSoldWhat(stores, markets, goals);
eq("markets in sort order", r.groups.map((g) => g.market.name), ["North", "Charleston"]);
eq("3 stores, 2 entered", [r.storeCount, r.enteredCount], [3, 2]);
const byId = Object.fromEntries(r.groups.flatMap((g) => g.rows).map((x) => [x.id, x]));
eq("section 3 rank: Duke (more tires) 1, Main St 2, Clinton unranked", [byId.s2.rank[3], byId.s1.rank[3], byId.s3.rank[3]], [1, 2, null]);
near("Main St change vs last month, section 3", byId.s1.delta[3], (37 - 10) / 91 / 5);
eq("no last month = no change shown", byId.s2.delta[3], null);
eq("not entered this month = no change shown", byId.s3.delta[3], null);
near("PGW total pools the entered stores", r.total.cur.values.kpi_su_tires, (37 + 80) / (91 + 91));
eq("market filter", buildWhoSoldWhat(stores, markets, goals, { marketId: "m1" }).storeCount, 2);
eq("measures requested", measuresFor(goals.slice(0, 2)), ["ro_count", "gross_sales", "days_with_data", "cat_units_kpi_su_ac_heat", "cat_units_kpi_su_lof"]);

eq("prevMonth", [prevMonth("2026-08"), prevMonth("2026-01")], ["2026-07", "2025-12"]);
eq("monthBounds", [monthBounds("2026-02"), monthBounds("2024-02")], [{ from: "2026-02-01", to: "2026-02-28" }, { from: "2024-02-01", to: "2024-02-29" }]);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
