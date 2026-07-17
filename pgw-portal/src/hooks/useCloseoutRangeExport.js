import { useCallback, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";

// Exports every closeout the current user may see in a date range as one .xlsx.
// RLS (can_access_location) does the scoping: a store manager gets their store,
// a district/regional manager their district/region, admin/master all of them —
// so we never client-side filter by store or hardcode the store list.
export function useCloseoutRangeExport() {
  const { stores } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);

  const exportRange = useCallback(
    async ({ startDate, endDate }) => {
      setExporting(true);
      setError(null);
      try {
        const from = startDate <= endDate ? startDate : endDate;
        const to = startDate <= endDate ? endDate : startDate;

        const { data, error: qErr } = await supabase
          .from("cash_drawer_closeouts")
          .select("*, location:location_id ( id, store_number, name, drawer_float )")
          .gte("business_date", from)
          .lte("business_date", to)
          .order("business_date");

        if (qErr) throw qErr;

        const records = data ?? [];

        // Join submitter names (same approach as useCashDrawer).
        const ids = [...new Set(records.map((r) => r.submitted_by).filter(Boolean))];
        let names = {};
        if (ids.length) {
          const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", ids);
          names = Object.fromEntries((profs ?? []).map((p) => [p.id, p.full_name]));
        }

        const closeouts = records
          .filter((r) => r.location) // drop any row whose location didn't resolve
          .map((r) => ({ ...r, store: r.location, submitted_by_name: names[r.submitted_by] || "" }));

        if (closeouts.length === 0) {
          setError("No closeouts found in that date range.");
          return { count: 0 };
        }

        const accessibleStores = (stores ?? []).map((s) => ({
          storeNumber: s.store_number,
          storeName: s.name,
        }));

        // Lazy-loaded so ExcelJS (~1 MB) is code-split out of the initial bundle
        // and only fetched when a user actually exports a workbook.
        const { exportAllCloseoutsWorkbook } = await import("../lib/closeoutWorkbook.js");
        await exportAllCloseoutsWorkbook(closeouts, { startDate: from, endDate: to, accessibleStores });
        return { count: closeouts.length };
      } catch (e) {
        setError(e.message || String(e));
        return { count: 0, error: e };
      } finally {
        setExporting(false);
      }
    },
    [stores]
  );

  return { exportRange, exporting, error };
}
