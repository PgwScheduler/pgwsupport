// Offline checks for the calendar's birthdays and anniversaries.
// Run: node src/lib/scheduleMath.test.mjs
import { celebrationsByDate, monthGrid } from "./scheduleMath.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const sept = monthGrid(2026, 8).flat(); // Mon Aug 31 .. Sun Oct 4
const roster = [
  { id: "a", full_name: "Amy Able", birth_month: 9, birth_day: 24, hire_date: "2021-09-24", rehire_date: null },
  { id: "b", full_name: "Bob Baker", birth_month: 9, birth_day: 24, hire_date: "2010-01-05", rehire_date: "2023-09-10" },
  { id: "c", full_name: "Cal New", birth_month: null, birth_day: null, hire_date: "2026-09-14", rehire_date: null },
  { id: "d", full_name: "Dee Edge", birth_month: 10, birth_day: 3, hire_date: "2025-08-31", rehire_date: null },
];
const c = celebrationsByDate(roster, sept);
eq("two birthdays and one anniversary on 9/24, birthdays first, by name", c["2026-09-24"], [
  { kind: "birthday", id: "a", name: "Amy Able" },
  { kind: "birthday", id: "b", name: "Bob Baker" },
  { kind: "anniversary", id: "a", name: "Amy Able", years: 5 },
]);
eq("rehire date wins over the original hire", c["2026-09-10"], [{ kind: "anniversary", id: "b", name: "Bob Baker", years: 3 }]);
eq("original hire date is not also an anniversary", c["2026-01-05"], undefined);
eq("the hire day itself is not an anniversary", c["2026-09-14"], undefined);
eq("leading/trailing grid days count (Aug 31, Oct 3)", [c["2026-08-31"]?.[0]?.years, c["2026-10-03"]?.[0]?.kind], [1, "birthday"]);

const leap = [{ id: "l", full_name: "Leap Day", birth_month: 2, birth_day: 29, hire_date: "2024-02-29", rehire_date: null }];
eq("Feb 29 shows on Feb 28 in a non-leap year", celebrationsByDate(leap, monthGrid(2027, 1).flat())["2027-02-28"].map((x) => x.kind), ["birthday", "anniversary"]);
eq("Feb 29 stays on Feb 29 in a leap year", Object.keys(celebrationsByDate(leap, monthGrid(2028, 1).flat())), ["2028-02-29"]);

const dec = monthGrid(2026, 11).flat(); // runs into Jan 2027
const nye = [{ id: "n", full_name: "New Year", birth_month: 1, birth_day: 2, hire_date: "2020-01-02", rehire_date: null }];
eq("a grid spanning two years uses each day's own year", celebrationsByDate(nye, dec)["2027-01-02"].map((x) => x.years ?? x.kind), ["birthday", 7]);
eq("empty roster", celebrationsByDate([], sept), {});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
