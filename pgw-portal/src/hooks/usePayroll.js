import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { weekEndOf, weekDates, isSundayWeek } from "../lib/weekUtils.js";
import { ratesOn } from "../lib/payRates.js";
import { buildPayrollRows } from "../lib/payrollRows.js";

const PRIVILEGED = ["admin", "master"];
// Fields that live on the shared core table; everything else routes to the
// brand extension (timesheet_midas / timesheet_speedee).
const CORE_KEYS = ["pto_days", "clock_hours_other", "clock_hours"];

// Brand-aware payroll data. Fetches the shared roster + core weekly rows
// and merges the brand's extension table. Pay tables (rates, timesheet_pay)
// are fetched only for admin/master — a store never receives per-employee
// pay in the network response. Store-visible aggregates come from the
// brand's SECURITY DEFINER summary RPC.
//
// From the cutover (migration 32) hours are DAILY. They are read through
// payroll_day_hours(), which resolves each (person, day) to exactly one
// source — tech_daily for a technician, payroll_daily for everyone else —
// so this hook never has to merge the two itself or decide who is a
// technician. A day whose source is 'tech' is READ-ONLY here: it is
// entered in the Tech Tracker, and the database refuses a second copy.
//
// The weekly totals are summed from those day rows rather than read back
// from payroll_week_hours, so an edit shows in the totals immediately
// instead of after a round trip. Both compute the same figure; the RPC
// is the authority and the grid reconciles to it on the next fetch.
//
// WHO IS ON THE WEEK (migration 56): anyone with hours or a timesheet
// row in it, or anyone employed during it (lib/payRates.js
// employedDuring). The whole roster is fetched, active or not, so ending
// someone's employment no longer erases them from weeks they worked.
//
// RATES (migration 56) are effective-dated: each row carries the rates
// in force at THIS week's start, read from employee_pay_rate_history.
// They are edited on the employee profile, never in the grid.
export function usePayroll(locationId, weekStart, brand, cutover) {
  const { user, role } = useAuth();
  const privileged = PRIVILEGED.includes(role);
  const isSpeedee = brand === "speedee";
  const extTable = isSpeedee ? "timesheet_speedee" : "timesheet_midas";
  const isDaily = isSundayWeek(weekStart, cutover);

  const [employees, setEmployees] = useState([]);
  const [entries, setEntries] = useState([]);   // core timesheet_entries rows
  const [ext, setExt] = useState({});            // employee_id -> brand extension row
  const [rates, setRates] = useState({});        // employee_id -> pay_rate (privileged)
  const [pays, setPays] = useState({});          // entry_id    -> timesheet_pay (privileged)
  const [roleRates, setRoleRates] = useState({}); // position -> sales_rate_per_hour (speedee)
  const [weekSales, setWeekSales] = useState(null); // store_week_sales row (speedee)
  const [rpcSummary, setRpcSummary] = useState(null);
  const [flatFlags, setFlatFlags] = useState({});
  const [days, setDays] = useState({});      // empId -> dateIso -> day row
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Only the latest fetch may write. A store change resets the week while
  // the first fetch is still in flight; without this the older response
  // could land last and leave the grid showing another week's hours.
  const seq = useRef(0);

  const fetchAll = useCallback(async () => {
    if (!locationId || !weekStart) return;
    const mine = ++seq.current;
    const stale = () => mine !== seq.current;
    setLoading(true);

    const [empRes, entRes] = await Promise.all([
      supabase.from("employees").select("*").eq("location_id", locationId)
        .order("position", { ascending: true }).order("created_at", { ascending: true }),
      supabase.from("timesheet_entries").select("*").eq("location_id", locationId).eq("week_start", weekStart),
    ]);
    if (stale()) return;
    if (empRes.error || entRes.error) {
      setError((empRes.error || entRes.error).message);
      setLoading(false);
      return;
    }
    setError(null);
    setEmployees(empRes.data ?? []);
    setEntries(entRes.data ?? []);

    const entRows = entRes.data ?? [];
    const entIds = entRows.map((e) => e.id);
    const entById = {};
    for (const e of entRows) entById[e.id] = e;

    // Brand extension rows, keyed back to employee_id.
    const extMap = {};
    if (entIds.length) {
      const { data: extRows } = await supabase.from(extTable).select("*").in("timesheet_entry_id", entIds);
      if (stale()) return;
      for (const x of extRows ?? []) {
        const empId = entById[x.timesheet_entry_id]?.employee_id;
        if (empId) extMap[empId] = x;
      }
    }
    setExt(extMap);

    // Daily hours, already resolved per (person, day) to one source.
    if (isDaily) {
      const { data: dayRows, error: dayErr } = await supabase.rpc("payroll_day_hours", {
        loc: locationId,
        d_from: weekStart,
        d_to: weekEndOf(weekStart, cutover),
      });
      if (stale()) return;
      if (dayErr) setError(dayErr.message);
      const dm = {};
      for (const d of dayRows ?? []) {
        (dm[d.employee_id] ||= {})[d.work_date] = {
          hours_worked: Number(d.hours_worked || 0),
          hours_worked_other: Number(d.hours_worked_other || 0),
          hours_turned: Number(d.hours_turned || 0),
          source: d.source,
        };
      }
      setDays(dm);
    } else {
      setDays({});
    }

    // Pay tables — admin/master only.
    if (privileged) {
      const empIds = (empRes.data ?? []).map((e) => e.id);
      const [rateRes, payRes] = await Promise.all([
        empIds.length
          ? supabase.from("employee_pay_rate_history").select("employee_id, rate_type, effective_date, amount").in("employee_id", empIds)
          : Promise.resolve({ data: [] }),
        entIds.length ? supabase.from("timesheet_pay").select("*").in("timesheet_entry_id", entIds) : Promise.resolve({ data: [] }),
      ]);
      if (stale()) return;
      if (rateRes.error) setError(rateRes.error.message);
      const histByEmp = {};
      for (const h of rateRes.data ?? []) (histByEmp[h.employee_id] ||= []).push(h);
      // Rates in force at this week's start -- the same rule as
      // _pay_rate_at(employee, week start) in every SQL reader.
      const rateMap = {};
      for (const id of empIds) rateMap[id] = ratesOn(histByEmp[id], weekStart);
      const payMap = {}; for (const p of payRes.data ?? []) payMap[p.timesheet_entry_id] = p;
      setRates(rateMap);
      setPays(payMap);
    } else {
      setRates({});
      setPays({});
    }

    if (isSpeedee) {
      const [rrRes, wsRes, sumRes] = await Promise.all([
        supabase.from("role_sales_rates").select("position, sales_rate_per_hour").eq("brand", "speedee"),
        supabase.from("store_week_sales").select("*").eq("location_id", locationId).eq("week_start", weekStart).maybeSingle(),
        supabase.rpc("payroll_speedee_summary", { loc: locationId, wk: weekStart }),
      ]);
      if (stale()) return;
      const rrMap = {}; for (const r of rrRes.data ?? []) rrMap[r.position] = r.sales_rate_per_hour;
      setRoleRates(rrMap);
      setWeekSales(wsRes.data ?? null);
      setRpcSummary(Array.isArray(sumRes.data) ? sumRes.data[0] ?? null : sumRes.data ?? null);
      setFlatFlags({});
    } else {
      setRoleRates({});
      setWeekSales(null);
      if (!privileged) {
        const [sumRes, flagRes] = await Promise.all([
          supabase.rpc("payroll_pct_summary", { loc: locationId, wk: weekStart }),
          supabase.rpc("flat_flags_for_week", { loc: locationId, wk: weekStart }),
        ]);
        if (stale()) return;
        setRpcSummary(Array.isArray(sumRes.data) ? sumRes.data[0] ?? null : sumRes.data ?? null);
        const fm = {}; for (const f of flagRes.data ?? []) fm[f.employee_id] = f.flat_flag;
        setFlatFlags(fm);
      } else {
        setRpcSummary(null);
        setFlatFlags({});
      }
    }

    setLoading(false);
  }, [locationId, weekStart, brand, privileged, isSpeedee, extTable, isDaily, cutover]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const dates = useMemo(
    () => (isDaily ? weekDates(weekStart, cutover) : []),
    [isDaily, weekStart, cutover]
  );

  // One merged row per employee on the week (lib/payrollRows.js, shared
  // with the all-stores export); `entry` carries core + brand fields.
  const rows = useMemo(
    () => buildPayrollRows({
      employees, entries, ext, rates, pays, roleRates, days, dates,
      isDaily, isSpeedee, privileged, weekStart, cutover,
    }),
    [employees, entries, ext, rates, pays, roleRates, privileged, isSpeedee, days, dates, isDaily, weekStart, cutover]
  );

  // Ensure a core row exists for (employee, week); returns it.
  const ensureEntry = useCallback(
    async (employeeId) => {
      const existing = entries.find((e) => e.employee_id === employeeId);
      if (existing) return existing;
      const { data, error: e } = await supabase
        .from("timesheet_entries")
        .upsert(
          { location_id: locationId, employee_id: employeeId, week_start: weekStart, submitted_by: user?.id },
          { onConflict: "employee_id,week_start" }
        )
        .select()
        .single();
      if (e) { setError(e.message); return null; }
      setEntries((prev) => (prev.some((r) => r.id === data.id) ? prev : [...prev, data]));
      return data;
    },
    [entries, locationId, weekStart, user?.id]
  );

  const saveCore = useCallback(async (employeeId, patch) => {
    const entry = await ensureEntry(employeeId);
    if (!entry) return;
    const { data, error: e } = await supabase.from("timesheet_entries").update(patch).eq("id", entry.id).select().single();
    if (e) return setError(e.message);
    setEntries((prev) => prev.map((r) => (r.id === data.id ? data : r)));
  }, [ensureEntry]);

  const saveExt = useCallback(async (employeeId, patch) => {
    const entry = await ensureEntry(employeeId);
    if (!entry) return;
    const { data, error: e } = await supabase
      .from(extTable)
      .upsert({ timesheet_entry_id: entry.id, location_id: locationId, updated_at: new Date().toISOString(), ...patch },
        { onConflict: "timesheet_entry_id" })
      .select()
      .single();
    if (e) return setError(e.message);
    setExt((prev) => ({ ...prev, [employeeId]: data }));
  }, [ensureEntry, extTable, locationId]);

  // Compatibility saver used by the grids: splits a patch across the core
  // and brand tables so callers can treat the row as one thing.
  const saveEntry = useCallback(async (employeeId, patch) => {
    const core = {}, extp = {};
    for (const [k, v] of Object.entries(patch)) {
      (CORE_KEYS.includes(k) ? core : extp)[k] = v;
    }
    if (Object.keys(core).length) await saveCore(employeeId, core);
    if (Object.keys(extp).length) await saveExt(employeeId, extp);
    if (!Object.keys(patch).length) await ensureEntry(employeeId);
  }, [saveCore, saveExt, ensureEntry]);

  // Write one day cell. Upserts on (employee_id, work_date) — the same
  // key the table is unique on — so repeated edits update in place.
  //
  // A technician's day is never written here. The UI renders those
  // read-only, and if one somehow reached this call the database refuses
  // it (trg_payroll_daily_no_tech_overlap, migration 32). That refusal
  // names the person and the date, so it is surfaced verbatim rather
  // than replaced with a generic failure — it is the more useful message.
  const saveDay = useCallback(
    async (employeeId, workDate, patch) => {
      const existing = days[employeeId]?.[workDate];
      if (existing?.source === "tech") return;

      const row = {
        location_id: locationId,
        employee_id: employeeId,
        work_date: workDate,
        hours_worked: existing?.hours_worked ?? 0,
        hours_worked_other: existing?.hours_worked_other ?? 0,
        hours_turned: existing?.hours_turned ?? 0,
        ...patch,
        submitted_by: user?.id,
        updated_at: new Date().toISOString(),
      };

      // Optimistic: the totals row recomputes from `days`, so the week
      // total moves with the keystroke rather than after the round trip.
      setDays((prev) => ({
        ...prev,
        [employeeId]: { ...(prev[employeeId] ?? {}), [workDate]: { ...row, source: "payroll" } },
      }));

      const { error: e } = await supabase
        .from("payroll_daily")
        .upsert(row, { onConflict: "employee_id,work_date" });
      if (e) {
        setError(e.message);
        fetchAll(); // put the optimistic cell back to what the server holds
      } else {
        setError(null);
      }
    },
    [days, locationId, user?.id, fetchAll]
  );

  const savePay = useCallback(async (employeeId, patch) => {
    const entry = await ensureEntry(employeeId);
    if (!entry) return;
    const { data, error: e } = await supabase
      .from("timesheet_pay")
      .upsert({ timesheet_entry_id: entry.id, updated_at: new Date().toISOString(), ...patch }, { onConflict: "timesheet_entry_id" })
      .select()
      .single();
    if (e) return setError(e.message);
    setPays((prev) => ({ ...prev, [entry.id]: data }));
  }, [ensureEntry]);

  const saveWeekSales = useCallback(async (value) => {
    const { data, error: e } = await supabase
      .from("store_week_sales")
      .upsert(
        { location_id: locationId, week_start: weekStart, actual_weekly_sales: value === "" ? 0 : Number(value) || 0, updated_at: new Date().toISOString() },
        { onConflict: "location_id,week_start" }
      )
      .select()
      .single();
    if (e) return setError(e.message);
    setWeekSales(data);
  }, [locationId, weekStart]);

  const addEmployee = useCallback(async ({ full_name, position }) => {
    const { data, error: e } = await supabase
      .from("employees")
      .insert({ location_id: locationId, full_name: full_name ?? "", position: position ?? (isSpeedee ? "cashier" : "tech") })
      .select()
      .single();
    if (e) { setError(e.message); return null; }
    setEmployees((prev) => [...prev, data]);
    return data; // the caller opens the new person's profile
  }, [locationId, isSpeedee]);

  const updateEmployee = useCallback(async (employeeId, patch) => {
    setEmployees((prev) => prev.map((e) => (e.id === employeeId ? { ...e, ...patch } : e)));
    const { error: e } = await supabase.from("employees").update(patch).eq("id", employeeId);
    if (e) setError(e.message);
  }, []);

  // Replaces the old "Remove" (active = false and nothing else, which
  // also erased the person from weeks they had worked). The last day
  // keeps them on every week up to and including it.
  const endEmployment = useCallback(async (employeeId, lastDay) => {
    const { error: e } = await supabase
      .from("employees")
      .update({ termination_date: lastDay, active: false })
      .eq("id", employeeId);
    if (e) { setError(e.message); return { error: e }; }
    setEmployees((prev) => prev.map((x) => (x.id === employeeId ? { ...x, termination_date: lastDay, active: false } : x)));
    return { error: null };
  }, []);

  return {
    rows,
    dates,
    isDaily,
    privileged,
    rpcSummary,
    flatFlags,
    weekSales,
    loading,
    error,
    addEmployee,
    updateEmployee,
    endEmployment,
    saveEntry,
    saveDay,
    savePay,
    saveWeekSales,
    refetch: fetchAll,
  };
}
