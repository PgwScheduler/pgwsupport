import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { iso } from "../lib/weekUtils.js";

// GP vs Budget: everything lib/gpBudget.js needs for one "through" date.
//
// WHERE EACH NUMBER COMES FROM
//   GP by store by month -> report_build(), grouped by month and split by
//                           store: the one definition of GP, scoped by
//                           can_access_location, sandbox excluded
//   full-year GP budget  -> bonus_monthly_targets (12 rows per store)
//   pace calendar        -> open_days_between (Mon–Sat less holidays)
//   lead / division      -> regions / districts; names and row order
//                           from store_report_profile
//
// The through date is a month: a finished month runs to its last day,
// the current month to the last open business day (report_default_date).
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const lastDay = (y, m) => iso(new Date(y, m, 0));

export function useGpBudget() {
  const now = new Date();
  const year = now.getFullYear();
  const thisMonth = now.getMonth() + 1;
  // Default to the last finished month, like the slide ("Through May").
  const [month, setMonth] = useState(Math.max(1, thisMonth - 1));
  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (m) => {
    setLoading(true);
    setError(null);
    try {
      let through = lastDay(year, m);
      if (m === thisMonth) {
        const { data, error: e } = await supabase.rpc("report_default_date", { p_today: iso(new Date()) });
        if (e) throw e;
        through = data;
      }
      const from = `${year}-01-01`;
      const [locRes, distRes, regRes, profRes, tgRes, gpRes, elapsedRes, yearRes] = await Promise.all([
        supabase.from("locations").select("id, store_number, name, brand, district_id, is_sandbox"),
        supabase.from("districts").select("id, name, region_id"),
        supabase.from("regions").select("id, name"),
        supabase.from("store_report_profile").select("location_id, report_sort_order, report_display_name"),
        supabase.from("bonus_monthly_targets").select("location_id, month, gp_budget").eq("plan_year", year),
        supabase.rpc("report_build", {
          p_from: from, p_to: through, p_group_by: "month",
          p_measures: ["ro_count", "gross_profit"], p_split_by_store: true,
        }),
        supabase.rpc("open_days_between", { d_from: from, d_to: through }),
        supabase.rpc("open_days_between", { d_from: from, d_to: `${year}-12-31` }),
      ]);
      const firstErr = [locRes, distRes, regRes, profRes, tgRes, gpRes, elapsedRes, yearRes].find((r) => r.error)?.error;
      if (firstErr) throw firstErr;

      const prof = Object.fromEntries((profRes.data ?? []).map((p) => [p.location_id, p]));
      // A month the store entered nothing (no cars) is blank, not $0.
      const gp = (gpRes.data ?? [])
        .filter((r) => !r.is_total && r.store_id && (num(r.measures?.ro_count) ?? 0) > 0)
        .map((r) => ({ store_id: r.store_id, month: Number(r.bucket_key.slice(5, 7)), gp: num(r.measures?.gross_profit) }));

      setRaw({
        stores: (locRes.data ?? []).filter((l) => !l.is_sandbox).map((l) => ({
          id: l.id, storeNumber: l.store_number, brand: l.brand, districtId: l.district_id,
          name: prof[l.id]?.report_display_name ?? l.name, sort: prof[l.id]?.report_sort_order ?? null,
        })),
        districts: (distRes.data ?? []).map((d) => ({ id: d.id, name: d.name, regionId: d.region_id })),
        regions: regRes.data ?? [],
        budgets: tgRes.data ?? [],
        gp,
        elapsed: num(elapsedRes.data),
        yearDays: num(yearRes.data),
        through, year,
      });
    } catch (e) {
      setError(e.message ?? String(e));
      setRaw(null);
    }
    setLoading(false);
  }, [year, thisMonth]);

  useEffect(() => { load(month); }, [month, load]);

  return { year, month, setMonth, thisMonth, raw, loading, error };
}
