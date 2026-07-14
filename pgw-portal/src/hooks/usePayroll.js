import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";

const PRIVILEGED = ["admin", "master"];

// Merges the roster with a week's timesheet entries (and, for privileged
// users, pay rates + bonus/incentives) into one row per active employee.
// Store users never fetch the pay tables, so pay data is absent from the
// network response — not merely hidden.
export function usePayroll(locationId, weekStart) {
  const { user, role } = useAuth();
  const privileged = PRIVILEGED.includes(role);

  const [employees, setEmployees] = useState([]);
  const [entries, setEntries] = useState([]);      // timesheet_entries for the week
  const [rates, setRates] = useState({});           // employee_id -> pay_rate row (privileged)
  const [pays, setPays] = useState({});             // entry_id    -> timesheet_pay row (privileged)
  const [rpcSummary, setRpcSummary] = useState(null); // store users: percentages only
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!locationId || !weekStart) return;
    setLoading(true);

    const [empRes, entRes] = await Promise.all([
      supabase
        .from("employees")
        .select("*")
        .eq("location_id", locationId)
        .eq("active", true)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("timesheet_entries")
        .select("*")
        .eq("location_id", locationId)
        .eq("week_start", weekStart),
    ]);

    const firstErr = empRes.error || entRes.error;
    if (firstErr) {
      setError(firstErr.message);
      setLoading(false);
      return;
    }
    setError(null);
    setEmployees(empRes.data ?? []);
    setEntries(entRes.data ?? []);

    if (privileged) {
      const empIds = (empRes.data ?? []).map((e) => e.id);
      const entIds = (entRes.data ?? []).map((e) => e.id);
      const [rateRes, payRes] = await Promise.all([
        empIds.length
          ? supabase.from("employee_pay_rates").select("*").in("employee_id", empIds)
          : Promise.resolve({ data: [] }),
        entIds.length
          ? supabase.from("timesheet_pay").select("*").in("timesheet_entry_id", entIds)
          : Promise.resolve({ data: [] }),
      ]);
      const rateMap = {};
      for (const r of rateRes.data ?? []) rateMap[r.employee_id] = r;
      const payMap = {};
      for (const p of payRes.data ?? []) payMap[p.timesheet_entry_id] = p;
      setRates(rateMap);
      setPays(payMap);
      setRpcSummary(null);
    } else {
      // Store/district/regional: percentages come from the RPC — no dollars.
      const { data, error: rpcErr } = await supabase.rpc("payroll_pct_summary", {
        loc: locationId,
        wk: weekStart,
      });
      if (rpcErr) setRpcSummary(null);
      else setRpcSummary(Array.isArray(data) ? data[0] ?? null : data ?? null);
    }

    setLoading(false);
  }, [locationId, weekStart, privileged]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // One merged row per active employee.
  const rows = useMemo(() => {
    const byEmp = {};
    for (const e of entries) byEmp[e.employee_id] = e;
    return employees.map((emp) => {
      const entry = byEmp[emp.id] ?? null;
      return {
        employee: emp,
        // The merged shape computeStoreRow/computePayRow consume:
        entry: {
          position: emp.position,
          pto_days: entry?.pto_days ?? 0,
          clock_hours_other: entry?.clock_hours_other ?? 0,
          clock_hours: entry?.clock_hours ?? 0,
          hrs_turned_other: entry?.hrs_turned_other ?? 0,
          hrs_turned_here: entry?.hrs_turned_here ?? 0,
          actual_sales: entry?.actual_sales ?? 0,
          work_orders: entry?.work_orders ?? 0,
          sales_required: entry?.sales_required ?? null,
        },
        entryId: entry?.id ?? null,
        rate: privileged ? rates[emp.id] ?? null : null,
        pay: entry ? (privileged ? pays[entry.id] ?? null : null) : null,
      };
    });
  }, [employees, entries, rates, pays, privileged]);

  // ---- Roster mutations ----
  const addEmployee = useCallback(
    async ({ full_name, position }) => {
      const { data, error: e } = await supabase
        .from("employees")
        .insert({ location_id: locationId, full_name: full_name ?? "", position: position ?? "tech" })
        .select()
        .single();
      if (e) return setError(e.message);
      setEmployees((prev) => [...prev, data]);
    },
    [locationId]
  );

  const updateEmployee = useCallback(async (employeeId, patch) => {
    setEmployees((prev) => prev.map((e) => (e.id === employeeId ? { ...e, ...patch } : e)));
    const { error: e } = await supabase.from("employees").update(patch).eq("id", employeeId);
    if (e) setError(e.message);
  }, []);

  const removeEmployee = useCallback(async (employeeId) => {
    // Soft delete: keep weekly history intact.
    setEmployees((prev) => prev.filter((e) => e.id !== employeeId));
    const { error: e } = await supabase.from("employees").update({ active: false }).eq("id", employeeId);
    if (e) setError(e.message);
  }, []);

  // ---- Entry (store-visible) upsert ----
  // Ensures a row exists for (employee, week) and applies the patch.
  // Returns the entry id so pay upserts can reference it.
  const saveEntry = useCallback(
    async (employeeId, patch) => {
      const existing = entries.find((e) => e.employee_id === employeeId);
      const payload = {
        ...(existing ? { id: existing.id } : {}),
        location_id: locationId,
        employee_id: employeeId,
        week_start: weekStart,
        submitted_by: user?.id,
        ...patch,
      };
      const { data, error: e } = await supabase
        .from("timesheet_entries")
        .upsert(payload, { onConflict: "employee_id,week_start" })
        .select()
        .single();
      if (e) {
        setError(e.message);
        return null;
      }
      setEntries((prev) => {
        const idx = prev.findIndex((r) => r.id === data.id);
        if (idx === -1) return [...prev, data];
        const next = prev.slice();
        next[idx] = data;
        return next;
      });
      return data.id;
    },
    [entries, locationId, weekStart, user?.id]
  );

  // ---- Pay-rate upsert (privileged) ----
  const saveRate = useCallback(async (employeeId, patch) => {
    const { data, error: e } = await supabase
      .from("employee_pay_rates")
      .upsert({ employee_id: employeeId, updated_at: new Date().toISOString(), ...patch }, { onConflict: "employee_id" })
      .select()
      .single();
    if (e) return setError(e.message);
    setRates((prev) => ({ ...prev, [employeeId]: data }));
  }, []);

  // ---- Bonus/incentives upsert (privileged) ----
  // Ensures the entry exists first (FK target).
  const savePay = useCallback(
    async (employeeId, patch) => {
      const entryId = await saveEntry(employeeId, {}); // no-op patch, guarantees a row
      if (!entryId) return;
      const { data, error: e } = await supabase
        .from("timesheet_pay")
        .upsert({ timesheet_entry_id: entryId, updated_at: new Date().toISOString(), ...patch }, { onConflict: "timesheet_entry_id" })
        .select()
        .single();
      if (e) return setError(e.message);
      setPays((prev) => ({ ...prev, [entryId]: data }));
    },
    [saveEntry]
  );

  return {
    rows,
    privileged,
    rpcSummary,
    loading,
    error,
    addEmployee,
    updateEmployee,
    removeEmployee,
    saveEntry,
    saveRate,
    savePay,
    refetch: fetchAll,
  };
}
