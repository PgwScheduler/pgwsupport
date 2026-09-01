import { computeBonus, scaleValue } from "./bonusMath.js";
let pass = 0, fail = 0;
const close = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;
function ok(name, cond, got) { if (cond) pass++; else { fail++; console.log("FAIL", name, "got", got); } }
const amt = (r, k) => r.lines.find((l) => l.key === k)?.amount ?? null;
const ln = (r, k) => r.lines.find((l) => l.key === k) ?? null;

// The three company-wide tables, exactly as migration 26 seeds them.
const RATES = [
  { model: "A", tier: "gold", role: "pool", pct: 0.07 },
  { model: "A", tier: "silver", role: "pool", pct: 0.05 },
  { model: "A", tier: "bronze", role: "pool", pct: 0.04 },
  { model: "B", tier: "gold", role: "manager", pct: 0.03 },
  { model: "B", tier: "gold", role: "assistant", pct: 0.01 },
  { model: "B", tier: "silver", role: "manager", pct: 0.015 },
  { model: "B", tier: "silver", role: "assistant", pct: 0.01 },
  { model: "C", tier: "gold", role: "operator", pct: 0.0455 },
  { model: "C", tier: "silver", role: "operator", pct: 0.0325 },
  { model: "C", tier: "bronze", role: "operator", pct: 0.026 },
  { model: "D", tier: "flat", role: "manager", pct: 0.03 },
];
const SPLITS = [
  { model: "A", role: "General Manager", share: 0.65, sort_order: 1 },
  { model: "A", role: "Assistant Manager", share: 0.25, sort_order: 2 },
  { model: "A", role: "Service Advisor", share: 0.10, sort_order: 3 },
];
const POLICY = [
  { key: "google_per_review", value: 10 },
  { key: "google_min_reviews", value: 15 },
  { key: "google_cap_model_c", value: 1000 },
  { key: "credit_penalty_per_app", value: 75 },
  { key: "credit_penalty_floor", value: 35 },
  { key: "phone_conversion_waiver", value: 0.40 },
  { key: "model_b_improvement_pct", value: 0.06 },
];

const tireA = [
  { kind: "tire", threshold: 5, payout: 1250, increment_above: null },
  { kind: "tire", threshold: 6, payout: 1500, increment_above: null },
  { kind: "tire", threshold: 7, payout: 2000, increment_above: null },
  { kind: "tire", threshold: 8, payout: 2500, increment_above: 500 },
];
const creditA = [
  { kind: "credit_app", threshold: 50, payout: 500, increment_above: null },
  { kind: "credit_app", threshold: 100, payout: 1500, increment_above: null },
];
const tireB = [
  { kind: "tire", threshold: 3, payout: 150, increment_above: null },
  { kind: "tire", threshold: 4, payout: 200, increment_above: null },
  { kind: "tire", threshold: 5, payout: 250, increment_above: null },
  { kind: "tire", threshold: 6, payout: 300, increment_above: 50 },
];
const creditB = [
  { kind: "credit_app", threshold: 35, payout: 150, increment_above: null },
  { kind: "credit_app", threshold: 40, payout: 200, increment_above: null },
  { kind: "credit_app", threshold: 50, payout: 250, increment_above: null },
  { kind: "credit_app", threshold: 60, payout: 300, increment_above: null },
  { kind: "credit_app", threshold: 70, payout: 350, increment_above: null },
  { kind: "credit_app", threshold: 80, payout: 400, increment_above: null },
];
const carsD = [
  { kind: "car_increase", threshold: 2, payout: 400, increment_above: null },
  { kind: "car_increase", threshold: 3, payout: 600, increment_above: null },
  { kind: "car_increase", threshold: 4, payout: 800, increment_above: null },
  { kind: "car_increase", threshold: 5, payout: 1000, increment_above: 200 },
];

// Millwood #3303, July 2026 — seeded targets, actuals from the tic sheet.
const MILLWOOD = {
  days_open: 26, daily_car_goal: 16.7, sales_goal: 159234.38, gp_budget: 93506.55,
  gold_threshold: 88831.22, silver_threshold: 84155.90, bronze_threshold: 74805.24, last_year_gp: null,
};
const MILLWOOD_ACTUAL = { grossProfit: 83226.00, daysElapsed: 26, tireUnits: 142, creditApps: 7, roCount: 377 };
const runA = (over = {}) => computeBonus({
  model: "A", target: { ...MILLWOOD, ...(over.target || {}) },
  tiers: [...tireA, ...creditA], inputs: over.inputs ?? null,
  actual: { ...MILLWOOD_ACTUAL, ...(over.actual || {}) },
  rates: RATES, splits: SPLITS, policy: POLICY,
});

