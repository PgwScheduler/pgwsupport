// =====================================================================
// Annual bonus tiers — the one place the Gold / Silver / Bronze cutoffs
// live as a share of the full-year GP budget. GP vs Budget reads them
// off its Track % (projected full year ÷ full-year budget); anything
// else that needs "which tier is this pace" should import from here
// rather than repeat the numbers.
//
// The same 95 / 90 / 80 split is how bonus_monthly_targets seeds the
// monthly thresholds for Models A and C (migration 26). Monthly bonus
// math (bonusMath.js) still reads those seeded dollar thresholds, not
// these shares.
// =====================================================================

// Highest first: a pace is the first tier whose cutoff it reaches.
export const ANNUAL_TIERS = [
  { key: "gold", label: "Gold", min: 0.95 },
  { key: "silver", label: "Silver", min: 0.90 },
  { key: "bronze", label: "Bronze", min: 0.80 },
];
export const BELOW_TIERS = { key: "below", label: "Below Bronze", min: null };

// Models whose plan isn't a Gold / Silver / Bronze ladder on the GP
// budget: B pays on last year's GP (two rungs, no bronze), D is a flat
// rate with no tiers. A and C use all three.
export const MODELS_WITHOUT_TIERS = new Set(["B", "D"]);

// Track % (a fraction, 1 = 100%) -> tier, or null when there is none.
export function annualTier(track) {
  if (track == null || !Number.isFinite(track)) return null;
  return ANNUAL_TIERS.find((t) => track >= t.min) ?? BELOW_TIERS;
}
