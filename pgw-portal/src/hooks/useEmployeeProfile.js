import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";

// One employee's profile (migration 56). Details are location-scoped
// like the rest of `employees`, so a store manager can read and edit
// their own people. Pay history and technician rates are fetched ONLY
// for admin/master -- both tables are admin-only in RLS, and a store
// user's network response never carries a rate.
const EMPLOYEE_SELECT = `
  id, location_id, full_name, position, active, is_store_manager,
  hire_date, termination_date, employee_number, created_at,
  rehire_date, birth_month, birth_day,
  location:location_id ( name, store_number, brand, is_home_office )
`;

export function useEmployeeProfile(employeeId) {
  const { role } = useAuth();
  const privileged = role === "admin" || role === "master";
  const [employee, setEmployee] = useState(null);
  const [history, setHistory] = useState([]);
  const [techRates, setTechRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!employeeId) return;
    const [e, h, t] = await Promise.all([
      supabase.from("employees").select(EMPLOYEE_SELECT).eq("id", employeeId).maybeSingle(),
      privileged
        ? supabase.from("employee_pay_rate_history")
            .select("rate_type, effective_date, amount, source, updated_at")
            .eq("employee_id", employeeId).order("effective_date", { ascending: false })
        : Promise.resolve({ data: [] }),
      privileged
        ? supabase.from("tech_pay_rates").select("effective_date, flat_rate, guarantee_rate")
            .eq("employee_id", employeeId).order("effective_date", { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);
    const err = e.error || h.error || t.error;
    if (err) setError(err.message);
    else if (!e.data) setError("This employee could not be found, or is not in your scope.");
    else {
      setError(null);
      setEmployee(e.data);
      setHistory(h.data ?? []);
      setTechRates(t.data ?? []);
    }
    setLoading(false);
  }, [employeeId, privileged]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const saveDetails = useCallback(async (patch) => {
    const { error: e } = await supabase.from("employees").update(patch).eq("id", employeeId);
    if (!e) await load();
    return { error: e };
  }, [employeeId, load]);

  const endEmployment = useCallback(async (lastDay) => {
    const { error: e } = await supabase.from("employees")
      .update({ termination_date: lastDay, active: false }).eq("id", employeeId);
    if (!e) await load();
    return { error: e };
  }, [employeeId, load]);

  const reactivate = useCallback(async () => {
    const { error: e } = await supabase.from("employees")
      .update({ termination_date: null, active: true }).eq("id", employeeId);
    if (!e) await load();
    return { error: e };
  }, [employeeId, load]);

  // One change on one date. Re-saving the same type + date replaces the
  // amount rather than stacking a second row (it is the primary key).
  const saveRate = useCallback(async (rateType, effectiveDate, amount) => {
    const { data, error: e } = await supabase.from("employee_pay_rate_history")
      .upsert(
        { employee_id: employeeId, rate_type: rateType, effective_date: effectiveDate, amount, source: "manual" },
        { onConflict: "employee_id,rate_type,effective_date" }
      )
      .select();
    // RLS turns a refused upsert into zero rows, not an error; say so.
    const refused = !e && (!data || data.length === 0);
    const out = refused ? { message: "The change was not saved (not permitted)." } : e;
    if (!out) await load();
    return { error: out };
  }, [employeeId, load]);

  const removeRate = useCallback(async (row) => {
    const { data, error: e } = await supabase.from("employee_pay_rate_history")
      .delete()
      .eq("employee_id", employeeId).eq("rate_type", row.rate_type).eq("effective_date", row.effective_date)
      .select();
    const refused = !e && (!data || data.length === 0);
    const out = refused ? { message: "The change was not removed (not permitted)." } : e;
    if (!out) await load();
    return { error: out };
  }, [employeeId, load]);

  return { employee, history, techRates, privileged, loading, error, reload: load, saveDetails, endEmployment, reactivate, saveRate, removeRate };
}