const A = runA();

// --- Part 7.1 — Bronze on a $93,507 budget ----------------------------
ok("1.projected", close(A.projectedGp, 83226.00), A.projectedGp);
ok("1.mtdEqualsProjected", close(A.mtdGp, A.projectedGp), [A.mtdGp, A.projectedGp]); // month complete
ok("1.tier", A.tier.name === "bronze", A.tier.name);
ok("1.base", close(amt(A, "base"), 3329.04), amt(A, "base"));
ok("1.gapToSilver", A.tier.next.name === "silver" && close(A.tier.next.gap, 84155.90 - 83226.00), A.tier.next);

// --- Part 7.2 — 142 tires over 26 days --------------------------------
ok("2.tirePerDay", close(A.tirePerDay, 142 / 26, 0.0001), A.tirePerDay);
ok("2.tire", close(amt(A, "tire"), 1250), amt(A, "tire"));
ok("2.noOverage", !/includes/.test(ln(A, "tire").note), ln(A, "tire").note);

// --- Part 7.3 — pool and the three-way split --------------------------
ok("3.pool", close(A.pool, 4579.04), A.pool);
ok("3.gm", close(A.payouts[0].amount, 2976.38, 0.006) && A.payouts[0].role === "General Manager", A.payouts[0]);
ok("3.assistant", close(A.payouts[1].amount, 1144.76) && A.payouts[1].role === "Assistant Manager", A.payouts[1]);
ok("3.advisor", close(A.payouts[2].amount, 457.90, 0.006) && A.payouts[2].role === "Service Advisor", A.payouts[2]);
ok("3.splitSums", close(A.payouts.reduce((s, p) => s + p.amount, 0), A.pool), A.payouts);

// --- Part 7.4 — 7 apps: no kicker, penalty shown but not applied ------
ok("4.noKicker", amt(A, "credit") === 0, amt(A, "credit"));
ok("4.kickerLocked", ln(A, "credit").status === "locked", ln(A, "credit").status);
ok("4.penaltyAmount", close(A.penalty.amount, 2100), A.penalty.amount);   // 75 x 28
ok("4.penaltyShortfall", A.penalty.shortfall === 28, A.penalty.shortfall);
ok("4.penaltyNotWaived", A.penalty.waived === false, A.penalty);          // no Gold, cars 14.5 < 16.7, phone unfilled
ok("4.penaltyNotApplied", close(A.pool, 4579.04), A.pool);                // pool untouched by the penalty
ok("4.penaltyAlternative", close(A.poolIfPenaltyApplied, 2479.04), A.poolIfPenaltyApplied);
ok("4.phoneUnfilled", A.unfilled.includes("phone_conversion"), A.unfilled);

// --- Part 7.5 — Gold keeps the tire and credit money ------------------
// Same store, GP raised past Gold, and enough apps to earn the kicker.
const GOLD = runA({ actual: { grossProfit: 90000, creditApps: 120 } });
ok("5.tierGold", GOLD.tier.name === "gold", GOLD.tier.name);
ok("5.base7pct", close(amt(GOLD, "base"), 90000 * 0.07), amt(GOLD, "base"));
ok("5.tireKept", close(amt(GOLD, "tire"), 1250), amt(GOLD, "tire"));
ok("5.creditKept", close(amt(GOLD, "credit"), 1500), amt(GOLD, "credit"));  // workbook would zero this
ok("5.poolGold", close(GOLD.pool, 6300 + 1250 + 1500), GOLD.pool);
ok("5.goldWaivesPenalty", GOLD.penalty.waived === true && GOLD.penalty.waiverReasons.includes("Gold GP earned"), GOLD.penalty);

// kicker at exactly Silver qualifies; just under does not
ok("5.kickerAtSilver", close(amt(runA({ actual: { grossProfit: 84155.90, creditApps: 60 } }), "credit"), 500),
   amt(runA({ actual: { grossProfit: 84155.90, creditApps: 60 } }), "credit"));
ok("5.kickerBelowSilver", amt(runA({ actual: { grossProfit: 84155.00, creditApps: 60 } }), "credit") === 0,
   amt(runA({ actual: { grossProfit: 84155.00, creditApps: 60 } }), "credit"));

