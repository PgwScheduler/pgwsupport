// =====================================================================
// Matt's reports: the colour rules. ONE engine for screen and Excel.
//
// Every coloured column is described ONCE, as data: which cells it is
// compared with and which colour each band gets. From that description:
//   * evaluate()      paints the screen,
//   * excelRules()    writes LIVE conditional-formatting rules into the
//                     export (the user, 2026-09-21: "like Matt's"), each
//                     comparing the cell with ITS OWN ROW's goal cell --
//                     so editing a number or a goal in the file recolours
//                     it, and no row can be coloured against another
//                     store's goal (CM-9, CM-10).
// Both walk the same list of conditions, and scorecardRules.test.mjs
// runs the generated Excel formulas through an evaluator and checks
// they land on the screen's colour for every case.
//
// The bands are MUTUALLY EXCLUSIVE conditions, never "first match
// wins": Excel applies every matching rule, so an ordered ladder would
// depend on rule priority there and on list order here. Exclusive bands
// mean the two cannot disagree.
//
// Tier order (brief Part 5), used everywhere: green if above budget ->
// gold if at least gold -> silver if at least silver -> bronze if at
// least bronze -> red. CM-12 (Matt's red starting below silver, so
// bronze never shows) cannot happen.
//
// A blank is never coloured -- on screen or in the file.
// =====================================================================

// The exact Excel fills (brief Part 5) and their dark-theme screen
// tokens. Orange is the brand's interactive colour and is not a tier.
export const PALETTE = {
  green:  { fill: "C6EFCE", font: "006100", bg: "var(--success-tint)",     fg: "var(--success)" },
  red:    { fill: "FFC7CE", font: "9C0006", bg: "var(--danger-tint)",      fg: "var(--danger)" },
  yellow: { fill: "FFEB9C", font: "9C5700", bg: "var(--warning-tint)",     fg: "var(--warning)" },
  gold:   { fill: "FFE699", font: "000000", bg: "var(--tier-gold-bg)",     fg: "var(--tier-gold-fg)" },
  silver: { fill: "BFBFBF", font: "000000", bg: "var(--tier-silver-bg)",   fg: "var(--tier-silver-fg)" },
  bronze: { fill: "F8CBAD", font: "000000", bg: "var(--tier-bronze-bg)",   fg: "var(--tier-bronze-fg)" },
};

// Operands: { col: "<row key>" } reads the same row; { set: "<key>" } is
// a report_settings value; { num: n } is a literal.
const col = (k) => ({ col: k });
const set = (k) => ({ set: k });
const num = (v) => ({ num: v });

// The shapes. Each returns [{ token, when: [[op, left, right], ...] }]
// where `v` is the cell's own value. Conditions are ANDed.
const V = { self: true };
const SHAPES = {
  // Five-way tier against four cells in the row.
  tier: ({ budget, gold, silver, bronze }) => [
    { token: "green",  when: [[">", V, budget]] },
    { token: "gold",   when: [[">=", V, gold], ["<=", V, budget]] },
    { token: "silver", when: [[">=", V, silver], ["<", V, gold]] },
    { token: "bronze", when: [[">=", V, bronze], ["<", V, silver]] },
    { token: "red",    when: [["<", V, bronze]] },
  ],
  // At or above a goal cell is green; below is red.
  atLeast: ({ goal }) => [
    { token: "green", when: [[">=", V, goal]] },
    { token: "red",   when: [["<", V, goal]] },
  ],
  // Strictly above is green, below is red, exactly on it is left plain
  // (Matt: greaterThan -> green, lessThan -> red).
  above: ({ goal }) => [
    { token: "green", when: [[">", V, goal]] },
    { token: "red",   when: [["<", V, goal]] },
  ],
  // red < low <= yellow < high <= green
  bands: ({ low, high }) => [
    { token: "red",    when: [["<", V, low]] },
    { token: "yellow", when: [[">=", V, low], ["<", V, high]] },
    { token: "green",  when: [[">=", V, high]] },
  ],
  // red < low <= yellow <= high < green (% of goal: green is ABOVE 99.9%)
  bandsAbove: ({ low, high }) => [
    { token: "red",    when: [["<", V, low]] },
    { token: "yellow", when: [[">=", V, low], ["<=", V, high]] },
    { token: "green",  when: [[">", V, high]] },
  ],
  sign: () => [
    { token: "green", when: [[">", V, num(0)]] },
    { token: "red",   when: [["<", V, num(0)]] },
  ],
};

const tierCells = (budget, gold, silver, bronze) => ({ budget: col(budget), gold: col(gold), silver: col(silver), bronze: col(bronze) });
// % of budget in the market table: the tier percentages as fixed bands.
const pctTier = { budget: set("goal_pct_green_above"), gold: set("tier_gold_pct"), silver: set("tier_silver_pct"), bronze: set("tier_bronze_pct") };

