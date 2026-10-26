import ExcelJS from "exceljs";
import { applyBorders, downloadWorkbook, headerFill } from "./excelStyle.js";
import { CURRENCY_FMT, TEXT_FMT } from "./excelFormats.js";
import { AP_TASK_KIND, monthShort, statusLabel, storeActionLabel, vendorLabel } from "./partsRecon.js";

// Parts Recon exports (migration 90).
//
// The tracker export is laid out exactly like management's shared
// tracker MONTHLY LOG (Month, Region, Location, Vendor, Status, Amount,
// Notes, Key), so its rows can be pasted over that month's block, or the
// file kept as the month's record. Amount = what's still left to deduct.

const money = (n) => (n === null || n === undefined || n === "" ? null : Number(n));

// "Sept auto-recon: ... | Portal 10/22: 12 of 14 ROs answered, $310.70 credited"
export function trackerNotes(line, asOf = new Date()) {
  const base = line.script_notes ?? "";
  if (!line.items) return base;
  const d = `${asOf.getMonth() + 1}/${asOf.getDate()}`;
  const answered = line.items - line.open_items;
  const parts = [`${answered} of ${line.items} item(s) answered`];
  if (Number(line.credited) > 0) parts.push(`$${Number(line.credited).toFixed(2)} credited`);
  if (line.to_review) parts.push(`${line.to_review} waiting on AP review`);
  return (base ? base + " | " : "") + `Portal ${d}: ` + parts.join(", ");
}

export async function exportTracker(month, lines) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("MONTHLY LOG");
  ws.columns = [
    { header: "Month", key: "month", width: 12 },
    { header: "Region", key: "region", width: 12 },
    { header: "Location", key: "loc", width: 18 },
    { header: "Vendor", key: "vendor", width: 20 },
    { header: "Status", key: "status", width: 22 },
    { header: "Amount", key: "amount", width: 13 },
    { header: "Notes", key: "notes", width: 90 },
    { header: "Key", key: "key", width: 36 },
  ];
  headerFill(ws.getRow(1));
  const [y, m] = String(month).split("-").map(Number);
  for (const l of lines) {
    const row = ws.addRow({
      month: new Date(Date.UTC(y, m - 1, 1)), region: l.region ?? "", loc: l.recon_store, vendor: l.vendor,
      status: l.status ?? "", amount: money(l.left_to_deduct), notes: trackerNotes(l), key: l.key,
    });
    row.getCell("month").numFmt = "yyyy-mm-dd";
    row.getCell("amount").numFmt = CURRENCY_FMT;
    applyBorders(row, 1, 8);
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: "A1", to: "H1" };
  downloadWorkbook(await wb.xlsx.writeBuffer(), `${monthShort(month)} Parts Recon Tracker.xlsx`);
}

// Every item with where it stands -- the Response Tracker's Items tab, plus
// the store's reply and AP's review.
export async function exportItems(month, items) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Items");
  ws.columns = [
    { header: "Store", key: "store", width: 16 }, { header: "Vendor", key: "vendor", width: 16 },
    { header: "RO #", key: "ro", width: 11 }, { header: "Vendor invoice(s)", key: "inv", width: 24 },
    { header: "Amount in question", key: "amount", width: 13 }, { header: "What we asked", key: "asked", width: 48 },
    { header: "Why", key: "why", width: 60 }, { header: "Status", key: "status", width: 22 },
    { header: "Store reply", key: "reply", width: 40 }, { header: "Replied", key: "replied", width: 18 },
    { header: "Credit #", key: "cno", width: 14 }, { header: "Credit $", key: "camt", width: 11 },
    { header: "AP note", key: "apnote", width: 40 }, { header: "Left to deduct", key: "left", width: 13 },
  ];
  headerFill(ws.getRow(1));
  for (const i of items) {
    const reply = [storeActionLabel(i.store_action), i.store_credit_no && `credit # ${i.store_credit_no}`,
      i.store_credit_amt !== null && i.store_credit_amt !== undefined && `$${Number(i.store_credit_amt).toFixed(2)}`, i.store_note]
      .filter(Boolean).join(" - ");
    const row = ws.addRow({
      store: i.recon_store, vendor: vendorLabel(i.vendor), ro: i.ro ?? "", inv: i.invoices ?? "", amount: money(i.amount),
      asked: i.asked ?? "", why: i.why ?? "", status: statusLabel(i.status), reply,
      replied: i.answered_at ? `${new Date(i.answered_at).toLocaleDateString()} ${i.answered_by_name ?? ""}`.trim() : "",
      cno: i.credit_no ?? "", camt: money(i.credit_amt), apnote: i.ap_note ?? "", left: money(i.left_to_deduct),
    });
    row.getCell("ro").numFmt = TEXT_FMT;
    for (const k of ["amount", "camt", "left"]) row.getCell(k).numFmt = CURRENCY_FMT;
    for (const k of ["asked", "why", "reply", "apnote"]) row.getCell(k).alignment = { wrapText: true, vertical: "top" };
    applyBorders(row, 1, 14);
  }
  ws.views = [{ state: "frozen", ySplit: 1, xSplit: 3 }];
  ws.autoFilter = { from: "A1", to: "N1" };
  downloadWorkbook(await wb.xlsx.writeBuffer(), `${monthShort(month)} Parts Recon Items.xlsx`);
}

