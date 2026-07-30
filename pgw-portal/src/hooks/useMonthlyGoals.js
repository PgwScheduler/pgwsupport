import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { countWorkdays, monthStartIso, monthEndIso } from "../lib/workdays.js";

// Loads the goals summary for one store and the month of `businessDate`:
//   - month gross profit target (from v_store_monthly_gp_target)
//   - month-to-date actual GP (sum of this month's daily_kpi)
//   - daily pace needed to hit the target over the remaining working days
//   - cars-per-day goal vs actual (null when the store has no cars goal)
// `todayIso` anchors the elapsed/remaining working-day split. RLS scopes
// every read to the store; the view is security_invoker so it obeys the same.
const KPI_SUM_SELECT =
  "ro_count, sales_labor, sales_parts, sales_tires, sales_supplies, sales_groupon, sales_discounts, cost_parts, cost_tires";

const EMPTY = {
  loading: false, error: null,
  gpTarget: null, mtdActual: 0, dailyPace: null, targetMet: false,
  carsGoal: null, carsActual: null, hasCarsGoal: false,
  daysOpen: 0, elapsed: 0, remaining: 0,
};

export function useMonthlyGoals(store, businessDate, todayIso) {
  const locationId = store?.id ?? null;
  const [year, month] = businessDate ? businessDate.split("-").map(Number) : [null, null];
  const [state, setState] = useState(EMPTY);

  const load = useCallback(async () => {
    if (!locationId || !year || !month) return;
    setState((s) => ({ ...s, loading: true, error: null }));

    const start = monthStartIso(year, month);
    const end = monthEndIso(year, month);

    const [tgtRes, carsRes, kpiRes, holRes] = await Promise.all([
      supabase.from("v_store_monthly_gp_target")
        .select("gp_target, days_open")
        .eq("location_id", locationId).eq("goal_year", year).eq("goal_month", month)
        .maybeSingle(),
      supabase.from("store_monthly_goals")
        .select("cars_per_day_goal")
        .eq("location_id", locationId).eq("goal_year", year).eq("goal_month", month)
        .maybeSingle(),
      supabase.from("daily_kpi")
        .select(KPI_SUM_SELECT)
        .eq("location_id", locationId)
        .gte("business_date", start).lte("business_date", end),
      supabase.from("holidays")
        .select("holiday_date")
        .gte("holiday_date", start).lte("holiday_date", end),
    ]);

    const error =
      tgtRes.error?.message || carsRes.error?.message ||
      kpiRes.error?.message || holRes.error?.message || null;

    const holidaySet = new Set((holRes.data ?? []).map((h) => h.holiday_date));
    let gp = 0, ro = 0;
    for (const r of kpiRes.data ?? []) {
      gp += Number(r.sales_labor) + Number(r.sales_parts) + Number(r.sales_tires)
          + Number(r.sales_supplies) + Number(r.sales_groupon) + Number(r.sales_discounts)
          - Number(r.cost_parts) - Number(r.cost_tires);
      ro += Number(r.ro_count);
    }

    // Total working days for the month (override-aware, from the view).
    const daysOpen = tgtRes.data?.days_open != null
      ? Number(tgtRes.data.days_open)
      : countWorkdays(start, end, holidaySet);

    // Working days already elapsed as of today, clamped into the month.
    let elapsed;
    if (todayIso < start) elapsed = 0;
    else if (todayIso > end) elapsed = daysOpen;
    else elapsed = Math.min(daysOpen, countWorkdays(start, todayIso, holidaySet));
    const remaining = Math.max(0, daysOpen - elapsed);

    const gpTarget = tgtRes.data ? Number(tgtRes.data.gp_target) : null;
    const shortfall = gpTarget != null ? gpTarget - gp : null;
    let dailyPace;
    if (gpTarget == null) dailyPace = null;
    else if (shortfall <= 0) dailyPace = 0;          // target met -> floored at zero
    else if (remaining > 0) dailyPace = shortfall / remaining;
    else dailyPace = null;                             // not met, no days left

    const carsGoal = carsRes.data?.cars_per_day_goal != null
      ? Number(carsRes.data.cars_per_day_goal) : null;
    const carsActual = elapsed > 0 ? ro / elapsed : null;

    setState({
      loading: false, error,
      gpTarget, mtdActual: gp,
      dailyPace, targetMet: gpTarget != null && shortfall <= 0,
      carsGoal, carsActual, hasCarsGoal: carsGoal != null,
      daysOpen, elapsed, remaining,
    });
  }, [locationId, year, month, todayIso]);

  useEffect(() => { load(); }, [load]);

  return { ...state, reload: load };
}
