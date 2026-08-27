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
// The catalogue-driven bits. A preset names GROUPS so a category added
// to a brand joins the category preset without an edit here.
// ---------------------------------------------------------------------
const CATALOG = [
  { measure_key: "ro_count",     label: "Repair Orders", group_label: "Tic sheet — summary", kind: "int",   restricted: false, sort_order: 100 },
  { measure_key: "sales",        label: "Sales",         group_label: "Tic sheet — summary", kind: "money", restricted: false, sort_order: 110 },
  { measure_key: "capture_rate", label: "Capture",       group_label: "Tic sheet — summary", kind: "ratio", restricted: false, sort_order: 140 },
  { measure_key: "gross_profit", label: "Gross Profit",  group_label: "Gross profit",        kind: "money", restricted: false, sort_order: 450 },
  { measure_key: "gross_profit_pct", label: "GP %",      group_label: "Gross profit",        kind: "ratio", restricted: false, sort_order: 460 },
  { measure_key: "tech_overtime", label: "Overtime",     group_label: "Technician — pay breakdown", kind: "money", restricted: true, sort_order: 620 },
  { measure_key: "cat_units_kpi_su_brakes", label: "Brakes", group_label: "Tic sheet — categories (units)", kind: "int", restricted: false, sort_order: 1050 },
  { measure_key: "cat_units_kpi_su_lof",    label: "LOF",    group_label: "Tic sheet — categories (units)", kind: "int", restricted: false, sort_order: 1170 },
  { measure_key: "cat_pct_kpi_su_brakes",   label: "Brakes — % of cars", group_label: "Tic sheet — categories (% of cars)", kind: "ratio", restricted: false, sort_order: 2050 },
];

const byKey = (p) => PRESETS.find((x) => x.key === p);

eq("category preset takes both category groups",
  resolvePresetMeasures(byKey("category_performance"), CATALOG),
  ["cat_units_kpi_su_brakes", "cat_units_kpi_su_lof", "cat_pct_kpi_su_brakes"]);

eq("store month preset takes summary + gross profit",
  resolvePresetMeasures(byKey("store_month"), CATALOG),
  ["ro_count", "sales", "capture_rate", "gross_profit", "gross_profit_pct"]);

// The district preset names five keys; this stub catalogue carries three
// of them. The other two are DROPPED rather than sent — report_build()
// rejects the whole request for one unknown measure, and losing a column
// beats losing the report.
eq("unknown preset keys are dropped, not sent",
  resolvePresetMeasures(byKey("district_comparison"), CATALOG),
  ["sales", "gross_profit", "gross_profit_pct", "ro_count", "capture_rate"].filter(
    (k) => CATALOG.some((m) => m.measure_key === k)));

eq("every preset resolves to something", PRESETS.every((p) => {
  const full = CATALOG.concat([
    { measure_key: "tech_hours_worked", label: "H", group_label: "Technician — operations", kind: "hours", restricted: false, sort_order: 500 },
  ]);
  return resolvePresetMeasures(p, full).length > 0;
}), true);
eq("every preset names a real grouping",
  PRESETS.every((p) => GROUP_BY.some(([k]) => k === p.groupBy)), true);

const CURRENT = STORES[0]; // Millwood, district d2
eq("current-store preset", resolvePresetStores(byKey("store_month"), { stores: STORES, currentStore: CURRENT }), ["s3"]);
eq("district preset takes the whole district",
  resolvePresetStores(byKey("district_comparison"), { stores: STORES, currentStore: STORES[1] }), ["s1", "s2"]);
// A store with no district must not resolve to an empty report.
eq("district preset falls back to the store itself",
  resolvePresetStores(byKey("district_comparison"), { stores: STORES, currentStore: STORES[4] }), ["s5"]);
eq("keep preset keeps a selection",
  resolvePresetStores(byKey("category_performance"), { stores: STORES, currentStore: CURRENT, selected: ["s1", "s4"] }),
  ["s1", "s4"]);
eq("keep preset falls back to everything visible",
  resolvePresetStores(byKey("category_performance"), { stores: STORES, currentStore: CURRENT, selected: [] }),
  ["s3", "s1", "s2", "s4", "s5"]);
// A stale id from a previous scope must not survive into the request.
eq("keep preset drops ids outside scope",
  resolvePresetStores(byKey("category_performance"), { stores: STORES, currentStore: CURRENT, selected: ["s1", "GONE"] }),
  ["s1"]);

// Column order comes from the catalogue, so the picker can stay a set.
eq("columns order by catalogue, not click order",
  orderMeasures(["gross_profit_pct", "ro_count", "cat_units_kpi_su_brakes", "sales"], CATALOG),
  // Catalogue order, not click order: summary (100, 110), then gross
  // profit (460), then the categories (1000 + the brand display order).
  ["ro_count", "sales", "gross_profit_pct", "cat_units_kpi_su_brakes"]);
eq("unknown measures sort last",
  orderMeasures(["mystery", "sales"], CATALOG), ["sales", "mystery"]);

eq("catalogue groups keep catalogue order",
  groupCatalog(CATALOG).map((g) => g.label),
  ["Tic sheet — summary", "Gross profit", "Technician — pay breakdown",
   "Tic sheet — categories (units)", "Tic sheet — categories (% of cars)"]);

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
