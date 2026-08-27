// =====================================================================
// The Report Builder's client-side vocabulary: how a measure is
// rendered, how the four presets fill the builder in, and how the store
// tree is assembled for the picker.
//
// WHAT IS DELIBERATELY NOT HERE
//   No measure list. The catalogue comes from report_measure_catalog()
//   so the picker and the query can never disagree about what exists —
//   and so a category added to a brand appears without a code change.
//   Presets therefore name GROUPS ("Tic sheet — categories (units)")
//   rather than enumerating keys: a new category joins the category
//   preset on its own.
//
//   No scoping. Which stores a user may report on is decided by
//   can_access_location() in the database. `stores` from AuthProvider is
//   already that list; this file only shapes it for display.
// =====================================================================

import { money, moneyCell, numOrDash, pct } from "./format.js";
import { CURRENCY_FMT, HOURS_FMT, PERCENT_FMT, QTY_FMT } from "./excelFormats.js";

// ---------------------------------------------------------------------
// WHO GETS THE BUILDER
//
// Task 10, Part 1 names district, regional, admin and master. It also
// observes that scoping a store user to their own store is free, and
// asks that this be FLAGGED for BDC rather than assumed — so it is a
// flag, off, and turning it on is this one line. Nothing else in the
// builder or the query changes: report_build() has always scoped by
// can_access_location(), which already resolves a store user to their
// own store, so the switch grants no reach that the database would not
// have granted anyway.
// ---------------------------------------------------------------------
export const STORE_USERS_MAY_BUILD_REPORTS = false;

export const REPORT_ROLES = ["district", "regional", "admin", "master"];

export const canBuildReports = (role) =>
  REPORT_ROLES.includes(role) || (STORE_USERS_MAY_BUILD_REPORTS && role === "store");

// The six groupings report_build() accepts, in menu order. Weeks are
// Sunday–Saturday everywhere in the portal; the note is shown under the
// control so nobody has to guess which Monday-or-Sunday convention this
// screen picked.
export const GROUP_BY = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
  ["store", "Store"],
  ["district", "District"],
  ["region", "Region"],
];

export const groupByLabel = (key) => GROUP_BY.find(([k]) => k === key)?.[1] ?? key;

// The default row cap. report_build() clamps whatever it is sent to
// [1, 20000]; this is the number the builder asks for and the number the
// "would return N rows" message is measured against.
export const DEFAULT_MAX_ROWS = 5000;

// ---------------------------------------------------------------------
// Rendering. `kind` comes from the catalogue, so screen and workbook
// always agree about what a column is.
//
// null is BLANK, never zero — a ratio with no denominator has no value,
// and printing 0.0% for it would assert something false. moneyCell()
// already draws zero as a dash, matching CURRENCY_FMT in the workbook.
// ---------------------------------------------------------------------
export function formatCell(kind, v) {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  switch (kind) {
    case "money":
    case "rate":
      return moneyCell(n);
    case "ratio":
      return pct(n);
    case "hours":
      return n === 0 ? "-" : numOrDash(n, 2);
    case "int":
      return n === 0 ? "-" : numOrDash(n, 0);
    default:
      return String(v);
  }
}

// Excel number format for a measure kind. Ratios are written as the raw
// fraction and formatted as a percentage by Excel; see PERCENT_FMT.
export function numFmtFor(kind) {
  switch (kind) {
    case "money":
    case "rate":
      return CURRENCY_FMT;
    case "ratio":
      return PERCENT_FMT;
    case "hours":
      return HOURS_FMT;
    case "int":
      return QTY_FMT;
    default:
      return null;
  }
}