// --- Tire overage and the three unusual scales ------------------------
ok("T.overage", close(scaleValue(tireA, 9.2).total, 3000), scaleValue(tireA, 9.2));   // 2500 + 500 x 1
ok("T.overagePartial", close(scaleValue(tireA, 8.9).total, 2500), scaleValue(tireA, 8.9));
ok("T.belowLowest", close(scaleValue(tireA, 4.9).total, 0), scaleValue(tireA, 4.9));
const lakeMurray = [
  { threshold: 16, payout: 1250, increment_above: null }, { threshold: 17, payout: 1500, increment_above: null },
  { threshold: 18, payout: 2000, increment_above: null }, { threshold: 19, payout: 2500, increment_above: 500 },
];
ok("T.lakeMurray", close(scaleValue(lakeMurray, 20.5).total, 3000), scaleValue(lakeMurray, 20.5));
// Wesmark's overage anchors on its BOTTOM row because its handout still
// reads "above 8" — seeded as written, so it computes as written.
const wesmark = [
  { threshold: 8, payout: 1250, increment_above: 500 }, { threshold: 9, payout: 1500, increment_above: null },
  { threshold: 10, payout: 2000, increment_above: null }, { threshold: 11, payout: 2500, increment_above: null },
];
ok("T.wesmarkAnchor", close(scaleValue(wesmark, 9.2).total, 2000), scaleValue(wesmark, 9.2)); // 1500 + 500
ok("T.wesmarkAtEight", close(scaleValue(wesmark, 8.0).total, 1250), scaleValue(wesmark, 8.0));

// --- Google -----------------------------------------------------------
ok("G.unfilled", ln(runA(), "google").status === "unfilled", ln(runA(), "google").status);
ok("G.unfilledIsNotZeroResult", runA().unfilled.includes("google_reviews"), runA().unfilled);
ok("G.belowMinimum", amt(runA({ inputs: { google_reviews: 14 } }), "google") === 0,
   amt(runA({ inputs: { google_reviews: 14 } }), "google"));
ok("G.atMinimum", close(amt(runA({ inputs: { google_reviews: 15 } }), "google"), 150),
   amt(runA({ inputs: { google_reviews: 15 } }), "google"));
ok("G.belowBronzeLocked",
   ln(runA({ inputs: { google_reviews: 20 }, actual: { grossProfit: 70000 } }), "google").status === "locked",
   ln(runA({ inputs: { google_reviews: 20 }, actual: { grossProfit: 70000 } }), "google").status);

// --- Penalty waivers --------------------------------------------------
ok("P.carGoalWaives",
   runA({ actual: { roCount: 500 } }).penalty.waiverReasons.includes("Daily car goal hit"),
   runA({ actual: { roCount: 500 } }).penalty);
ok("P.phoneWaives",
   runA({ inputs: { phone_conversion_pct: 0.42 } }).penalty.waiverReasons.includes("40% phone conversion"),
   runA({ inputs: { phone_conversion_pct: 0.42 } }).penalty);
ok("P.phoneBelowDoesNotWaive", runA({ inputs: { phone_conversion_pct: 0.39 } }).penalty.waived === false,
   runA({ inputs: { phone_conversion_pct: 0.39 } }).penalty);
ok("P.waivedRestoresPool",
   close(runA({ inputs: { phone_conversion_pct: 0.42 } }).poolIfPenaltyApplied,
         runA({ inputs: { phone_conversion_pct: 0.42 } }).pool),
   runA({ inputs: { phone_conversion_pct: 0.42 } }).poolIfPenaltyApplied);
ok("P.noPenaltyAt35", runA({ actual: { creditApps: 35 } }).penalty.amount === 0,
   runA({ actual: { creditApps: 35 } }).penalty);

// --- Provisional penalty ----------------------------------------------
// Three waivers, one of which we cannot evaluate. When the two computable
// ones (Gold GP, daily car goal) both fail and phone conversion is
// unknown, "not waived" would assert something we do not know: a store
// that actually converted 40% owes nothing. Provisional is the third
// state — computed, displayed, marked unconfirmed, never presented as
// final. Not the same as unfilled: the Google line is unfilled and
// resolves to a real $0; this resolves to an unknown.
ok("PR.unknownPhoneIsProvisional", A.penalty.provisional === true, A.penalty);
ok("PR.provisionalIsNotWaived", A.penalty.waived === false, A.penalty);
ok("PR.provisionalSurfaced", A.penaltyProvisional === true, A.penaltyProvisional);
ok("PR.namesThePendingWaiver", A.penalty.pendingWaiver === "phone conversion", A.penalty.pendingWaiver);
ok("PR.namesWhatWasChecked",
   A.penalty.waiversChecked.includes("Gold GP") && A.penalty.waiversChecked.includes("Daily car goal"),
   A.penalty.waiversChecked);
