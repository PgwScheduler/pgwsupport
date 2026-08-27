// =====================================================================
// Conditional formatting for reports.
//
// THE RULES ARE DATA. They live in report_format_rules and leadership
// changes them; nothing in this file knows a threshold. What lives here
// is only how to EVALUATE a rule and what a colour token looks like on
// screen versus in a workbook.
//
// TWO PALETTES, ONE TOKEN — the same split migration 30 introduced with
// export_argb. The portal's theme is dark, so `--success-tint` is a very
// dark green that is correct behind pale text on screen and unreadable
// as a fill in a white Excel sheet. Each token therefore carries a
// screen pair and a separate light ARGB for the workbook.
// =====================================================================

export const COLOR_TOKENS = {
  pos:     { bg: "var(--success-tint)", fg: "var(--success)", border: "var(--success-border)", argb: "FFD5EFDA" },
  neg:     { bg: "var(--danger-tint)",  fg: "var(--danger)",  border: "var(--danger-border)",  argb: "FFF7D4D6" },
  warn:    { bg: "var(--warning-tint)", fg: "var(--warning)", border: "var(--warning-border)", argb: "FFFCEFC7" },
  neutral: { bg: "var(--surface-overlay)", fg: "var(--content-secondary)", border: "var(--hairline-strong)", argb: "FFEDEDED" },
  // Reserved for the store-name-fill-by-market rule. NOT seeded — BDC
  // has not said which colour belongs to which market, and five
  // invented colours would look authoritative while being made up.
  // Adding the mapping is five inserts into report_format_rules.
  market_1: { bg: "var(--accent-tint)", fg: "var(--accent-text)", border: "var(--hairline-strong)", argb: "FFFDE3D2" },
  market_2: { bg: "var(--success-tint)", fg: "var(--success)", border: "var(--success-border)", argb: "FFDDEFE2" },
  market_3: { bg: "var(--warning-tint)", fg: "var(--warning)", border: "var(--warning-border)", argb: "FFFBF0D5" },
  market_4: { bg: "var(--danger-tint)", fg: "var(--danger)", border: "var(--danger-border)", argb: "FFF6DCDE" },
  market_5: { bg: "var(--surface-overlay)", fg: "var(--content-secondary)", border: "var(--hairline-strong)", argb: "FFE4E4EA" },
};

export const tokenStyle = (token) => COLOR_TOKENS[token] ?? null;
export const tokenArgb = (token) => COLOR_TOKENS[token]?.argb ?? null;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Which number a rule is actually testing. `rank` looks at the row's
// position rather than its value, so "top five in green" needs no
// threshold that changes as the business grows.
function basisValue(rule, value, ctx) {
  if (rule.basis === "rank") return num(ctx?.rank);
  return num(value);
}

function comparisonHolds(rule, v) {
  const a = num(rule.threshold_a);
  const b = num(rule.threshold_b);
  switch (rule.comparison) {
    case "gt":  return a !== null && v >  a;
    case "gte": return a !== null && v >= a;
    case "lt":  return a !== null && v <  a;
    case "lte": return a !== null && v <= a;
    // `between` is inclusive at the bottom and exclusive at the top, so
    // adjacent bands (0.90–1.00 and >= 1.00) cannot both claim 1.00 and
    // leave the winner to rule order.
    case "between": return a !== null && b !== null && v >= a && v < b;
    default: return false;
  }
}

// The first matching rule wins, in sort_order. Ordering is the author's
// way of saying which band takes precedence, so it is honoured rather
// than collecting every match and picking arbitrarily.
export function matchRule(rules, measureKey, value, ctx) {
  if (!rules?.length) return null;
  const applicable = rules
    .filter((r) => r.measure_key === measureKey || r.measure_key === "*")
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const r of applicable) {
    const v = basisValue(r, value, ctx);
    // A rule never fires on a blank. An absent value is not a low value,
    // and colouring it red would invent a judgement about a store that
    // simply has not reported.
    if (v === null) continue;
    if (comparisonHolds(r, v)) return r;
  }
  return null;
}

// What a cell should render as: its own formatted text, or the rule's
// label when the rule carries one. `BOOM!` is exactly this — the rule
// says the value is no longer the interesting thing.
export function formatWithRules(rules, measureKey, value, formatted, ctx) {
  const rule = matchRule(rules, measureKey, value, ctx);
  if (!rule) return { text: formatted, token: null, label: null };
  return {
    text: rule.label ?? formatted,
    token: rule.color_token,
    label: rule.label ?? null,
  };
}

// Index the rules once per report rather than filtering the whole list
// for every cell — a 36-row report with 13 columns is 468 lookups.
export function indexRules(rules = []) {
  const byMeasure = new Map();
  for (const r of rules) {
    const k = r.measure_key;
    if (!byMeasure.has(k)) byMeasure.set(k, []);
    byMeasure.get(k).push(r);
  }
  for (const list of byMeasure.values()) list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  return {
    for: (measureKey) => [...(byMeasure.get(measureKey) ?? []), ...(byMeasure.get("*") ?? [])],
    all: rules,
  };
}