// Which column gets which rule, per report. Keys are row keys from
// scorecard.js.
export const RULES = {
  scorecard: {
    cars:       ["atLeast", { goal: col("carGoalToday") }],
    aro:        ["bands", { low: set("aro_red_below"), high: set("aro_green_from") }],
    sales:      ["above", { goal: col("salesGoalToday") }],
    gp:         ["tier", tierCells("dailyGp", "dailyGold", "dailySilver", "dailyBronze")],
    gpPct:      ["bands", { low: set("gp_pct_red_below"), high: set("gp_pct_green_from") }],
    projGp:     ["tier", tierCells("gpBudget", "goldGp", "silverGp", "bronzeGp")],
    pctOfGoal:  ["bandsAbove", { low: set("goal_pct_red_below"), high: set("goal_pct_green_above") }],
    vs2025:     ["sign", {}],
  },
  markets: {
    projGp:              ["tier", tierCells("gpBudget", "goldGp", "silverGp", "bronzeGp")],
    gpYesterdayPerStore: ["tier", tierCells("dailyBudgetPerStore", "dailyGoldPerStore", "dailySilverPerStore", "dailyBronzePerStore")],
    pctOfBudget:         ["tier", pctTier],
    pctToBudget:         ["tier", pctTier],
  },
  tires: {
    tiresYest:   ["atLeast", { goal: col("dailyGoal") }],
    alignYest:   ["bands", { low: set("align_yellow_from"), high: set("align_green_from") }],
    tiresPerDay: ["atLeast", { goal: col("dailyGoal") }],
  },
};

export function conditionsFor(report, key) {
  const r = RULES[report]?.[key];
  if (!r) return null;
  const [shape, args] = r;
  return SHAPES[shape](args);
}

const isNum = (x) => x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x));

function operandValue(o, row, settings, self) {
  if (o === V) return self;
  if ("num" in o) return o.num;
  if ("set" in o) return settings[o.set];
  return row[o.col];
}

function holds(op, a, b) {
  switch (op) {
    case ">": return a > b;
    case ">=": return a >= b;
    case "<": return a < b;
    case "<=": return a <= b;
    default: return false;
  }
}

// The screen's colour for one cell: a PALETTE key, or null.
export function evaluate(report, key, row, settings) {
  const conds = conditionsFor(report, key);
  if (!conds) return null;
  const self = row[key];
  if (!isNum(self)) return null;
  for (const band of conds) {
    let all = true;
    for (const [op, l, r] of band.when) {
      const a = operandValue(l, row, settings, Number(self));
      const b = operandValue(r, row, settings, Number(self));
      if (!isNum(a) || !isNum(b) || !holds(op, Number(a), Number(b))) { all = false; break; }
    }
    if (all) return band.token;
  }
  return null;
}

export const cellStyle = (token) => (token ? { backgroundColor: PALETTE[token].bg, color: PALETTE[token].fg } : undefined);

// ---------------------------------------------------------------------
// Excel: live conditional formatting from the same conditions
// ---------------------------------------------------------------------
// addr(key) gives the column letter a row key was written to. The rule is
// written for the FIRST data row with relative rows ($A7, not $A$7) and
// applied to the whole range, so each row compares with its own cells.
// Settings are written as numbers, the way Matt's rules carry 275 / 0.58.
export function excelRules(report, key, { colOf, firstRow, lastRow, settings }) {
  const conds = conditionsFor(report, key);
  const self = colOf(key);
  if (!conds || !self) return null;
  const at = (c) => `${c}${firstRow}`;
  const refOf = (o) => {
    if (o === V) return at(self);
    if ("num" in o) return String(o.num);
    if ("set" in o) return String(settings[o.set]);
    const c = colOf(o.col);
    return c ? `$${c}${firstRow}` : null;
  };
  const rules = [];
  for (const band of conds) {
    const guards = new Set([`ISNUMBER(${at(self)})`]);
    const parts = [];
    let ok = true;
    for (const [op, l, r] of band.when) {
      const a = refOf(l), b = refOf(r);
      if (a === null || b === null) { ok = false; break; }
      for (const x of [a, b]) if (/^\$?[A-Z]+\d+$/.test(x)) guards.add(`ISNUMBER(${x})`);
      parts.push(`${a}${op}${b}`);
    }
    if (!ok) continue;
    rules.push({
      type: "expression",
      formulae: [`AND(${[...guards, ...parts].join(",")})`],
      style: {
        fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FF" + PALETTE[band.token].fill } },
        font: { color: { argb: "FF" + PALETTE[band.token].font } },
      },
      token: band.token, // for the test; ExcelJS ignores unknown keys
    });
  }
  return { ref: `${self}${firstRow}:${self}${lastRow}`, rules };
}
