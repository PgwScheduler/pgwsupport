import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { useDateRange } from "../context/DateRangeProvider.jsx";
import {
  DEFAULT_MAX_ROWS,
  groupByLabel,
  orderMeasures,
  resolvePresetMeasures,
  resolvePresetStores,
} from "../lib/reportSpec.js";
import { rangeLabel } from "../lib/dateRange.js";

// =====================================================================
// The Report Builder's state and its two calls into the database.
//
// SCOPE IS NOT DECIDED HERE. `stores` from AuthProvider is already the
// set can_access_location() allows, and the ids sent to report_build()
// only narrow it further — the function re-checks every one. Nothing on
// this side of the wire can widen a user's reach, which is why the
// picker can be built from the same list without a second thought.
//
// RUNNING IS EXPLICIT. Thirty-six stores by day is not a query to fire
// on every checkbox click, so `run()` is a button. The result carries
// the spec it was produced from, so exporting after editing the picker
// exports what is on screen rather than what is in the form.
// =====================================================================

const isAdmin = (role) => role === "admin" || role === "master";

export function useReportBuilder() {
  const { stores, currentStore, role } = useAuth();
  const { from, to, preset } = useDateRange();

  const [catalog, setCatalog] = useState([]);
  const [catalogError, setCatalogError] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  const [selectedStoreIds, setSelectedStoreIds] = useState([]);
  const [selectedMeasures, setSelectedMeasures] = useState([]);
  const [groupBy, setGroupBy] = useState("day");

  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  // The catalogue is the single source of truth for what exists. It is
  // filtered by role for DISPLAY only — report_build() refuses a
  // restricted measure whether or not the checkbox was ever rendered.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase.rpc("report_measure_catalog");
      if (cancelled) return;
      if (err) {
        setCatalogError(err.message);
        setCatalog([]);
      } else {
        setCatalogError(null);
        setCatalog((data ?? []).filter((m) => isAdmin(role) || !m.restricted));
      }
      setLoadingCatalog(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [role]);

  // Default the store selection to the store in the header picker, which
  // is the report a manager most often wants and the cheapest query.
  useEffect(() => {
    if (selectedStoreIds.length === 0 && currentStore) setSelectedStoreIds([currentStore.id]);
  }, [currentStore, selectedStoreIds.length]);

  const selectedStores = useMemo(
    () => stores.filter((s) => selectedStoreIds.includes(s.id)),
    [stores, selectedStoreIds]
  );

  const orderedMeasures = useMemo(
    () => orderMeasures(selectedMeasures, catalog),
    [selectedMeasures, catalog]
  );

  const columns = useMemo(() => {
    const byKey = new Map(catalog.map((m) => [m.measure_key, m]));
    return orderedMeasures
      .map((k) => byKey.get(k))
      .filter(Boolean)
      .map((m) => ({ key: m.measure_key, label: m.label, kind: m.kind, group: m.group_label }));
  }, [orderedMeasures, catalog]);

  const toggleMeasure = useCallback((key) => {
    setSelectedMeasures((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const setMeasureGroup = useCallback((keys, on) => {
    setSelectedMeasures((prev) => {
      const set = new Set(prev);
      for (const k of keys) (on ? set.add(k) : set.delete(k));
      return [...set];
    });
  }, []);

  const applyPreset = useCallback(
    (p) => {
      setSelectedMeasures(resolvePresetMeasures(p, catalog));
      setSelectedStoreIds(
        resolvePresetStores(p, { stores, currentStore, selected: selectedStoreIds })
      );
      setGroupBy(p.groupBy);
      setResult(null);
      setError(null);
    },
    [catalog, stores, currentStore, selectedStoreIds]
  );

  // One call. `p_split_by_store` stays false here — the on-screen table
  // is the grouping the user asked for, nothing more.
  const callBuild = useCallback(
    async ({ measures, storeIds, group, split }) =>
      supabase.rpc("report_build", {
        p_from: from,
        p_to: to,
        p_group_by: group,
        p_measures: measures,
        p_locations: storeIds,
        p_split_by_store: split,
        p_max_rows: DEFAULT_MAX_ROWS,
      }),
    [from, to]
  );

  const run = useCallback(async () => {
    if (!orderedMeasures.length || !selectedStoreIds.length) return;
    setRunning(true);
    setError(null);
    const { data, error: err } = await callBuild({
      measures: orderedMeasures,
      storeIds: selectedStoreIds,
      group: groupBy,
      split: false,
    });
    if (err) {
      // 54000 is the row cap and 42501 the pay-measure refusal. Both
      // carry a message written for a person, so show it as written
      // rather than translating it into something vaguer.
      setError({ code: err.code, message: err.message });
      setResult(null);
    } else {
      const all = data ?? [];
      setResult({
        rows: all.filter((r) => !r.is_total),
        total: all.find((r) => r.is_total && !r.store_id) ?? null,
        columns,
        spec: { from, to, groupBy, storeIds: selectedStoreIds, measures: orderedMeasures },
      });
    }
    setRunning(false);
  }, [callBuild, orderedMeasures, selectedStoreIds, groupBy, columns, from, to]);

  // Export the report that is ON SCREEN, using the spec it was run with.
  // Grouped by store across more than one store, a second call fetches
  // the same measures by day split by store so each tab is a filter of
  // one dataset — never a separately-derived second answer.
  const exportXlsx = useCallback(async () => {
    if (!result) return;
    setExporting(true);
    setError(null);
    try {
      const spec = result.spec;
      const wantTabs = spec.groupBy === "store" && spec.storeIds.length > 1;

      let perStoreRows = null;
      if (wantTabs) {
        const { data, error: err } = await callBuild({
          measures: spec.measures,
          storeIds: spec.storeIds,
          group: "day",
          split: true,
        });
        // A per-store breakdown that will not fit under the row cap is
        // not a reason to lose the summary: keep the tabs off and say so.
        if (err) {
          setError({
            code: err.code,
            message:
              err.code === "54000"
                ? `The summary exported, but the per-store daily tabs did not: ${err.message}`
                : err.message,
          });
        } else {
          perStoreRows = data ?? [];
        }
      }

      const present = new Set(
        spec.groupBy === "store"
          ? result.rows.filter((r) => Object.keys(r.measures ?? {}).length).map((r) => r.bucket_key)
          : []
      );
      const missingStores =
        spec.groupBy === "store"
          ? stores.filter((s) => spec.storeIds.includes(s.id) && !present.has(s.id))
          : [];

      const { exportReportWorkbook } = await import("../lib/reportWorkbook.js");
      await exportReportWorkbook({
        columns: result.columns,
        rows: [...result.rows, ...(result.total ? [result.total] : [])],
        perStoreRows,
        stores: stores.filter((s) => spec.storeIds.includes(s.id)),
        missingStores,
        meta: {
          from: spec.from,
          to: spec.to,
          groupBy: spec.groupBy,
          groupByLabel: groupByLabel(spec.groupBy),
          rangeLabel: rangeLabel(spec.from, spec.to),
        },
      });
    } catch (e) {
      setError({ code: null, message: e.message || String(e) });
    } finally {
      setExporting(false);
    }
  }, [result, callBuild, stores]);

  // Editing the form after a run leaves the table on screen but marks it
  // stale, so nobody reads a table that no longer matches the controls.
  const stale = useMemo(() => {
    if (!result) return false;
    const s = result.spec;
    return (
      s.from !== from ||
      s.to !== to ||
      s.groupBy !== groupBy ||
      s.measures.join() !== orderedMeasures.join() ||
      [...s.storeIds].sort().join() !== [...selectedStoreIds].sort().join()
    );
  }, [result, from, to, groupBy, orderedMeasures, selectedStoreIds]);

  return {
    catalog,
    catalogError,
    loadingCatalog,
    stores,
    currentStore,
    role,
    canSeePay: isAdmin(role),
    selectedStoreIds,
    setSelectedStoreIds,
    selectedStores,
    selectedMeasures: orderedMeasures,
    toggleMeasure,
    setMeasureGroup,
    setSelectedMeasures,
    groupBy,
    setGroupBy,
    columns,
    result,
    stale,
    running,
    exporting,
    error,
    from,
    to,
    rangePreset: preset,
    run,
    exportXlsx,
    applyPreset,
  };
}
