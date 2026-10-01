import ExcelJS from "exceljs";
import { downloadWorkbook } from "./excelStyle.js";
import { DIVISION_TOP, MEDALS, SUBTITLE_FONT, TITLE_FILL, periodLabels } from "./techRanks.js";

// =====================================================================
// Tech Ranks — the Excel export, laid out like "Tech ranks sept 2026.xlsx":
//
//   * five division blocks across the top (Rank | Name | Hrs Turned |
//     Hrs Worked | Proficiency, a spacer column between), heading merged
//     over Name..Proficiency, bold + underlined
//   * each division's stores listed under its block
//   * the navy "TOP 20 PGW TECHS - <PERIOD>" banner over the company
//     top 20, "Ranked by Hrs Turned" under it, and the "Techs in Top 20"
//     count by market beside it
//   * ranks 1-3 gold / silver / bronze, bold; proficiency 0%, and a live
//     =turned/worked formula as in the workbook
//
// Loaded on demand (TechRanksView imports it dynamically).
// =====================================================================

const FONT = { name: "Aptos Narrow", size: 11 };
const CENTER = { horizontal: "center", vertical: "middle" };
const THIN = { style: "thin" };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const argb = (hex) => "FF" + hex;

// Block start columns, as in the workbook: A, G, M, S, Y.
const BLOCK_STEP = 6;
const FIRST_RANK_ROW = 3;
const WIDTHS = { 1: 8.5, 2: 17, 3: 12, 4: 12, 5: 12 }; // within a block

function colLetter(n) {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function paintMedal(cells, rank) {
  const m = MEDALS[rank];
  if (!m) return;
  for (const c of cells) {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(m.fill) } };
    c.font = { ...FONT, bold: true, color: { argb: argb(m.font) } };
  }
}

const profFormula = (turnedRef, workedRef, value) =>
  ({ formula: `IF(${workedRef}>0,${turnedRef}/${workedRef},"")`, result: value ?? "" });

