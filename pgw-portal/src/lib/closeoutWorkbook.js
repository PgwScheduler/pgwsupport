import ExcelJS from "exceljs";
import { buildCloseoutRows, round2 } from "./closeoutRows.js";
import { computeTotals } from "./drawerMath.js";
import { CURRENCY_FMT, QTY_FMT, TEXT_FMT } from "./excelFormats.js";

// Multi-store workbook: a Summary sheet plus one sheet per closeout, all built
// from the same buildCloseoutRows() the single-store CSV uses. Each `closeout`
// here is a cash_drawer_closeouts row augmented with:
//   .store = { store_number, name, drawer_float }  (from the joined location)
//   .submitted_by_name                             (joined from profiles)

const GOLD = "FFF5A623"; // matches T.accent (#F5A623)
const HDR = "FFEDEDED";

// Thin gridline drawn around every populated cell so the sheet prints cleanly.
const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const applyBorders = (row, from, to) => {
  for (let c = from; c <= to; c++) row.getCell(c).border = BOX;
};
// 1-based index of the last non-empty cell in a padded row (0 = all empty).
const lastFilledCol = (cells) => {
  let last = 0;
  cells.forEach((v, i) => {
    if (v !== "" && v !== null && v !== undefined) last = i + 1;
  });
  return last;
};
// 1-based index of the last cell carrying a format token. Lets a table row keep
// its full-width border even when trailing cells are blank (e.g. an unused
// denomination row still spans all four qty/amount columns).
const lastFmtCol = (fmts) => {
  let last = 0;
  fmts.forEach((f, i) => {
    if (f) last = i + 1;
  });
  return last;
};

// The number format Excel should apply for a given cell token (null = none).
const numFmtFor = (fmt) =>
  fmt === "money" ? CURRENCY_FMT : fmt === "qty" ? QTY_FMT : fmt === "text" ? TEXT_FMT : null;

// Coerce a raw cell value to what Excel should store for its token: money/qty as
// real numbers (blank stays blank, never 0), text as a string so leading zeros
// survive, everything else untouched.
const cellValue = (v, fmt) => {
  const empty = v === "" || v === null || v === undefined;
  if (fmt === "money" || fmt === "qty") return empty ? null : Number(v);
  if (fmt === "text") return empty ? null : String(v);
  return v;
};

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
    const row = ws.addRow(r.cells.map((v, i) => cellValue(v, r.fmts[i])));
    const n = row.number;
    // numFmt is set per cell (not per column) because a single column carries
    // qty in the drawer table and money in the deposit table below it.
    r.fmts.forEach((f, i) => {
      const nf = numFmtFor(f);
      if (nf) row.getCell(i + 1).numFmt = nf;
    });
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
    if (r.style !== "blank") {
      const merged = r.style === "title" || r.style === "sectionTitle";
      const to = merged ? 5 : Math.max(1, lastFilledCol(r.cells), lastFmtCol(r.fmts));
      applyBorders(row, 1, to);
    }
  }
}

// Summary sheet columns, in display order. `money` cells get the currency
// number format; `total` cells are summed into the grand-total row. Each value
// maps to a closeout field (see rowValuesFor) so the layout stays data-driven.
const SUMMARY_COLS = [
  { key: "storeNumber",   label: "Store #", width: 10 },
  { key: "storeName",     label: "Store Name", width: 28 },
  { key: "date",          label: "Date", width: 12 },
  { key: "cashToDeposit", label: "Total Cash to Deposit", money: true, total: true, width: 20 },
  { key: "totalSales",    label: "Total Sales", money: true, total: true, width: 16 },
  { key: "homeOffice",    label: "Total for Home Office", money: true, total: true, width: 20 },
  { key: "storeDeposit",  label: "Store Deposit to Bank", money: true, total: true, width: 20 },
  { key: "checks",        label: "Total Customer Checks", money: true, total: true, width: 20 },
  { key: "cards",         label: "Visa, Disc, Amex, Debit, MC", money: true, total: true, width: 24 },
  { key: "bread",         label: "Midas CC Totals (Bread)", money: true, total: true, width: 22 },
  { key: "americanFirst", label: "American First Totals", money: true, total: true, width: 20 },
  { key: "koalifi",       label: "Koalifi Totals", money: true, total: true, width: 16 },
  { key: "snap",          label: "Snap Totals", money: true, total: true, width: 14 },
  { key: "fleet",         label: "Charges / Fleet Invoices", money: true, total: true, width: 22 },
  { key: "overShort",     label: "Cash Over / Short", money: true, total: false, width: 18 },
];

