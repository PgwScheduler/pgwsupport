import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { sanitizeEntryForSave } from "../lib/drawerMath.js";

export function useCashDrawer(locationId) {
  const { user, profile } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchRows = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("cash_drawer_closeouts")
      .select("*")
      .eq("location_id", locationId)
      .order("business_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    const closeouts = data ?? [];
    const ids = [...new Set(closeouts.map((r) => r.submitted_by).filter(Boolean))];
    let names = {};
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      names = Object.fromEntries((profs ?? []).map((p) => [p.id, p.full_name]));
    }
    setRows(closeouts.map((r) => ({ ...r, submitted_by_name: names[r.submitted_by] || "" })));
    setError(null);
    setLoading(false);
  }, [locationId]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const saveCloseout = useCallback(
    async (entry) => {
      const payload = { ...sanitizeEntryForSave(entry), location_id: locationId, submitted_by: user?.id };
      const { data, error } = await supabase.from("cash_drawer_closeouts").insert(payload).select().single();
      if (error) {
        setError(error.message);
        return { error };
      }
      setRows((prev) => [{ ...data, submitted_by_name: profile?.full_name || "" }, ...prev]);
      return { data };
    },
    [locationId, user?.id, profile?.full_name]
  );

  const updateCloseout = useCallback(
    async (id, entry) => {
      // Only the typed-in fields change; location_id and submitted_by (who
      // originally entered it) are left as-is. RLS (cash_drawer_update, scoped
      // by can_access_location) already limits this to stores the user can see.
      const payload = sanitizeEntryForSave(entry);
      const { data, error } = await supabase
        .from("cash_drawer_closeouts")
        .update(payload)
        .eq("id", id)
        .select()
        .single();
      if (error) {
        setError(error.message);
        return { error };
      }
      setRows((prev) =>
        prev
          .map((r) => (r.id === id ? { ...data, submitted_by_name: r.submitted_by_name } : r))
          .sort(
            (a, b) =>
              b.business_date.localeCompare(a.business_date) ||
              String(b.created_at).localeCompare(String(a.created_at))
          )
      );
      return { data };
    },
    []
  );

  const deleteCloseout = useCallback(
    async (id) => {
      const prevRows = rows;
      setRows((prev) => prev.filter((r) => r.id !== id));
      const { error } = await supabase.from("cash_drawer_closeouts").delete().eq("id", id);
      if (error) {
        setError(error.message);
        setRows(prevRows);
      }
    },
    [rows]
  );

  return { rows, loading, error, saveCloseout, updateCloseout, deleteCloseout, refetch: fetchRows };
}