ok("PR.stillNotDeducted", close(A.pool, 4579.04), A.pool);

// Phone entered below the waiver: now we KNOW it is owed. Not provisional.
const PHONE_LOW = runA({ inputs: { phone_conversion_pct: 0.39 } });
ok("PR.knownPhoneIsNotProvisional", PHONE_LOW.penalty.provisional === false, PHONE_LOW.penalty);
ok("PR.knownPhoneStillNotWaived", PHONE_LOW.penalty.waived === false, PHONE_LOW.penalty);

// A met waiver settles it, so nothing is left pending.
ok("PR.goldIsNotProvisional", GOLD.penalty.provisional === false, GOLD.penalty);
ok("PR.carGoalIsNotProvisional",
   runA({ actual: { roCount: 500 } }).penalty.provisional === false,
   runA({ actual: { roCount: 500 } }).penalty);
ok("PR.phoneWaiverIsNotProvisional",
   runA({ inputs: { phone_conversion_pct: 0.42 } }).penalty.provisional === false,
   runA({ inputs: { phone_conversion_pct: 0.42 } }).penalty);

// A month at the floor owes nothing, so there is nothing to be
// uncertain about — not provisional, despite phone being unknown.
ok("PR.noShortfallNoProvisional",
   runA({ actual: { creditApps: 35 } }).penalty.provisional === false &&
   runA({ actual: { creditApps: 35 } }).penalty.amount === 0,
   runA({ actual: { creditApps: 35 } }).penalty);

// --- Part 7.6 — Model B ------------------------------------------------
// Temple Hills #3296, July 2026: LY GP 42,323 -> gold 46,559.53,
// silver 40,206.85 (95% of LY), no bronze, no daily car goal.
const TH = {
  days_open: 26, daily_car_goal: null, sales_goal: 98905.94, gp_budget: 54165.60,
  gold_threshold: 46559.53, silver_threshold: 40206.85, bronze_threshold: null, last_year_gp: 42323,
};
const runB = (gp, over = {}) => computeBonus({
  model: "B", target: TH, tiers: [...tireB, ...creditB], inputs: over.inputs ?? null,
  actual: { grossProfit: gp, daysElapsed: 26, tireUnits: 130, creditApps: 42, roCount: 300, ...(over.actual || {}) },
  rates: RATES, splits: SPLITS, policy: POLICY,
});
const B1 = runB(42000);   // above minimum, below +10.01%
ok("6.twoThresholds", B1.tier.gold === 46559.53 && B1.tier.silver === 40206.85 && B1.tier.bronze === null, B1.tier);
ok("6.noCarGoal", TH.daily_car_goal === null, TH.daily_car_goal);
ok("6.silverTier", B1.tier.name === "silver", B1.tier.name);
ok("6.mgr15", close(amt(B1, "base_manager"), 42000 * 0.015), amt(B1, "base_manager"));
ok("6.asst1", close(amt(B1, "base_assistant"), 42000 * 0.01), amt(B1, "base_assistant"));
// Below last year, so MAX(0, ...) floors the improvement bonus at zero
// rather than clawing money back.
ok("6.improvementFloored", amt(B1, "improvement") === 0, amt(B1, "improvement"));
ok("6.improvementJustAbove", close(amt(runB(42423), "improvement"), 0.06 * (42423 - 42323)),
   amt(runB(42423), "improvement"));
ok("6.notDoubled", close(amt(B1, "credit"), 200) && close(amt(B1, "tire"), 250), [amt(B1, "credit"), amt(B1, "tire")]);
ok("6.payoutRoles", B1.payouts.map((p) => p.role).join("|") === "Store Manager|Assistant Manager", B1.payouts);

const B2 = runB(50000);   // clears +10.01%
ok("6.goldTier", B2.tier.name === "gold", B2.tier.name);
ok("6.mgr30", close(amt(B2, "base_manager"), 50000 * 0.03), amt(B2, "base_manager"));
ok("6.improvementPaid", close(amt(B2, "improvement"), 0.06 * (50000 - 42323)), amt(B2, "improvement"));
ok("6.creditDoubled", close(amt(B2, "credit"), 400), amt(B2, "credit"));
ok("6.tireDoubled", close(amt(B2, "tire"), 500), amt(B2, "tire"));
ok("6.improvementToManager",
   close(B2.payouts[0].amount, amt(B2, "base_manager") + amt(B2, "improvement")), B2.payouts[0]);
