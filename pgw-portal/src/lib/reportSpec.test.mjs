// Offline checks for the Report Builder's client-side vocabulary.
// Run: node src/lib/reportSpec.test.mjs
//
// The SQL is verified against live data; this covers the parts that can
// be wrong without the database noticing — a ratio rendered as a zero, a
// preset that silently selects nothing, a tab name Excel would reject.
import {
  formatCell, numFmtFor, excelValue, storeTree, storesInDistrict, storesInRegion,
  resolvePresetMeasures, resolvePresetStores, orderMeasures, groupCatalog,
  hasAttributedPay, sheetName, canBuildReports, PRESETS, GROUP_BY,
  PRIOR_YEAR_MEASURES, needsPriorYear, hasRepeatedMonthly,
} from "./reportSpec.js";
import { CURRENCY_FMT, HOURS_FMT, PERCENT_FMT, QTY_FMT } from "./excelFormats.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

// ---------------------------------------------------------------------
// Rendering. The distinction that matters: null is BLANK, zero is a
// DASH. A ratio with no denominator has no value, and printing 0.0% for
// it asserts something false.
// ---------------------------------------------------------------------
eq("money zero is a dash", formatCell("money", 0), "-");
eq("money negative", formatCell("money", -120.75), "-$120.75");
eq("money positive", formatCell("money", 1234.5), "$1,234.50");
eq("money null is blank", formatCell("money", null), "");
eq("rate uses money", formatCell("rate", 156.92), "$156.92");
eq("ratio renders percent", formatCell("ratio", 0.263), "26.3%");
eq("ratio zero renders percent", formatCell("ratio", 0), "0.0%");
eq("ratio null is blank", formatCell("ratio", null), "");
eq("int zero is a dash", formatCell("int", 0), "-");
eq("int rounds to whole", formatCell("int", 95), "95");
eq("hours two decimals", formatCell("hours", 37.5), "37.5");
eq("hours zero is a dash", formatCell("hours", 0), "-");
eq("non-numeric is blank", formatCell("money", "abc"), "");

eq("money format", numFmtFor("money"), CURRENCY_FMT);
eq("rate format is currency", numFmtFor("rate"), CURRENCY_FMT);
eq("ratio format", numFmtFor("ratio"), PERCENT_FMT);
eq("hours format", numFmtFor("hours"), HOURS_FMT);
eq("int format", numFmtFor("int"), QTY_FMT);
eq("unknown kind has no format", numFmtFor("text"), null);

// Excel must store numbers as numbers or the format is ignored, and an
// absent ratio must stay an EMPTY cell — a null written as 0 becomes a
// zero somebody later averages.
eq("excel keeps numbers", excelValue(1234.5), 1234.5);
eq("excel null stays null", excelValue(null), null);
eq("excel blank stays null", excelValue(""), null);
eq("excel zero is a real zero", excelValue(0), 0);
eq("excel rejects junk", excelValue("abc"), null);

// ---------------------------------------------------------------------
// The store tree. A store that has fallen out of the hierarchy must be
// visible, not quietly dropped from the picker.
// ---------------------------------------------------------------------
const REGION_A = { id: "r1", name: "Coastal" };
const REGION_B = { id: "r2", name: "Upstate" };
const D1 = { id: "d1", name: "Charleston", region: REGION_A };
const D2 = { id: "d2", name: "Columbia", region: REGION_A };
const D3 = { id: "d3", name: "Greenville", region: REGION_B };
const STORES = [
  { id: "s3", store_number: "3303", name: "Millwood", district: D2, district_id: "d2" },
  { id: "s1", store_number: "2321", name: "Beach Blvd", district: D1, district_id: "d1" },
  { id: "s2", store_number: "3938", name: "Wesmark", district: D1, district_id: "d1" },
  { id: "s4", store_number: "3308", name: "Brayboy", district: D3, district_id: "d3" },
  { id: "s5", store_number: "9999", name: "Orphan", district: null, district_id: null },
];

const tree = storeTree(STORES);
eq("regions sorted, unassigned included", tree.map((r) => r.name), ["Coastal", "Unassigned", "Upstate"]);
eq("districts under a region", tree[0].districts.map((d) => d.name), ["Charleston", "Columbia"]);
eq("stores sorted by number", tree[0].districts[0].stores.map((s) => s.store_number), ["2321", "3938"]);
eq("orphan store kept", tree[1].districts[0].stores.map((s) => s.name), ["Orphan"]);

