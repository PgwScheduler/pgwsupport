export const money = (n) =>
  (n < 0 ? "-$" : "$") + Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Renders a guarded ratio (null => "—") as a percentage, e.g. 0.263 -> "26.3%".
export const pct = (r, digits = 1) =>
  r == null || !Number.isFinite(r) ? "—" : (r * 100).toFixed(digits) + "%";

// Renders a numeric value, showing "—" for null/blank instead of 0.
export const numOrDash = (n, digits = 2) =>
  n == null || n === "" || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
