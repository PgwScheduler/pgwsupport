// Offline checks for bonus plan setup (migration 85).
// Run: node src/lib/bonusSetup.test.mjs
import { thresholdsFor, parsePastedColumn, pctToInput, inputToPct, groupProblems, MODEL_DEFAULT_RULES } from "./bonusSetup.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

// Same numbers the PGlite run produced from the SQL rule.
eq("A budget rule", thresholdsFor(MODEL_DEFAULT_RULES.A, { gp_budget: "93506.55" }),
  { gold: 88831.22, silver: 84155.9, bronze: 74805.24 });
eq("Wesmark bronze 85%", thresholdsFor({ ...MODEL_DEFAULT_RULES.A, bronze_pct: 0.85 }, { gp_budget: 92857.14 }).bronze, 78928.57);
eq("B last-year rule", thresholdsFor(MODEL_DEFAULT_RULES.B, { last_year_gp: 57200 }),
  { gold: 62925.72, silver: 54340, bronze: null });
eq("B floor wins in a weak month", thresholdsFor(MODEL_DEFAULT_RULES.B, { last_year_gp: 20000 }),
  { gold: 35000, silver: 35000, bronze: null });
eq("B typed 50,000", thresholdsFor(MODEL_DEFAULT_RULES.B, { last_year_gp: "50,000" }).gold, 55005);
eq("blank budget -> nulls, not zeros", thresholdsFor(MODEL_DEFAULT_RULES.A, { gp_budget: "" }),
  { gold: null, silver: null, bronze: null });
eq("blank LY -> nulls", thresholdsFor(MODEL_DEFAULT_RULES.B, { last_year_gp: null }).gold, null);

eq("paste a column", parsePastedColumn("$93,506.55\n88000\n\n70,000.10\n"), [93506.55, 88000, null, 70000.1]);
eq("paste CRLF + tabs takes first cell", parsePastedColumn("1\tx\r\n2\ty\r\n"), [1, 2]);
eq("paste junk -> NaN", parsePastedColumn("abc").map(Number.isNaN), [true]);

eq("pct to input", [pctToInput(0.95), pctToInput(1.1001), pctToInput(null)], ["95", "110.01", ""]);
eq("input to pct", [inputToPct("95"), inputToPct("110.01"), inputToPct("")], [0.95, 1.1001, null]);

const g = groupProblems([
  { location_id: null, problem: "no A rates for 2027" },
  { location_id: "x", store_number: "2320", month: 1, problem: "GP budget missing" },
  { location_id: "x", store_number: "2320", month: 2, problem: "GP budget missing" },
]);
eq("problems grouped", [g.general, g.byStore.x.length], [["no A rates for 2027"], 2]);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
