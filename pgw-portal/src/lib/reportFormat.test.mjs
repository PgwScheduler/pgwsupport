// Offline checks for conditional formatting.
// Run: node src/lib/reportFormat.test.mjs
//
// The rules are DATA, so what is tested here is only the evaluator: that
// a band claims the values it should, that a blank is never coloured,
// and that a label replaces a value rather than sitting beside it.
import { matchRule, formatWithRules, indexRules, tokenArgb, tokenStyle, COLOR_TOKENS } from "./reportFormat.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const R = (o) => ({ threshold_a: null, threshold_b: null, label: null, sort_order: 0, ...o });

// The seeded prior-year pair: up green, down red.
const PY = [
  R({ measure_key: "sales_vs_py", comparison: "gt", threshold_a: 0, basis: "vs_prior_year", color_token: "pos", sort_order: 10 }),
  R({ measure_key: "sales_vs_py", comparison: "lt", threshold_a: 0, basis: "vs_prior_year", color_token: "neg", sort_order: 11 }),
];
eq("positive vs last year is green", matchRule(PY, "sales_vs_py", 1200)?.color_token, "pos");
eq("negative vs last year is red", matchRule(PY, "sales_vs_py", -1200)?.color_token, "neg");
// Exactly flat is neither: gt 0 and lt 0 both miss, and inventing a
// colour for "no change" would assert a judgement nobody wrote.
eq("flat is uncoloured", matchRule(PY, "sales_vs_py", 0), null);
// A blank is not a low value. Colouring an unreported store red would
// say something false about it.
eq("a null is never coloured", matchRule(PY, "sales_vs_py", null), null);
eq("an empty string is never coloured", matchRule(PY, "sales_vs_py", ""), null);
eq("a non-number is never coloured", matchRule(PY, "sales_vs_py", "n/a"), null);
eq("another measure is untouched", matchRule(PY, "sales", -1200), null);

// The percent-of-budget bands (placeholder cut points, but the BANDING
// behaviour is what matters here).
const BUDGET = [
  R({ measure_key: "pct_of_budget", comparison: "gte", threshold_a: 1.0, basis: "pct_of_goal", color_token: "pos", sort_order: 20 }),
  R({ measure_key: "pct_of_budget", comparison: "between", threshold_a: 0.9, threshold_b: 1.0, basis: "pct_of_goal", color_token: "warn", sort_order: 21 }),
  R({ measure_key: "pct_of_budget", comparison: "lt", threshold_a: 0.9, basis: "pct_of_goal", color_token: "neg", sort_order: 22 }),
];
eq("over budget is green", matchRule(BUDGET, "pct_of_budget", 1.14)?.color_token, "pos");
eq("just under is amber", matchRule(BUDGET, "pct_of_budget", 0.95)?.color_token, "warn");
eq("well under is red", matchRule(BUDGET, "pct_of_budget", 0.62)?.color_token, "neg");
// The boundary belongs to exactly one band. `between` is inclusive at
// the bottom and exclusive at the top, so 1.00 is green and only green.
eq("1.00 is green, not amber", matchRule(BUDGET, "pct_of_budget", 1.0)?.color_token, "pos");
eq("0.90 is amber, not red", matchRule(BUDGET, "pct_of_budget", 0.9)?.color_token, "warn");
eq("0.8999 is red", matchRule(BUDGET, "pct_of_budget", 0.8999)?.color_token, "neg");

// BOOM! — the label replaces the value entirely.
const BOOM = [
  R({ measure_key: "gold_remaining", comparison: "lte", threshold_a: 0, basis: "absolute", color_token: "pos", label: "BOOM!", sort_order: 30 }),
];
eq("a cleared tier reads BOOM!",
  formatWithRules(BOOM, "gold_remaining", -4200, "-$4,200.00"), { text: "BOOM!", token: "pos", label: "BOOM!" });
eq("exactly zero remaining is also cleared",
  formatWithRules(BOOM, "gold_remaining", 0, "-").text, "BOOM!");
eq("an uncleared tier keeps its figure",
  formatWithRules(BOOM, "gold_remaining", 5300, "$5,300.00"), { text: "$5,300.00", token: null, label: null });
// A tier a store does not have (Model B has no Bronze) must stay empty,
// not read BOOM!. A missing tier is not an achieved one.
eq("a tier the store does not have stays blank",
  formatWithRules(BOOM, "gold_remaining", null, ""), { text: "", token: null, label: null });

// Rule order decides precedence, so a broader rule listed later cannot
// steal a value from the narrower band above it.
const ORDERED = [
  R({ measure_key: "x", comparison: "gte", threshold_a: 100, basis: "absolute", color_token: "pos", sort_order: 1 }),
  R({ measure_key: "x", comparison: "gte", threshold_a: 0, basis: "absolute", color_token: "warn", sort_order: 2 }),
];
eq("first match by sort_order wins", matchRule(ORDERED, "x", 150)?.color_token, "pos");
eq("later band still catches the rest", matchRule(ORDERED, "x", 50)?.color_token, "warn");
eq("sort_order is honoured even when the array is shuffled",
  matchRule([ORDERED[1], ORDERED[0]], "x", 150)?.color_token, "pos");

// `rank` looks at the row's position, not its value — "top three green"
// needs no threshold that goes stale as the numbers grow.
const RANKED = [R({ measure_key: "gross_profit", comparison: "lte", threshold_a: 3, basis: "rank", color_token: "pos" })];
eq("rank 1 is coloured", matchRule(RANKED, "gross_profit", 999, { rank: 1 })?.color_token, "pos");
eq("rank 9 is not", matchRule(RANKED, "gross_profit", 999, { rank: 9 }), null);
eq("rank basis ignores the value entirely", matchRule(RANKED, "gross_profit", -5, { rank: 2 })?.color_token, "pos");

// The wildcard applies to every measure, so one rule can colour a whole
// report without being repeated per column.
const STAR = [R({ measure_key: "*", comparison: "lt", threshold_a: 0, basis: "absolute", color_token: "neg" })];
eq("wildcard colours any measure", matchRule(STAR, "anything_at_all", -1)?.color_token, "neg");

// Indexing must not change any verdict, only the lookup cost.
const idx = indexRules([...PY, ...BUDGET, ...STAR]);
eq("index finds a measure's own rules", idx.for("sales_vs_py").length, 3); // 2 own + 1 wildcard
eq("index still evaluates the same", matchRule(idx.for("pct_of_budget"), "pct_of_budget", 0.95)?.color_token, "warn");
eq("index appends the wildcard last", idx.for("pct_of_budget").at(-1).measure_key, "*");

// Two palettes, one token — the dark screen tint and the light workbook
// fill are different colours and must never be swapped.
eq("every token has a screen and an export colour",
  Object.values(COLOR_TOKENS).every((t) => t.bg?.startsWith("var(") && /^[0-9A-F]{8}$/.test(t.argb)), true);
eq("export fills are light, screen tints are not", tokenArgb("pos"), "FFD5EFDA");
eq("an unknown token has no style", tokenStyle("nope"), null);
eq("an unknown token has no fill", tokenArgb("nope"), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