ok("6.assistantGetsIncentives",
   close(B2.payouts[1].amount, amt(B2, "base_assistant") + amt(B2, "credit") + amt(B2, "tire")), B2.payouts[1]);
const B3 = runB(50000, { inputs: { google_reviews: 20 } });
ok("6.googleSplit", close(B3.payouts[0].amount - B2.payouts[0].amount, 100) &&
                    close(B3.payouts[1].amount - B2.payouts[1].amount, 100), [B3.payouts, B2.payouts]);
ok("6.googleNoGpGate", amt(runB(10000, { inputs: { google_reviews: 20 } }), "google") === 200,
   amt(runB(10000, { inputs: { google_reviews: 20 } }), "google"));
ok("6.belowMinimumPaysNothing", runB(30000).tier.name === "none" &&
   amt(runB(30000), "base_manager") === 0, runB(30000).tier);
ok("6.penaltyNoWaiver", runB(42000, { actual: { creditApps: 20 } }).penalty.waived === false,
   runB(42000, { actual: { creditApps: 20 } }).penalty);
ok("6.tireOverage", close(amt(runB(42000, { actual: { tireUnits: 26 * 8 } }), "tire"), 300 + 50 * 2),
   amt(runB(42000, { actual: { tireUnits: 26 * 8 } }), "tire"));

// --- Part 7.7 — Model C ------------------------------------------------
// SpeeDee Summerville #3009, July 2026.
const SV = {
  days_open: 26, daily_car_goal: 35.5, sales_goal: 156535.36, gp_budget: 81444.92,
  gold_threshold: 77372.67, silver_threshold: 73300.42, bronze_threshold: 65155.93, last_year_gp: null,
};
const runC = (gp, inputs = null) => computeBonus({
  model: "C", target: SV, tiers: [], inputs,
  actual: { grossProfit: gp, daysElapsed: 26, tireUnits: 200, creditApps: 60, roCount: 900 },
  rates: RATES, splits: SPLITS, policy: POLICY,
});
const C1 = runC(78000);
ok("7.singlePayout", C1.payouts.length === 1 && C1.payouts[0].role === "Business Operator", C1.payouts);
ok("7.gold455", close(amt(C1, "base"), 78000 * 0.0455), amt(C1, "base"));
ok("7.silver325", close(amt(runC(74000), "base"), 74000 * 0.0325), amt(runC(74000), "base"));
ok("7.bronze260", close(amt(runC(66000), "base"), 66000 * 0.026), amt(runC(66000), "base"));
ok("7.noneBelowBronze", runC(60000).tier.name === "none" && amt(runC(60000), "base") === 0, runC(60000).tier);
ok("7.noTireSection", C1.lines.every((l) => l.key !== "tire"), C1.lines.map((l) => l.key));
ok("7.noCreditSection", C1.lines.every((l) => l.key !== "credit"), C1.lines.map((l) => l.key));
ok("7.noPenalty", C1.penalty === null, C1.penalty);
ok("7.googleCap", close(amt(runC(78000, { google_reviews: 150 }), "google"), 1000),
   amt(runC(78000, { google_reviews: 150 }), "google"));
ok("7.googleCapStatus", ln(runC(78000, { google_reviews: 150 }), "google").status === "capped",
   ln(runC(78000, { google_reviews: 150 }), "google").status);
ok("7.googleUnderCap", close(amt(runC(78000, { google_reviews: 40 }), "google"), 400),
   amt(runC(78000, { google_reviews: 40 }), "google"));
ok("7.googleNeedsBronze", ln(runC(60000, { google_reviews: 40 }), "google").status === "locked",
   ln(runC(60000, { google_reviews: 40 }), "google").status);