eq("stores in a district", storesInDistrict(STORES, "d1").map((s) => s.id), ["s1", "s2"]);
eq("stores in a region", storesInRegion(STORES, "r1").map((s) => s.id), ["s3", "s1", "s2"]);
eq("no district is no stores", storesInDistrict(STORES, null), []);

// ---------------------------------------------------------------------
// The five leadership reports. These are not guesses, so the checks are
// about the report being FAITHFUL: the right sort, the right window on
// the right column, and the prior-year columns declared as such.
// ---------------------------------------------------------------------
const CATALOG = [
  { measure_key: "ro_count",     label: "Repair Orders", group_label: "Tic sheet — summary", kind: "int",   restricted: false, sort_order: 100 },
  { measure_key: "sales",        label: "Sales",         group_label: "Tic sheet — summary", kind: "money", restricted: false, sort_order: 110 },
  { measure_key: "ave_estimate", label: "Est / Car",     group_label: "Tic sheet — summary", kind: "money", restricted: false, sort_order: 150 },
  { measure_key: "tires_per_day", label: "Tires per Day", group_label: "Tic sheet — summary", kind: "num", restricted: false, sort_order: 210 },
  { measure_key: "gross_profit", label: "Gross Profit",  group_label: "Gross profit",        kind: "money", restricted: false, sort_order: 450 },
  { measure_key: "gross_profit_pct", label: "GP %",      group_label: "Gross profit",        kind: "ratio", restricted: false, sort_order: 460 },
  { measure_key: "projected_gp", label: "Projected GP",  group_label: "Projection & budget", kind: "money", restricted: false, sort_order: 474 },
  { measure_key: "projected_sales", label: "Sales Projection", group_label: "Projection & budget", kind: "money", restricted: false, sort_order: 476 },
  { measure_key: "gp_budget",    label: "GP Budget",     group_label: "Projection & budget", kind: "money", restricted: false, sort_order: 478 },
  { measure_key: "pct_of_budget", label: "% of Budget",  group_label: "Projection & budget", kind: "ratio", restricted: false, sort_order: 480 },
  { measure_key: "gp_budget_remaining", label: "Budget Remaining", group_label: "Projection & budget", kind: "money", restricted: false, sort_order: 482 },
  { measure_key: "gp_budget_per_day", label: "Budget Per Day", group_label: "Projection & budget", kind: "money", restricted: false, sort_order: 484 },
  { measure_key: "cars_per_store", label: "Cars per Store", group_label: "Per store", kind: "num", restricted: false, sort_order: 488 },
  { measure_key: "gp_per_store", label: "GP per Store", group_label: "Per store", kind: "money", restricted: false, sort_order: 492 },
  { measure_key: "sales_vs_py",  label: "vs Last Year ($)", group_label: "Prior year", kind: "money", restricted: false, sort_order: 497 },
  { measure_key: "sales_vs_py_pct", label: "vs Last Year (%)", group_label: "Prior year", kind: "ratio", restricted: false, sort_order: 498 },
  { measure_key: "cars_per_store_vs_py", label: "Cars vs LY", group_label: "Prior year", kind: "num", restricted: false, sort_order: 499 },
  { measure_key: "gold_threshold", label: "Gold", group_label: "Bonus tiers", kind: "money", restricted: false, sort_order: 900 },
  { measure_key: "gold_remaining", label: "Gold Remaining", group_label: "Bonus tiers", kind: "money", restricted: false, sort_order: 901 },
  { measure_key: "gold_per_day", label: "Gold Per Day", group_label: "Bonus tiers", kind: "money", restricted: false, sort_order: 902 },
  { measure_key: "silver_threshold", label: "Silver", group_label: "Bonus tiers", kind: "money", restricted: false, sort_order: 903 },
  { measure_key: "silver_remaining", label: "Silver Remaining", group_label: "Bonus tiers", kind: "money", restricted: false, sort_order: 904 },
  { measure_key: "silver_per_day", label: "Silver Per Day", group_label: "Bonus tiers", kind: "money", restricted: false, sort_order: 905 },
  { measure_key: "bronze_threshold", label: "Bronze", group_label: "Bonus tiers", kind: "money", restricted: false, sort_order: 906 },
  { measure_key: "bronze_remaining", label: "Bronze Remaining", group_label: "Bonus tiers", kind: "money", restricted: false, sort_order: 907 },
  { measure_key: "bronze_per_day", label: "Bronze Per Day", group_label: "Bonus tiers", kind: "money", restricted: false, sort_order: 908 },
  { measure_key: "tech_overtime", label: "Overtime", group_label: "Technician — pay breakdown", kind: "money", restricted: true, sort_order: 620 },
  { measure_key: "cat_units_kpi_su_tires", label: "Tires", group_label: "Tic sheet — categories (units)", kind: "int", restricted: false, sort_order: 1290 },
  { measure_key: "cat_units_kpi_su_wheel_alignments", label: "Wheel Alignments", group_label: "Tic sheet — categories (units)", kind: "int", restricted: false, sort_order: 1250 },
];

