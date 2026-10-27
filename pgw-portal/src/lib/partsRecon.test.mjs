// Offline checks for Parts Recon (migration 90): the left-to-deduct rule
// and the workbook rules that mirror the Python recon scripts.
// Run: node src/lib/partsRecon.test.mjs
import { leftToDeduct, itemTotals, groupItems, matchesFilter, monthShort, chunk, poKind, poRo } from "./partsRecon.js";
import { fromBreakdown, fromDetail, fromTracker, fromResponses, monthFromTitle, buildImport, cellValue } from "./partsReconImport.js";
import { trackerNotes } from "./partsReconWorkbook.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

// left to deduct = the Response Tracker formula
eq("credit received", leftToDeduct("credit_received", 100, 40), 0);
eq("explained", leftToDeduct("explained", 100, null), 0);
eq("partial", leftToDeduct("partial_credit", 100, 40), 60);
eq("partial over", leftToDeduct("partial_credit", 100, 140), 0);
eq("open", leftToDeduct("open", 100, 40), 100);
eq("deduct", leftToDeduct("deduct", "12.5", null), 12.5);

const items = [
  { recon_store: "B", vendor: "Napa", status: "open", amount: 10 },
  { recon_store: "A", vendor: "ATD", status: "partial_credit", amount: 50, credit_amt: 20 },
  { recon_store: "A", vendor: "ATD", status: "answered", amount: 70 },
  { recon_store: "A", vendor: "Napa", status: "credit_received", amount: 5, credit_amt: 5 },
];
eq("totals", itemTotals(items), { items: 4, open: 1, answered: 1, done: 2, amount: 135, credited: 25, left: 110 });
const g = groupItems(items);
eq("group order", g.map((x) => [x.store, x.vendors.map((v) => v.vendor)]), [["A", ["ATD", "Napa"]], ["B", ["Napa"]]]);
eq("biggest first", g[0].vendors[0].items.map((i) => i.amount), [70, 50]);
eq("filter open includes partial/deduct", items.filter((i) => matchesFilter(i, "open")).length, 2);
eq("filter answered", items.filter((i) => matchesFilter(i, "answered")).length, 1);
eq("month short", [monthShort("2026-09-01"), monthShort("2026-10-01"), monthShort("")], ["Sept 2026", "Oct 2026", ""]);
eq("chunk", chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);

eq("title month long", monthFromTitle("September 2026 Parts Reconciliation — all vendor statements"), "2026-09-01");
eq("title month short", monthFromTitle("Sept 2026 RO Cost Breakdown - every RO"), "2026-09-01");
eq("title month oct", monthFromTitle("Oct 2026 RO Cost Breakdown"), "2026-10-01");
eq("title none", monthFromTitle("RO Cost Breakdown"), null);
eq("cell: uncalculated formula", cellValue({ formula: "M7" }), null);
eq("cell: formula result", cellValue({ formula: "M7", result: 4.5 }), 4.5);
eq("cell: date", cellValue(new Date(Date.UTC(2026, 8, 19))), "2026-09-19");

