import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { thisWeekStart } from "../lib/weekUtils.js";

export function useDashboard(locationId) {
  const [latestDrawer, setLatestDrawer] = useState(null);
  const [weekRows, setWeekRows] = useState([]);
  const [docCount, setDocCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    const week = thisWeekStart();

    const [drawerRes, hoursRes, docsRes] = await Promise.all([
      supabase
        .from("cash_drawer_closeouts")
        .select("*")
        .eq("location_id", locationId)
        .order("business_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("employee_hours").select("*").eq("location_id", locationId).eq("week_start", week),
      supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("location_id", locationId)
        .eq("item_type", "file"),
    ]);

    const firstError = drawerRes.error || hoursRes.error || docsRes.error;
    if (firstError) setError(firstError.message);
    else setError(null);

    setLatestDrawer(drawerRes.data ?? null);
    setWeekRows(hoursRes.data ?? []);
    setDocCount(docsRes.count ?? 0);
    setLoading(false);
  }, [locationId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return { latestDrawer, weekRows, docCount, loading, error, refetch: fetchAll };
}
