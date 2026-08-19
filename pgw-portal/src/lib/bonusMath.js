// =====================================================================
// Bonus tracker — Models A / B / C / D.
//
// NOTHING about a plan is written here. Rates, splits, thresholds,
// incentive scales and policy scalars all arrive as arguments, loaded
// from bonus_model_rates / bonus_model_splits / bonus_policy /
// bonus_monthly_targets / bonus_incentive_tiers (migration 26). The
// scales already vary by store and are re-cut every year.
//
// THE ATTAINMENT FIGURE — every model measures against PROJECTED
// month-end gross profit, not month to date:
//
//     projected_gp = (MTD gross profit / days_elapsed) * days_open
//
// which is what makes this a tracker rather than a scoreboard: it
// answers "what will I earn if the rest of the month looks like this".
// At month close the two converge. Gross profit is the same figure the
// tic sheet's goals strip shows, so it is only right once technician
// labor cost is in (migration 24) — before that it is overstated by
// roughly 20%.
//
// TWO STANDING DECISIONS, both surfaced as flags on screen:
//
//   * Penalties are computed and shown but NEVER deducted. Model A's
//     waiver depends on phone conversion, which no system tracks, so
//     applying it would quietly cut somebody's expected pay on the
//     strength of a figure nobody has entered. `poolIfPenaltyApplied`
//     carries the other number so it is one glance away.
//
//   * The Millwood workbook zeroes the credit-app kicker whenever
//     projected GP clears Gold, so its best months lose the kicker.
//     That is a defect, not policy. The kicker is paid at Gold here.
// =====================================================================

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const has = (v) => v !== null && v !== undefined && v !== "";

// Highest tier whose threshold the measure reaches, plus the overage.
// `increment_above` sits on the row that ANCHORS the overage rule — for
// nearly every store that is the top tier, but Wesmark's sits on its
// bottom row because its handout still reads "above 8" while its tiers
// run 8/9/10/11. Seeded as written, so it computes as written.
export function scaleValue(rows, measure) {
  const sorted = [...(rows || [])].sort((a, b) => num(a.threshold) - num(b.threshold));
  let base = 0, matched = null;
  for (const r of sorted) if (measure >= num(r.threshold)) { base = num(r.payout); matched = r; }
  const anchor = sorted.find((r) => has(r.increment_above));
  let overage = 0;
  if (anchor && measure > num(anchor.threshold))
    overage = num(anchor.increment_above) * Math.floor(measure - num(anchor.threshold));
  return { base, overage, total: base + overage, matched, anchor };
}

// gold > silver > bronze. Model B has no bronze; Model D has no tiers at
// all, though its handout still carries the columns and its Google
// minimum reads off Bronze.
function resolveTier(projected, target) {
  const at = (k) => (has(target?.[k]) ? num(target[k]) : null);
  const gold = at("gold_threshold"), silver = at("silver_threshold"), bronze = at("bronze_threshold");
  let name = "none";
  if (gold != null && projected >= gold) name = "gold";
  else if (silver != null && projected >= silver) name = "silver";
  else if (bronze != null && projected >= bronze) name = "bronze";

  // The dollar gap to the next rung up, for the "how far away am I" line.
  const rungs = [["gold", gold], ["silver", silver], ["bronze", bronze]]
    .filter(([, v]) => v != null && projected < v)
    .sort((a, b) => a[1] - b[1]);
  const next = rungs[0] ? { name: rungs[0][0], threshold: rungs[0][1], gap: rungs[0][1] - projected } : null;
  return { name, gold, silver, bronze, next };
}

const rateFor = (rates, model, tier, role) =>
  num((rates || []).find((r) => r.model === model && r.tier === tier && r.role === role)?.pct);

const policyOf = (policy, key) => {
  const row = (policy || []).find((p) => p.key === key);
  return row ? num(row.value) : 0;
};

