// =====================================================================
// Technician Tracker math — mirrors the Excel "Technician Tracking" tech
// sheets, replicating their formulas byte-for-byte (including one defect,
// see allocation below).
//
// Nothing here is persisted; every derived value is recomputed on read.
// This module runs the PER-TECHNICIAN view, which is MASTER/ADMIN ONLY:
// it needs the effective rates, and tech_pay_rates returns zero rows to a
// store user, so a store never reaches this pay. STORE-LEVEL aggregate
// labor cost comes from the SECURITY DEFINER functions tech_store_month /
// tech_store_daily instead (server-side), NOT from this file.
//
// The pay engine here MUST stay in sync with those two SQL functions in
// pgw_tech_time_tracker_24.sql.
//
// Weeks run SUNDAY..SATURDAY. Five blocks per month.
// =====================================================================

export const OT_THRESHOLD = 40;

export const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Division that returns null (render as "—") on a zero/blank denominator.
export const safeDiv = (n, d) => {
  const dd = num(d);
  if (dd === 0) return null;
  const r = num(n) / dd;
  return Number.isFinite(r) ? r : null;
};

// Sunday (as 'YYYY-MM-DD') of the week containing `isoDate`. dow: Sun=0.
export function weekStartOf(isoDate) {
  const d = new Date(isoDate + "T00:00:00");
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

// The five Sunday week-starts of a month: the Sunday on-or-before the 1st,
// then four more. Matches the tech sheet's fixed 5-block layout.
export function monthWeekStarts(year, month1to12) {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const sun = new Date(first);
  sun.setUTCDate(first.getUTCDate() - first.getUTCDay());
  const out = [];
  for (let i = 0; i < 5; i++) {
    const w = new Date(sun);
    w.setUTCDate(sun.getUTCDate() + i * 7);
    out.push(w.toISOString().slice(0, 10));
  }
  return out;
}

// Effective rate for a date: row with the greatest effective_date <= date.
// `rates` = [{ effective_date, flat_rate, guarantee_rate }]. null if none.
export function rateForDate(rates, isoDate) {
  let best = null;
  for (const r of rates || []) {
    if (r.effective_date <= isoDate) {
      if (!best || r.effective_date > best.effective_date) best = r;
    }
  }
  return best;
}

// ---- Per day (all derived, never stored) -----------------------------
// day = { hours_worked, flag_hours, labor_sales }; rate may be null.
export function computeTechDay(day, rate) {
  const hours = num(day?.hours_worked);
  const flag = num(day?.flag_hours);
  const labor = num(day?.labor_sales);
  const guaranteePay = hours * num(rate?.guarantee_rate); // K = E*guar
  const commission = flag * num(rate?.flat_rate); //          L = F*flat
  // ELR = labor<=0 ? 0 : labor/flag. Guard flag=0 so it never returns Inf.
  const elr = labor <= 0 || flag === 0 ? 0 : labor / flag;
  // `iso` and `inRange` are carried through untouched so a caller can tell
  // which day a computed row belongs to, and whether it falls inside the
  // selected date range. Neither affects any figure: the week is always
  // computed over all seven days, and inRange only decides what is drawn.
  return { iso: day?.iso, inRange: day?.inRange, hours, flag, labor, guaranteePay, commission, elr };
}

// ---- Per week --------------------------------------------------------
// days = that week's day rows (0..7). `rate` is the week's effective rate
// (rates are effective-dated and rarely change mid-week; guarantee_rate
// here feeds the OT premium exactly like the sheet's $E$3). otherPay is
// the weekly Other Pay (stored once per week, never daily).
export function computeTechWeek(days, rate, otherPay) {
  const guaranteeRate = num(rate?.guarantee_rate);
  const op = num(otherPay);

  let hoursTotal = 0, flagTotal = 0, laborTotal = 0;
  let guarTotal = 0, commTotal = 0, daysWorked = 0;
  const dayRows = (days || []).map((d) => {
    const cd = computeTechDay(d, rate);
    hoursTotal += cd.hours;
    flagTotal += cd.flag;
    laborTotal += cd.labor;
    guarTotal += cd.guaranteePay;
    commTotal += cd.commission;
    if (cd.hours > 0) daysWorked += 1; // COUNTIF(E6:E12,">0")
    return cd;
  });

  const proficiency = hoursTotal === 0 ? 0 : flagTotal / hoursTotal;
  const elrWeek = laborTotal <= 0 || flagTotal === 0 ? 0 : laborTotal / flagTotal;

  // Overtime: half-time premium ON TOP OF the guarantee (base hours are
  // already inside guarTotal), which is why it is * 0.5.
  let overtime = 0;
  if (hoursTotal >= OT_THRESHOLD) {
    overtime =
      guarTotal > commTotal
        ? (hoursTotal - OT_THRESHOLD) * guaranteeRate * 0.5
        : (hoursTotal - OT_THRESHOLD) * (commTotal / hoursTotal) * 0.5;
  }

  const totalPay = Math.max(guarTotal + overtime, commTotal) + op;
  const countdown = Math.max(0, OT_THRESHOLD - hoursTotal); // hide when 0

  const allocations = computeDailyAllocation(dayRows, {
    guarTotal, commTotal, overtime, otherPay: op, daysWorked,
  });
  const allocationTotal = allocations.reduce((a, b) => a + b, 0);

  return {
    hoursTotal, flagTotal, laborTotal, guarTotal, commTotal,
    proficiency, elrWeek, overtime, otherPay: op, totalPay, countdown,
    daysWorked, days: dayRows, allocations, allocationTotal,
  };
}

// ---- Daily pay allocation (DEFECT REPLICATED ON PURPOSE) -------------
// Horizon receives labor cost PER DAY, so weekly pay is spread across days
// using the spreadsheet's P-column formula. This does NOT sum to total_pay
// and that is intentional: a day with flag hours but zero clocked hours
// passes the (guar_pay + commission) > 0 gate and collects a share of
// overtime + other pay, yet is excluded from the divisor N (days with
// hours_worked > 0). Millwood week 3 allocates $913.15 against a true
// weekly pay of $896.08 — one surplus share of $17.07.
//
// DO NOT "fix" this. It is deliberate, to preserve continuity in Horizon's
// historical data. See the Task 4 brief, Part 3. The correct figure is
// total_pay; this defective figure is used ONLY for the Horizon payload.
export function computeDailyAllocation(dayRows, wk) {
  const N = wk.daysWorked; // COUNTIF(hours > 0) — the intentionally-wrong divisor
  const useGuar = wk.guarTotal + wk.overtime > wk.commTotal;
  return dayRows.map((cd) => {
    if (cd.guaranteePay + cd.commission <= 0) return 0;
    const base = useGuar
      ? cd.guaranteePay + (N ? wk.overtime / N : 0)
      : cd.commission;
    return base + (N ? wk.otherPay / N : 0);
  });
}

// ---- Per month (one slot) --------------------------------------------
// weeks = array of computeTechWeek(...) results (typically 5).
export function computeTechMonth(weeks) {
  const t = {
    hoursTotal: 0, flagTotal: 0, laborTotal: 0,
    guarTotal: 0, commTotal: 0, overtime: 0, otherPay: 0,
    totalPay: 0, allocationTotal: 0,
  };
  for (const w of weeks || []) {
    t.hoursTotal += w.hoursTotal;
    t.flagTotal += w.flagTotal;
    t.laborTotal += w.laborTotal;
    t.guarTotal += w.guarTotal;
    t.commTotal += w.commTotal;
    t.overtime += w.overtime;
    t.otherPay += w.otherPay;
    t.totalPay += w.totalPay;
    t.allocationTotal += w.allocationTotal;
  }
  t.proficiency = t.hoursTotal === 0 ? 0 : t.flagTotal / t.hoursTotal;
  t.elr = t.laborTotal <= 0 || t.flagTotal === 0 ? 0 : t.laborTotal / t.flagTotal;
  // Cost / Hour = month total_pay / flag hours  (Summary T-column).
  t.costPerHour = t.flagTotal === 0 ? 0 : t.totalPay / t.flagTotal;
  // Labor GP % = (ELR − cost/hour) / ELR, zero when it would error.
  t.laborGpPct = t.elr === 0 ? 0 : (t.elr - t.costPerHour) / t.elr;
  return t;
}

// ---- Store-visible tech summary row (NO pay needed) ------------------
// Proficiency and ELR come only from hours/flag/labor, so a store user can
// see them. Cost/Hour and Labor GP % need pay and are master/admin only.
export function computeTechSummaryStore(monthDays) {
  let hours = 0, flag = 0, labor = 0;
  for (const d of monthDays || []) {
    hours += num(d.hours_worked);
    flag += num(d.flag_hours);
    labor += num(d.labor_sales);
  }
  return {
    hours, flag, labor,
    proficiency: hours === 0 ? 0 : flag / hours,
    elr: labor <= 0 || flag === 0 ? 0 : labor / flag,
  };
}
