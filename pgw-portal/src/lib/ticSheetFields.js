// Field definitions and value coercion shared by the tic sheet's two
// layouts: the month grid (desktop) and the one-day form (phones).

export const num = (v) => Number(v) || 0;
export const numToStr = (n) => (n == null || Number(n) === 0 ? "" : String(n));

// What a typed cell stores: blank or junk is 0, never negative, counts whole.
export function toNum(raw, kind) {
  const n = Number(raw);
  if (raw === "" || raw == null || !Number.isFinite(n)) return 0;
  const v = kind === "int" ? Math.trunc(n) : n;
  return v < 0 ? 0 : v;
}

// Day-summary columns, to the right of the service categories.
// zero_dollar_tickets took First Time Customers' slot (migration 25). It is a
// daily entry with no Horizon field, and it does NOT reduce ro_count — repair
// orders, capture rate and average estimate per car are untouched by it.
export const SUMMARY_COLS = [
  { key: "ro_count", label: "Repair Orders", kind: "int", type: "edit" },
  { key: "zero_dollar_tickets", label: "Zero Dollar Tickets", kind: "int", type: "edit" },
  { key: "sales", label: "Sales", kind: "money", type: "sales" },
  { key: "declined_sales", label: "Declined Sales", kind: "money", type: "edit" },
  { key: "credit_apps", label: "CC Apps", kind: "int", type: "edit" },
  { key: "credit_dollars", label: "Credit $", kind: "money", type: "edit" },
  { key: "total_potential", label: "Total Potential", kind: "money", type: "calc" },
  { key: "ave_estimate", label: "Ave Estimate / Car", kind: "money", type: "calc" },
  { key: "capture_rate", label: "Sales Capture Rate", kind: "pct", type: "calc" },
];