// One closeout -> the value for each Summary column. The typed-in fields
// (checks/cards/bread/american_first/koalifi/snap) come straight off the row;
// fleet is the summed Charges/Fleet line items via computeTotals().fleetTotal.
function rowValuesFor(c) {
  const t = computeTotals(c, c.store.drawer_float);
  const n = (v) => round2(Number(v) || 0);
  return {
    storeNumber: c.store.store_number,
    storeName: c.store.name,
    date: fmtDate(c.business_date),
    cashToDeposit: round2(t.cashToDeposit),
    totalSales: round2(t.totalSales),
    homeOffice: round2(t.homeOffice),
    storeDeposit: round2(t.storeDeposit),
    checks: n(c.checks),
    cards: n(c.cards),
    bread: n(c.bread),
    americanFirst: n(c.american_first),
    koalifi: n(c.koalifi),
    snap: n(c.snap),
    fleet: round2(t.fleetTotal),
    overShort: round2(t.diff),
  };
}

function buildSummarySheet(ws, closeouts, { startDate, endDate, accessibleStores }) {
  const single = startDate === endDate;
  const nCols = SUMMARY_COLS.length;

  ws.mergeCells(1, 1, 1, nCols);
  ws.getCell("A1").value = single
    ? `PGW Cash Drawer Closeouts — ${fmtDate(startDate)}`
    : `PGW Cash Drawer Closeouts — ${fmtDate(startDate)} to ${fmtDate(endDate)}`;
  ws.getCell("A1").font = { bold: true, size: 14 };

  const hRow = ws.addRow(SUMMARY_COLS.map((c) => c.label));
  hRow.font = { bold: true };
  hRow.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } }));
  applyBorders(hRow, 1, nCols);

  const sorted = [...closeouts].sort(
    (a, b) => a.store.store_number.localeCompare(b.store.store_number) ||
      a.business_date.localeCompare(b.business_date));

  const totals = {};
  SUMMARY_COLS.forEach((c) => { if (c.total) totals[c.key] = 0; });

  for (const c of sorted) {
    const v = rowValuesFor(c);
    SUMMARY_COLS.forEach((col) => {
      if (col.total) totals[col.key] = round2(totals[col.key] + v[col.key]);
    });
    const row = ws.addRow(SUMMARY_COLS.map((col) => v[col.key]));
    applyBorders(row, 1, nCols);
  }

  const tRow = ws.addRow(SUMMARY_COLS.map((col, i) => {
    if (i === 1) return "TOTAL";
    return col.total ? totals[col.key] : "";
  }));
  tRow.font = { bold: true };
  applyBorders(tRow, 1, nCols);

  SUMMARY_COLS.forEach((col, i) => {
    const column = ws.getColumn(i + 1);
    column.width = col.width;
    if (col.money) column.numFmt = CURRENCY_FMT;
  });
  ws.views = [{ state: "frozen", ySplit: 2 }];

  // Stores the user can access but that have no closeout in the chosen range.
  const present = new Set(closeouts.map((c) => c.store.store_number));
  const missing = (accessibleStores || []).filter((s) => !present.has(s.storeNumber));
  if (missing.length) {
    ws.addRow([]);
    const mHead = ws.addRow(["Stores with no closeout in range"]);
    mHead.getCell(1).font = { bold: true, color: { argb: "FFB00020" } };
    for (const s of missing) {
      const row = ws.addRow([s.storeNumber, s.storeName]);
      applyBorders(row, 1, 2);
    }
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