export async function exportTasks(month, tasks) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("AP To-Do");
  ws.columns = [
    { header: "Store", key: "store", width: 18 }, { header: "Vendor", key: "vendor", width: 18 },
    { header: "Type", key: "kind", width: 22 }, { header: "What to do", key: "task", width: 60 },
    { header: "Invoice #", key: "inv", width: 18 }, { header: "PO / RO #", key: "po", width: 14 },
    { header: "Date", key: "date", width: 11 }, { header: "Statement amount", key: "stmt", width: 14 },
    { header: "AP amount", key: "ap", width: 12 }, { header: "Detail", key: "detail", width: 42 },
    { header: "Done", key: "done", width: 20 }, { header: "Note", key: "note", width: 30 },
  ];
  headerFill(ws.getRow(1));
  for (const t of tasks) {
    const row = ws.addRow({
      store: t.recon_store, vendor: vendorLabel(t.vendor), kind: AP_TASK_KIND[t.kind] ?? t.kind, task: t.task,
      inv: t.invoice ?? "", po: t.po ?? "", date: t.txn_date ?? "", stmt: money(t.stmt_amount), ap: money(t.ap_amount),
      detail: t.detail ?? "", done: t.done_at ? `${new Date(t.done_at).toLocaleDateString()} ${t.done_by_name ?? ""}`.trim() : "",
      note: t.note ?? "",
    });
    for (const k of ["inv", "po"]) row.getCell(k).numFmt = TEXT_FMT;
    for (const k of ["stmt", "ap"]) row.getCell(k).numFmt = CURRENCY_FMT;
    applyBorders(row, 1, 12);
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: "A1", to: "L1" };
  downloadWorkbook(await wb.xlsx.writeBuffer(), `${monthShort(month)} Parts Recon AP To-Do.xlsx`);
}

// The Deduction Report (lib/partsReconDeduction.js): a Summary sheet, one
// row per store with the Tracker alongside, and a Detail sheet of every
// line with something left to deduct -- the same rows as the screen.
export async function exportDeductionReport(monthRow, report, storeKey = "") {
  const month = monthRow.month;
  const stores = storeKey ? report.stores.filter((s) => s.key === storeKey) : report.stores;
  const wb = new ExcelJS.Workbook();

  const sum = wb.addWorksheet("Summary");
  sum.columns = [
    { header: "Store #", key: "num", width: 9 }, { header: "Store", key: "store", width: 22 },
    { header: "Lines", key: "count", width: 8 }, { header: "Left to deduct", key: "left", width: 15 },
    { header: "Tracker left to deduct", key: "tracker", width: 15 }, { header: "Difference", key: "diff", width: 12 },
  ];
  headerFill(sum.getRow(1));
  for (const s of stores) {
    const row = sum.addRow({ num: s.storeNumber ?? "", store: s.name, count: s.count, left: s.left, tracker: s.trackerLeft, diff: s.diff });
    row.getCell("num").numFmt = TEXT_FMT;
    for (const k of ["left", "tracker", "diff"]) row.getCell(k).numFmt = CURRENCY_FMT;
    applyBorders(row, 1, 6);
  }
  const add = (k) => Math.round(stores.reduce((a, s) => a + s[k], 0) * 100) / 100;
  const total = sum.addRow({ num: "", store: "TOTAL", count: stores.reduce((a, s) => a + s.count, 0),
    left: add("left"), tracker: add("trackerLeft"), diff: add("diff") });
  total.font = { bold: true };
  for (const k of ["left", "tracker", "diff"]) total.getCell(k).numFmt = CURRENCY_FMT;
  applyBorders(total, 1, 6);
  sum.addRow([]);
  sum.addRow([monthRow.closed_at
    ? `${monthRow.label}: closed ${new Date(monthRow.closed_at).toLocaleDateString()}${monthRow.closed_by_name ? ` by ${monthRow.closed_by_name}` : ""}.`
    : `${monthRow.label}: OPEN. These figures can still change until AP closes the month.`]);
  sum.addRow([`Exported ${new Date().toLocaleString()}.`]);
  sum.views = [{ state: "frozen", ySplit: 1 }];

  const det = wb.addWorksheet("Detail");
  det.columns = [
    { header: "Store #", key: "num", width: 9 }, { header: "Store", key: "store", width: 18 },
    { header: "Kind", key: "kind", width: 22 }, { header: "Vendor", key: "vendor", width: 18 },
    { header: "RO #", key: "ro", width: 12 }, { header: "Invoices", key: "inv", width: 28 },
    { header: "Status", key: "status", width: 22 }, { header: "Item amount", key: "amount", width: 13 },
    { header: "AP credit $", key: "credit", width: 12 }, { header: "Left to deduct", key: "left", width: 14 },
  ];
  headerFill(det.getRow(1));
  for (const s of stores) {
    for (const l of s.lines) {
      const row = det.addRow({
        num: s.storeNumber ?? "", store: s.name, kind: l.kindLabel, vendor: vendorLabel(l.vendor), ro: l.ro ?? "",
        inv: l.invoices ?? "", status: l.status ? statusLabel(l.status) : "", amount: money(l.amount), credit: money(l.credit), left: money(l.left),
      });
      for (const k of ["num", "ro", "inv"]) row.getCell(k).numFmt = TEXT_FMT;
      for (const k of ["amount", "credit", "left"]) row.getCell(k).numFmt = CURRENCY_FMT;
      applyBorders(row, 1, 10);
    }
  }
  det.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
  det.autoFilter = { from: "A1", to: "J1" };

  const scope = storeKey && stores[0] ? ` ${stores[0].name}` : "";
  downloadWorkbook(await wb.xlsx.writeBuffer(), `${monthShort(month)} Parts Recon Deductions${scope}.xlsx`);
}
