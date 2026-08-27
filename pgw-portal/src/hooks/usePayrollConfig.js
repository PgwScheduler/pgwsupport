import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

// payroll_config (migration 32) holds the daily-entry cutover date and
// the technicians-in-the-metric policy. One company-wide row, readable by
// every authenticated user, written only by master.
//
// Nothing in the app may hardcode the cutover: it decides which basis a
// pay week uses, which table its hours come from, and which weeks are
// frozen. It is fetched once per page load and shared — the promise, not
// the result, is cached, so simultaneous mounts make one request.
let cached = null;

export function fetchPayrollConfig() {
  if (!cached) {
    cached = supabase
      .from("payroll_config")
      .select("daily_cutover_date, include_technicians")
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) { cached = null; throw error; }
        return {
          cutover: data?.daily_cutover_date ?? null,
          includeTechnicians: data?.include_technicians ?? true,
        };
      });
  }
  return cached;
}

export function usePayrollConfig() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    fetchPayrollConfig()
      .then((c) => { if (live) setConfig(c); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  return {
    cutover: config?.cutover ?? null,
    includeTechnicians: config?.includeTechnicians ?? true,
    // Callers must wait: with no cutover every week helper would fall
    // back to a Sunday basis and a pre-cutover week would render on the
    // wrong days before snapping across once the row arrives.
    loading: config == null && !error,
    error,
  };
}