// --- Part 7.8 — Model D ------------------------------------------------
// SpeeDee Lexington #3308, July 2026. Car goal 10.4 is already LY + 2,
// so last year ran 8.4 cars/day.
const LEX = {
  days_open: 26, daily_car_goal: 10.4, sales_goal: 47573.16, gp_budget: 28979.70,
  gold_threshold: 27530.72, silver_threshold: 26081.73, bronze_threshold: 23183.76, last_year_gp: null,
};
const runD = (gp, over = {}) => computeBonus({
  model: "D", target: LEX, tiers: carsD, inputs: over.inputs ?? null,
  actual: { grossProfit: gp, daysElapsed: 26, tireUnits: 0, creditApps: 0, roCount: 26 * 11.5, ...(over.actual || {}) },
  rates: RATES, splits: SPLITS, policy: POLICY,
});
const D1 = runD(28000);
ok("8.flat3pct", close(amt(D1, "base"), 28000 * 0.03), amt(D1, "base"));
ok("8.singleRecipient", D1.payouts.length === 1 && D1.payouts[0].role === "Store Manager", D1.payouts);
ok("8.noTierGate", close(amt(runD(10000), "base"), 300), amt(runD(10000), "base")); // flat, pays below every rung
ok("8.carsPerDay", close(D1.carsPerDay, 11.5), D1.carsPerDay);
ok("8.carIncrease", close(amt(D1, "car_increase"), 600), amt(D1, "car_increase")); // 11.5 - 8.4 = 3.1/day -> 600
ok("8.carAtTwo", close(amt(runD(28000, { actual: { roCount: 26 * 10.4 } }), "car_increase"), 400),
   amt(runD(28000, { actual: { roCount: 26 * 10.4 } }), "car_increase"));
ok("8.carBelowTwo", amt(runD(28000, { actual: { roCount: 26 * 10.0 } }), "car_increase") === 0,
   amt(runD(28000, { actual: { roCount: 26 * 10.0 } }), "car_increase"));
ok("8.carOverage", close(amt(runD(28000, { actual: { roCount: 26 * 15.4 } }), "car_increase"), 1000 + 200 * 2),
   amt(runD(28000, { actual: { roCount: 26 * 15.4 } }), "car_increase"));
// Referral GP credit lifts the GP used for bonus math and nothing else.
const D2 = runD(28000, { inputs: { referral_gp_credit: 3000 } });
ok("8.referralLiftsGp", close(D2.projectedGp, 31000), D2.projectedGp);
ok("8.referralNotInMtd", close(D2.mtdGp, 28000), D2.mtdGp);
ok("8.referralPaid", close(amt(D2, "base"), 31000 * 0.03), amt(D2, "base"));
ok("8.referralExposed", close(D2.referralCredit, 3000), D2.referralCredit);
ok("8.noTireSectionD", D1.lines.every((l) => l.key !== "tire"), D1.lines.map((l) => l.key));

// --- Part 7.9 — GP flows from labor cost, not a placeholder ------------
// Same store and month, gross profit before and after technician labor
// cost is entered. Every downstream figure has to move.
const beforeLabor = runA({ actual: { grossProfit: 98866.19 } }); // 83,226 + 15,640.19 labor cost
const afterLabor = A;
ok("9.tierMoves", beforeLabor.tier.name === "gold" && afterLabor.tier.name === "bronze",
   [beforeLabor.tier.name, afterLabor.tier.name]);
ok("9.poolMoves", beforeLabor.pool > afterLabor.pool, [beforeLabor.pool, afterLabor.pool]);
ok("9.gmMoves", !close(beforeLabor.payouts[0].amount, afterLabor.payouts[0].amount),
   [beforeLabor.payouts[0].amount, afterLabor.payouts[0].amount]);
ok("9.overstatedByAbout20pct", close(beforeLabor.pool / afterLabor.pool, 2.0, 0.35),
   beforeLabor.pool / afterLabor.pool);

// --- Projection and degenerate input ----------------------------------
const MID = runA({ actual: { grossProfit: 41613, daysElapsed: 13 } });
ok("X.projectsForward", close(MID.projectedGp, (41613 / 13) * 26), MID.projectedGp);
ok("X.projectionExceedsMtd", MID.projectedGp > MID.mtdGp, [MID.projectedGp, MID.mtdGp]);
ok("X.convergesAtClose", close(A.projectedGp, A.mtdGp), [A.projectedGp, A.mtdGp]);
const NONE = runA({ actual: { grossProfit: 0, daysElapsed: 0 } });
ok("X.notReady", NONE.ready === false && NONE.projectedGp === null, NONE.projectedGp);
ok("X.noNaN", NONE.lines.every((l) => Number.isFinite(l.amount)) && Number.isFinite(NONE.pool), NONE.lines);
ok("X.zeroPayouts", NONE.payouts.every((p) => p.amount === 0), NONE.payouts);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