const line = (key, label, amount, opts = {}) => ({
  key, label, amount, applied: opts.applied !== false, status: opts.status ?? null, note: opts.note ?? null,
});

// ---------------------------------------------------------------------
// computeBonus
//   model    'A' | 'B' | 'C' | 'D'
//   target   one bonus_monthly_targets row
//   tiers    that store's bonus_incentive_tiers rows for the year
//   inputs   bonus_monthly_inputs row (may be missing entirely)
//   actual   { grossProfit, daysElapsed, tireUnits, creditApps, roCount }
//   rates / splits / policy   the three company-wide tables
// ---------------------------------------------------------------------
export function computeBonus({ model, target, tiers = [], inputs = null, actual = {}, rates = [], splits = [], policy = [] }) {
  const daysOpen = num(target?.days_open);
  const daysElapsed = num(actual.daysElapsed);
  const mtdGp = num(actual.grossProfit);
  const referral = num(inputs?.referral_gp_credit);

  // Model D's Midas referral credit is a whole-month figure, so it is
  // added AFTER the projection rather than scaled up with the daily run
  // rate. Bonus math only — it never reaches the tic sheet or Horizon.
  const projectedBase = daysElapsed > 0 && daysOpen > 0 ? (mtdGp / daysElapsed) * daysOpen : null;
  const projectedGp = projectedBase == null ? null : projectedBase + (model === "D" ? referral : 0);
  const ready = projectedGp != null;
  const proj = ready ? projectedGp : 0;

  const tier = resolveTier(proj, target);
  const perDay = (n) => (daysElapsed > 0 ? num(n) / daysElapsed : 0);
  const tirePerDay = perDay(actual.tireUnits);
  const carsPerDay = perDay(actual.roCount);
  const creditApps = num(actual.creditApps);

  const of = (kind) => (tiers || []).filter((t) => t.kind === kind);
  const reviews = has(inputs?.google_reviews) ? num(inputs.google_reviews) : null;
  const phone = has(inputs?.phone_conversion_pct) ? num(inputs.phone_conversion_pct) : null;

  const perReview = policyOf(policy, "google_per_review");
  const minReviews = policyOf(policy, "google_min_reviews");
  const penaltyPerApp = policyOf(policy, "credit_penalty_per_app");
  const penaltyFloor = policyOf(policy, "credit_penalty_floor");

  const unfilled = [];
  if (reviews == null) unfilled.push("google_reviews");
  if (model === "A" && phone == null) unfilled.push("phone_conversion");

  // Google is the same shape everywhere: $10 a review above a minimum
  // count, gated on a GP rung. Model C caps it; Model B has no GP gate.
  const googleAmount = (gate) => {
    if (reviews == null) return { amount: 0, status: "unfilled", note: "No review count entered" };
    if (reviews < minReviews)
      return { amount: 0, status: "short", note: `${reviews} of ${minReviews} reviews needed` };
    if (gate != null && proj < gate)
      return { amount: 0, status: "locked", note: "Below the GP minimum to qualify" };
    let amount = perReview * reviews;
    if (model === "C") {
      const cap = policyOf(policy, "google_cap_model_c");
      if (cap > 0 && amount > cap) return { amount: cap, status: "capped", note: `Capped at the ${cap} monthly maximum` };
    }
    return { amount, status: null, note: `${reviews} reviews` };
  };

  const lines = [];
  let penalty = null;
  let payouts = [];
  const flags = [];

  if (model === "A") {
    const rate = tier.name === "none" ? 0 : rateFor(rates, "A", tier.name, "pool");
    lines.push(line("base", `Base pool — ${tier.name === "none" ? "no tier reached" : tier.name} (${(rate * 100).toFixed(0)}% of GP)`,
      proj * rate, { status: tier.name === "none" ? "locked" : null }));

    const tireRows = of("tire");
    const t = scaleValue(tireRows, tirePerDay);
    lines.push(line("tire", "Tire incentive", t.total, {
      note: `${tirePerDay.toFixed(2)} tires/day` + (t.overage ? ` — includes ${t.overage} above ${num(t.anchor.threshold)}/day` : ""),
      status: t.total === 0 ? "short" : null,
    }));

    // The kicker needs Silver. It is deliberately NOT withdrawn at Gold.
    const c = scaleValue(of("credit_app"), creditApps);
    const creditGate = tier.silver;
    const creditOk = creditGate == null || proj >= creditGate;
    lines.push(line("credit", "Credit app kicker", creditOk ? c.total : 0, {
      note: creditOk ? `${creditApps} apps` : `${creditApps} apps — Silver GP is the minimum to qualify`,
      status: !creditOk ? "locked" : c.total === 0 ? "short" : null,
    }));

    const g = googleAmount(tier.bronze);
    lines.push(line("google", "Google review incentive", g.amount, { status: g.status, note: g.note }));

    const shortfall = Math.max(0, penaltyFloor - creditApps);
    const waiverReasons = [];
    if (tier.name === "gold") waiverReasons.push("Gold GP earned");
    if (has(target?.daily_car_goal) && carsPerDay >= num(target.daily_car_goal)) waiverReasons.push("Daily car goal hit");
    if (phone != null && phone >= policyOf(policy, "phone_conversion_waiver")) waiverReasons.push("40% phone conversion");
    penalty = {
      amount: shortfall * penaltyPerApp,
      shortfall,
      waived: waiverReasons.length > 0,
      waiverReasons,
      note: `${creditApps} apps, ${shortfall} below the floor of ${penaltyFloor}`,
    };

    const pool = lines.reduce((s, l) => s + l.amount, 0);
    payouts = (splits || [])
      .filter((s) => s.model === "A")
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({ role: s.role, share: num(s.share), amount: pool * num(s.share) }));
  }

  if (model === "B") {
    const lastYear = has(target?.last_year_gp) ? num(target.last_year_gp) : null;
    // "Grow GP by 10.01% over LY" is read as clearing the seeded gold
    // threshold — the same rung that pays the higher rate. The handout
    // floors that column at 35,000, so the two can differ in a weak
    // month; flagged for BDC rather than resolved here.
    const grew = tier.name === "gold";
    const mgrRate = tier.name === "none" ? 0 : rateFor(rates, "B", tier.name, "manager");
    const asstRate = tier.name === "none" ? 0 : rateFor(rates, "B", tier.name, "assistant");

    lines.push(line("base_manager", `Store manager — ${tier.name === "none" ? "below minimum" : tier.name === "gold" ? "+10.01% LY" : "minimum to bonus"} (${(mgrRate * 100).toFixed(1)}% of GP)`,
      proj * mgrRate, { status: tier.name === "none" ? "locked" : null }));
    lines.push(line("base_assistant", `Assistant manager (${(asstRate * 100).toFixed(1)}% of GP)`,
      proj * asstRate, { status: tier.name === "none" ? "locked" : null }));

    const improvementPct = policyOf(policy, "model_b_improvement_pct");
    const improvement = lastYear == null ? 0 : improvementPct * Math.max(0, proj - lastYear);
    lines.push(line("improvement", `GP improvement over last year (${(improvementPct * 100).toFixed(0)}%)`, improvement, {
      note: lastYear == null ? "No last-year figure on file"
        : `Last year ${lastYear.toLocaleString(undefined, { style: "currency", currency: "USD" })} — recipient unconfirmed, assumed store manager`,
      status: improvement === 0 ? "short" : null,
    }));

    const c = scaleValue(of("credit_app"), creditApps);
    lines.push(line("credit", "Credit app bonus — assistant manager", c.total * (grew ? 2 : 1), {
      note: `${creditApps} apps` + (grew ? " — doubled at +10.01% GP" : ""),
      status: c.total === 0 ? "short" : null,
    }));

    const t = scaleValue(of("tire"), tirePerDay);
    lines.push(line("tire", "Tire bonus — assistant manager", t.total * (grew ? 2 : 1), {
      note: `${tirePerDay.toFixed(2)} tires/day` + (grew ? " — doubled at +10.01% GP" : ""),
      status: t.total === 0 ? "short" : null,
    }));

    const g = googleAmount(null); // Model B's handout sets no GP minimum
    lines.push(line("google", "Google review incentive — split manager / assistant", g.amount, { status: g.status, note: g.note }));

    const shortfall = Math.max(0, penaltyFloor - creditApps);
    penalty = {
      amount: shortfall * penaltyPerApp, shortfall, waived: false, waiverReasons: [],
      note: `${creditApps} apps, ${shortfall} below the floor of ${penaltyFloor} — store manager penalty, no waiver conditions listed`,
    };

    const at = (k) => lines.find((l) => l.key === k)?.amount ?? 0;
    payouts = [
      { role: "Store Manager", amount: at("base_manager") + at("improvement") + at("google") / 2 },
      { role: "Assistant Manager", amount: at("base_assistant") + at("credit") + at("tire") + at("google") / 2 },
    ];
  }

  if (model === "C") {
    const rate = tier.name === "none" ? 0 : rateFor(rates, "C", tier.name, "operator");
    lines.push(line("base", `Business operator — ${tier.name === "none" ? "no tier reached" : tier.name} (${(rate * 100).toFixed(2)}% of GP)`,
      proj * rate, { status: tier.name === "none" ? "locked" : null }));
    const g = googleAmount(tier.bronze);
    lines.push(line("google", "Google review incentive", g.amount, {
      status: g.status, note: (g.note ? g.note + " — " : "") + "distribution at the store manager's discretion",
    }));
    const pool = lines.reduce((s, l) => s + l.amount, 0);
    payouts = [{ role: "Business Operator", amount: pool }];
  }

  if (model === "D") {
    const rate = rateFor(rates, "D", "flat", "manager");
    lines.push(line("base", `Store manager — flat ${(rate * 100).toFixed(0)}% of GP`, proj * rate));

    // The daily car goal is already last year + 2, so last year's rate is
    // goal - 2 and the measure is how far above that the store is running.
    const carGoal = has(target?.daily_car_goal) ? num(target.daily_car_goal) : null;
    const lastYearCars = carGoal == null ? null : carGoal - 2;
    const over = lastYearCars == null ? 0 : carsPerDay - lastYearCars;
    const ci = scaleValue(of("car_increase"), over);
    lines.push(line("car_increase", "Monthly car increase vs last year", ci.total, {
      note: lastYearCars == null ? "No daily car goal on file"
        : `${carsPerDay.toFixed(2)} cars/day vs ${lastYearCars.toFixed(1)} last year — ${over >= 0 ? "+" : ""}${over.toFixed(2)}/day`,
      status: ci.total === 0 ? "short" : null,
    }));

    const g = googleAmount(tier.bronze);
    lines.push(line("google", "Google review incentive", g.amount, { status: g.status, note: g.note }));

    const pool = lines.reduce((s, l) => s + l.amount, 0);
    payouts = [{ role: "Store Manager", amount: pool }];
  }

  const pool = lines.reduce((s, l) => s + l.amount, 0);
  const penaltyAmount = penalty && !penalty.waived ? penalty.amount : 0;

  return {
    ready,
    model,
    mtdGp,
    projectedGp: ready ? projectedGp : null,
    referralCredit: referral,
    daysElapsed,
    daysOpen,
    tirePerDay,
    carsPerDay,
    creditApps,
    tier,
    lines,
    pool,
    penalty,
    // What the pool would be if the penalty were deducted. Shown beside
    // the pool, never substituted for it.
    poolIfPenaltyApplied: pool - penaltyAmount,
    payouts: payouts.map((p) => ({ ...p, amount: p.amount })),
    unfilled,
    flags,
  };
}
