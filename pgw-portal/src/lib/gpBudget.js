// =====================================================================
// GP vs Budget — the year's gross profit against each store's full-year
// GP budget, projected at the current daily pace (John's report, from
// the "2026 Gross Profit vs Budget — Through May" slide).
//
//   * Budget       = the 12 monthly gp_budget rows in bonus_monthly_targets
//   * YTD GP       = report_build() gross profit, Jan 1 to the through date
//                    (the same GP every other report uses, adjustments in)
//   * Daily GP     = YTD GP / open days elapsed (Mon–Sat less holidays,
//                    open_days_between) -- the slide's own pace: Sunbeam
//                    $188,525 / $1,473 = 128 open days to May 31
//   * Proj Full Yr = Daily GP x open days in the whole year (308 in 2026)
//   * Track %      = Proj Full Yr / Budget; 100% or more is Over
//   * Projected Trend = the annual bonus tier Track % is on pace for
//                    (cutoffs in bonusTiers.js); "N/A" for a store whose
//                    bonus model has no Gold/Silver/Bronze ladder
//   * Months on budget = each finished month's GP against that month's
//                    budget, per division (the "N of 12" grid)
//
// Lead = region, Division = district. Totals add stores up; a total's
// Track % only counts stores that HAVE a budget, so a store with sales
// and no budget cannot lift its division.
//
// A region in SPLIT_REGIONS is two markets under one RM: its districts
// show as groups of their own (like Charleston), and the region's
// combined total moves to the bottom, above PGW TOTAL. Display only --
// the region and its districts are unchanged in the data.
// =====================================================================

import { MODELS_WITHOUT_TIERS, annualTier } from "./bonusTiers.js";

export const SPLIT_REGIONS = new Set(["Florida & North"]);

export const BAND_RED = 0.80;  // below this Track % reads red (exactly 80% does not)
export const BAND_GREEN = 1.0; // at or above it reads green, and "Over"

export const trackTone = (t) => (t == null ? null : t >= BAND_GREEN ? "over" : t < BAND_RED ? "low" : "under");

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// Months fully inside Jan 1..through: May 31 -> 5, May 30 -> 4.
export function completedMonths(through) {
  const [y, m, d] = through.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d === last ? m : m - 1;
}

function storeRow(s, budgetByMonth, gpByMonth, ctx) {
  const bMonths = Object.values(budgetByMonth ?? {});
  const budget = bMonths.length ? sum(bMonths) : null;
  const gpMonths = Object.values(gpByMonth ?? {});
  const ytd = gpMonths.length ? sum(gpMonths) : null;
  const daily = ytd != null && ctx.elapsed > 0 ? ytd / ctx.elapsed : null;
  const proj = daily != null ? daily * ctx.yearDays : null;
  const track = proj != null && budget ? proj / budget : null;
  // "na" = the store's plan has no tiers; null = no budget or no pace yet.
  const trend = s.model && MODELS_WITHOUT_TIERS.has(s.model) ? "na" : annualTier(track)?.key ?? null;
  return { ...s, budget, ytd, daily, proj, track, trend, budgetByMonth: budgetByMonth ?? {}, gpByMonth: gpByMonth ?? {} };
}

function totalRow(label, rows) {
  const pick = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null); return v.length ? sum(v) : null; };
  const budgeted = rows.filter((r) => r.budget);
  const budget = budgeted.length ? sum(budgeted.map((r) => r.budget)) : null;
  const projBudgeted = sum(budgeted.map((r) => r.proj ?? 0));
  const track = budget ? projBudgeted / budget : null;
  return {
    label, budget, ytd: pick("ytd"), daily: pick("daily"), proj: pick("proj"),
    track, trend: annualTier(track)?.key ?? null,
  };
}

