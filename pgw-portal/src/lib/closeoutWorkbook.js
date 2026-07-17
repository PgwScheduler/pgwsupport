import ExcelJS from "exceljs";
import { buildCloseoutRows, round2 } from "./closeoutRows.js";
import { computeTotals } from "./drawerMath.js";

// Multi-store workbook: a Summary sheet plus one sheet per closeout, all built
// from the same buildCloseoutRows() the single-store CSV uses. Each `closeout`
// here is a cash_drawer_closeouts row augmented with:
//   .store = { store_number, name, drawer_float }  (from the joined location)
//   .submitted_by_name                             (joined from profiles)

const GOLD = "FFF5A623"; // matches T.accent (#F5A623)
const HDR = "FFEDEDED";

const fmtDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${m}/${d}/${y}`;
};

// Excel tab names: max 31 chars, no : \ / ? * [ ], must be unique.
function sheetNameFor(c, singleDate) {
  const [, m, d] = String(c.business_date).slice(0, 10).split("-").map(Number);
  const base = singleDate ? `${c.store.store_number}` : `${c.store.store_number} ${m}-${d}`;
  return base.replace(/[:\\/?*[\]]/g, "").slice(0, 31);
}

function uniqueName(name, used) {
  let n = name, i = 2;
  while (used.has(n)) {
    const suffix = `-${i++}`;
    n = name.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(n);
  return n;
}

function renderCloseoutSheet(ws, c) {
  ws.columns = [{ width: 34 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }];
  for (const r of buildCloseoutRows(c, c.store)) {
    const row = ws.addRow(r.cells.map((v) => (typeof v === "number" ? round2(v) : v)));
    const n = row.number;
    if (r.style === "title") {
      ws.mergeCells(n, 1, n, 5);
      row.getCell(1).font = { bold: true, size: 14 };
    } else if (r.style === "sectionTitle") {
      ws.mergeCells(n, 1, n, 5);
      row.getCell(1).font = { bold: true, color: { argb: "FF000000" } };
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } };
    } else if (r.style === "columnHeader") {
      row.font = { bold: true };
      row.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HDR } }));
    } else if (r.style === "meta") {
      row.getCell(1).font = { bold: true };
    } else if (r.style === "total") {
      row.eachCell((cell) => (cell.font = { bold: true }));
    }
  }
}

function buildSummarySheet(ws, closeouts, { startDate, endDate, accessibleStores }) {
  const single = startDate === endDate;
  ws.mergeCells("A1:H1");
  ws.getCell("A1").value = single
    ? `PGW Cash Drawer Closeouts — ${fmtDate(startDate)}`
    : `PGW Cash Drawer Closeouts — ${fmtDate(startDate)} to ${fmtDate(endDate)}`;
  ws.getCell("A1").font = { bold: true, size: 14 };

  const cols = ["Store #", "Store Name", "Date", "Total Cash to Deposit", "Total Sales",
    "Total for Home Office", "Store Deposit to Bank", "Cash Over / Short"];
  const hRow = ws.addRow(cols);
  hRow.font = { bold: true };
  hRow.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } }));

  const sorted = [...closeouts].sort(
    (a, b) => a.store.store_number.localeCompare(b.store.store_number) ||
      a.business_date.localeCompare(b.business_date));

  const totals = [0, 0, 0, 0];
  for (const c of sorted) {
    const t = computeTotals(c, c.store.drawer_float);
    const vals = [round2(t.cashToDeposit), round2(t.totalSales), round2(t.homeOffice), round2(t.storeDeposit)];
    vals.forEach((v, i) => (totals[i] = round2(totals[i] + v)));
    ws.addRow([c.store.store_number, c.store.name, fmtDate(c.business_date), ...vals, round2(t.diff)]);
  }
  const tRow = ws.addRow(["", "TOTAL", "", ...totals, ""]);
  tRow.font = { bold: true };

  ["D", "E", "F", "G", "H"].forEach((col) => {
    ws.getColumn(col).numFmt = "#,##0.00";
    ws.getColumn(col).width = 20;
  });
  ws.getColumn("A").width = 10;
  ws.getColumn("B").width = 28;
  ws.getColumn("C").width = 12;
  ws.views = [{ state: "frozen", ySplit: 2 }];

  // Stores the user can access but that have no closeout in the chosen range.
  const present = new Set(closeouts.map((c) => c.store.store_number));
  const missing = (accessibleStores || []).filter((s) => !present.has(s.storeNumber));
  if (missing.length) {
    ws.addRow([]);
    const mHead = ws.addRow(["Stores with no closeout in range"]);
    mHead.getCell(1).font = { bold: true, color: { argb: "FFB00020" } };
    for (const s of missing) ws.addRow([s.storeNumber, s.storeName]);
  }
}

export async function exportAllCloseoutsWorkbook(closeouts, { startDate, endDate, accessibleStores = [] }) {
  const single = startDate === endDate;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  buildSummarySheet(wb.addWorksheet("Summary"), closeouts, { startDate, endDate, accessibleStores });

  const used = new Set();
  const sorted = [...closeouts].sort(
    (a, b) => a.store.store_number.localeCompare(b.store.store_number) ||
      a.business_date.localeCompare(b.business_date));
  for (const c of sorted) {
    renderCloseoutSheet(wb.addWorksheet(uniqueName(sheetNameFor(c, single), used)), c);
  }

  const buf = await wb.xlsx.writeBuffer();
  const fname = single
    ? `PGW_all_closeouts_${startDate}.xlsx`
    : `PGW_all_closeouts_${startDate}_to_${endDate}.xlsx`;

  // Trigger the browser download when running in the app; no-op under Node.
  if (typeof document !== "undefined") {
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return { buffer: buf, filename: fname };
}
