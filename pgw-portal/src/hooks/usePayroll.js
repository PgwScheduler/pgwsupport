import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { weekEndOf, weekDates, isSundayWeek } from "../lib/weekUtils.js";

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

  const fetchAll = useCallback(async () => {
    if (!locationId || !weekStart) return;
    setLoading(true);

    const [empRes, entRes] = await Promise.all([
      supabase.from("employees").select("*").eq("location_id", locationId).eq("active", true)
        .order("position", { ascending: true }).order("created_at", { ascending: true }),
      supabase.from("timesheet_entries").select("*").eq("location_id", locationId).eq("week_start", weekStart),
    ]);
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
        empIds.length ? supabase.from("employee_pay_rates").select("*").in("employee_id", empIds) : Promise.resolve({ data: [] }),
        entIds.length ? supabase.from("timesheet_pay").select("*").in("timesheet_entry_id", entIds) : Promise.resolve({ data: [] }),
      ]);
      const rateMap = {}; for (const r of rateRes.data ?? []) rateMap[r.employee_id] = r;
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

  // One merged row per active employee; `entry` carries core + brand fields.
  const rows = useMemo(() => {
    const byEmp = {};
    for (const e of entries) byEmp[e.employee_id] = e;
    return employees.map((emp) => {
      const entry = byEmp[emp.id] ?? null;
      const x = ext[emp.id] ?? null;
      const empDays = days[emp.id] ?? {};

      // A week is technician-sourced when ANY of its days came from the
      // Tech Tracker. Resolution is per DAY, so someone who was a tech
      // for part of the week has some days locked and some typed here —
      // the row is marked read-only for the days that are, not wholesale.
      const techDates = dates.filter((d) => empDays[d]?.source === "tech");

      // Weekly totals, summed across whichever source each day resolved
      // to. Overtime is computed from these downstream, once, on the
      // week — never per day.
      const totals = dates.reduce(
        (a, d) => {
          const r = empDays[d];
          if (!r) return a;
          a.total_hours += r.hours_worked + r.hours_worked_other;
          a.total_hours_other += r.hours_worked_other;
          a.total_turned += r.hours_turned;
          return a;
        },
        { total_hours: 0, total_hours_other: 0, total_turned: 0 }
      );

      const base = {
        position: emp.position,
        is_store_manager: emp.is_store_manager,
        pto_days: entry?.pto_days ?? 0,
        clock_hours_other: entry?.clock_hours_other ?? 0,
        clock_hours: entry?.clock_hours ?? 0,
        // Present ONLY in the daily era. payrollMath falls back to the
        // frozen weekly columns when these are absent, which is what
        // makes a pre-cutover week still render correctly.
        ...(isDaily ? totals : {}),
      };
      const mergedEntry = isSpeedee
        ? {
            ...base,
            spiffs: x?.spiffs ?? 0,
            labor_sales: x?.labor_sales ?? null,
            labor_pct_eligible: emp.labor_pct_eligible,
            labor_pct_rate: emp.labor_pct_rate,
            sales_expectation_flat: emp.sales_expectation_flat,
          }
        : {
            ...base,
            hrs_turned_other: x?.hrs_turned_other ?? 0,
            hrs_turned_here: x?.hrs_turned_here ?? 0,
            actual_sales: x?.actual_sales ?? 0,
            work_orders: x?.work_orders ?? 0,
            sales_required: x?.sales_required ?? null,
          };
      return {
        employee: emp,
        entry: mergedEntry,
        entryId: entry?.id ?? null,
        rate: privileged ? rates[emp.id] ?? null : null,
        pay: entry ? (privileged ? pays[entry.id] ?? null : null) : null,
        roleSalesRate: isSpeedee ? roleRates[emp.position] ?? 0 : null,
        days: empDays,
        techDates,
        techSourced: techDates.length > 0,
      };
    });
  }, [employees, entries, ext, rates, pays, roleRates, privileged, isSpeedee, days, dates, isDaily]);

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

  const saveRate = useCallback(async (employeeId, patch) => {
    const { data, error: e } = await supabase
      .from("employee_pay_rates")
      .upsert({ employee_id: employeeId, updated_at: new Date().toISOString(), ...patch }, { onConflict: "employee_id" })
      .select()
      .single();
    if (e) return setError(e.message);
    setRates((prev) => ({ ...prev, [employeeId]: data }));
  }, []);

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
    if (e) return setError(e.message);
    setEmployees((prev) => [...prev, data]);
  }, [locationId, isSpeedee]);

  const updateEmployee = useCallback(async (employeeId, patch) => {
    setEmployees((prev) => prev.map((e) => (e.id === employeeId ? { ...e, ...patch } : e)));
    const { error: e } = await supabase.from("employees").update(patch).eq("id", employeeId);
    if (e) setError(e.message);
  }, []);

  const removeEmployee = useCallback(async (employeeId) => {
    setEmployees((prev) => prev.filter((e) => e.id !== employeeId));
    const { error: e } = await supabase.from("employees").update({ active: false }).eq("id", employeeId);
    if (e) setError(e.message);
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
    removeEmployee,
    saveEntry,
    saveDay,
    saveRate,
    savePay,
    saveWeekSales,
    refetch: fetchAll,
  };
}