const byKey = (p) => PRESETS.find((x) => x.key === p);
const CURRENT = STORES[0]; // #3303 Millwood, district d2

eq("there are five reports", PRESETS.length, 5);
eq("the five reports, in order", PRESETS.map((p) => p.key),
  ["market_review", "gp_yesterday", "tires_yesterday", "sales_vs_last_year", "month_gp"]);

// Every report is "sorted by" something, and the sort must be a column
// the report actually shows — sorting by an absent measure would be a
// silent no-op that nobody notices until the order looks wrong.
eq("every report declares a sort", PRESETS.every((p) => !!p.sort?.measure), true);
eq("every sort measure is a selected column",
  PRESETS.every((p) => p.measures.includes(p.sort.measure)), true);
eq("every sort direction is valid",
  PRESETS.every((p) => ["asc", "desc"].includes(p.sort.dir)), true);

// The sorts the samples specify, named individually so a change to any
// one of them fails loudly rather than quietly reordering a report.
eq("GP yesterday sorts by GP desc", byKey("gp_yesterday").sort, { measure: "gross_profit", dir: "desc" });
eq("tires sorts by tires desc", byKey("tires_yesterday").sort, { measure: "cat_units_kpi_su_tires", dir: "desc" });
// The point of report 4 is who is improving MOST, not who is largest.
eq("sales vs LY sorts by percentage, not dollars",
  byKey("sales_vs_last_year").sort, { measure: "sales_vs_py_pct", dir: "desc" });
eq("month GP sorts by GP desc", byKey("month_gp").sort, { measure: "gross_profit", dir: "desc" });

// The two dual-window reports. An alt measure must be one of the
// report's own columns, or it would be computed and never displayed.
eq("market review is MTD with a yesterday column",
  [byKey("market_review").range, byKey("market_review").altRange, byKey("market_review").altMeasures],
  ["mtd", "yesterday", ["gp_per_store"]]);
eq("tires is yesterday with an MTD column",
  [byKey("tires_yesterday").range, byKey("tires_yesterday").altRange, byKey("tires_yesterday").altMeasures],
  ["yesterday", "mtd", ["tires_per_day"]]);
eq("alt measures are always selected columns",
  PRESETS.every((p) => !p.altMeasures || p.altMeasures.every((k) => p.measures.includes(k))), true);
eq("a report with alt measures always names an alt range",
  PRESETS.every((p) => !p.altMeasures?.length || !!p.altRange), true);
eq("three reports run on yesterday or use it",
  PRESETS.filter((p) => p.range === "yesterday" || p.altRange === "yesterday").length, 3);

// Prior-year columns must be DECLARED, because they are the ones that
// have to render as unavailable rather than as zero.
eq("market review declares its prior-year column",
  byKey("market_review").requiresPriorYear, ["cars_per_store_vs_py"]);
eq("sales vs LY declares both prior-year columns",
  byKey("sales_vs_last_year").requiresPriorYear, ["sales_vs_py", "sales_vs_py_pct"]);
eq("every declared prior-year column really is one",
  PRESETS.every((p) => (p.requiresPriorYear ?? []).every((k) => PRIOR_YEAR_MEASURES.includes(k))), true);
// The inverse: any prior-year measure a report uses must be declared, or
// it would silently render blank instead of "unavailable".
eq("no undeclared prior-year column slips through",
  PRESETS.every((p) => p.measures.filter((k) => PRIOR_YEAR_MEASURES.includes(k)).every(
    (k) => (p.requiresPriorYear ?? []).includes(k))), true);
