import ExcelJS from "exceljs";
import { downloadWorkbook } from "./excelStyle.js";
import { PALETTE } from "./scorecardRules.js";
import { CLOSE, unitsKey } from "./whoSoldWhat.js";

// =====================================================================
// Who Sold What — the Excel export, in the shape of Matt's template:
// three sections side by side (store, cars, a column per service, the
// average of 5, rank, then last month), a goal row under the headers,
// and the unit counts on their own "Counts" tab.
//
// LIVE, like his sheet: a % cell is =count/cars reading the Counts tab
// (his L4 = L25/H4), the average is =(a+b+c+d+e)/5, the rank is =RANK(),
// and the colours are conditional-formatting rules against the goal row
// -- so correcting a count or a goal in the file recalculates and
// recolours it. A store with no tic sheets gets blank cells, never a
// formula that would divide by zero, and so is never ranked or coloured.
//
// Loaded on demand (WhoSoldWhatView imports it dynamically).
// =====================================================================

const FONT = { name: "Calibri", size: 11 };
const PCT0 = "0%";
const PCT1 = "0.0%";
const DEC1 = "0.0";
const INT = "#,##0";

export function colLetter(n) { // 1 -> A
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const monthLabel = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

// Green at goal, amber from CLOSE x goal, red below; blanks never coloured.
function bandRules(ref, cell, goalCell) {
  const style = (t) => ({
    fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF" + PALETTE[t].fill } },
    font: { color: { argb: "FF" + PALETTE[t].font } },
  });
  const has = `AND(ISNUMBER(${cell}),ISNUMBER(${goalCell}),${goalCell}>0)`;
  return {
    ref,
    rules: [
      { type: "expression", formulae: [`AND(${has},${cell}>=${goalCell})`], style: style("green"), priority: 1 },
      { type: "expression", formulae: [`AND(${has},${cell}<${goalCell},${cell}>=${goalCell}*${CLOSE})`], style: style("yellow"), priority: 2 },
      { type: "expression", formulae: [`AND(${has},${cell}<${goalCell}*${CLOSE})`], style: style("red"), priority: 3 },
    ],
  };
}

export function buildWhoSoldWhatWorkbook(report) {
  const { built, goals, month, prevMonth } = report;
  const wb = new ExcelJS.Workbook();
  wb.creator = "PGW Support Portal";

  // Store rows in market order; the pooled total is written separately.
  const stores = built.groups.flatMap((g) => g.rows);

  // ---- Counts tab: the raw numbers every formula reads ----------------
  const cs = wb.addWorksheet("Counts", { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  // Raw units here, so "LOF / day" is just "LOF".
  const countCols = ["Store", "Market", "Cars", "Days entered", "Sales", ...goals.map((g) => g.label.replace(/ \/ day$/, ""))];
  cs.addRow(countCols).font = { ...FONT, bold: true };
  const C_CARS = 3, C_DAYS = 4, C_SALES = 5;
  const countColOf = Object.fromEntries(goals.map((g, i) => [g.service_key, 6 + i]));
  const countRowOf = {};
  const marketName = Object.fromEntries(built.groups.map((g) => [g.market.id, g.market.name]));
  stores.forEach((s, i) => {
    const r = i + 2;
    countRowOf[s.id] = r;
    const m = s.raw.cur;
    const entered = !!s.cur;
    cs.addRow([
      s.name, marketName[s.marketId] ?? "",
      entered ? Number(m.ro_count) : null, entered ? Number(m.days_with_data ?? 0) : null,
      entered ? Number(m.gross_sales ?? 0) : null,
      ...goals.map((g) => (entered ? Number(m[unitsKey(g.service_key)] ?? 0) : null)),
    ]);
  });
  const cFirst = 2, cLast = stores.length + 1;
  cs.getColumn(1).width = 20; cs.getColumn(2).width = 18;
  for (let c = 3; c <= countCols.length; c++) cs.getColumn(c).width = 11;
  cs.getColumn(C_SALES).numFmt = '"$"#,##0';
  const cRef = (col, row) => `Counts!$${colLetter(col)}$${row}`;
  const cSum = (col) => `SUM(Counts!$${colLetter(col)}$${cFirst}:$${colLetter(col)}$${cLast})`;

  // ---- Main sheet ------------------------------------------------------
  const ws = wb.addWorksheet("Who Sold What", { views: [{ state: "frozen", ySplit: 4 }] });
  ws.getCell("A1").value = `Who Sold What — ${monthLabel(month)} (compared with ${monthLabel(prevMonth)})`;
  ws.getCell("A1").font = { ...FONT, bold: true, size: 14 };

  const HDR_ROW = 3, GOAL_ROW = 4, FIRST = 5;
  const LAST = FIRST + stores.length - 1;
  const TOTAL_ROW = LAST + 2;
  let col = 1;

  for (const sec of built.sections) {
    const start = col;
    const cStore = col++, cCars = col++;
    const svcCol = {};
    for (const g of sec.cols) svcCol[g.service_key] = col++;
    const cAvg = col++, cRank = col++, cPrev = col++, cChg = col++;

    ws.getCell(2, start).value = sec.title;
    ws.getCell(2, start).font = { ...FONT, bold: true, size: 12 };
    const heads = { [cStore]: "Store", [cCars]: "Cars", [cAvg]: `Avg of ${sec.avgCount}`, [cRank]: "Rank",
      [cPrev]: `${monthLabel(prevMonth).split(" ")[0]} avg`, [cChg]: "Change" };
    for (const g of sec.cols) heads[svcCol[g.service_key]] = g.label;
    for (const [c, label] of Object.entries(heads)) {
      const cell = ws.getCell(HDR_ROW, Number(c));
      cell.value = label;
      cell.font = { ...FONT, bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } };
      cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
    }
    ws.getCell(GOAL_ROW, cStore).value = sec.cols.some((g) => g.measure === "per_day") ? "Goal (% of cars; LOF per day)" : "% of Cars Goal";
    ws.getCell(GOAL_ROW, cStore).font = { ...FONT, italic: true };
    for (const g of sec.cols) {
      const cell = ws.getCell(GOAL_ROW, svcCol[g.service_key]);
      cell.value = g.goal;
      cell.numFmt = g.measure === "pct" ? PCT0 : DEC1;
      cell.font = { ...FONT, italic: true };
    }
    const avgCols = sec.cols.filter((g) => g.in_average).map((g) => colLetter(svcCol[g.service_key]));
    const avgGoal = ws.getCell(GOAL_ROW, cAvg);
    avgGoal.value = avgCols.length ? { formula: `(${avgCols.map((c) => `${c}${GOAL_ROW}`).join("+")})/${avgCols.length}` } : null;
    avgGoal.numFmt = PCT1; avgGoal.font = { ...FONT, italic: true };

    const writeRow = (r, row, { countsRow = null, pooled = false } = {}) => {
      const nameCell = ws.getCell(r, cStore);
      nameCell.value = row.name;
      nameCell.font = { ...FONT, bold: true, color: row.font ? { argb: "FF" + row.font } : undefined };
      if (row.fill && !pooled) nameCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + row.fill } };
      if (!row.cur) return; // not entered: blanks, never a divide-by-zero formula
      const cars = pooled ? cSum(C_CARS) : cRef(C_CARS, countsRow);
      const days = pooled ? cSum(C_DAYS) : cRef(C_DAYS, countsRow);
      ws.getCell(r, cCars).value = { formula: cars, result: row.cur.cars };
      ws.getCell(r, cCars).numFmt = INT;
      for (const g of sec.cols) {
        const u = pooled ? cSum(countColOf[g.service_key]) : cRef(countColOf[g.service_key], countsRow);
        const cell = ws.getCell(r, svcCol[g.service_key]);
        const result = row.cur.values[g.service_key];
        cell.value = g.measure === "pct" ? { formula: `${u}/${cars}`, result }
          : g.measure === "per_day" ? { formula: `IF(${days}>0,${u}/${days},"")`, result }
          : { formula: u, result };
        cell.numFmt = g.measure === "pct" ? PCT0 : g.measure === "per_day" ? DEC1 : INT;
      }
      const avg = ws.getCell(r, cAvg);
      avg.value = avgCols.length ? { formula: `(${avgCols.map((c) => `${c}${r}`).join("+")})/${avgCols.length}`, result: row.cur.avg[sec.section] } : null;
      avg.numFmt = PCT1;
      avg.font = { ...FONT, bold: true };
      const prevAvg = row.prev?.avg[sec.section];
      if (prevAvg !== null && prevAvg !== undefined) {
        ws.getCell(r, cPrev).value = prevAvg;
        ws.getCell(r, cPrev).numFmt = PCT1;
        ws.getCell(r, cChg).value = { formula: `${colLetter(cAvg)}${r}-${colLetter(cPrev)}${r}`, result: row.delta?.[sec.section] ?? null };
        ws.getCell(r, cChg).numFmt = '+0.0%;-0.0%;0.0%';
      }
    };

    stores.forEach((s, i) => {
      const r = FIRST + i;
      writeRow(r, s, { countsRow: countRowOf[s.id] });
      if (s.cur) {
        const a = colLetter(cAvg);
        ws.getCell(r, cRank).value = { formula: `RANK(${a}${r},$${a}$${FIRST}:$${a}$${LAST})`, result: s.rank?.[sec.section] ?? null };
      }
    });
    writeRow(TOTAL_ROW, built.total, { pooled: true });
    for (let c = start; c <= cChg; c++) ws.getCell(TOTAL_ROW, c).font = { ...FONT, bold: true };

    // Live colour rules on the store rows (totals stay plain).
    if (stores.length) {
      for (const g of sec.cols) {
        if (g.goal === null) continue;
        const L = colLetter(svcCol[g.service_key]);
        ws.addConditionalFormatting(bandRules(`${L}${FIRST}:${L}${LAST}`, `${L}${FIRST}`, `${L}$${GOAL_ROW}`));
      }
      if (avgCols.length) {
        const A = colLetter(cAvg);
        ws.addConditionalFormatting(bandRules(`${A}${FIRST}:${A}${LAST}`, `${A}${FIRST}`, `${A}$${GOAL_ROW}`));
      }
    }

    ws.getColumn(cStore).width = 18;
    for (let c = cCars; c <= cChg; c++) ws.getColumn(c).width = 9.5;
    col = cChg + 2; // a spacer column between sections, as in the template
  }
  ws.getRow(HDR_ROW).height = 30;
  ws.eachRow((row) => row.eachCell((cell) => { if (!cell.font?.name) cell.font = { ...FONT, ...(cell.font ?? {}) }; }));
  return wb;
}

export async function downloadWhoSoldWhatWorkbook(report) {
  const wb = buildWhoSoldWhatWorkbook(report);
  const buf = await wb.xlsx.writeBuffer();
  downloadWorkbook(buf, `Who Sold What ${report.month}.xlsx`);
}
