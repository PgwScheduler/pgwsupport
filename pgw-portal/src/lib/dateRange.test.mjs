// Offline checks for the shared date range. Run: node src/lib/dateRange.test.mjs
import {
  rangeFor, addMonths, isWholeCalendarMonth, weeksTouching, eachDay,
  sundayOf, daysBetween, startOfQuarter,
} from "./dateRange.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

// A Thursday, mid-month, mid-quarter.
const REF = "2026-08-27";

eq("today", rangeFor("today", REF), { from: "2026-08-27", to: "2026-08-27" });
eq("yesterday", rangeFor("yesterday", REF), { from: "2026-08-26", to: "2026-08-26" });
// Weeks start SUNDAY: 2026-08-27 is a Thursday, its Sunday is the 23rd.
eq("wtd", rangeFor("wtd", REF), { from: "2026-08-23", to: "2026-08-27" });
eq("last7", rangeFor("last7", REF), { from: "2026-08-21", to: "2026-08-27" });
eq("mtd", rangeFor("mtd", REF), { from: "2026-08-01", to: "2026-08-27" });
eq("last_month", rangeFor("last_month", REF), { from: "2026-07-01", to: "2026-07-31" });
eq("last_2_weeks", rangeFor("last_2_weeks", REF), { from: "2026-08-14", to: "2026-08-27" });
eq("last_3_months", rangeFor("last_3_months", REF), { from: "2026-05-28", to: "2026-08-27" });
eq("qtd", rangeFor("qtd", REF), { from: "2026-07-01", to: "2026-08-27" });
eq("ytd", rangeFor("ytd", REF), { from: "2026-01-01", to: "2026-08-27" });

// Rolling windows are inclusive of today: 7 days means 7, not 8.
eq("last7 length", daysBetween(...Object.values(rangeFor("last7", REF))), 7);
eq("last_2_weeks length", daysBetween(...Object.values(rangeFor("last_2_weeks", REF))), 14);

// Month arithmetic must clamp, not roll over. 31 May minus one month is
// 30 April, never 1 May.
eq("addMonths clamps short month", addMonths("2026-05-31", -1), "2026-04-30");
eq("addMonths clamps to Feb", addMonths("2026-03-31", -1), "2026-02-28");
eq("addMonths leap Feb", addMonths("2028-03-31", -1), "2028-02-29");

// Last month, run from the 31st, must not skip a month.
eq("last_month from the 31st", rangeFor("last_month", "2026-05-31"), { from: "2026-04-01", to: "2026-04-30" });
// ...or from the 1st.
eq("last_month from the 1st", rangeFor("last_month", "2026-01-01"), { from: "2025-12-01", to: "2025-12-31" });

// Quarters.
eq("Q1", startOfQuarter("2026-02-14"), "2026-01-01");
eq("Q3", startOfQuarter("2026-08-27"), "2026-07-01");
eq("Q4", startOfQuarter("2026-12-31"), "2026-10-01");

// Whole calendar month — the Tech Tracker's five-block test.
eq("whole month", isWholeCalendarMonth("2026-08-01", "2026-08-31"), true);
eq("whole Feb", isWholeCalendarMonth("2026-02-01", "2026-02-28"), true);
eq("month minus a day", isWholeCalendarMonth("2026-08-01", "2026-08-30"), false);
eq("crosses months", isWholeCalendarMonth("2026-08-01", "2026-09-30"), false);
eq("mtd is not a whole month", isWholeCalendarMonth(...Object.values(rangeFor("mtd", REF))), false);

// Whole-week coverage. The pay engine runs over these, so a range that
// cuts a week in half still evaluates the WHOLE week.
// Wed 5 Aug to Wed 12 Aug touches TWO Sunday weeks (Aug 2-8, Aug 9-15),
// and both are partial — the engine still evaluates each whole week.
const w = weeksTouching("2026-08-05", "2026-08-12");
eq("weeks touched", w.length, 2);
eq("first week is a whole week", [w[0].weekStart, w[0].weekEnd], ["2026-08-02", "2026-08-08"]);
eq("first week is partial", w[0].partial, true);
eq("first week covered slice", [w[0].from, w[0].to], ["2026-08-05", "2026-08-08"]);
eq("last week is partial", w[1].partial, true);
eq("last week is a whole week", [w[1].weekStart, w[1].weekEnd], ["2026-08-09", "2026-08-15"]);
eq("last week covered slice", [w[1].from, w[1].to], ["2026-08-09", "2026-08-12"]);

// A range that is exactly whole weeks has no partial flags.
const whole = weeksTouching("2026-08-02", "2026-08-15");
eq("two whole weeks", whole.length, 2);
eq("neither partial", whole.map((x) => x.partial), [false, false]);

// The custom range named in the task's confirmations.
eq("3 May to 17 Sep spans", daysBetween("2026-05-03", "2026-09-17"), 138);
eq("3 May to 17 Sep not a month", isWholeCalendarMonth("2026-05-03", "2026-09-17"), false);
eq("3 May to 17 Sep weeks", weeksTouching("2026-05-03", "2026-09-17").length, 20);
// 3 May 2026 is itself a Sunday, so the first week is NOT partial.
eq("May 3 is a Sunday", sundayOf("2026-05-03"), "2026-05-03");
eq("first week whole", weeksTouching("2026-05-03", "2026-09-17")[0].partial, false);

eq("eachDay length", eachDay("2026-08-01", "2026-08-31").length, 31);
eq("eachDay crosses year", eachDay("2025-12-30", "2026-01-02"),
   ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
