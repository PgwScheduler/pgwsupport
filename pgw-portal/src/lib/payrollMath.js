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
// The paycheck formula MUST stay in sync with payroll_pct_summary(), now
// rewritten in pgw_payroll_daily_sunday_32.sql (originally migration 14).
// =====================================================================

export const OT_THRESHOLD = 40;
export const OT_MULTIPLIER = 1.5;

// Targets from the source sheet.
export const TARGETS = { total: 0.26, cst: 0.1, vst: 0.16 };

// Midas positions. POSITIONS kept as the Midas alias for existing callers.
export const POSITIONS = [
  ["manager", "Manager"],
  ["front", "Front"],
  ["tech", "Tech"],
];
export const MIDAS_POSITIONS = POSITIONS;

export const SPEEDEE_POSITIONS = [
  ["manager", "Manager"],
  ["front", "Front"],
  ["cashier", "Cashier"],
  ["labor_pct_tech", "Labor % Tech"],
  ["pitman", "Pitman"],
  ["hood_tech", "Hood Tech"],
];

// Speedee holds a single payroll % target.
export const SPEEDEE_TARGET = 0.26;

export const positionsForBrand = (brand) =>
  brand === "speedee" ? SPEEDEE_POSITIONS : MIDAS_POSITIONS;

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

// ---- Hours, either side of the cutover --------------------------------
// From the cutover (migration 32) hours are daily and arrive already
// summed for the week as total_hours / total_turned, resolved per day
// across payroll_daily and tech_daily. Before it they are the two
// frozen weekly columns. Everything downstream reads these two helpers
// so no formula has to know which era it is looking at.
export const entryHours = (entry) =>
  entry?.total_hours != null
    ? num(entry.total_hours)
    : num(entry?.clock_hours_other) + num(entry?.clock_hours);

export const entryTurned = (entry) =>
  entry?.total_turned != null
    ? num(entry.total_turned)
    : num(entry?.hrs_turned_other) + num(entry?.hrs_turned_here);

// Worked at THIS store — the productivity denominator. Daily rows split
// it the same way the weekly columns did.
export const entryHoursHere = (entry) =>
  entry?.total_hours != null
    ? num(entry.total_hours) - num(entry.total_hours_other)
    : num(entry?.clock_hours);

// ---- Store-visible computed fields -----------------------------------
// `entry` carries the store-visible timesheet columns + the employee's
// position/name. No rates, no pay.
export function computeStoreRow(entry) {
  const clockHere = entryHoursHere(entry);
  const totalHours = entryHours(entry);
  const totalTurned = entryTurned(entry);
  const isTech = entry.position === "tech";
  return {
    totalHours,
    totalTurned,
    // productivity only meaningful for techs
    productivity: isTech ? safeDiv(totalTurned, clockHere) : null,
    aro: safeDiv(entry.actual_sales, entry.work_orders),
    pctOfGoal: safeDiv(entry.actual_sales, entry.sales_required),
  };
}

// ---- Master/admin pay fields -----------------------------------------
// `rate` = employee_pay_rates row (or null); `pay` = timesheet_pay row
// (or null).
//
// SALARIED means is_store_manager, NOT position === 'manager'. The old
// rule paid every 'manager' row a salary and never computed hourly or
// overtime for them, which silently swept assistant managers in with the
// GM. BDC's rule (migration 32) is that only the GM is salaried and
// excluded from payroll-to-sales, and that assistants stay in it — which
// is only coherent if assistants are hourly. An assistant manager needs
// employee_pay_rates.hourly_rate set; their manager_salary is ignored.
// MUST stay in sync with payroll_pct_summary() in migration 32.
export function computePayRow(entry, rate, pay) {
  const bonus = num(pay?.bonus);
  const incentives = num(pay?.incentives);
  const isSalaried = !!entry.is_store_manager;

  if (isSalaried) {
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
  const totalHours = entryHours(entry);
  const totalTurned = entryTurned(entry);

  // Overtime is WEEKLY — one 40-hour threshold on the week's total,
  // never per day, however the hours were captured.
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

// =====================================================================
// SPEEDEE
// Different sheet: no hours-turned / flat-rate / work-orders. Tech pay is
// labor-sales % + spiffs. Paychecks are ENTERED by payroll, never derived
// here — hourly/OT figures are reference only and must not feed pay.
// =====================================================================

// Store-visible Speedee row. `roleSalesRate` comes from role_sales_rates
// for the employee's position; labor_sales is store-visible (exposed so
// Total Incentive isn't a hidden-but-derivable figure).
export function computeSpeedeeStoreRow(entry, roleSalesRate) {
  const totalHours = entryHours(entry);
  const laborPctPay = entry.labor_pct_eligible
    ? num(entry.labor_pct_rate) * num(entry.labor_sales)
    : 0;
  const totalIncentive = num(entry.spiffs) + laborPctPay;
  const flat = entry.sales_expectation_flat;
  const salesExpectation =
    flat != null && flat !== "" ? num(flat) : totalHours * num(roleSalesRate);
  return { totalHours, laborPctPay, totalIncentive, salesExpectation };
}

// Master/admin reference figures — shown so payroll can sanity-check the
// paycheck they key in. They NEVER feed paycheck_amount.
export function computeSpeedeeRefRow(entry, rate) {
  const hourlyRate = num(rate?.hourly_rate);
  const totalHours = entryHours(entry);
  const regularHours = Math.min(totalHours, OT_THRESHOLD);
  const otHours = Math.max(totalHours - OT_THRESHOLD, 0);
  const hourlyEarned = hourlyRate * regularHours;
  const otEarned = hourlyRate * OT_MULTIPLIER * otHours;
  return { hourlyRate, regularHours, otHours, hourlyEarned, otEarned, hourlyAndOt: hourlyEarned + otEarned };
}

// Master/admin summary. Payroll $ is the SUM of ENTERED paychecks.
// rows: [{ entry, pay, roleSalesRate }].
export function computeSpeedeeSummary(rows, actualWeeklySales) {
  let payrollDollars = 0;
  let salesRequired = 0;
  for (const { entry, pay, roleSalesRate } of rows) {
    payrollDollars += num(pay?.paycheck_amount);
    salesRequired += computeSpeedeeStoreRow(entry, roleSalesRate).salesExpectation;
  }
  const aws = num(actualWeeklySales);
  return {
    payrollDollars,
    salesRequired,
    actualWeeklySales: aws,
    payrollPct: safeDiv(payrollDollars, aws),
  };
}