// RO Cost Breakdown -> store items (emails_data.py rules)
const bd = fromBreakdown({
  byRo: [
    ["Atlantic", "Napa", "82486", 566.82, 207.41, 207.41, 359.41, "inv 922670 is a part not on the RO", "Return the part(s) not on the RO to the vendor and reply with the credit #", 3, "Yes", 0],
    ["Atlantic", "Napa", "82490", 100, 80, 80, 20, "sales tax", "AP: vendor charged sales tax", 1, "Yes", 0],          // AP-only: not a store item
    ["Knox Abbott", "Napa", "1093656", 421.9, 0, 0, 403.9, "battery", "Return the part(s) not on the RO to the vendor and reply with the credit #; AP: x", 4, "Yes", 18],
    ["Gervais", "ATD", "31", 50, 64, 64, -14, "RO higher", "Reply to confirm the part number and price", 1, "Yes", 0],
  ],
  lineDetail: [
    ["Atlantic", "Napa", "82486", "Vendor invoice", "922670", "2026-09-19", "Napa", null, null, null, 283.41, "Not on RO", "nothing matches"],
    ["Atlantic", "Napa", "82486", "RO part - this vendor", null, null, "Napa", "P1", "PADS", "Stock", 20, "Matched", null],
  ],
  stockOrdered: [["Atlantic", "Napa", "774", "NAD1415", "R CERAMIC PADS", 29.99, "inv 1"]],
  warranty: [["Bush River", "US AutoForce", "3124373", "INV1", 106, 51, 55, "ER800170 $51.00"]],
});
eq("store items skip AP-only", bd.items.map((i) => i.ro), ["82486", "1093656", "31"]);
eq("amount = billed - RO - core", bd.items.map((i) => i.amount), [359.41, 403.9, 0]);
eq("AP asks dropped from the store's ask", bd.items[1].asked, "Return the part(s) not on the RO to the vendor and reply with the credit #");
eq("RO higher", [bd.items[2].ro_higher, /higher than the bill/.test(bd.items[2].asked)], [14, true]);
eq("detail lines", [bd.items[0].detail.lines.length, bd.items[0].detail.parts[0].stock, bd.items[0].invoices], [1, true, "922670"]);
eq("notes", bd.notes.length, 1);
eq("warranty task", [bd.tasks[0].kind, bd.tasks[0].po], ["warranty_addback", "3124373"]);

// Parts Recon Detail -> Divvy items, ARM items, AP to-do (build_packets.py rules)
const sl = (store, vendor, date, inv, po, amt, ap, apInv = null, apAmt = null, note = null, src = "stmt") =>
  [store, vendor, date, inv, po, null, amt, "Charge", ap, apInv, apAmt, null, null, null, note, src];
const det = fromDetail({
  statementLines: [
    sl("Decker", "Divvy", "2026-09-03", "AMAZON", "1104001", 75, "NOT IN AP"),
    sl("Decker", "Divvy", "2026-09-03", "AMAZON", "1104001", 75, "NOT IN AP"),           // same charge twice -> #2
    sl("Decker", "Divvy", "2026-09-04", "REFUND", "", -20, "NOT IN AP"),                  // credit: not an item
    sl("Decker", "Napa", "2026-09-05", "211", "R1", 62, "NOT IN AP"),
    sl("Decker", "Napa", "2026-09-05", "212", "R2", 10, "NOT IN AP"),                     // under $25: set aside
    sl("Decker", "Napa", "2026-09-06", "213", "R3", -208, "NOT IN AP"),
    sl("Decker", "Napa", "2026-09-07", "214", "R4", 152.98, "AMOUNT DIFF", "214", 42.99, "looks like sales tax"),
    sl("Decker", "Napa", "2026-09-08", "215", "R5", 123, "WRONG SUPPLIER IN AP", "215", 123, "entered under 1-800 RADIATORS"),
    sl("Decker", "Uber", "2026-09-08", "U1", "", 90, "NOT IN AP"),                         // Uber: skipped
    sl("Unassigned", "S&S Tire", "2026-09-04", "910", "", 370.5, "NOT IN AP"),
    sl("SD James Island", "Napa", "2026-09-04", "1", "1", 40, "N/A - ARM (no AP report)"),
  ],
  roCostCheck: [
    ["Decker", "Napa", "1104036", "R1104036", 1, 96.37, 50, 46.37, "SALES TAX ON INVOICE (AP)", "5-9% over", "S1"],
    ["Decker", "Napa", "1111", "R1111", 1, 122, 0, 122, "RO NOT ON PARTS DETAIL", null, "S2"],
    ["Decker", "Napa", null, ", shop", 2, 30, 0, 30, "NO RO # ON STATEMENT", null, "S3"],
    ["Oviedo", "US AutoForce", null, "", 1, 874, 0, 874, "NO PO - STOCK ORDER?", null, "INV0019625227"],
    ["Oviedo", "Napa", null, "", 1, 60, 0, 60, "NO RO # ON STATEMENT", null, "S4"],               // pre-10/27 run, blank PO
    ["Oviedo", "Napa", null, "RUSH", 1, 70, 0, 70, "NO RO # ON STATEMENT", null, "S5"],
  ],
  apNotOnStatement: [["Decker", "Napa", "NAPA", "2026-09-01", "211504", "ORDER", 197.76, "No"], ["Decker", "Napa", "NAPA", "2026-09-01", "9", "X", 10, "No"]],
  summary: [["September 2026 Parts Reconciliation"], [], [], ["Location", "Vendor", "GP Amount → tracker", "Status → tracker", "Tracker line"],
    ["Decker", "Divvy", 150, "INCOMPLETE", "Divvy"], ["SD James Island", "Napa", 613.56, "INCOMPLETE", "Napa"],
    ["SD James Island", "Divvy", null, "COMPLETE", "Divvy"], ["TOTAL", null, 763.56]],
  summaryTitle: "September 2026 Parts Reconciliation",
});
eq("divvy items (dupe keyed #2, credit skipped)", det.items.filter((i) => i.kind === "divvy").map((i) => i.import_key.endsWith("#2")), [false, true]);
eq("arm item", det.items.filter((i) => i.kind === "arm").map((i) => [i.recon_store, i.vendor, i.amount]), [["SD James Island", "Napa", 613.56]]);
const kinds = det.tasks.map((t) => t.kind);
eq("ap to-do kinds", kinds, ["bill_not_in_ap", "credit_not_in_ap", "amount_diff", "wrong_supplier", "unassigned", "sales_tax",
  "ro_not_on_parts_detail", "no_ro_on_statement", "no_po", "no_po", "no_ro_on_statement", "ap_not_on_statement"]);
