import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { monthStartIso, monthEndIso } from "../lib/workdays.js";

// Loads a whole month of the tic sheet for one store: the brand's service
// categories, every daily_kpi row + its service-unit counts for the month,
// and the month's holidays. Exposes get-or-create + per-cell autosave so the
// grid never needs a save button. RLS (can_access_location) scopes all reads
// and writes to the store. Nothing here assumes a category has a Horizon key —
// categories are identified by their numeric id, displayed by display_name.
const CATEGORY_SELECT =
  "display_order, active, service_category:service_category_id ( id, horizon_key, display_name )";

// Every editable / stored daily_kpi field the grid touches. Sales breakdown
// (labor/parts/tires/discounts/other) is entered in the per-day detail panel.
const KPI_COLUMNS = [
  "ro_count", "first_time_customers", "declined_sales", "credit_apps", "credit_dollars",
  "sales_labor", "sales_parts", "sales_tires", "sales_supplies", "sales_groupon", "sales_discounts",
  "cost_parts", "cost_tires",
];
const KPI_SELECT = "id, business_date, " + KPI_COLUMNS.join(", ");

export function useMonthlyTicSheet(store, year, month) {
  const { user } = useAuth();
  const locationId = store?.id ?? null;
  const brand = store?.brand ?? null;

  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [holidaySet, setHolidaySet] = useState(() => new Set());

  // Live source of truth for grid cells; a tick forces re-render after writes
  // without clobbering the uncontrolled inputs the user is typing into.
  const kpiRef = useRef({});    // dateIso -> daily_kpi row (has id)
  const unitsRef = useRef({});  // dateIso -> { [categoryId]: units }
  const pendingRef = useRef({}); // dateIso -> Promise<id> (in-flight get-or-create)
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);

  const load = useCallback(async () => {
    if (!locationId || !brand || !year || !month) return;
    setLoading(true);
    setError(null);
    kpiRef.current = {};
    unitsRef.current = {};
    pendingRef.current = {};

    const start = monthStartIso(year, month);
    const end = monthEndIso(year, month);

    const [catRes, kpiRes, holRes] = await Promise.all([
      supabase.from("brand_service_categories").select(CATEGORY_SELECT)
        .eq("brand", brand).eq("active", true).order("display_order"),
      supabase.from("daily_kpi").select(KPI_SELECT)
        .eq("location_id", locationId).gte("business_date", start).lte("business_date", end),
      supabase.from("holidays").select("holiday_date")
        .gte("holiday_date", start).lte("holiday_date", end),
    ]);

    if (catRes.error) setError(catRes.error.message);
    else setCategories(
      (catRes.data ?? []).filter((r) => r.service_category)
        .map((r) => ({ ...r.service_category, display_order: r.display_order }))
    );

    if (kpiRes.error) setError(kpiRes.error.message);
    else {
      const byId = {};
      for (const row of kpiRes.data ?? []) {
        kpiRef.current[row.business_date] = row;
        byId[row.id] = row.business_date;
      }
      const ids = (kpiRes.data ?? []).map((r) => r.id);
      if (ids.length) {
        const { data: unitRows, error: unitErr } = await supabase
          .from("daily_service_units").select("daily_kpi_id, service_category_id, units")
          .in("daily_kpi_id", ids);
        if (unitErr) setError(unitErr.message);
        else for (const u of unitRows ?? []) {
          const d = byId[u.daily_kpi_id];
          (unitsRef.current[d] ??= {})[u.service_category_id] = u.units;
        }
      }
    }

    if (!holRes.error) setHolidaySet(new Set((holRes.data ?? []).map((h) => h.holiday_date)));

    setLoading(false);
    rerender();
  }, [locationId, brand, year, month]);

  useEffect(() => { load(); }, [load]);

  // Return the daily_kpi id for a date, inserting an empty row if needed.
  // A per-date in-flight promise prevents duplicate inserts when the manager
  // tabs quickly across a brand-new day's cells.
  const ensureRow = useCallback((dateIso) => {
    const existing = kpiRef.current[dateIso];
    if (existing?.id) return Promise.resolve(existing.id);
    if (pendingRef.current[dateIso]) return pendingRef.current[dateIso];
    const p = (async () => {
      const { data, error: insErr } = await supabase.from("daily_kpi")
        .insert({ location_id: locationId, business_date: dateIso, entered_by: user?.id ?? null, updated_by: user?.id ?? null })
        .select(KPI_SELECT).single();
      if (insErr) { delete pendingRef.current[dateIso]; throw insErr; }
      kpiRef.current[dateIso] = data;
      delete pendingRef.current[dateIso];
      rerender();
      return data.id;
    })();
    pendingRef.current[dateIso] = p;
    return p;
  }, [locationId, user?.id]);

  const saveSummary = useCallback(async (dateIso, patch) => {
    try {
      const id = await ensureRow(dateIso);
      const { error: updErr } = await supabase.from("daily_kpi")
        .update({ ...patch, updated_by: user?.id ?? null, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (updErr) return { error: updErr };
      kpiRef.current[dateIso] = { ...kpiRef.current[dateIso], ...patch };
      rerender();
      return { error: null };
    } catch (e) { return { error: e }; }
  }, [ensureRow, user?.id]);

  const saveUnit = useCallback(async (dateIso, categoryId, value) => {
    try {
      const id = await ensureRow(dateIso);
      const { error: upErr } = await supabase.from("daily_service_units")
        .upsert({ daily_kpi_id: id, service_category_id: categoryId, units: value },
                { onConflict: "daily_kpi_id,service_category_id" });
      if (upErr) return { error: upErr };
      (unitsRef.current[dateIso] ??= {})[categoryId] = value;
      rerender();
      return { error: null };
    } catch (e) { return { error: e }; }
  }, [ensureRow]);

  return {
    categories, holidaySet, loading, error,
    kpiByDate: kpiRef.current, unitsByDate: unitsRef.current,
    saveSummary, saveUnit, reload: load,
  };
}
