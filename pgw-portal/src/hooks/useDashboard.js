import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { fetchPayrollConfig } from "./usePayrollConfig.js";
import { thisWeekStart, weekEndOf, isSundayWeek } from "../lib/weekUtils.js";

export function useDashboard(locationId) {
  const [latestDrawer, setLatestDrawer] = useState(null);
  const [weekRows, setWeekRows] = useState([]);
  const [docCount, setDocCount] = useState(0);
  const [cutover, setCutover] = useState(null);
  const [week, setWeek] = useState(null);
  const [pts, setPts] = useState(null);       // payroll_to_sales_wtd row
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);

    // The cutover decides which basis this week uses and therefore which
    // Sunday-or-Monday key everything below is asked for.
    const cfg = await fetchPayrollConfig().catch((e) => { setError(e.message); return null; });
    const cut = cfg?.cutover ?? null;
    const wk = thisWeekStart(cut);
    setCutover(cut);
    setWeek(wk);

    const [drawerRes, docsRes, hoursRes, ptsRes] = await Promise.all([
      supabase
        .from("cash_drawer_closeouts")
        .select("*")
        .eq("location_id", locationId)
        .order("business_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("location_id", locationId)
        .eq("item_type", "file"),
      // Hours this week, resolved across the cutover: daily rows from the
      // cutover, the frozen weekly columns before it. payroll_week_hours
      // handles both, so the dashboard no longer reads timesheet_entries
      // directly — post-cutover an employee can have hours and no weekly
      // row at all, and that query would have shown zero.
      supabase.rpc("payroll_week_hours", { loc: locationId, wk }),
      supabase.rpc("payroll_to_sales_wtd", { loc: locationId, wk }),
    ]);

    const firstError = drawerRes.error || docsRes.error || hoursRes.error || ptsRes.error;
    if (firstError) setError(firstError.message);
    else setError(null);

    setLatestDrawer(drawerRes.data ?? null);
    setDocCount(docsRes.count ?? 0);
    setWeekRows(hoursRes.data ?? []);
    setPts(Array.isArray(ptsRes.data) ? ptsRes.data[0] ?? null : ptsRes.data ?? null);
    setLoading(false);
  }, [locationId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return {
    latestDrawer,
    weekRows,
    docCount,
    week,
    cutover,
    isDaily: isSundayWeek(week, cutover),
    weekEnd: week ? weekEndOf(week, cutover) : null,
    payrollToSales: pts,
    loading,
    error,
    refetch: fetchAll,
  };
}
