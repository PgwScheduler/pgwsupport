import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";

const PRIVILEGED = ["admin", "master"];
// Fields that live on the shared core table; everything else routes to the
// brand extension (timesheet_midas / timesheet_speedee).
const CORE_KEYS = ["pto_days", "clock_hours_other", "clock_hours"];

// Brand-aware payroll data. Fetches the shared roster + core weekly rows
// and merges the brand's extension table. Pay tables (rates, timesheet_pay)
// are fetched only for admin/master — a store never receives per-employee
// pay in the network response. Store-visible aggregates come from the
// brand's SECURITY DEFINER summary RPC.
export function usePayroll(locationId, weekStart, brand) {
  const { user, role } = useAuth();
  const privileged = PRIVILEGED.includes(role);
  const isSpeedee = brand === "speedee";
  const extTable = isSpeedee ? "timesheet_speedee" : "timesheet_midas";

  const [employees, setEmployees] = useState([]);
  const [entries, setEntries] = useState([]);   // core timesheet_entries rows
  const [ext, setExt] = useState({});            // employee_id -> brand extension row
  const [rates, setRates] = useState({});        // employee_id -> pay_rate (privileged)
  const [pays, setPays] = useState({});          // entry_id    -> timesheet_pay (privileged)
  const [roleRates, setRoleRates] = useState({}); // position -> sales_rate_per_hour (speedee)
  const [weekSales, setWeekSales] = useState(null); // store_week_sales row (speedee)
  const [rpcSummary, setRpcSummary] = useState(null);
  const [flatFlags, setFlatFlags] = useState({});
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
  }, [locationId, weekStart, brand, privileged, isSpeedee, extTable]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // One merged row per active employee; `entry` carries core + brand fields.
  const rows = useMemo(() => {
    const byEmp = {};
    for (const e of entries) byEmp[e.employee_id] = e;
    return employees.map((emp) => {
      const entry = byEmp[emp.id] ?? null;
      const x = ext[emp.id] ?? null;
      const base = {
        position: emp.position,
        pto_days: entry?.pto_days ?? 0,
        clock_hours_other: entry?.clock_hours_other ?? 0,
        clock_hours: entry?.clock_hours ?? 0,
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
      };
    });
  }, [employees, entries, ext, rates, pays, roleRates, privileged, isSpeedee]);

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
    saveRate,
    savePay,
    saveWeekSales,
    refetch: fetchAll,
  };
}