export function buildTechRanksWorkbook(report, { from, to }) {
  const period = periodLabels(from, to);
  const wb = new ExcelJS.Workbook();
  wb.creator = "PGW Support Portal";
  const ws = wb.addWorksheet("Tech Ranks");

  // ---- division blocks -----------------------------------------------
  report.divisions.forEach((d, i) => {
    const c0 = 1 + i * BLOCK_STEP; // rank column
    const [cRank, cName, cTurn, cWork, cProf] = [c0, c0 + 1, c0 + 2, c0 + 3, c0 + 4];
    for (let k = 0; k < 5; k++) ws.getColumn(c0 + k).width = WIDTHS[k + 1];

    ws.mergeCells(1, cName, 1, cProf);
    const h = ws.getCell(1, cName);
    h.value = d.label;
    h.font = { ...FONT, bold: true, underline: true };
    h.alignment = { horizontal: "center" };

    ["Name", "Hrs Turned", "Hrs Worked", "Proficiency"].forEach((t, k) => {
      const c = ws.getCell(2, cName + k);
      c.value = t;
      c.alignment = CENTER;
    });

    for (let n = 0; n < DIVISION_TOP; n++) {
      const r = FIRST_RANK_ROW + n;
      const t = d.top[n];
      const rank = ws.getCell(r, cRank);
      rank.value = n + 1;
      if (!t) continue;
      ws.getCell(r, cName).value = t.name;
      ws.getCell(r, cTurn).value = t.hoursTurned;
      ws.getCell(r, cWork).value = t.hoursWorked;
      ws.getCell(r, cProf).value = profFormula(`${colLetter(cTurn)}${r}`, `${colLetter(cWork)}${r}`, t.proficiency);
      ws.getCell(r, cTurn).numFmt = "0";
      ws.getCell(r, cWork).numFmt = "0";
      ws.getCell(r, cProf).numFmt = "0%";
      for (const c of [cName, cTurn, cWork, cProf]) ws.getCell(r, c).alignment = CENTER;
      paintMedal([cRank, cName, cTurn, cWork, cProf].map((c) => ws.getCell(r, c)), t.rank);
    }

    d.stores.forEach((s, k) => { ws.getCell(FIRST_RANK_ROW + DIVISION_TOP + 1 + k, cRank).value = s.name; });
  });

  // ---- company top 20 --------------------------------------------------
  const maxStores = Math.max(0, ...report.divisions.map((d) => d.stores.length));
  // Stores run from row 14 to 14 + maxStores - 1; the banner sits on the
  // next row (22 with eight stores, as in the workbook).
  const T = FIRST_RANK_ROW + DIVISION_TOP + 1 + maxStores;
  const [I, J, K, L, M, N, P, Q] = [9, 10, 11, 12, 13, 14, 16, 17];

  ws.mergeCells(T, I, T, N);
  const banner = ws.getCell(T, I);
  banner.value = `TOP 20 PGW TECHS - ${period.title}`;
  banner.font = { ...FONT, size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  banner.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(TITLE_FILL) } };
  banner.alignment = CENTER;
  ws.getRow(T).height = 27.95;

  ws.mergeCells(T + 1, I, T + 1, N);
  const sub = ws.getCell(T + 1, I);
  sub.value = "Ranked by Hrs Turned";
  sub.font = { ...FONT, bold: true, italic: true, color: { argb: argb(SUBTITLE_FONT) } };
  sub.alignment = CENTER;
  ws.getRow(T + 1).height = 20.1;

  const H = T + 2;
  ["Rank", "Name", "Market", "Hrs Turned", "Hrs Worked", "Proficiency"].forEach((t, k) => {
    const c = ws.getCell(H, I + k);
    c.value = t;
    c.alignment = CENTER;
  });
  report.top.forEach((t, n) => {
    const r = H + 1 + n;
    ws.getCell(r, I).value = t.rank;
    ws.getCell(r, J).value = t.name;
    ws.getCell(r, K).value = t.division;
    ws.getCell(r, L).value = t.hoursTurned;
    ws.getCell(r, M).value = t.hoursWorked;
    ws.getCell(r, N).value = profFormula(`${colLetter(L)}${r}`, `${colLetter(M)}${r}`, t.proficiency);
    ws.getCell(r, L).numFmt = "0";
    ws.getCell(r, M).numFmt = "0";
    ws.getCell(r, N).numFmt = "0%";
    for (let c = I; c <= N; c++) ws.getCell(r, c).alignment = CENTER;
    paintMedal([I, J, K, L, M, N].map((c) => ws.getCell(r, c)), t.rank);
  });

  // ---- techs in top 20, by market ---------------------------------------
  const countHead = period.short ? `Techs in ${period.short} Top 20` : "Techs in Top 20";
  [[P, "Market"], [Q, countHead]].forEach(([c, v]) => {
    const cell = ws.getCell(H, c);
    cell.value = v;
    cell.font = { ...FONT, bold: true };
    cell.alignment = CENTER;
    cell.border = BOX;
  });
  report.counts.forEach((m, n) => {
    for (const [c, v] of [[P, m.label], [Q, m.count]]) {
      const cell = ws.getCell(H + 1 + n, c);
      cell.value = v;
      cell.alignment = CENTER;
      cell.border = BOX;
    }
  });

  // The top-20 columns sit inside division blocks; widen them for the
  // names and market labels they hold, as the workbook does.
  ws.getColumn(J).width = 20;
  ws.getColumn(K).width = 27.5;
  ws.getColumn(N).width = 20.5;
  ws.getColumn(P).width = 23.5;
  ws.getColumn(Q).width = 22;

  ws.eachRow((row) => row.eachCell((cell) => { if (!cell.font?.name) cell.font = { ...FONT, ...(cell.font ?? {}) }; }));
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
  return wb;
}

export async function downloadTechRanksWorkbook(report, range) {
  const wb = buildTechRanksWorkbook(report, range);
  const buf = await wb.xlsx.writeBuffer();
  const p = periodLabels(range.from, range.to);
  downloadWorkbook(buf, `Tech Ranks ${p.short ? p.long : `${range.from} to ${range.to}`}.xlsx`);
}
