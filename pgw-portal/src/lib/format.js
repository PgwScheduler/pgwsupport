export const money = (n) =>
  (n < 0 ? "-$" : "$") + Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The JS mirror of CURRENCY_FMT ('$#,##0.00;-$#,##0.00;"-"??') from
// lib/excelFormats.js, so a grid cell and the same cell in an Excel export
// read identically: positives $1,234.56, negatives -$1,234.56, zero a bare
// dash. null/undefined stays blank — an empty cell is not a zero.
export const moneyCell = (n) => {
  if (n == null || n === "") return "";
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return v === 0 ? "-" : money(v);
};

// Renders a guarded ratio (null => "—") as a percentage, e.g. 0.263 -> "26.3%".
export const pct = (r, digits = 1) =>
  r == null || !Number.isFinite(r) ? "—" : (r * 100).toFixed(digits) + "%";

// Renders a numeric value, showing "—" for null/blank instead of 0.
export const numOrDash = (n, digits = 2) =>
  n == null || n === "" || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
