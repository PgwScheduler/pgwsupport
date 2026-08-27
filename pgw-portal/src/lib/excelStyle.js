// Shared workbook LOOK — the gold header band, the grey column header, the
// thin print gridline. Extracted from closeoutWorkbook.js when the Report
// Builder needed "the same header treatment as the cash drawer export": that
// is only true if both read the same constants, rather than both carrying a
// copy of FFF5A623 that drifts the first time the accent is retuned.
//
// Number formats live next door in excelFormats.js. This file is colour and
// border only.

export const GOLD = "FFF5A623"; // matches T.accent (#F5A623)
export const HDR = "FFEDEDED";

const THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
export const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };

// Thin gridline around every populated cell so the sheet prints cleanly.
export const applyBorders = (row, from, to) => {
  for (let c = from; c <= to; c++) row.getCell(c).border = BOX;
};

// The gold band used for a sheet's column headers.
export const headerFill = (row) => {
  row.font = { bold: true };
  row.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } }));
};

// The quieter grey band used for a second-level header inside a sheet.
export const subHeaderFill = (row) => {
  row.font = { bold: true };
  row.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HDR } }));
};

// Trigger a browser download for a finished workbook buffer. A no-op under
// Node, so the same export path can be exercised offline.
export function downloadWorkbook(buffer, filename) {
  if (typeof document === "undefined") return;
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