// A measure cell as Excel should STORE it: a real number so the format
// applies, or null so an absent ratio stays an empty cell rather than a
// zero someone will later average.
export function excelValue(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Right-align everything numeric; only the bucket label is text.
export const alignRight = (kind) => kind !== "text";

// ---------------------------------------------------------------------
// The store tree for the picker: region -> district -> stores, built
// from the stores the user can already see. A store with no district
// (or a district with no region) is not dropped — it lands under an
// "Unassigned" heading, because a store that has fallen out of the
// hierarchy is exactly the one someone needs to notice.
// ---------------------------------------------------------------------
export function storeTree(stores = []) {
  const regions = new Map();
  for (const s of stores) {
    const d = s.district ?? null;
    const r = d?.region ?? null;
    const rKey = r?.id ?? "~none";
    const dKey = d?.id ?? "~none";
    if (!regions.has(rKey)) regions.set(rKey, { id: r?.id ?? null, name: r?.name ?? "Unassigned", districts: new Map() });
    const region = regions.get(rKey);
    if (!region.districts.has(dKey)) region.districts.set(dKey, { id: d?.id ?? null, name: d?.name ?? "Unassigned", stores: [] });
    region.districts.get(dKey).stores.push(s);
  }
  return [...regions.values()]
    .map((r) => ({
      ...r,
      districts: [...r.districts.values()]
        .map((d) => ({ ...d, stores: [...d.stores].sort(byStoreNumber) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const byStoreNumber = (a, b) => String(a.store_number ?? "").localeCompare(String(b.store_number ?? ""));

export const storesInDistrict = (stores, districtId) =>
  districtId == null ? [] : stores.filter((s) => (s.district?.id ?? s.district_id) === districtId);

export const storesInRegion = (stores, regionId) =>
  regionId == null ? [] : stores.filter((s) => s.district?.region?.id === regionId);

export const storeLabel = (s) => `#${s.store_number} · ${s.name}`;

// ---------------------------------------------------------------------
// PRESETS
//
// A blank builder is a builder nobody uses. Each of these fills all four
// choices and is then editable — nothing here is a mode, it is a
// starting point.
//
// FLAGGED for BDC: these four are a reasonable guess, not a researched
// answer. The question to ask is which three or four reports his boss
// asks for today; replacing these is editing this array and nothing
// else. `groups` names catalogue groups rather than measure keys, so a
// preset stays correct as measures are added.
//
// stores:
//   'current'   just the store in the header picker
//   'district'  every accessible store in that store's district
//   'keep'      leave the current selection alone
// ---------------------------------------------------------------------
export const PRESETS = [
  {
    key: "store_month",
    label: "Store month summary",
    hint: "One store · month to date · every summary and gross-profit measure · by day",
    range: "mtd",
    stores: "current",
    groupBy: "day",
    groups: ["Tic sheet — summary", "Gross profit"],
  },
  {
    key: "district_comparison",
    label: "District comparison",
    hint: "Every store in the district · month to date · sales, GP, ROs, capture rate · by store",
    range: "mtd",
    stores: "district",
    groupBy: "store",
    measures: ["sales", "gross_profit", "gross_profit_pct", "ro_count", "capture_rate"],
  },
  {
    key: "category_performance",
    label: "Category performance",
    hint: "Selected stores · month to date · every category with its % of cars · by store",
    range: "mtd",
    stores: "keep",
    groupBy: "store",
    groups: ["Tic sheet — categories (units)", "Tic sheet — categories (% of cars)"],
  },
  {
    key: "technician_productivity",
    label: "Technician productivity",
    hint: "Selected stores · month to date · hours, flag, labor sales, ELR, proficiency · by store",
    range: "mtd",
    stores: "keep",
    groupBy: "store",
    measures: ["tech_hours_worked", "tech_flag_hours", "tech_labor_sales", "tech_elr", "tech_proficiency"],
  },
];

// Resolve a preset's measure selection against the live catalogue. Named
// groups expand to every measure in them, in catalogue order; explicit
// keys are kept in the order the preset lists them. A key the catalogue
// does not carry is dropped rather than sent — report_build() would
// reject the whole request for one unknown measure, and losing a report
// because a column was renamed is worse than losing the column.
export function resolvePresetMeasures(preset, catalog = []) {
  if (preset.groups) {
    const wanted = new Set(preset.groups);
    return catalog.filter((m) => wanted.has(m.group_label)).map((m) => m.measure_key);
  }
  const known = new Set(catalog.map((m) => m.measure_key));
  return (preset.measures ?? []).filter((k) => known.has(k));
}

// Resolve a preset's store directive. Returns an array of store ids.
export function resolvePresetStores(preset, { stores = [], currentStore = null, selected = [] } = {}) {
  switch (preset.stores) {
    case "current":
      return currentStore ? [currentStore.id] : [];
    case "district": {
      const districtId = currentStore?.district?.id ?? currentStore?.district_id ?? null;
      const inDistrict = storesInDistrict(stores, districtId).map((s) => s.id);
      // A store with no district would otherwise resolve to an empty
      // report; fall back to the store itself rather than nothing.
      return inDistrict.length ? inDistrict : currentStore ? [currentStore.id] : [];
    }
    default: {
      const keep = selected.filter((id) => stores.some((s) => s.id === id));
      return keep.length ? keep : stores.map((s) => s.id);
    }
  }
}

// ---------------------------------------------------------------------
// Ordering the measure columns. The picker is a set, not a list, so the
// column order has to come from somewhere stable: the catalogue's
// sort_order, which groups related measures together and keeps the
// categories in their brand display order.
// ---------------------------------------------------------------------
export function orderMeasures(keys, catalog = []) {
  const rank = new Map(catalog.map((m) => [m.measure_key, m.sort_order]));
  return [...keys].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b));
}

// Group the catalogue for the picker, preserving catalogue order within
// and between groups.
export function groupCatalog(catalog = []) {
  const out = [];
  const byName = new Map();
  for (const m of [...catalog].sort((a, b) => a.sort_order - b.sort_order)) {
    if (!byName.has(m.group_label)) {
      const g = { label: m.group_label, measures: [] };
      byName.set(m.group_label, g);
      out.push(g);
    }
    byName.get(m.group_label).measures.push(m);
  }
  return out;
}

// A pay measure grouped by day is attributed, not paid — see the header
// of _report_tech_daily in migration 35. The builder says so on screen
// rather than letting someone quote a Tuesday's overtime at a meeting.
export const PAY_MEASURE_KEYS = ["tech_guarantee_pay", "tech_commission", "tech_overtime", "tech_other_pay"];

export const hasAttributedPay = (measures = [], groupBy = "") =>
  groupBy === "day" && measures.some((k) => PAY_MEASURE_KEYS.includes(k));

// Excel tab names: 31 chars, none of : \ / ? * [ ], unique per workbook.
export function sheetName(base, used) {
  const clean = String(base).replace(/[:\\/?*[\]]/g, "").slice(0, 31) || "Sheet";
  let n = clean;
  let i = 2;
  while (used.has(n)) {
    const suffix = `-${i++}`;
    n = clean.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(n);
  return n;
}

export { money };
