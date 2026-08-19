import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { monthStartIso, monthEndIso } from "../lib/workdays.js";
import { computeGrossProfit } from "../lib/grossProfit.js";
import { computeBonus } from "../lib/bonusMath.js";

// Loads everything one store's bonus month needs and hands it to
// computeBonus. Nothing about the plan is computed here — the plan, its
// thresholds, its incentive scales, the model rates and the policy
// scalars all come out of migration 26's tables. RLS scopes every store
// read to the store; the three company-wide tables are readable by all.
//
// Gross profit is the SAME figure the tic sheet's goals strip shows
// (lib/grossProfit.js), so it already has technician labor cost deducted.
// Before the tech tracker was wired in this ran ~20% high.
const KPI_SUM_SELECT =
  "id, business_date, ro_count, credit_apps, sales_parts, sales_tires, sales_supplies, " +
  "sales_groupon, sales_discounts, cost_parts, cost_tires";

const PRIVILEGED = ["admin", "master"];

export function useBonusTracker(store, year, month) {
  const { user, role } = useAuth();
  const locationId = store?.id ?? null;
  const canEdit = PRIVILEGED.includes(role);

  const [state, setState] = useState({ loading: false, error: null, plan: null, target: null,
    tiers: [], inputs: null, flags: [], result: null, actual: null });

  const load = useCallback(async () => {
    if (!locationId || !year || !month) return;
    setState((s) => ({ ...s, loading: true, error: null }));

    const start = monthStartIso(year, month);
    const end = monthEndIso(year, month);

    const [planRes, tgtRes, tierRes, inpRes, rateRes, splitRes, polRes, flagRes, kpiRes, techRes, tireCatRes] =
      await Promise.all([
        supabase.from("bonus_plans").select("model")
          .eq("location_id", locationId).eq("plan_year", year).maybeSingle(),
        supabase.from("bonus_monthly_targets").select("*")
          .eq("location_id", locationId).eq("plan_year", year).eq("month", month).maybeSingle(),
        supabase.from("bonus_incentive_tiers").select("kind, tier_index, threshold, payout, increment_above")
          .eq("location_id", locationId).eq("plan_year", year).order("kind").order("tier_index"),
        supabase.from("bonus_monthly_inputs").select("google_reviews, phone_conversion_pct, referral_gp_credit")
          .eq("location_id", locationId).eq("plan_year", year).eq("month", month).maybeSingle(),
        supabase.from("bonus_model_rates").select("model, tier, role, pct"),
        supabase.from("bonus_model_splits").select("model, role, share, sort_order"),
        supabase.from("bonus_policy").select("key, value, note"),
        supabase.from("bonus_flags").select("code, severity, summary, detail, scope_location_id"),
        supabase.from("daily_kpi").select(KPI_SUM_SELECT)
          .eq("location_id", locationId).gte("business_date", start).lte("business_date", end),
        supabase.rpc("tech_store_month", { loc: locationId, month_start: start }),
        supabase.from("service_categories").select("id").eq("horizon_key", "kpi_su_tires").maybeSingle(),
      ]);

    const error = [planRes, tgtRes, tierRes, inpRes, rateRes, splitRes, polRes, flagRes, kpiRes]
      .map((r) => r.error?.message).find(Boolean) ?? null;

    // Month-to-date actuals. days_elapsed counts ENTERED days, matching
    // the tic sheet's PACE and the source spreadsheet's COUNT of the RO
    // column — not calendar days.
    const k = { parts_sales: 0, supplies: 0, tire_sales: 0, groupon: 0, discounts: 0, parts_cost: 0, tire_cost: 0 };
    let roCount = 0, creditApps = 0, daysElapsed = 0;
    const kpiIds = [];
    for (const r of kpiRes.data ?? []) {
      k.parts_sales += Number(r.sales_parts);
      k.tire_sales += Number(r.sales_tires);
      k.supplies += Number(r.sales_supplies);
      k.groupon += Number(r.sales_groupon);
      k.discounts += Number(r.sales_discounts);
      k.parts_cost += Number(r.cost_parts);
      k.tire_cost += Number(r.cost_tires);
      roCount += Number(r.ro_count);
      creditApps += Number(r.credit_apps);
      if (Number(r.ro_count) > 0) daysElapsed += 1;
      kpiIds.push(r.id);
    }

    let tireUnits = 0;
    const tireCatId = tireCatRes.data?.id ?? null;
    if (tireCatId && kpiIds.length) {
      const { data: units } = await supabase.from("daily_service_units")
        .select("units").in("daily_kpi_id", kpiIds).eq("service_category_id", tireCatId);
      for (const u of units ?? []) tireUnits += Number(u.units);
    }

    const tech = Array.isArray(techRes.data) ? techRes.data[0] ?? null : techRes.data ?? null;
    const grossProfit = computeGrossProfit(k, tech).grossProfit;
    const actual = { grossProfit, daysElapsed, tireUnits, creditApps, roCount, laborCost: Number(tech?.labor_cost ?? 0) };

    const plan = planRes.data?.model ?? null;
    const target = tgtRes.data ?? null;
    const inputs = inpRes.data ?? null;
    const flags = (flagRes.data ?? []).filter((f) => !f.scope_location_id || f.scope_location_id === locationId);

    const result = plan && target
      ? computeBonus({ model: plan, target, tiers: tierRes.data ?? [], inputs, actual,
          rates: rateRes.data ?? [], splits: splitRes.data ?? [], policy: polRes.data ?? [] })
      : null;

    setState({ loading: false, error, plan, target, tiers: tierRes.data ?? [], inputs, flags, result, actual });
  }, [locationId, year, month]);

  useEffect(() => { load(); }, [load]);

  // The three figures nothing tracks yet. Null is meaningful — it means
  // "never entered", which the screen shows as unfilled rather than zero.
  const saveInputs = useCallback(async (patch) => {
    const { error } = await supabase.from("bonus_monthly_inputs").upsert(
      { location_id: locationId, plan_year: year, month,
        google_reviews: null, phone_conversion_pct: null, referral_gp_credit: 0,
        ...(state.inputs ?? {}), ...patch,
        updated_by: user?.id ?? null, updated_at: new Date().toISOString() },
      { onConflict: "location_id,plan_year,month" }
    );
    if (error) return { error };
    await load();
    return { error: null };
  }, [locationId, year, month, state.inputs, user?.id, load]);

  return { ...state, canEdit, saveInputs, reload: load };
}
