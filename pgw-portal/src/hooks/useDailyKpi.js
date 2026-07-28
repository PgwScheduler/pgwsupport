import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";

// Loads one store's service-category list (for its brand) plus the daily_kpi
// row + service-unit counts for a single business date, and saves them back.
// RLS (can_access_location) does all store scoping — we never filter by role
// or hardcode a store list here. The category list comes from
// brand_service_categories joined to service_categories; a Speedee store with
// no seeded categories simply returns an empty list.
const CATEGORY_SELECT =
  "display_order, active, service_category:service_category_id ( id, horizon_key, display_name )";

// The eleven day-summary columns, in entry order.
export const SUMMARY_FIELDS = [
  { key: "ro_count", label: "Repair Orders", kind: "int" },
  { key: "sales_labor", label: "Labor Sales", kind: "money" },
  { key: "sales_parts", label: "Parts Sales", kind: "money" },
  { key: "sales_tires", label: "Tire Sales", kind: "money" },
  { key: "sales_discounts", label: "Discounts", kind: "money" },
  { key: "sales_other", label: "Other Sales", kind: "money" },
  { key: "cost_parts", label: "Parts Cost", kind: "money" },
  { key: "cost_tires", label: "Tire Cost", kind: "money" },
  { key: "declined_sales", label: "Declined Sales", kind: "money" },
  { key: "credit_apps", label: "Credit Applications", kind: "int" },
  { key: "credit_dollars", label: "Credit Dollars", kind: "money" },
];

const SUMMARY_COLUMNS = SUMMARY_FIELDS.map((f) => f.key);
const KPI_SELECT =
  "id, location_id, business_date, submitted_at, entered_at, updated_at, " + SUMMARY_COLUMNS.join(", ");

export function useDailyKpi(store, businessDate) {
  const { user } = useAuth();
  const locationId = store?.id ?? null;
  const brand = store?.brand ?? null;

  const [categories, setCategories] = useState([]); // [{ id, horizon_key, display_name, display_order }]
  const [kpi, setKpi] = useState(null); // the daily_kpi row for this date, or null
  const [units, setUnits] = useState({}); // { [service_category_id]: number }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!locationId || !brand || !businessDate) return;
    setLoading(true);
    setError(null);

    const [catRes, kpiRes] = await Promise.all([
      supabase
        .from("brand_service_categories")
        .select(CATEGORY_SELECT)
        .eq("brand", brand)
        .eq("active", true)
        .order("display_order"),
      supabase
        .from("daily_kpi")
        .select(KPI_SELECT)
        .eq("location_id", locationId)
        .eq("business_date", businessDate)
        .maybeSingle(),
    ]);

    if (catRes.error) setError(catRes.error.message);
    else {
      setCategories(
        (catRes.data ?? [])
          .filter((r) => r.service_category)
          .map((r) => ({ ...r.service_category, display_order: r.display_order }))
      );
    }

    if (kpiRes.error) {
      setError(kpiRes.error.message);
      setKpi(null);
      setUnits({});
    } else {
      const row = kpiRes.data ?? null;
      setKpi(row);
      if (row) {
        const { data: unitRows, error: unitErr } = await supabase
          .from("daily_service_units")
          .select("service_category_id, units")
          .eq("daily_kpi_id", row.id);
        if (unitErr) setError(unitErr.message);
        else {
          const map = {};
          for (const u of unitRows ?? []) map[u.service_category_id] = u.units;
          setUnits(map);
        }
      } else {
        setUnits({});
      }
    }

    setLoading(false);
  }, [locationId, brand, businessDate]);

  useEffect(() => {
    load();
  }, [load]);

  // Persist the day. `summary` is a { column: number } map, `unitCounts` is a
  // { service_category_id: number } map. submit=true stamps submitted_at (and
  // leaves it stamped on re-save); an already-submitted day stays editable.
  const save = useCallback(
    async ({ summary, unitCounts, submit }) => {
      if (!locationId || !businessDate) return { error: new Error("No store or date selected") };
      const nowIso = new Date().toISOString();

      let kpiId = kpi?.id ?? null;

      if (kpiId) {
        const patch = { ...summary, updated_by: user?.id ?? null, updated_at: nowIso };
        if (submit) patch.submitted_at = nowIso;
        const { error: updErr } = await supabase.from("daily_kpi").update(patch).eq("id", kpiId);
        if (updErr) return { error: updErr };
      } else {
        const insertRow = {
          location_id: locationId,
          business_date: businessDate,
          ...summary,
          entered_by: user?.id ?? null,
          updated_by: user?.id ?? null,
        };
        if (submit) insertRow.submitted_at = nowIso;
        const { data, error: insErr } = await supabase
          .from("daily_kpi")
          .insert(insertRow)
          .select("id")
          .single();
        if (insErr) return { error: insErr };
        kpiId = data.id;
      }

      // Upsert one unit row per category (blank -> 0 handled by the caller).
      const unitRows = categories.map((c) => ({
        daily_kpi_id: kpiId,
        service_category_id: c.id,
        units: unitCounts[c.id] ?? 0,
      }));
      if (unitRows.length) {
        const { error: unitErr } = await supabase
          .from("daily_service_units")
          .upsert(unitRows, { onConflict: "daily_kpi_id,service_category_id" });
        if (unitErr) return { error: unitErr };
      }

      await load();
      return { error: null };
    },
    [locationId, businessDate, kpi?.id, user?.id, categories, load]
  );

  const submittedAt = kpi?.submitted_at ?? null;

  return useMemo(
    () => ({ categories, kpi, units, submittedAt, loading, error, reload: load, save }),
    [categories, kpi, units, submittedAt, loading, error, load, save]
  );
}