eq("needsPriorYear spots one", needsPriorYear(["sales", "sales_vs_py_pct"]), true);
eq("needsPriorYear ignores ordinary measures", needsPriorYear(["sales", "gross_profit"]), false);

// The month-GP report is the bonus tracker across all stores: budget
// plus three tiers, each with a threshold, a remaining and a per-day.
eq("month GP carries budget and all three tiers", byKey("month_gp").measures.length, 13);
eq("every tier column present",
  ["gold", "silver", "bronze"].every((t) =>
    ["_threshold", "_remaining", "_per_day"].every((s) => byKey("month_gp").measures.includes(t + s))), true);

// Monthly figures repeat when a report is grouped shorter than a month.
eq("budget repeats by day", hasRepeatedMonthly(["gp_budget"], "day"), true);
eq("budget repeats by week", hasRepeatedMonthly(["gp_budget"], "week"), true);
eq("budget does not repeat by store", hasRepeatedMonthly(["gp_budget"], "store"), false);
eq("budget does not repeat by month", hasRepeatedMonthly(["gp_budget"], "month"), false);
eq("ordinary measures never repeat", hasRepeatedMonthly(["sales"], "day"), false);

// Resolution against a live catalogue.
eq("every report resolves to all of its measures",
  PRESETS.every((p) => resolvePresetMeasures(p, CATALOG).length === p.measures.length), true);
eq("month GP resolves in catalogue order, not preset order",
  resolvePresetMeasures(byKey("month_gp"), CATALOG).slice(0, 3),
  ["gross_profit", "gp_budget", "gp_budget_remaining"]);
// A key the catalogue has lost is dropped, not sent: report_build
// rejects a whole request for one unknown measure.
eq("an unknown key is dropped, not sent",
  resolvePresetMeasures({ measures: ["sales", "vanished"] }, CATALOG), ["sales"]);

// Store resolution. The leadership reports are company-wide by nature.
eq("every report asks for all accessible stores",
  PRESETS.every((p) => p.stores === "all"), true);
eq("'all' resolves to everything visible",
  resolvePresetStores(byKey("market_review"), { stores: STORES, currentStore: CURRENT }),
  ["s3", "s1", "s2", "s4", "s5"]);
// A district user's "all" is their district — the scope is upstream.
eq("'all' cannot reach past the caller's scope",
  resolvePresetStores(byKey("market_review"), { stores: [STORES[0], STORES[1]], currentStore: CURRENT }),
  ["s3", "s1"]);

// ---------------------------------------------------------------------
// The attributed-pay warning fires only where it is true: overtime is a
// property of a week, so a WEEK grouping needs no caveat.
// ---------------------------------------------------------------------
eq("pay by day is attributed", hasAttributedPay(["tech_overtime", "sales"], "day"), true);
eq("pay by week is exact", hasAttributedPay(["tech_overtime"], "week"), false);
eq("no pay, no warning", hasAttributedPay(["sales"], "day"), false);
eq("labor cost is not a pay-breakdown measure", hasAttributedPay(["tech_labor_cost"], "day"), false);

// ---------------------------------------------------------------------
// Excel tab names: 31 chars, none of : \ / ? * [ ], unique.
// ---------------------------------------------------------------------
const used = new Set(["Summary"]);
eq("plain name", sheetName("3303", used), "3303");
eq("duplicate gets a suffix", sheetName("3303", used), "3303-2");
eq("third duplicate", sheetName("3303", used), "3303-3");
eq("collides with Summary", sheetName("Summary", used), "Summary-2");
eq("illegal characters stripped", sheetName("A/B:C*D?E[F]G", new Set()), "ABCDEFG");
eq("clipped to 31", sheetName("x".repeat(50), new Set()).length, 31);
eq("empty name still names a sheet", sheetName("///", new Set()), "Sheet");

// ---------------------------------------------------------------------
// Who gets the builder. Store users are a flag, off, per Part 1.
// ---------------------------------------------------------------------
eq("district can build", canBuildReports("district"), true);
eq("regional can build", canBuildReports("regional"), true);
eq("admin can build", canBuildReports("admin"), true);
eq("master can build", canBuildReports("master"), true);
eq("store cannot, by default", canBuildReports("store"), false);
eq("no role cannot", canBuildReports(null), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
