import ExcelJS from "exceljs";
import { GOLD, applyBorders, downloadWorkbook, headerFill, subHeaderFill } from "./excelStyle.js";
import { excelValue, numFmtFor, sheetName } from "./reportSpec.js";
import { indexRules, matchRule, tokenArgb } from "./reportFormat.js";

// =====================================================================
// The Report Builder's workbook.
//
// STYLING is the cash drawer export's, not a lookalike: GOLD, the thin
// print border and the currency-with-a-dash-for-zero format all come
// from excelStyle.js / excelFormats.js, which closeoutWorkbook.js reads
// too. Retune the accent once and both workbooks follow.
//
// SHAPE follows the same rule as the cash drawer export — a Summary
// sheet plus one sheet per store — but only when a per-store sheet has
// something to say. Grouped by store across several stores, each store
// gets a tab holding its own days, so the summary answers "how did my
// stores compare" and the tab answers "what happened at this one". One
// store, or a grouping that is already per period, gets the Summary
// sheet alone: eleven tabs each holding a single row is not a workbook,
// it is a filing cabinet.
//
// NUMBERS are written as numbers. A money or ratio value coerced to a
// string looks identical on screen and silently ignores the number
// format, so every cell goes through excelValue() and null stays null —
// an absent ratio must be an empty cell, never a zero someone averages.
// =====================================================================

const fmtDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${m}/${d}/${y}`;
};

// Wide enough for the label, wider for money columns that can carry
// "-$1,234,567.89", and never so wide that a category name pushes the
// next column off the page.
const widthFor = (col) => Math.min(34, Math.max(col.kind === "money" || col.kind === "rate" ? 16 : 12, col.label.length + 3));

function writeTable(ws, { title, subtitle, firstColLabel, firstColWidth, columns, rows, rules, unavailable }) {
  const nCols = columns.length + 1;
  const idx = indexRules(rules ?? []);
  const gone = new Set(unavailable ?? []);

  ws.mergeCells(1, 1, 1, nCols);
  ws.getCell("A1").value = title;
  ws.getCell("A1").font = { bold: true, size: 14 };

  if (subtitle) {
    ws.mergeCells(2, 1, 2, nCols);
    ws.getCell("A2").value = subtitle;
    ws.getCell("A2").font = { size: 10, color: { argb: "FF666666" } };
  }
  ws.addRow([]);

  // A column reading the other window says so in the header, exactly as
  // it does on screen. Two windows side by side with identical-looking
  // headers is how somebody quotes yesterday's number as the month's.
  const hRow = ws.addRow([
    firstColLabel,
    ...columns.map((c) =>
      c.label + (c.altWindow ? ` (${c.altWindow})` : "") + (gone.has(c.key) ? " (no 2025 data)" : "")),
  ]);
  headerFill(hRow);
  hRow.alignment = { wrapText: true, vertical: "bottom", horizontal: "right" };
  applyBorders(hRow, 1, nCols);
  const headerRowNumber = hRow.number;

  rows.forEach((r, i) => {
    const rank = r.is_total ? 0 : i + 1;
    const row = ws.addRow([
      r.bucket_label,
      ...columns.map((c) => {
        if (gone.has(c.key)) return "n/a";
        const raw = r.measures?.[c.key];
        const rule = matchRule(idx.for(c.key), c.key, raw, { rank });
        // A rule's label REPLACES the value — BOOM! is a string in a
        // money column, and that is correct: the number stopped being
        // the point once the tier was cleared.
        return rule?.label ?? excelValue(raw);
      }),
    ]);

    // Fills are applied per CELL, because a rule matches a value rather
    // than a column, and the same column can carry three different bands.
    columns.forEach((c, j) => {
      if (gone.has(c.key)) return;
      const rule = matchRule(idx.for(c.key), c.key, r.measures?.[c.key], { rank });
      const argb = rule ? tokenArgb(rule.color_token) : null;
      if (argb) row.getCell(j + 2).fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    });

    if (r.is_total) {
      // The total row is computed by report_build() over the whole set,
      // not summed down the column — a capture rate cannot be added up.
      // It is bolded and banded so nobody mistakes it for another store.
      subHeaderFill(row);
    }
    applyBorders(row, 1, nCols);
  });

  ws.getColumn(1).width = firstColWidth;
  columns.forEach((c, i) => {
    const column = ws.getColumn(i + 2);
    column.width = widthFor(c);
    const nf = numFmtFor(c.kind);
    if (nf) column.numFmt = nf;
    column.alignment = { horizontal: "right" };
  });
  ws.getColumn(1).alignment = { horizontal: "left" };
  // Freeze the title block and the header so a 5,000-row report still
  // tells you which column you are reading at row 4,000.
  ws.views = [{ state: "frozen", ySplit: headerRowNumber }];
}

function appendMissingStores(ws, nCols, missingStores) {
  if (!missingStores?.length) return;
  ws.addRow([]);
  const head = ws.addRow(["Selected stores with no data in this range"]);
  head.getCell(1).font = { bold: true, color: { argb: "FFB00020" } };
  for (const s of missingStores) {
    const row = ws.addRow([`#${s.store_number}`, s.name]);
    applyBorders(row, 1, 2);
  }
}

