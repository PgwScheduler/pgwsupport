import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useDateRange } from "../context/DateRangeProvider.jsx";

// The five dashboard widgets, over the shared date range.
//
// `storeId` narrows to one store; null means "everything this user can
// see". The scoping is done in the database by can_access_location(),
// not here — a store user asking for everything gets their store, and a
// district user gets their district. The UI never has to know which.
export function useDashboardRange(storeId) {
  const { from, to } = useDateRange();
  const [metrics, setMetrics] = useState(null);
  const [payroll, setPayroll] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    const args = { d_from: from, d_to: to, loc: storeId ?? null };
    const [mRes, pRes] = await Promise.all([
      supabase.rpc("dashboard_range_metrics", args),
      supabase.rpc("payroll_to_sales_range", args),
    ]);
    const err = mRes.error || pRes.error;
    setError(err ? err.message : null);
    const first = (r) => (Array.isArray(r.data) ? r.data[0] ?? null : r.data ?? null);
    setMetrics(mRes.error ? null : first(mRes));
    setPayroll(pRes.error ? null : first(pRes));
    setLoading(false);
  }, [from, to, storeId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  return { metrics, payroll, from, to, loading, error, refetch: fetchAll };
}
