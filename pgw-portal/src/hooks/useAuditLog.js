import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useDateRange } from "../context/DateRangeProvider.jsx";

const PAGE = 200;

// The Change Log (migration 81). audit_log_feed() is SECURITY INVOKER, so
// audit_log's RLS decides what comes back; this hook only filters and
// pages (newest first, "load older" by id).
export function useAuditLog({ locationId, area, employeeId }) {
  const { from, to } = useDateRange();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [names, setNames] = useState({ districts: [], regions: [] });

  const fetchPage = useCallback(
    (beforeId) =>
      supabase.rpc("audit_log_feed", {
        p_from: from, p_to: to,
        p_location_id: locationId || null,
        p_area: area || null,
        p_employee_id: employeeId || null,
        p_before_id: beforeId ?? null,
        p_limit: PAGE,
      }),
    [from, to, locationId, area, employeeId]
  );

  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    setLoading(true);
    setError(null);
    fetchPage(null).then(({ data, error: e }) => {
      if (!live) return;
      if (e) { setError(e.message); setRows([]); setMore(false); }
      else { setRows(data ?? []); setMore((data ?? []).length === PAGE); }
      setLoading(false);
    });
    return () => { live = false; };
  }, [fetchPage, from, to]);

  // District/region names for role changes. Readable by everyone; a
  // failure only means role changes show "a district".
  useEffect(() => {
    Promise.all([
      supabase.from("districts").select("id, name"),
      supabase.from("regions").select("id, name"),
    ]).then(([d, r]) => setNames({ districts: d.data ?? [], regions: r.data ?? [] }));
  }, []);

  const loadOlder = useCallback(async () => {
    if (!rows.length) return;
    setLoading(true);
    const { data, error: e } = await fetchPage(rows[rows.length - 1].id);
    if (e) setError(e.message);
    else { setRows((cur) => [...cur, ...(data ?? [])]); setMore((data ?? []).length === PAGE); }
    setLoading(false);
  }, [rows, fetchPage]);

  return { from, to, rows, loading, more, error, loadOlder, names };
}