export async function exportReportWorkbook({
  columns = [],
  rows = [],
  perStoreRows = null,
  stores = [],
  missingStores = [],
  rules = [],
  unavailable = [],
  meta = {},
}) {
  const { from, to, groupByLabel = "Group", rangeLabel = "", altLabel = null, sort = null } = meta;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const scope =
    stores.length === 1
      ? `#${stores[0].store_number} · ${stores[0].name}`
      : `${stores.length} stores`;
  const subtitle = [
    `${fmtDate(from)} – ${fmtDate(to)}`,
    rangeLabel,
    scope,
    `Grouped by ${groupByLabel.toLowerCase()}`,
    sort ? `Sorted by ${sort.measure} ${sort.dir === "desc" ? "high to low" : "low to high"}` : null,
    altLabel ? `Columns marked with a window read ${altLabel}` : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  const summary = wb.addWorksheet("Summary");
  writeTable(summary, {
    title: `PGW Report — by ${groupByLabel.toLowerCase()}`,
    subtitle,
    firstColLabel: groupByLabel,
    firstColWidth: 30,
    columns,
    rows,
    rules,
    unavailable,
  });
  appendMissingStores(summary, columns.length + 1, missingStores);

  // Per-store tabs. perStoreRows is the same report re-run by day with
  // one row per store, so a tab is a filter of it rather than a second,
  // differently-derived answer.
  if (perStoreRows?.length) {
    const byStore = new Map();
    for (const r of perStoreRows) {
      if (!r.store_id) continue;
      if (!byStore.has(r.store_id)) byStore.set(r.store_id, []);
      byStore.get(r.store_id).push(r);
    }
    const used = new Set(["Summary"]);
    const ordered = [...stores].sort((a, b) =>
      String(a.store_number ?? "").localeCompare(String(b.store_number ?? ""))
    );
    for (const s of ordered) {
      const storeRows = byStore.get(s.id);
      if (!storeRows?.length) continue;
      const ws = wb.addWorksheet(sheetName(String(s.store_number ?? s.name), used));
      writeTable(ws, {
        title: `#${s.store_number} · ${s.name}`,
        subtitle: `${fmtDate(from)} – ${fmtDate(to)}  ·  Grouped by day`,
        firstColLabel: "Day",
        firstColWidth: 16,
        columns,
        rows: storeRows,
        rules,
        unavailable,
      });
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const fname = `PGW_report_${meta.groupBy ?? "report"}_${from}_to_${to}.xlsx`;
  downloadWorkbook(buf, fname);
  return { buffer: buf, filename: fname };
}

export { GOLD };
