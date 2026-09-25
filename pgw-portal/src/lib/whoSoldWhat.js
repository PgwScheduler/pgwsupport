// =====================================================================
// Who Sold What (migration 70) — Matt's service penetration report.
//
// Per store, each service sold as a share of cars, against a goal, in
// three sections. Each section has an "average of 5" (the in_average
// services), a rank across every store shown, and the change from last
// month. Pure: the hook hands in report_build() rows and the layout table.
//
// DEFINITIONS (all from the template):
//   pct      units / cars                   e.g. Prem Oil = L25 / H4
//   per_day  units / days entered           LOF "min 7/day"
//   also_counts: other services whose units are ADDED to a column's own
//            (migration 71: LOF counts LOF + LOF Premium, all oil changes)
//   count    units
//   average  mean of the section's in_average % values: (M+N+O+P+Q)/5
//   rank     by that average, highest = 1; ties share a rank (1, 2, 2, 4)
//   market / PGW rows: pooled -- total units / total cars -- never an
//            average of store percentages
// A store with no cars in the month has no entered tic sheet: every
// value is null (shown blank, never 0) and it is not ranked.
// =====================================================================

export const SECTION_TITLES = {
  1: "Low Hanging Fruit",
  2: "Flushes",
  3: "Tires & Repairs",
};

// Colour bands, the shape of Matt's live rules on his "Aug 23" tab: at or
// above goal is green, a little under it is amber, well under is red.
// CLOSE is the fraction of goal where amber starts.
export const CLOSE = 0.75;

export const unitsKey = (serviceKey) => `cat_units_${serviceKey}`;

// The report_build measures this report needs.
export function measuresFor(goals) {
  const keys = new Set(goals.flatMap((g) => [g.service_key, ...(g.also_counts ?? [])]));
  return ["ro_count", "gross_sales", "days_with_data", ...[...keys].map(unitsKey)];
}

// A column's units: its own service plus any it also counts.
export const serviceKeysOf = (g) => [g.service_key, ...(g.also_counts ?? [])];

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

export function sectionsOf(goals) {
  const out = [];
  for (const s of [1, 2, 3]) {
    const cols = goals.filter((g) => g.section === s).sort((a, b) => a.sort_order - b.sort_order);
    if (!cols.length) continue;
    const avgCols = cols.filter((c) => c.in_average);
    const avgGoal = avgCols.length && avgCols.every((c) => num(c.goal) !== null)
      ? avgCols.reduce((a, c) => a + num(c.goal), 0) / avgCols.length
      : null;
    out.push({ section: s, title: SECTION_TITLES[s], cols, avgCount: avgCols.length, avgGoal });
  }
  return out;
}

// One store's (or a pooled group's) values for one period.
// `m` is a report_build measures object, or a pooled sum of them.
export function valuesOf(m, goals) {
  const cars = num(m?.ro_count) ?? 0;
  if (cars <= 0) return null; // nothing entered
  const days = num(m?.days_with_data) ?? 0;
  const values = {};
  for (const g of goals) {
    // A category with nothing sold has no unit row, so on an entered
    // month a missing count is 0, not blank.
    const u = serviceKeysOf(g).reduce((a, k) => a + (num(m?.[unitsKey(k)]) ?? 0), 0);
    values[g.service_key] =
      g.measure === "pct" ? u / cars
      : g.measure === "per_day" ? (days > 0 ? u / days : null)
      : u;
  }
  const avg = {};
  for (const s of [1, 2, 3]) {
    const cols = goals.filter((g) => g.section === s && g.in_average);
    avg[s] = cols.length ? cols.reduce((a, g) => a + values[g.service_key], 0) / cols.length : null;
  }
  return { cars, sales: num(m?.gross_sales), days, values, avg };
}

// Sum report_build measures objects (for market and company rows).
export function pool(list, goals) {
  const keys = measuresFor(goals);
  const out = {};
  let any = false;
  for (const m of list) {
    if (!m || (num(m.ro_count) ?? 0) <= 0) continue;
    any = true;
    for (const k of keys) out[k] = (out[k] ?? 0) + (num(m[k]) ?? 0);
  }
  return any ? out : null;
}

// Competition ranking: highest first, ties share, gaps after ties.
export function rankOf(pairs) {
  const sorted = pairs.filter((p) => p.value !== null && p.value !== undefined).sort((a, b) => b.value - a.value);
  const ranks = {};
  sorted.forEach((p, i) => {
    ranks[p.id] = i > 0 && sorted[i - 1].value === p.value ? ranks[sorted[i - 1].id] : i + 1;
  });
  return ranks;
}

// Colour token for a value against its goal: green / yellow / red, or
// null when there is no goal or no value (never colour a blank).
export function tokenFor(value, goal) {
  const v = num(value), g = num(goal);
  if (v === null || g === null || g <= 0) return null;
  if (v >= g) return "green";
  if (v >= g * CLOSE) return "yellow";
  return "red";
}

// stores: [{ id, name, storeNumber, marketId, sort, fill, font, cur, prev }]
//   cur / prev: report_build measures for the month and the month before
// markets: [{ id, name, sort_order, display_color, display_font_color }]
export function buildWhoSoldWhat(stores, markets, goals, { marketId = null } = {}) {
  const sections = sectionsOf(goals);
  const shown = stores
    .filter((s) => !marketId || s.marketId === marketId)
    .map((s) => {
      const cur = valuesOf(s.cur, goals);
      const prev = valuesOf(s.prev, goals);
      // raw keeps the report_build measures so market rows can pool units.
      return { ...s, raw: { cur: s.cur, prev: s.prev }, cur, prev, delta: deltaOf(cur, prev, sections) };
    });

  const rank = {};
  for (const { section } of sections) {
    rank[section] = rankOf(shown.map((s) => ({ id: s.id, value: s.cur?.avg[section] ?? null })));
  }
  const rows = shown.map((s) => ({ ...s, rank: Object.fromEntries(sections.map(({ section }) => [section, rank[section][s.id] ?? null])) }));

  const mkts = [...markets].sort((a, b) => a.sort_order - b.sort_order)
    .filter((m) => rows.some((r) => r.marketId === m.id));
  const groups = mkts.map((m) => {
    const members = rows.filter((r) => r.marketId === m.id).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const cur = valuesOf(pool(members.map((r) => r.raw.cur), goals), goals);
    const prev = valuesOf(pool(members.map((r) => r.raw.prev), goals), goals);
    return { market: m, rows: members, total: { name: `${m.name} total`, isTotal: true, cur, prev, delta: deltaOf(cur, prev, sections) } };
  });
  const allCur = valuesOf(pool(rows.map((r) => r.raw.cur), goals), goals);
  const allPrev = valuesOf(pool(rows.map((r) => r.raw.prev), goals), goals);
  return {
    sections,
    groups,
    total: { name: marketId ? "Market total" : "PGW total", isTotal: true, cur: allCur, prev: allPrev, delta: deltaOf(allCur, allPrev, sections) },
    storeCount: rows.length,
    enteredCount: rows.filter((r) => r.cur).length,
  };
}

function deltaOf(cur, prev, sections) {
  const d = {};
  for (const { section } of sections) {
    d[section] = cur && prev && cur.avg[section] !== null && prev.avg[section] !== null ? cur.avg[section] - prev.avg[section] : null;
  }
  return d;
}

// The month before a 'YYYY-MM' month, and a month's first/last day.
export function prevMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
export function monthBounds(ym) {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
}
