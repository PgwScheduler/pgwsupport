import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { summarizeEntryStatus } from "../lib/ticEntry.js";

// Who has (not) entered the tic sheet over the last `days` working days
// (migration 80). The database scopes it: a DM gets their district, an RM
// their region, master everything; the sandbox and Home Office never show.
export function useTicEntryStatus(days = 7) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: rows, error: err } = await supabase.rpc("tic_entry_status", { p_days: days });
    setError(err ? err.message : null);
    setData(err ? null : summarizeEntryStatus(rows));
    setLoading(false);
  }, [days]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, refetch: load };
}
