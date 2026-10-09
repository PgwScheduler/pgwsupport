import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

// Bonus plan setup (migration 85): plan years, the yearly rollover,
// publish / discard, company rates per year, and one store's plan.
// Every rule is enforced in the database -- draft-only edits, master-only
// rates and year changes -- so a refused write comes back as 0 rows or an
// error, and this hook reports it rather than pretending it saved.

const err = (r) => r?.error?.message ?? null;

export function useBonusYears() {
  const [years, setYears] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await supabase.from("bonus_plan_years").select("*").order("plan_year");
    setError(err(r));
    setYears(r.data ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const call = async (fn, args) => {
    const r = await supabase.rpc(fn, args);
    if (r.error) return { error: r.error.message };
    await load();
    return { data: r.data };
  };

  return {
    years, loading, error, reload: load,
    rollover: (from, to) => call("bonus_rollover", { p_from: from, p_to: to }),
    publish: (year) => call("bonus_publish_year", { p_year: year }),
    discard: (year) => call("bonus_discard_draft", { p_year: year }),
    fillLastYear: (year, overwrite = false) => call("bonus_fill_last_year_gp", { p_year: year, p_overwrite: overwrite }),
  };
}

// Plans + problems for every store in a year (the store list).
export function useBonusYearOverview(year) {
  const [plans, setPlans] = useState([]);
  const [problems, setProblems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!year) return;
    setLoading(true);
    const [p, pr] = await Promise.all([
      supabase.from("bonus_plans").select("location_id, model").eq("plan_year", year),
      supabase.rpc("bonus_year_problems", { p_year: year }),
    ]);
    setError(err(p) ?? err(pr));
    setPlans(p.data ?? []);
    setProblems(pr.data ?? []);
    setLoading(false);
  }, [year]);
  useEffect(() => { load(); }, [load]);

  return { plans, problems, loading, error, reload: load };
}

// Company-wide rates for a year.
export function useBonusRates(year) {
  const [rates, setRates] = useState([]);
  const [splits, setSplits] = useState([]);
  const [policy, setPolicy] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!year) return;
    setLoading(true);
    const [r, s, p] = await Promise.all([
      supabase.from("bonus_model_rates").select("model, tier, role, pct").eq("plan_year", year).order("model").order("tier").order("role"),
      supabase.from("bonus_model_splits").select("model, role, share, sort_order").eq("plan_year", year).order("model").order("sort_order"),
      supabase.from("bonus_policy").select("key, value, note").eq("plan_year", year).order("key"),
    ]);
    setError(err(r) ?? err(s) ?? err(p));
    setRates(r.data ?? []); setSplits(s.data ?? []); setPolicy(p.data ?? []);
    setLoading(false);
  }, [year]);
  useEffect(() => { load(); }, [load]);

  // Each save writes only the rows passed and reads back how many the
  // database accepted; fewer means RLS refused (not master / not draft).
  const save = async (table, rows, keys) => {
    for (const row of rows) {
      let q = supabase.from(table).update(row.patch);
      q = q.eq("plan_year", year);
      for (const k of keys) q = q.eq(k, row[k]);
      const { data, error } = await q.select(keys[0]);
      if (error) return { error: error.message };
      if (!data?.length) return { error: "Not saved — only a master can change rates, and only in a draft year." };
    }
    await load();
    return { error: null };
  };

  return {
    rates, splits, policy, loading, error, reload: load,
    saveRates: (rows) => save("bonus_model_rates", rows, ["model", "tier", "role"]),
    saveSplits: (rows) => save("bonus_model_splits", rows, ["model", "role"]),
    savePolicy: (rows) => save("bonus_policy", rows, ["key"]),
  };
}

