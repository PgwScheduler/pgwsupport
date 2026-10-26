// Offline checks for the Parts Recon Deduction Report.
// Run: node src/lib/partsReconDeduction.test.mjs
import { buildDeductionReport } from "./partsReconDeduction.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const locations = [
  { id: "L1", store_number: "3303", name: "Midas Millwood Ave" },
  { id: "L2", store_number: "3938", name: "Midas Sumter" },
  { id: "L3", store_number: "3111", name: "Midas Sunbeam Rd" },          // nothing this month
  { id: "SB", store_number: null, name: "Value Service", is_sandbox: true },
  { id: "HO", store_number: "1515", name: "Home Office", is_home_office: true },
];
// left_to_deduct is what parts_recon_items() returns (parts_recon_left).
const item = (id, loc, store, kind, vendor, status, amount, credit, left, extra = {}) =>
  ({ id, location_id: loc, recon_store: store, kind, vendor, status, amount, credit_amt: credit, left_to_deduct: left, ro: "R" + id, invoices: "I" + id, ...extra });
const items = [
  item(1, "L1", "Millwood", "ro_cost", "Napa", "open", 100, null, 100),
  item(2, "L1", "Millwood", "ro_cost", "Napa", "credit_received", 50, 50, 0),
  item(3, "L1", "Millwood", "divvy", "Divvy", "partial_credit", 80, 30, 50),
  item(4, "L1", "Millwood", "ro_cost", "O'Reilly's", "explained", 40, null, 0),
  item(5, "L1", "Millwood", "ro_cost", "O'Reilly's", "answered", 25.5, null, 25.5),
  item(6, "L2", "Wesmark", "arm", "Napa", "deduct", 300, null, 300),
  item(7, "SB", "Value Service", "ro_cost", "Napa", "open", 999, null, 999),
];
const tracker = [
  { recon_store: "Millwood", location_id: "L1", vendor: "Napa", items: 2, left_to_deduct: 100, script_amount: 150 },
  { recon_store: "Millwood", location_id: "L1", vendor: "Divvy", items: 1, left_to_deduct: 50, script_amount: 80 },
  { recon_store: "Millwood", location_id: "L1", vendor: "O'Reilly's", items: 2, left_to_deduct: 25.5, script_amount: 65.5 },
  { recon_store: "Millwood", location_id: "L1", vendor: "Agero Towing", items: 0, left_to_deduct: 45, script_amount: 45 },
  { recon_store: "Wesmark", location_id: "L2", vendor: "Napa", items: 1, left_to_deduct: 300, script_amount: 300 },
  { recon_store: "Wesmark", location_id: "L2", vendor: "Agero Towing", items: 0, left_to_deduct: 0, script_amount: 0 },
];

const rep = buildDeductionReport({ items, tracker, locations });
const by = Object.fromEntries(rep.stores.map((s) => [s.storeNumber, s]));

eq("every store, $0 included, no sandbox or Home Office", rep.stores.map((s) => s.storeNumber), ["3111", "3303", "3938"]);
eq("$0 store", [by["3111"].left, by["3111"].count, by["3111"].name], [0, 0, "Midas Sunbeam Rd"]);
eq("store name from the recon", by["3303"].name, "Millwood");
eq("Millwood = 100 + 50 + 25.50 + Agero 45", by["3303"].left, 220.5);
eq("Millwood matches the Tracker", [by["3303"].trackerLeft, by["3303"].diff], [220.5, 0]);
eq("only lines with something left", by["3303"].lines.map((l) => l.kindLabel + ":" + l.left), [
  "RO cost:100", "Divvy:50", "Tracker line (no items):45", "RO cost:25.5",
]);
eq("partial credit shows AP credit", by["3303"].lines.find((l) => l.kind === "divvy").credit, 30);
eq("ARM counted and labelled", [by["3938"].left, by["3938"].lines[0].kindLabel], [300, "ARM"]);
eq("$0 tracker-only line not listed", by["3938"].count, 1);
eq("grand total", rep.total, 520.5);
eq("grand total matches Tracker", [rep.trackerTotal, rep.diff, rep.mismatches], [520.5, 0, 0]);

// An item whose store x vendor has no Tracker line would not be on the
// Tracker: the report still counts it and shows the difference.
const orphan = buildDeductionReport({ items: [...items, item(8, "L2", "Wesmark", "ro_cost", "Parts Authority", "open", 12, null, 12)], tracker, locations });
const w = orphan.stores.find((s) => s.storeNumber === "3938");
eq("orphan item shows as a difference", [w.left, w.trackerLeft, w.diff, orphan.mismatches], [312, 300, 12, 1]);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
