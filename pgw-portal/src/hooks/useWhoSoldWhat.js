import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { measuresFor, monthBounds, prevMonth } from "../lib/whoSoldWhat.js";

// Who Sold What (migration 70): everything the report reads, for a month
// and the month before. The numbers are computed in lib/whoSoldWhat.js.
//
//   units, cars, sales, days entered -> report_build(), grouped by store
//                                       (scoped + sandbox/Home Office
//                                       excluded in the database)
//   which service goes where, goals  -> service_penetration_goals
//   market, row order, name, fill    -> markets + store_report_profile
async function byStore(from, to, measures) {
  const { data, error } = await supabase.rpc("report_build", {
    p_from: from, p_to: to, p_group_by: "store", p_measures: measures,
  });
  if (error) throw error;
  // Grouped by store, report_build puts the store's id in bucket_key.
  const out = {};
  for (const r of data ?? []) {
    const id = r.store_id ?? r.bucket_key;
    if (!r.is_total && id) out[id] = r.measures ?? {};
  }
  return out;
}

export function useWhoSoldWhat() {
  const [month, setMonth] = useState(null); // 'YYYY-MM'
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Default: the latest month any visible store has entered.
  useEffect(() => {
    let live = true;
    supabase.from("daily_kpi").select("business_date").order("business_date", { ascending: false }).limit(1)
      .then(({ data: rows, error: e }) => {
        if (!live) return;
        if (e) setError(e.message);
        else setMonth((rows?.[0]?.business_date ?? new Date().toISOString()).slice(0, 7));
      });
    return () => { live = false; };
  }, []);

  const load = useCallback(async (ym) => {
    if (!ym) return;
    setLoading(true);
    setError(null);
    try {
      const [locRes, profRes, mktRes, goalRes] = await Promise.all([
        supabase.from("locations").select("id, store_number, name, is_sandbox, is_home_office"),
        supabase.from("store_report_profile").select("location_id, market_id, report_sort_order, report_display_name, name_fill_override"),
        supabase.from("markets").select("id, code, name, sort_order, display_color, display_font_color").order("sort_order"),
        supabase.from("service_penetration_goals").select("service_key, section, sort_order, label, measure, goal, in_average, also_counts"),
      ]);
      const firstErr = [locRes, profRes, mktRes, goalRes].find((r) => r.error)?.error;
      if (firstErr) throw firstErr;

      const goals = (goalRes.data ?? []).map((g) => ({ ...g, goal: g.goal === null ? null : Number(g.goal) }));
      const measures = measuresFor(goals);
      const cur = monthBounds(ym), prev = monthBounds(prevMonth(ym));
      const [curBy, prevBy] = await Promise.all([
        byStore(cur.from, cur.to, measures),
        byStore(prev.from, prev.to, measures),
      ]);

      const prof = Object.fromEntries((profRes.data ?? []).map((p) => [p.location_id, p]));
      const mkts = Object.fromEntries((mktRes.data ?? []).map((m) => [m.id, m]));
      const stores = (locRes.data ?? [])
        .filter((l) => !l.is_sandbox && !l.is_home_office && prof[l.id])
        .map((l) => {
          const p = prof[l.id], m = mkts[p.market_id];
          return {
            id: l.id, storeNumber: l.store_number, name: p.report_display_name ?? l.name,
            marketId: p.market_id, sort: p.report_sort_order,
            fill: p.name_fill_override ?? m?.display_color, font: m?.display_font_color,
            cur: curBy[l.id] ?? null, prev: prevBy[l.id] ?? null,
          };
        });

      setData({ month: ym, prevMonth: prevMonth(ym), stores, markets: mktRes.data ?? [], goals });
    } catch (e) {
      setError(e.message ?? String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (month) load(month); }, [month, load]);

  // Admin/master: change one goal. RLS + a column grant allow the goal
  // column only; the layout stays migration-owned.
  const saveGoal = useCallback(async (serviceKey, goal) => {
    const { error: e } = await supabase.from("service_penetration_goals")
      .update({ goal }).eq("service_key", serviceKey);
    if (e) return e;
    setData((d) => d && { ...d, goals: d.goals.map((g) => (g.service_key === serviceKey ? { ...g, goal } : g)) });
    return null;
  }, []);

  return { month, setMonth, data, loading, error, saveGoal, reload: () => load(month) };
}