// One store's plan for a year: the plan row (model + rule), 12 months of
// targets, and the incentive tiers.
export function useStorePlan(locationId, year) {
  const [plan, setPlan] = useState(null);
  const [targets, setTargets] = useState([]);
  const [tiers, setTiers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!locationId || !year) return;
    setLoading(true);
    const [p, t, ti] = await Promise.all([
      supabase.from("bonus_plans").select("*").eq("location_id", locationId).eq("plan_year", year).maybeSingle(),
      supabase.from("bonus_monthly_targets").select("*").eq("location_id", locationId).eq("plan_year", year).order("month"),
      supabase.from("bonus_incentive_tiers").select("*").eq("location_id", locationId).eq("plan_year", year).order("kind").order("tier_index"),
    ]);
    setError(err(p) ?? err(t) ?? err(ti));
    setPlan(p.data ?? null); setTargets(t.data ?? []); setTiers(ti.data ?? []);
    setLoading(false);
  }, [locationId, year]);
  useEffect(() => { load(); }, [load]);

  // plan: the edited plan row; targets: all 12 edited rows; tiers: the
  // full edited list (rows missing from it are deleted).
  const save = async ({ plan: nextPlan, targets: nextTargets, tiers: nextTiers }) => {
    const planPatch = (({ model, threshold_basis, gold_pct, silver_pct, bronze_pct, threshold_floor }) =>
      ({ model, threshold_basis, gold_pct, silver_pct, bronze_pct, threshold_floor, updated_at: new Date().toISOString() }))(nextPlan);
    const pr = await supabase.from("bonus_plans").update(planPatch).eq("id", nextPlan.id).select("id");
    if (pr.error) return { error: pr.error.message };
    if (!pr.data?.length) return { error: "Not saved — plans can be changed only by admin or master, and only in a draft year." };

    for (const t of nextTargets) {
      const before = targets.find((x) => x.id === t.id);
      const fields = ["days_open", "daily_car_goal", "sales_goal", "gp_budget", "last_year_gp"];
      const patch = {};
      for (const f of fields) if (String(before?.[f] ?? "") !== String(t[f] ?? "")) patch[f] = t[f];
      if (!Object.keys(patch).length) continue;
      const r = await supabase.from("bonus_monthly_targets").update(patch).eq("id", t.id).select("id");
      if (r.error) return { error: `Month ${t.month}: ${r.error.message}` };
    }

    const keep = new Set(nextTiers.filter((x) => x.id).map((x) => x.id));
    const removed = tiers.filter((x) => !keep.has(x.id)).map((x) => x.id);
    if (removed.length) {
      const d = await supabase.from("bonus_incentive_tiers").delete().in("id", removed);
      if (d.error) return { error: d.error.message };
    }
    // Re-number each kind 1..n in threshold order, so tier_index stays
    // unique however rows were added or removed.
    const rows = [];
    for (const kind of [...new Set(nextTiers.map((x) => x.kind))]) {
      nextTiers.filter((x) => x.kind === kind)
        .sort((a, b) => Number(a.threshold) - Number(b.threshold))
        .forEach((x, i) => rows.push({ ...x, tier_index: i + 1 }));
    }
    // Move existing rows out of the way first (tier_index is unique per
    // kind), then write the final numbering.
    for (const [i, x] of rows.filter((r) => r.id).entries()) {
      const r = await supabase.from("bonus_incentive_tiers").update({ tier_index: 1000 + i }).eq("id", x.id);
      if (r.error) return { error: r.error.message };
    }
    for (const x of rows) {
      const body = { location_id: locationId, plan_year: year, kind: x.kind, tier_index: x.tier_index,
        threshold: x.threshold, payout: x.payout, increment_above: x.increment_above };
      const r = x.id
        ? await supabase.from("bonus_incentive_tiers").update(body).eq("id", x.id)
        : await supabase.from("bonus_incentive_tiers").insert(body);
      if (r.error) return { error: `${x.kind} tier: ${r.error.message}` };
    }

    const rc = await supabase.rpc("bonus_recalc_thresholds", { p_year: year, p_location: locationId });
    if (rc.error) return { error: rc.error.message };
    await load();
    return { error: null };
  };

  return { plan, targets, tiers, loading, error, reload: load, save };
}
