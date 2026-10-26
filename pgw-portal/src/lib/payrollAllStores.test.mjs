// Offline checks for Extract All Stores.
// Run: node src/lib/payrollAllStores.test.mjs
import { buildAllStoresCsv, combinedHead, storeLabel, asExportRows } from "./payrollAllStores.js";
import { headFor, PAY_HEAD, SPEEDEE_STORE_HEAD } from "./payrollExport.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const SUN = [["sun", "Sun"], ["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"]];
const dates = ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"];

// Combined header: Store first, Midas columns, SpeeDee-only, then pay.
const head = combinedHead(SUN);
eq("store first", head.slice(0, 2), ["Store", "Week of"]);
eq("midas store columns next", head.slice(2, 2 + headFor(SUN).length), headFor(SUN));
eq("speedee-only store columns", head.filter((h) => SPEEDEE_STORE_HEAD.includes(h) && !headFor(SUN).includes(h)),
  ["Clock Hrs Other", "Clock Hrs Here", "Labor %", "Labor % Eligible", "Labor Sales", "Spiffs", "Total Incentive", "Sales Expectation"]);
eq("one Paycheck column", head.filter((h) => h.startsWith("Paycheck")), ["Paycheck"]);
eq("midas pay columns all there", PAY_HEAD.every((h) => head.includes(h)), true);
eq("speedee-only pay columns", head.slice(head.indexOf("Paycheck") + 1), ["Hourly & OT", "Labor % Pay"]);
eq("no duplicate columns", new Set(head).size, head.length);

eq("label store", storeLabel({ store_number: "3303", name: "Midas Millwood" }), "3303 Midas Millwood");
eq("label home office", storeLabel({ store_number: "1515", name: "Home Office", is_home_office: true }), "Home Office");

// Two stores and the Home Office, out of order; names out of order.
const emp = (id, full_name, position, extra = {}) => ({ id, full_name, position, is_store_manager: false, ...extra });
const midasRow = (e, hours) => ({
  employee: e,
  entry: { position: e.position, pto_days: 0, total_hours: hours, total_hours_other: 0, total_turned: 0,
    hrs_turned_other: 0, hrs_turned_here: 0, actual_sales: 0, work_orders: 0, sales_required: null },
  rate: { hourly_rate: 20 }, pay: { bonus: 0, incentives: 0 },
  days: { [dates[1]]: { hours_worked: hours } }, techDates: [], techSourced: false,
});
const sdRow = (e, hours) => ({
  employee: e,
  entry: { position: e.position, pto_days: 0, total_hours: hours, total_hours_other: 0, spiffs: 5, labor_sales: null },
  rate: { hourly_rate: 15 }, pay: { paycheck_amount: 600 }, roleSalesRate: 0,
  days: { [dates[2]]: { hours_worked: hours } },
});
const stores = [
  { loc: { store_number: "3303", name: "Midas Millwood", brand: "midas" },
    rows: asExportRows([midasRow(emp("b", "Zed Tech", "tech"), 40), midasRow(emp("a", "Amy Front", "front"), 30)], "midas") },
  { loc: { store_number: "3009", name: "SpeeDee Summerville", brand: "speedee" },
    rows: asExportRows([sdRow(emp("c", "Cal Cashier", "cashier"), 20)], "speedee") },
  { loc: { store_number: "1515", name: "Home Office", brand: "midas", is_home_office: true },
    rows: asExportRows([midasRow(emp("d", "Dee Office", "office"), 35)], "midas") },
];
const { csv, rowCount } = buildAllStoresCsv({ stores, week: "2026-10-18", dates, dayLabels: SUN });
const lines = csv.split("\n").map((l) => l.split(","));
const col = (h) => lines[0].indexOf(h);
eq("row count", rowCount, 4);
eq("sorted by store number, then name", lines.slice(1).map((l) => `${l[0]}|${l[col("Employee")]}`),
  ["Home Office|Dee Office", "3009 SpeeDee Summerville|Cal Cashier", "3303 Midas Millwood|Amy Front", "3303 Midas Millwood|Zed Tech"]);
eq("every line has every column", lines.every((l) => l.length === lines[0].length), true);
const cal = lines[2];
eq("speedee day hours filled", cal[col("Tue")], "20");
eq("speedee blank on a Midas-only column", cal[col("Productivity")], "");
eq("speedee paycheck in Paycheck", cal[col("Paycheck")], "$600.00");
eq("speedee spiffs", cal[col("Spiffs")], "5");
const amy = lines[3];
eq("midas blank on a SpeeDee-only column", amy[col("Spiffs")], "");
eq("midas day hours", amy[col("Mon")], "30");
eq("office position label", lines[1][col("Position")], "Office");

// A Monday (pre-cutover) week: no day columns, the weekly clock columns.
const weekly = buildAllStoresCsv({ stores, week: "2026-08-24", dates: [], dayLabels: SUN });
const wHead = weekly.csv.split("\n")[0].split(",");
eq("weekly week has no day columns", wHead.includes("Sun") || wHead.includes("Mon"), false);
eq("weekly week has clock columns once", wHead.filter((h) => h === "Clock Hrs Here").length, 1);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