eq("sales tax hint", /looks like sales tax/.test(det.tasks[2].task), true);
eq("no PO task", det.tasks.filter((t) => t.kind === "no_po").map((t) => [t.recon_store, t.task, t.po, t.stmt_amount]),
  [["Oviedo", "No PO – stock order?", "(blank)", 874], ["Oviedo", "No PO – stock order?", "(blank)", 60]]);
eq("RUSH stays review", det.tasks.find((t) => t.invoice === "S5").po, "RUSH");

// PO cleanup (same table as the scripts' test_po.py)
const PO_CASES = [["R0004116", "ro", "4116"], ["r335997", "ro", "335997"], ["RO 4116", "ro", "4116"], ["RO#4116", "ro", "4116"],
  ["R-4116", "ro", "4116"], ["rd000915", "ro", "915"], ["RD001001", "ro", "1001"], ["R0107796", "ro", "107796"],
  ["0004116", "ro", "4116"], [" ro: 0004116 ", "ro", "4116"], ["", "blank", ""], [null, "blank", ""], ["   ", "blank", ""],
  ["SHOP", "shop", ""], ["shop stock", "shop", ""], ["TOOLS", "shop", ""], ["Inventory 4116", "shop", ""], ["SUPPLIES", "shop", ""],
  ["RUSH", "review", ""], ["RGN 245893", "review", ""], ["NEW RETURNS", "review", ""], ["John Smith", "review", ""], ["RX4116", "review", ""]];
eq("PO cleanup", PO_CASES.map(([p]) => [p, poKind(p), poRo(p)]), PO_CASES);

// "FET not on RO": a deduction with no store action, kept as a store item
const fet = fromBreakdown({
  byRo: [["Wesmark", "ATD", "4116", 192.43, 180, 180, 12.43, "inv S1 $12.43 is Federal Excise Tax that is not on the RO",
    "No action needed - Federal Excise Tax on the tire invoice is not on the RO, so it is deducted from the store", 2, "Yes", 0]],
  lineDetail: [["Wesmark", "ATD", "4116", "Vendor invoice", "S1", null, "ATD", null, null, null, 12.43, "FET not on RO", "Federal Excise Tax"]],
  stockOrdered: [], warranty: [],
});
eq("FET item", fet.items.map((i) => [i.ro, i.amount, i.detail.lines[0].result]), [["4116", 12.43, "FET not on RO"]]);
eq("summary total", det.summaryTotal, 763.56);

