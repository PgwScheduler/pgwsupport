// Offline checks for the Change Log (migration 81).
// Run: node src/lib/auditLog.test.mjs
import {
  canSeeAuditLog, changesOf, describeRecord, formatValue, groupByTxid, actionVerb, actorLabel, auditCsv, fieldLabel,
} from "./auditLog.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

eq("roles", ["master", "admin", "district", "regional", "store", "office"].map(canSeeAuditLog), [true, true, true, true, false, false]);

const lookups = { stores: [{ id: "A", store_number: "3303", name: "Millwood" }], districts: [{ id: "D", name: "Columbia East" }] };
eq("money field", formatValue("sales_labor", 1200.5), "$1,200.50");
eq("adjustment negative", formatValue("sales_adjustments", -50), "-$50.00");
eq("count field", formatValue("ro_count", 20), "20");
eq("hours", formatValue("hours_worked", "9.5"), "9.5");
eq("null", formatValue("hours_worked", null), "—");
eq("bool", formatValue("active", false), "No");
eq("store id", formatValue("location_id", "A", lookups), "#3303");
eq("unknown store", formatValue("location_id", "Z", lookups), "another store");
eq("district", formatValue("district_id", "D", lookups), "Columbia East");
eq("role", formatValue("role", "district"), "District Manager");
eq("date", formatValue("termination_date", "2026-10-07"), "Wed 10/7/26");
eq("employee number stays text", formatValue("employee_number", "00123"), "00123");
eq("sales_required is money", formatValue("sales_required", 5000), "$5,000.00");
eq("label override", fieldLabel("ro_count"), "Cars");
eq("label humanized", fieldLabel("sales_labor"), "Sales labor");

eq("record: tic day", describeRecord({ row_ref: { business_date: "2026-10-08" } }), "Thu 10/8/26");
eq("record: units", describeRecord({ row_ref: { business_date: "2026-10-08", category: "Brakes" } }), "Brakes · Thu 10/8/26");
eq("record: week", describeRecord({ row_ref: { week_start: "2026-10-04" } }), "week of Sun 10/4/26");
eq("record: month", describeRecord({ row_ref: { plan_year: 2026, month: 10 } }), "Oct 2026");
eq("record: rate", describeRecord({ row_ref: { rate_type: "hourly", effective_date: "2026-10-01" } }), "Hourly · from Thu 10/1/26");

const upd = { action: "update", table_name: "daily_kpi", old_values: { ro_count: 18 }, new_values: { ro_count: 20 } };
eq("update changes", changesOf(upd), [{ field: "ro_count", from: 18, to: 20 }]);
const ins = { action: "insert", table_name: "payroll_daily", new_values: { id: "x", location_id: "A", employee_id: "e", work_date: "2026-10-07", hours_worked: 8 } };
eq("insert hides ref columns", changesOf(ins), [{ field: "hours_worked", from: null, to: 8 }]);
const del = { action: "delete", table_name: "payroll_daily", old_values: { id: "x", work_date: "2026-10-07", hours_worked: 9.5 } };
eq("delete shows old values", changesOf(del), [{ field: "hours_worked", from: 9.5, to: null }]);
const empIns = { action: "insert", table_name: "employees", new_values: { id: "n", location_id: "A", full_name: "Sue", transferred_from_id: "o" } };
eq("employee insert keeps store", changesOf(empIns).map((c) => c.field), ["location_id", "full_name", "transferred_from_id"]);
eq("transfer verb", actionVerb(empIns), "transferred in");
eq("actor: database", actorLabel({ source: "database" }), "Direct database change");
eq("actor: person", actorLabel({ source: "portal", actor_name: "Dan" }), "Dan");

const g = groupByTxid([
  { id: 9, txid: 5, table_name: "employee_pay_rate_history", action: "insert" },
  { id: 8, txid: 5, ...empIns },
  { id: 7, txid: 5, table_name: "employees", action: "update" },
  { id: 6, txid: 4, ...upd },
  { id: 5, txid: 3, ...upd },
]);
eq("grouping", g.map((x) => [x.txid, x.rows.length, x.isTransfer]), [[5, 3, true], [4, 1, false], [3, 1, false]]);

const csv = auditCsv([{ ...upd, at: "2026-10-09T18:14:00Z", source: "portal", actor_name: "Sam, Jr.", actor_role: "store", store_number: "3303", area: "tic", subject_name: null, row_ref: { business_date: "2026-10-08" } }]);
const lines = csv.split("\n");
eq("csv rows", lines.length, 2);
eq("csv escapes + content", lines[1], '"Oct 9, 2026, 2:14 PM","Sam, Jr.",Store Manager,#3303,Tic sheet,Tic sheet,,Thu 10/8/26,changed,Cars,18,20');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
