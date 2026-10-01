import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useDateRange } from "../context/DateRangeProvider.jsx";

// Tech Ranks (migration 74): per-technician totals for the shared date
// range, company-wide. tech_ranks() is SECURITY DEFINER and returns names
// and hours only; it refuses store logins with 42501.
export function useTechRanks() {
  const { from, to } = useDateRange();
  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    setLoading(true);
    setError(null);
    supabase.rpc("tech_ranks", { p_from: from, p_to: to }).then(({ data, error: e }) => {
      if (!live) return;
      if (e) { setError(e.message); setRaw(null); }
      else setRaw(data);
      setLoading(false);
    });
    return () => { live = false; };
  }, [from, to]);

  return { from, to, raw, loading, error };
}