// Tracker: the filled block wins over management's blank template block; hand-keyed lines kept.
const log = [["MONTHLY LOG"], ["Month", "Region", "Location", "Vendor", "Status", "Amount", "Notes", "Key"],
  ["2026-09-01", "Columbia", "Decker", "Divvy", "INCOMPLETE", 150, "auto", "2026-09|Decker|Divvy"],
  ["2026-08-01", "Columbia", "Decker", "Divvy", "COMPLETE", 1, "", "2026-08|Decker|Divvy"],
  ["2026-09-01", "Columbia", "Decker", "Divvy", null, null, null, "2026-09|Decker|Divvy"],
  ["2026-09-01", "Columbia", "Gervais", "Agero Towing", null, 360, null, "2026-09|Gervais|Agero Towing"]];
const tr = fromTracker(log, "2026-09-01").tracker;
eq("tracker dedupe", tr.map((t) => [t.key, t.script_amount]), [["2026-09|Decker|Divvy", 150], ["2026-09|Gervais|Agero Towing", 360]]);

// Responses map display vendor names back to the item.
const resp = fromResponses([["Store", "Vendor", "RO #"], ["Atlantic", "NAPA", "82486", "", 1, "", "", "Credit received", "C1", 359.41, "2026-10-21", "n"],
  ["Atlantic", "NAPA", "99999", "", 1, "", "", "Partial credit", "", 1, "", ""], ["Gervais", "ATD", "31", "", 0, "", "", "Open"],
  ["Knox Abbott", "NAPA", "R01093656", "", 1, "", "", "Explained - no deduction", "", null, "", ""]],   // PO-style RO # still finds it
  [["Credits"], [], [], ["Store", "Vendor", "Credit #"], ["Mt Pleasant", "NAPA", "800177", "2026-09-24", "796665", "139643", "blades", 28.78, "Aug 2026", "x"]],
  bd.items);
eq("responses matched", resp.responses.map((r) => [r.import_key, r.status]), [["ro_cost|Atlantic|Napa|82486", "credit_received"], ["ro_cost|Knox Abbott|Napa|1093656", "explained"]]);
eq("responses unmatched", resp.unmatched, ["Atlantic NAPA RO 99999"]);
eq("other credits", resp.credits.map((c) => [c.recon_store, c.amount]), [["Mt Pleasant", 28.78]]);

// buildImport assigns tracker rows (Misc. when the tracker has no row for the vendor)
const built = buildImport({
  breakdown: { byRo: [["Decker", "CRW", "1", 50, 20, 20, 30, "x", "Return it", 1, "Yes", 0]], lineDetail: [], stockOrdered: [], warranty: [], title: "Sept 2026 RO Cost Breakdown" },
  detail: { statementLines: [], roCostCheck: [], apNotOnStatement: [],
    summary: [["Location", "Vendor", "GP Amount → tracker", "Status → tracker", "Tracker line"], ["Decker", "CRW", 30, "INCOMPLETE", "Misc."], ["TOTAL", null, 30]],
    summaryTitle: "September 2026 Parts Reconciliation" },
  tracker: { log: [["Month", "Region", "Location", "Vendor", "Status", "Amount", "Notes", "Key"], ["2026-09-01", "Columbia", "Decker", "Misc.", "INCOMPLETE", 30, "", "2026-09|Decker|Misc."]] },
});
eq("built ok", [built.errors.length, built.check.total, built.check.mismatches, built.check.tracker_mismatches], [0, 30, 0, 0]);
eq("tracker vendor", built.items[0].tracker_vendor, "Misc.");
const mixed = buildImport({ breakdown: { byRo: [], lineDetail: [], stockOrdered: [], warranty: [], title: "Oct 2026 RO Cost Breakdown" },
  detail: { statementLines: [], roCostCheck: [], apNotOnStatement: [], summary: [], summaryTitle: "September 2026 Parts Reconciliation" } });
eq("month mismatch caught", mixed.errors.length, 1);
eq("needs both files", buildImport({ breakdown: null, detail: null }).errors.length, 2);

eq("tracker note", trackerNotes({ script_notes: "auto", items: 3, open_items: 1, to_review: 1, credited: 12.5 }, new Date(2026, 9, 22)),
  "auto | Portal 10/22: 2 of 3 item(s) answered, $12.50 credited, 1 waiting on AP review");
eq("tracker note, no items", trackerNotes({ script_notes: "auto", items: 0 }), "auto");

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
