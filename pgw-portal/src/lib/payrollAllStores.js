// =====================================================================
// Extract All Stores — one CSV for one pay week: every store plus the
// Home Office (#1515), sandbox left out, master/admin only.
//
// This file builds the CSV (pure); lib/payrollAllStoresLoad.js loads.
// Every read is an ordinary table select or the same invoker-rights
// payroll_day_hours() the grid uses, so RLS decides what comes back --
// there is no definer shortcut. Pay tables are admin/master-only by RLS;
// the button is only offered to those roles, and loadAllStoresPayroll
// refuses anyone else before a request is made.
//
// Rows are built by lib/payrollRows.js (the grid's own rule for who is on
// a week) and cells by lib/payrollExport.js (the single-store CSV's own
// cells), so a store's lines here match its own master/admin CSV.
//
// Midas and SpeeDee columns differ, so the file uses one combined set:
// a column a brand doesn't have is left blank on that brand's rows.
// =====================================================================

import { csvEsc } from "./csv.js";
import { computePayRow } from "./payrollMath.js";
import {
  headFor, storeCells, payCells, PAY_HEAD,
  SPEEDEE_STORE_HEAD, SPEEDEE_PAY_HEAD, speedeeStoreCells, speedeePayCells,
} from "./payrollExport.js";

export const ALL_STORES_ROLES = ["admin", "master"];

// SpeeDee's entered paycheck is the same figure as Midas's Paycheck.
const SPEEDEE_RENAME = { "Paycheck (entered)": "Paycheck" };

export const storeLabel = (loc) => (loc.is_home_office ? "Home Office" : `${loc.store_number ?? ""} ${loc.name}`.trim());

// ---------------------------------------------------------------------
// Pure: rows -> CSV text
// ---------------------------------------------------------------------

// The combined header: Store, Week of, then Midas's store columns, the
// SpeeDee-only store columns, Midas's pay columns, the SpeeDee-only pay
// columns. On a daily (Sunday) week Midas's columns carry one per day.
export function combinedHead(dayLabels) {
  const midasStore = headFor(dayLabels);
  const speedeeStore = SPEEDEE_STORE_HEAD.filter((h) => !midasStore.includes(h));
  const speedeePay = SPEEDEE_PAY_HEAD.map((h) => SPEEDEE_RENAME[h] ?? h).filter((h) => !PAY_HEAD.includes(h));
  return ["Store", "Week of", ...midasStore, ...speedeeStore, ...PAY_HEAD, ...speedeePay];
}

const zip = (heads, cells) => Object.fromEntries(heads.map((h, i) => [h, cells[i]]));

// One record (header -> value) per row, from the brand's own CSV cells.
function midasRecord(row, dates, dayLabels) {
  return { ...zip(headFor(dayLabels), storeCells(row, dates)), ...zip(PAY_HEAD, payCells(row)) };
}
function speedeeRecord(row, dates, dayLabels) {
  const rec = {
    ...zip(SPEEDEE_STORE_HEAD, speedeeStoreCells(row)),
    ...zip(SPEEDEE_PAY_HEAD.map((h) => SPEEDEE_RENAME[h] ?? h), speedeePayCells(row)),
  };
  // Hours worked per day apply to SpeeDee too; the SpeeDee CSV just has
  // no day columns of its own.
  dates.forEach((d, i) => { rec[dayLabels[i][1]] = row.days?.[d]?.hours_worked ?? 0; });
  return rec;
}

// stores: [{ loc, rows }] with rows already shaped like the grid's merged
// rows (entry/rate/pay plus mEntry/mRate/mPay/flatFlag).
export function buildAllStoresCsv({ stores, week, dates, dayLabels }) {
  const labels = dates.length ? dayLabels : [];
  const head = combinedHead(labels);
  const lines = [];
  const sorted = [...stores].sort((a, b) =>
    (Number(a.loc.store_number) || 0) - (Number(b.loc.store_number) || 0) || storeLabel(a.loc).localeCompare(storeLabel(b.loc)));
  for (const { loc, rows } of sorted) {
    const speedee = loc.brand === "speedee";
    const byName = [...rows].sort((a, b) => (a.employee.full_name || "").localeCompare(b.employee.full_name || ""));
    for (const r of byName) {
      const rec = speedee ? speedeeRecord(r, dates, labels) : midasRecord(r, dates, labels);
      rec["Store"] = storeLabel(loc);
      rec["Week of"] = week;
      lines.push(head.map((h) => rec[h] ?? ""));
    }
  }
  return { csv: [head, ...lines].map((r) => r.map(csvEsc).join(",")).join("\n"), rowCount: lines.length };
}

// The grid's merge step without on-screen edits: mEntry/mRate/mPay are
// the server values, and FLAT comes from the rates, as for master/admin.
export function asExportRows(rows, brand) {
  return rows.map((r) => {
    const mEntry = { ...r.entry }, mRate = { ...(r.rate || {}) }, mPay = { ...(r.pay || {}) };
    const flatFlag = brand === "speedee" ? false : computePayRow(mEntry, mRate, mPay).flatFlag;
    return { ...r, mEntry, mRate, mPay, flatFlag };
  });
}
