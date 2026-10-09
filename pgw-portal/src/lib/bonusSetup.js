// Bonus plan setup (migration 85). The DATABASE recomputes thresholds
// (bonus_recalc_thresholds) when a draft store is saved; thresholdsFor()
// mirrors that rule only so the editor can show the effect of a typed
// budget before saving. Keep the two in step.

// Defaults when a store's model is switched in a draft year. They are the
// 2026 values every store but Wesmark (bronze 0.85) used.
export const MODEL_DEFAULT_RULES = {
  A: { threshold_basis: "budget", gold_pct: 0.95, silver_pct: 0.9, bronze_pct: 0.8, threshold_floor: null },
  B: { threshold_basis: "last_year", gold_pct: 1.1001, silver_pct: 0.95, bronze_pct: null, threshold_floor: 35000 },
  C: { threshold_basis: "budget", gold_pct: 0.95, silver_pct: 0.9, bronze_pct: 0.8, threshold_floor: null },
  D: { threshold_basis: "budget", gold_pct: 0.95, silver_pct: 0.9, bronze_pct: 0.8, threshold_floor: null },
};

const toNum = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;

// One month's gold/silver/bronze from the plan's rule. null where the
// input it needs is blank -- never a zero.
export function thresholdsFor(rule, row) {
  const pick = (pctKey) => {
    const p = toNum(rule?.[pctKey]);
    if (p === null) return null;
    if (rule?.threshold_basis === "last_year") {
      const ly = toNum(row?.last_year_gp);
      if (ly === null) return null;
      return Math.max(round2(ly * p), toNum(rule.threshold_floor) ?? 0);
    }
    const budget = toNum(row?.gp_budget);
    return budget === null ? null : round2(budget * p);
  };
  return { gold: pick("gold_pct"), silver: pick("silver_pct"), bronze: pick("bronze_pct") };
}

// A column pasted from Excel / Google Sheets: one value per line (tabs
// take the first cell). "$12,345.60" -> 12345.6; blank -> null; anything
// unreadable -> NaN so the caller can refuse the paste.
export function parsePastedColumn(text) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.split("\t")[0].trim())
    .filter((cell, i, all) => !(cell === "" && i === all.length - 1)) // trailing newline
    .map((cell) => {
      if (cell === "") return null;
      const n = toNum(cell);
      return n === null ? NaN : n;
    });
}

// Percent shown to people (95, 110.01) <-> stored fraction (0.95, 1.1001).
export const pctToInput = (v) => (v === null || v === undefined ? "" : String(Math.round(Number(v) * 1000000) / 10000));
export const inputToPct = (s) => {
  const n = toNum(s);
  return n === null ? null : Math.round(n * 100) / 10000;
};

// bonus_year_problems rows -> { byStore: {location_id: [..]}, general: [..] }
export function groupProblems(rows) {
  const byStore = {};
  const general = [];
  for (const r of rows ?? []) {
    if (!r.location_id) { general.push(r.problem); continue; }
    (byStore[r.location_id] ??= []).push(r);
  }
  return { byStore, general };
}

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const TIER_KINDS = [
  { kind: "tire", label: "Tires per day" },
  { kind: "credit_app", label: "Credit apps" },
  { kind: "car_increase", label: "Cars/day over last year" },
];
