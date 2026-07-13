import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";

export function useEmployeeHours(locationId, weekStart) {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchRows = useCallback(async () => {
    if (!locationId || !weekStart) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("employee_hours")
      .select("*")
      .eq("location_id", locationId)
      .eq("week_start", weekStart)
      .order("created_at", { ascending: true });
    if (error) setError(error.message);
    else {
      setRows(data ?? []);
      setError(null);
    }
    setLoading(false);
  }, [locationId, weekStart]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const addRow = useCallback(async () => {
    const { data, error } = await supabase
      .from("employee_hours")
      .insert({ location_id: locationId, week_start: weekStart, employee_name: "", submitted_by: user?.id })
      .select()
      .single();
    if (error) {
      setError(error.message);
      return;
    }
    setRows((prev) => [...prev, data]);
  }, [locationId, weekStart, user?.id]);

  const updateRowLocal = useCallback((id, patch) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const saveRow = useCallback(async (id, patch) => {
    const { error } = await supabase.from("employee_hours").update(patch).eq("id", id);
    if (error) setError(error.message);
  }, []);

  const deleteRow = useCallback(
    async (id) => {
      const prevRows = rows;
      setRows((prev) => prev.filter((r) => r.id !== id));
      const { error } = await supabase.from("employee_hours").delete().eq("id", id);
      if (error) {
        setError(error.message);
        setRows(prevRows);
      }
    },
    [rows]
  );

  return { rows, loading, error, addRow, updateRowLocal, saveRow, deleteRow, refetch: fetchRows };
}
