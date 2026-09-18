// Offline checks for effective-dated pay rates (migration 56 mirror).
// Run: node src/lib/payRates.test.mjs
import { rateOn, ratesOn, rowOn, employedDuring, firstPayWeek, weeksAlreadyStarted, LEGACY_DATE } from "./payRates.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const CUT = "2026-08-30";
const H = [
  { rate_type: "hourly", effective_date: LEGACY_DATE, amount: "15.00" },
  { rate_type: "hourly", effective_date: "2026-09-09", amount: "25.00" },
  { rate_type: "flat", effective_date: LEGACY_DATE, amount: "20.00" },
  { rate_type: "salary", effective_date: "2026-10-04", amount: "1200.00" },
];

// --- the rate rule (mirrors _pay_rate_at) ------------------------------
eq("legacy rate before any change", rateOn(H, "hourly", "2026-08-30"), 15);
eq("in force ON its date", rateOn(H, "hourly", "2026-09-09"), 25);
eq("day before", rateOn(H, "hourly", "2026-09-08"), 15);
eq("week of 9/6 (start before the 9/9 raise) keeps the old rate", rateOn(H, "hourly", "2026-09-06"), 15);
eq("week of 9/13 gets the raise", rateOn(H, "hourly", "2026-09-13"), 25);
eq("no row of a type reads 0", rateOn(H, "salary", "2026-09-13"), 0);
eq("future-dated salary not yet in force", rateOn(H, "salary", "2026-10-03"), 0);
eq("future-dated salary from its date", rateOn(H, "salary", "2026-10-04"), 1200);
eq("empty history", rateOn([], "hourly", "2026-09-13"), 0);
eq("ratesOn shape = computePayRow's", ratesOn(H, "2026-09-13"), { hourly_rate: 25, flat_rate_per_hour: 20, manager_salary: 0 });
eq("rowOn finds the row", rowOn(H, "hourly", "2026-09-20").effective_date, "2026-09-09");
eq("rowOn none", rowOn(H, "salary", "2026-09-20"), null);
// unordered input
eq("order-independent", rateOn([...H].reverse(), "hourly", "2026-09-20"), 25);

// --- who is on a pay week (mirrors _employed_during) --------------------
const wk = ["2026-09-06", "2026-09-12"];
eq("active, no dates", employedDuring({ active: true }, ...wk), true);
eq("legacy removed", employedDuring({ active: false }, ...wk), false);
eq("hired mid-week", employedDuring({ active: true, hire_date: "2026-09-10" }, ...wk), true);
eq("hired after the week", employedDuring({ active: true, hire_date: "2026-09-13" }, ...wk), false);
eq("ended mid-week", employedDuring({ active: false, termination_date: "2026-09-08" }, ...wk), true);
eq("ended before the week", employedDuring({ active: false, termination_date: "2026-09-05" }, ...wk), false);
eq("termination date wins over the active flag", employedDuring({ active: true, termination_date: "2026-09-05" }, ...wk), false);

// --- which week a change first applies to -------------------------------
eq("dated on a Sunday week start: that week", firstPayWeek("2026-09-13", CUT), "2026-09-13");
eq("dated mid-week: the next week", firstPayWeek("2026-09-09", CUT), "2026-09-13");
eq("dated Saturday: the next week", firstPayWeek("2026-09-12", CUT), "2026-09-13");
eq("pre-cutover Monday week start", firstPayWeek("2026-08-24", CUT), "2026-08-24");
eq("pre-cutover mid-week lands on the cutover Sunday", firstPayWeek("2026-08-26", CUT), "2026-08-30");
eq("future change: no started weeks", weeksAlreadyStarted("2026-09-20", CUT, "2026-09-18"), 0);
eq("dated this week mid-week: next week, none started", weeksAlreadyStarted("2026-09-15", CUT, "2026-09-18"), 0);
eq("dated this week's start: 1 (the current week)", weeksAlreadyStarted("2026-09-13", CUT, "2026-09-18"), 1);
eq("backdated two weeks", weeksAlreadyStarted("2026-08-30", CUT, "2026-09-18"), 3);
eq("backdated across the cutover", weeksAlreadyStarted("2026-08-24", CUT, "2026-09-18"), 4);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
