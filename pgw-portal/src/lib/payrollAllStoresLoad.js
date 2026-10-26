// Extract All Stores, the loading half: every store's week in a few
// batched, RLS-scoped requests, shaped by the grid's own row rule. The
// CSV itself is built by lib/payrollAllStores.js (pure, tested offline).
import { supabase } from "./supabaseClient.js";
import { downloadFile } from "./csv.js";
import { buildPayrollRows } from "./payrollRows.js";
import { ratesOn } from "./payRates.js";
import { daysForWeek, isSundayWeek, weekDates, weekEndOf } from "./weekUtils.js";
import { ALL_STORES_ROLES, asExportRows, buildAllStoresCsv } from "./payrollAllStores.js";

const PAGE = 1000;   // PostgREST's row cap per request
const IN_CHUNK = 150; // ids per .in() filter, to keep the URL short

const chunk = (xs, n) => { const out = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

// Every page of a select (ordered, so pages don't overlap).
async function allPages(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}
async function inChunks(ids, build) {
  const out = [];
  for (const part of chunk(ids, IN_CHUNK)) out.push(...(await allPages(() => build(part))));
  return out;
}

export async function loadAllStoresPayroll({ role, weekStart, cutover }) {
  if (!ALL_STORES_ROLES.includes(role)) throw new Error("Only master and admin can extract all stores.");
  const isDaily = isSundayWeek(weekStart, cutover);
  const dates = isDaily ? weekDates(weekStart, cutover) : [];
  const dayLabels = daysForWeek(weekStart, cutover);

  const locs = (await allPages(() => supabase.from("locations")
    .select("id, store_number, name, brand, is_sandbox, is_home_office").order("id")))
    .filter((l) => !l.is_sandbox);
  const locIds = locs.map((l) => l.id);

  const [employees, entries, roleRatesRows] = await Promise.all([
    inChunks(locIds, (ids) => supabase.from("employees").select("*").in("location_id", ids).order("id")),
    inChunks(locIds, (ids) => supabase.from("timesheet_entries").select("*").in("location_id", ids).eq("week_start", weekStart).order("id")),
    allPages(() => supabase.from("role_sales_rates").select("position, sales_rate_per_hour").eq("brand", "speedee").order("position")),
  ]);
  const entIds = entries.map((e) => e.id);
  const empIds = employees.map((e) => e.id);
  const entById = Object.fromEntries(entries.map((e) => [e.id, e]));

  const [midasExt, speedeeExt, rateHist, payRows] = await Promise.all([
    inChunks(entIds, (ids) => supabase.from("timesheet_midas").select("*").in("timesheet_entry_id", ids).order("timesheet_entry_id")),
    inChunks(entIds, (ids) => supabase.from("timesheet_speedee").select("*").in("timesheet_entry_id", ids).order("timesheet_entry_id")),
    inChunks(empIds, (ids) => supabase.from("employee_pay_rate_history")
      .select("employee_id, rate_type, effective_date, amount").in("employee_id", ids).order("employee_id").order("effective_date")),
    inChunks(entIds, (ids) => supabase.from("timesheet_pay").select("*").in("timesheet_entry_id", ids).order("timesheet_entry_id")),
  ]);

  // Daily hours: the grid's own reader, one call per store, a few at a time.
  const daysByLoc = {};
  if (isDaily) {
    const weekEnd = weekEndOf(weekStart, cutover);
    for (const part of chunk(locs, 8)) {
      const res = await Promise.all(part.map((l) =>
        supabase.rpc("payroll_day_hours", { loc: l.id, d_from: weekStart, d_to: weekEnd })));
      res.forEach(({ data, error }, i) => {
        if (error) throw error;
        const dm = {};
        for (const d of data ?? []) {
          (dm[d.employee_id] ||= {})[d.work_date] = {
            hours_worked: Number(d.hours_worked || 0),
            hours_worked_other: Number(d.hours_worked_other || 0),
            hours_turned: Number(d.hours_turned || 0),
            source: d.source,
          };
        }
        daysByLoc[part[i].id] = dm;
      });
    }
  }

  const roleRates = Object.fromEntries(roleRatesRows.map((r) => [r.position, r.sales_rate_per_hour]));
  const histByEmp = {};
  for (const h of rateHist) (histByEmp[h.employee_id] ||= []).push(h);
  const rates = Object.fromEntries(empIds.map((id) => [id, ratesOn(histByEmp[id], weekStart)]));
  const pays = Object.fromEntries(payRows.map((p) => [p.timesheet_entry_id, p]));

  const stores = locs.map((loc) => {
    const isSpeedee = loc.brand === "speedee";
    const ext = {};
    for (const x of isSpeedee ? speedeeExt : midasExt) {
      const e = entById[x.timesheet_entry_id];
      if (e && e.location_id === loc.id) ext[e.employee_id] = x;
    }
    const rows = buildPayrollRows({
      employees: employees.filter((e) => e.location_id === loc.id),
      entries: entries.filter((e) => e.location_id === loc.id),
      ext, rates, pays, roleRates,
      days: daysByLoc[loc.id] ?? {},
      dates, isDaily, isSpeedee, privileged: true, weekStart, cutover,
    });
    return { loc, rows: asExportRows(rows, loc.brand) };
  });

  return { stores, dates, dayLabels };
}

export async function extractAllStores({ role, weekStart, cutover }) {
  const { stores, dates, dayLabels } = await loadAllStoresPayroll({ role, weekStart, cutover });
  const { csv, rowCount } = buildAllStoresCsv({ stores, week: weekStart, dates, dayLabels });
  downloadFile(`PGW_all_stores_payroll_week_${weekStart}.csv`, csv, "text/csv;charset=utf-8;");
  return { rowCount, storeCount: stores.filter((s) => s.rows.length).length };
}
