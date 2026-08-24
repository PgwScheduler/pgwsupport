// Employee Schedule -> Excel. A month grid, one row band per calendar week,
// with each shift on its own line inside the day cell.
//
// COLOUR: the fill comes from shift_types.export_argb, NOT from the screen
// token. The two palettes cannot be the same. Screen tokens are tuned to
// clear WCAG AA against near-black (#0B0B0C); these workbooks are
// deliberately light with black text, the house rule stated in index.css
// ("The Excel export code is intentionally NOT themed from here"). A colour
// legible on near-black is illegible as a fill behind black text, so each
// catalog row carries a pale print fill alongside its screen token.
//
// Colour is never the only signal here either: the abbreviation is written
// into the cell text and a legend sits above the grid, so the sheet still
// reads correctly in greyscale or for a colourblind reader.
import ExcelJS from "exceljs";
import { monthGrid, inMonth, shiftHours, fmtTime, fmtHours, weekSummary } from "./scheduleMath.js";

const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HDR_FILL = "FF1F1F23";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

export async function buildScheduleWorkbook({ store, year, month, byDate, shiftTypes, typesById }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PGW Support Portal";
  const ws = wb.addWorksheet(`${MONTHS[month]} ${year}`, {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.getColumn(1).width = 4;
  for (let c = 2; c <= 8; c++) ws.getColumn(c).width = 26;
  ws.getColumn(9).width = 12;

  // ---- title -------------------------------------------------------------
  ws.mergeCells(1, 1, 1, 9);
  const title = ws.getCell(1, 1);
  title.value = `${store.name} (#${store.store_number}) — ${MONTHS[month]} ${year} schedule`;
  title.font = { bold: true, size: 14 };
  ws.getRow(1).height = 22;

  // ---- legend ------------------------------------------------------------
  // Sits above the grid so an abbreviation in a cell can always be resolved.
  ws.mergeCells(2, 1, 2, 9);
  ws.getCell(2, 1).value = "Shift types";
  ws.getCell(2, 1).font = { bold: true, size: 10 };

  let legendRow = 3;
  const typed = (shiftTypes ?? []).filter((t) => (t.abbreviation || "").trim());
  typed.forEach((t, i) => {
    const col = 1 + (i % 3) * 3;
    const cell = ws.getCell(legendRow, col);
    cell.value = `${t.abbreviation}`;
    cell.fill = solid(t.export_argb);
    cell.border = BORDER;
    cell.alignment = { horizontal: "center" };
    cell.font = { bold: true, size: 9 };
    const label = ws.getCell(legendRow, col + 1);
    label.value = `${t.name}${t.counts_toward_hours ? "" : " (not counted in hours)"}`;
    label.font = { size: 9 };
    if (i % 3 === 2) legendRow += 1;
  });
  if (typed.length % 3 !== 0) legendRow += 1;

  const headRow = legendRow + 1;
  const head = ws.getRow(headRow);
  WEEKDAYS.forEach((d, i) => {
    const c = head.getCell(i + 2);
    c.value = d;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = solid(HDR_FILL);
    c.alignment = { horizontal: "center" };
    c.border = BORDER;
  });
  const hoursHead = head.getCell(9);
  hoursHead.value = "Hours";
  hoursHead.font = { bold: true, color: { argb: "FFFFFFFF" } };
  hoursHead.fill = solid(HDR_FILL);
  hoursHead.alignment = { horizontal: "center" };
  hoursHead.border = BORDER;

  // ---- the month grid ----------------------------------------------------
  const grid = monthGrid(year, month);
  let r = headRow + 1;
  for (const week of grid) {
    const row = ws.getRow(r);
    row.height = 76;
    week.forEach((date, i) => {
      const cell = row.getCell(i + 2);
      const dayShifts = byDate[date] ?? [];
      const dnum = Number(date.slice(8, 10));
      const outside = !inMonth(date, month);

      // Day number, then one line per shift: name, times, and — where the
      // shift is typed — the abbreviation, so the text alone carries it.
      const lines = [String(dnum)];
      for (const s of dayShifts) {
        const abbr = typesById?.[s.shift_type_id]?.abbreviation?.trim();
        lines.push(
          `${s.employee_id ? (s.employee?.full_name ?? "—") : "Unassigned"}  ${fmtTime(s.start_time)}-${fmtTime(s.end_time)}` +
          (abbr ? `  [${abbr}]` : "")
        );
      }
      cell.value = lines.join("\n");
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = BORDER;
      cell.font = { size: 9, color: { argb: outside ? "FF9A9A9A" : "FF000000" } };

      // A day holding exactly one typed shift takes that type's fill. Mixed
      // or multi-shift days stay plain — a single fill would misrepresent
      // them, and the per-line [ABBR] already says what each shift is.
      const typedShifts = dayShifts.filter((s) => s.shift_type_id);
      if (dayShifts.length === 1 && typedShifts.length === 1) {
        const t = typesById?.[typedShifts[0].shift_type_id];
        if (t?.export_argb) cell.fill = solid(t.export_argb);
      } else if (outside) {
        cell.fill = solid("FFF7F7F7");
      }
    });

    // Weekly total honours counts_toward_hours, exactly as the screen does.
    const total = weekSummary(week, byDate, typesById).total;
    const hc = row.getCell(9);
    hc.value = Number(fmtHours(total));
    hc.numFmt = "0.##";
    hc.font = { bold: true, size: 10 };
    hc.alignment = { vertical: "top", horizontal: "right" };
    hc.border = BORDER;
    r += 1;
  }

  // ---- footnote ----------------------------------------------------------
  const note = ws.getCell(r + 1, 1);
  ws.mergeCells(r + 1, 1, r + 1, 9);
  note.value =
    "Hours exclude shift types not counted toward hours (unpaid time off, open/unassigned). " +
    "Paid time off is included as scheduled labor; it is not worked time, so it should be excluded " +
    "from any overtime forecast built on these totals.";
  note.font = { size: 8, italic: true, color: { argb: "FF666666" } };
  note.alignment = { wrapText: true };

  return wb;
}

export async function downloadScheduleWorkbook(args) {
  const wb = await buildScheduleWorkbook(args);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `schedule-${args.store.store_number}-${args.year}-${String(args.month + 1).padStart(2, "0")}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
