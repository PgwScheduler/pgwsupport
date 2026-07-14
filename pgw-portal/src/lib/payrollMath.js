// =====================================================================
// Payroll math — mirrors the store payroll spreadsheet, corrected.
//
// Nothing here is persisted; every derived value is recomputed on read
// (same pattern as drawerMath.js). Two tiers of computation:
//   - computeStoreRow: fields a STORE user is allowed to see.
//   - computePayRow:   MASTER/ADMIN pay fields (rates, OT, paycheck).
// The store code path never receives the inputs computePayRow needs, so
// pay figures can't leak through the UI.
//
// The paycheck formula MUST stay in sync with payroll_pct_summary() in
// pgw_employee_hours_payroll_rebuild_14.sql.
// =====================================================================

export const OT_THRESHOLD = 40;
export const OT_MULTIPLIER = 1.5;

// Targets from the source sheet.
export const TARGETS = { total: 0.26, cst: 0.1, vst: 0.16 };

export const POSITIONS = [
  ["manager", "Manager"],
  ["front", "Front"],
  ["tech", "Tech"],
];

export const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Guard every division: a blank/zero denominator renders as "—", never
// NaN or Infinity. Returns null so callers can format it as a dash.
export const safeDiv = (n, d) => {
  const dd = num(d);
  if (dd === 0) return null;
  const r = num(n) / dd;
  return Number.isFinite(r) ? r : null;
};

// ---- Store-visible computed fields -----------------------------------
// `entry` carries the store-visible timesheet columns + the employee's
// position/name. No rates, no pay.
export function computeStoreRow(entry) {
  const clockHere = num(entry.clock_hours);
  const totalHours = num(entry.clock_hours_other) + clockHere;
  const totalTurned = num(entry.hrs_turned_other) + num(entry.hrs_turned_here);
  const isTech = entry.position === "tech";
  return {
    totalHours,
    totalTurned,
    // productivity only meaningful for techs
    productivity: isTech ? safeDiv(entry.hrs_turned_here, clockHere) : null,
    aro: safeDiv(entry.actual_sales, entry.work_orders),
    pctOfGoal: safeDiv(entry.actual_sales, entry.sales_required),
  };
}

// ---- Master/admin pay fields -----------------------------------------
// `rate` = employee_pay_rates row (or null); `pay` = timesheet_pay row
// (or null). Managers are salaried: hourly/OT/flat don't apply.
export function computePayRow(entry, rate, pay) {
  const bonus = num(pay?.bonus);
  const incentives = num(pay?.incentives);
  const isManager = entry.position === "manager";

  if (isManager) {
    const salary = num(rate?.manager_salary);
    return {
      manager: true,
      hourlyRate: null,
      flatRate: null,
      regularHours: null,
      otHours: null,
      hourlyEarned: null,
      otEarned: null,
      totalHourly: null,
      totalFlat: null,
      bonus,
      incentives,
      paycheck: salary + bonus + incentives,
      flatFlag: false,
    };
  }

  const hourlyRate = num(rate?.hourly_rate);
  const flatRate = num(rate?.flat_rate_per_hour);
  const totalHours = num(entry.clock_hours_other) + num(entry.clock_hours);
  const totalTurned = num(entry.hrs_turned_other) + num(entry.hrs_turned_here);

  const regularHours = Math.min(totalHours, OT_THRESHOLD);
  const otHours = Math.max(totalHours - OT_THRESHOLD, 0);
  const hourlyEarned = hourlyRate * regularHours;
  const otEarned = hourlyRate * OT_MULTIPLIER * otHours; // 0 when <= 40h
  const totalHourly = hourlyEarned + otEarned;
  const totalFlat = flatRate * totalTurned;

  return {
    manager: false,
    hourlyRate,
    flatRate,
    regularHours,
    otHours,
    hourlyEarned,
    otEarned,
    totalHourly,
    totalFlat,
    bonus,
    incentives,
    paycheck: Math.max(totalHourly, totalFlat) + bonus + incentives,
    flatFlag: totalFlat > totalHourly,
  };
}

// ---- Payroll summary (master/admin, dollars + percentages) -----------
// rows: [{ entry, rate, pay }]. Store users don't call this — they read
// percentages from the payroll_pct_summary RPC (no dollars exposed).
export function computePayrollSummary(rows) {
  let actualSales = 0;
  let payrollDollars = 0;
  let cstDollars = 0;

  for (const { entry, rate, pay } of rows) {
    actualSales += num(entry.actual_sales);
    const p = computePayRow(entry, rate, pay);
    payrollDollars += p.paycheck;
    if (entry.position === "manager" || entry.position === "front") {
      cstDollars += p.paycheck;
    }
  }

  const totalPct = safeDiv(payrollDollars, actualSales);
  const cstPct = safeDiv(cstDollars, actualSales);
  const vstPct = totalPct == null ? null : totalPct - cstPct;

  return { actualSales, payrollDollars, cstDollars, totalPct, cstPct, vstPct };
}