// Each finished month: did the group's GP reach the group's budget?
// null = nobody entered anything that month (not a miss).
function monthGrid(rows, nDone) {
  const cells = [];
  for (let m = 1; m <= 12; m++) {
    if (m > nDone) { cells.push({ month: m, state: "future" }); continue; }
    const budgeted = rows.filter((r) => r.budgetByMonth[m]);
    const entered = budgeted.some((r) => r.gpByMonth[m] != null);
    const budget = sum(budgeted.map((r) => r.budgetByMonth[m]));
    const gp = sum(budgeted.map((r) => r.gpByMonth[m] ?? 0));
    cells.push({ month: m, budget, gp, state: !budget || !entered ? "none" : gp >= budget ? "hit" : "miss" });
  }
  return { cells, hits: cells.filter((c) => c.state === "hit").length, done: nDone };
}

// raw: { stores:[{id,storeNumber,name,brand,districtId,sort}], districts:[{id,name,regionId}],
//        regions:[{id,name}], budgets:[{location_id,month,gp_budget}],
//        gp:[{store_id,month,gp}], models:{[location_id]:'A'|'B'|'C'|'D'},
//        elapsed, yearDays, through }
// opts.includeSpeedee: SpeeDee stores are left out unless asked for.
export function buildGpBudget(raw, { includeSpeedee = false } = {}) {
  const ctx = { elapsed: raw.elapsed, yearDays: raw.yearDays };
  const nDone = completedMonths(raw.through);

  const budgets = {};
  for (const b of raw.budgets) {
    if (b.gp_budget == null) continue;
    (budgets[b.location_id] ||= {})[b.month] = Number(b.gp_budget);
  }
  const gp = {};
  for (const g of raw.gp) {
    if (g.gp == null) continue;
    (gp[g.store_id] ||= {})[g.month] = Number(g.gp);
  }

  // A location with neither a budget nor any GP (the Home Office) is not
  // a store this report is about.
  const stores = raw.stores
    .filter((s) => includeSpeedee || s.brand !== "speedee")
    .filter((s) => budgets[s.id] || gp[s.id])
    .map((s) => storeRow({ ...s, model: raw.models?.[s.id] ?? null }, budgets[s.id], gp[s.id], ctx));

  const dist = Object.fromEntries(raw.districts.map((d) => [d.id, d]));
  const reg = Object.fromEntries(raw.regions.map((r) => [r.id, r]));
  const leads = new Map();
  for (const s of stores) {
    const d = dist[s.districtId];
    const r = d ? reg[d.regionId] : null;
    const lk = r?.id ?? "none", dk = d?.id ?? "none";
    if (!leads.has(lk)) leads.set(lk, { id: lk, name: r?.name ?? "No region", divisions: new Map() });
    const L = leads.get(lk);
    if (!L.divisions.has(dk)) L.divisions.set(dk, { id: dk, name: d?.name ?? "No district", stores: [] });
    L.divisions.get(dk).stores.push(s);
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const built = [...leads.values()].map((L) => {
    const divisions = [...L.divisions.values()].sort(byName).map((D) => {
      // Matt's report row order (store_report_profile), then by name.
      D.stores.sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || byName(a, b));
      return { ...D, total: totalRow(`${D.name} TOTAL`, D.stores), grid: monthGrid(D.stores, nDone) };
    });
    const all = divisions.flatMap((D) => D.stores);
    return { id: L.id, name: L.name, divisions, total: totalRow(`${L.name} TOTAL`, all), grid: monthGrid(all, nDone) };
  });

  // A split region becomes one group per district, named for it; its
  // combined total is kept as built, for the bottom of the report.
  const out = [], combinedTotals = [];
  for (const L of built) {
    if (!SPLIT_REGIONS.has(L.name) || L.divisions.length < 2) { out.push(L); continue; }
    for (const D of L.divisions) out.push({ id: D.id, name: D.name, divisions: [D], total: D.total, grid: D.grid });
    combinedTotals.push(L.total);
  }
  out.sort(byName);

  return {
    leads: out,
    combinedTotals,
    total: totalRow("PGW TOTAL", stores),
    grid: monthGrid(stores, nDone),
    storeCount: stores.length,
    withBudget: stores.filter((s) => s.budget).length,
    withGp: stores.filter((s) => s.ytd != null).length,
    completedMonths: nDone,
  };
}
