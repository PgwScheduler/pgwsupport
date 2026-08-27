import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { useDateRange } from "../context/DateRangeProvider.jsx";
import {
  DEFAULT_MAX_ROWS,
  groupByLabel,
  needsPriorYear,
  orderMeasures,
  resolvePresetMeasures,
  resolvePresetStores,
} from "../lib/reportSpec.js";
import { indexRules } from "../lib/reportFormat.js";
import { rangeFor, rangeLabel } from "../lib/dateRange.js";

// =====================================================================
// The Report Builder's state and its calls into the database.
//
// SCOPE IS NOT DECIDED HERE. `stores` from AuthProvider is already the
// set can_access_location() allows, and the ids sent to report_build()
// only narrow it further — the function re-checks every one. Nothing on
// this side of the wire can widen a user's reach.
//
// RUNNING IS EXPLICIT. Thirty-six stores by day is not a query to fire
// on every checkbox click, so `run()` is a button. The result carries
// the spec it was produced from, so what is on screen always describes
// itself rather than the form above it.
// =====================================================================

const isAdmin = (role) => role === "admin" || role === "master";

export function useReportBuilder() {
  const { stores, currentStore, role } = useAuth();
  const { from, to, preset, setPreset } = useDateRange();

  const [catalog, setCatalog] = useState([]);
  const [catalogError, setCatalogError] = useState(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [rules, setRules] = useState([]);

  const [selectedStoreIds, setSelectedStoreIds] = useState([]);
  const [selectedMeasures, setSelectedMeasures] = useState([]);
  const [groupBy, setGroupBy] = useState("day");
  const [sort, setSort] = useState({ measure: null, dir: "desc" });
  // The second window: which preset range it follows and which of the
  // selected measures read it. Null means every column is the main range.
  const [alt, setAlt] = useState(null);

  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [priorYearAvailable, setPriorYearAvailable] = useState(null);

  // The catalogue is the single source of truth for what exists. It is
  // filtered by role for DISPLAY only — report_build() refuses a
  // restricted measure whether or not the checkbox was ever rendered.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cat, fr] = await Promise.all([
        supabase.rpc("report_measure_catalog"),
        supabase.from("report_format_rules").select("*").order("sort_order"),
      ]);
      if (cancelled) return;
      if (cat.error) {
        setCatalogError(cat.error.message);
        setCatalog([]);
      } else {
        setCatalogError(null);
        setCatalog((cat.data ?? []).filter((m) => isAdmin(role) || !m.restricted));
      }
      // Formatting is a nicety; a report without colours is still a
      // report, so a rules failure must not blank the screen.
      setRules(fr.error ? [] : fr.data ?? []);
      setLoadingCatalog(false);
    })();
    return () => { cancelled = true; };
  }, [role]);

  // Is there any prior-year data for the month this report lands in? The
  // answer decides whether the vs-2025 columns render as figures or as
  // UNAVAILABLE — never as zero, and never as a percentage against
  // nothing, which reads as infinite improvement for every store.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!to) return;
      const d = new Date(to + "T00:00:00");
      const { data, error: err } = await supabase
        .from("prior_year_actuals")
        .select("id")
        .eq("year", d.getFullYear() - 1)
        .eq("month", d.getMonth() + 1)
        .limit(1);
      if (!cancelled) setPriorYearAvailable(err ? null : (data ?? []).length > 0);
    })();
    return () => { cancelled = true; };
  }, [to]);

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

  const ruleIndex = useMemo(() => indexRules(rules), [rules]);

  const altWindow = useMemo(() => (alt?.range ? rangeFor(alt.range) : null), [alt?.range]);

  const columns = useMemo(() => {
    const byKey = new Map(catalog.map((m) => [m.measure_key, m]));
    return orderedMeasures
      .map((k) => byKey.get(k))
      .filter(Boolean)
      .map((m) => ({
        key: m.measure_key,
        label: m.label,
        kind: m.kind,
        group: m.group_label,
        // A column on the other window says so in its header, because a
        // yesterday column beside month-to-date columns is otherwise
        // indistinguishable and quietly wrong to read.
        altWindow: alt?.measures?.includes(m.measure_key) ? alt.range : null,
      }));
  }, [orderedMeasures, catalog, alt]);

  const toggleMeasure = useCallback((key) => {
    setSelectedMeasures((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    // A measure that leaves the report cannot remain its sort.
    setSort((s) => (s.measure === key ? { measure: null, dir: s.dir } : s));
  }, []);

  const setMeasureGroup = useCallback((keys, on) => {
    setSelectedMeasures((prev) => {
      const set = new Set(prev);
      for (const k of keys) (on ? set.add(k) : set.delete(k));
      return [...set];
    });
    if (!on) setSort((s) => (keys.includes(s.measure) ? { measure: null, dir: s.dir } : s));
  }, []);

  // Clicking a column header sorts by it; clicking the same one again
  // flips the direction. Descending first, because every leadership
  // report leads with the largest.
  const toggleSort = useCallback((key) => {
    setSort((s) => (s.measure === key ? { measure: key, dir: s.dir === "desc" ? "asc" : "desc" }
                                      : { measure: key, dir: "desc" }));
  }, []);

  const applyPreset = useCallback(
    (p) => {
      const measures = resolvePresetMeasures(p, catalog);
      setSelectedMeasures(measures);
      setSelectedStoreIds(resolvePresetStores(p, { stores, currentStore, selected: selectedStoreIds }));
      setGroupBy(p.groupBy);
      setSort(p.sort ?? { measure: null, dir: "desc" });
      setAlt(p.altRange ? { range: p.altRange, measures: p.altMeasures ?? [] } : null);
      if (p.range) setPreset(p.range);
      setResult(null);
      setError(null);
    },
    [catalog, stores, currentStore, selectedStoreIds, setPreset]
  );

  const callBuild = useCallback(
    async ({ measures, storeIds, group, split, sortSpec, altSpec }) =>
      supabase.rpc("report_build", {
        p_from: from,
        p_to: to,
        p_group_by: group,
        p_measures: measures,
        p_locations: storeIds,
        p_split_by_store: split,
        p_max_rows: DEFAULT_MAX_ROWS,
        p_sort_measure: sortSpec?.measure ?? null,
        p_sort_dir: sortSpec?.dir ?? "desc",
        p_alt_from: altSpec?.from ?? null,
        p_alt_to: altSpec?.to ?? null,
        p_alt_measures: altSpec?.measures ?? null,
      }),
    [from, to]
  );

  const run = useCallback(async () => {
    if (!orderedMeasures.length || !selectedStoreIds.length) return;
    setRunning(true);
    setError(null);
    const altSpec = altWindow && alt?.measures?.length
      ? { from: altWindow.from, to: altWindow.to, measures: alt.measures }
      : null;
    const { data, error: err } = await callBuild({
      measures: orderedMeasures,
      storeIds: selectedStoreIds,
      group: groupBy,
      split: false,
      sortSpec: sort.measure ? sort : null,
      altSpec,
    });
    if (err) {
      // 54000 is the row cap, 42501 the pay refusal, 22023 a bad
      // request. All carry a message written for a person.
      setError({ code: err.code, message: err.message });
      setResult(null);
    } else {
      const all = data ?? [];
      setResult({
        rows: all.filter((r) => !r.is_total),
        total: all.find((r) => r.is_total && !r.store_id) ?? null,
        columns,
        spec: {
          from, to, groupBy, storeIds: selectedStoreIds, measures: orderedMeasures,
          sort: sort.measure ? { ...sort } : null,
          alt: altSpec ? { ...altSpec, range: alt.range } : null,
        },
      });
    }
    setRunning(false);
  }, [callBuild, orderedMeasures, selectedStoreIds, groupBy, columns, from, to, sort, alt, altWindow]);

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
          sortSpec: null,
          altSpec: spec.alt,
        });
        if (err) {
          setError({
            code: err.code,
            message: err.code === "54000"
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
      const missingStores = spec.groupBy === "store"
        ? stores.filter((s) => spec.storeIds.includes(s.id) && !present.has(s.id))
        : [];

      // Lazy-loaded to keep ExcelJS (~1 MB) out of the entry chunk — see the
      // note in useCloseoutRangeExport.js; all three workbooks share one copy,
      // so this only works if none of them is imported statically.
      const { exportReportWorkbook } = await import("../lib/reportWorkbook.js");
      await exportReportWorkbook({
        columns: result.columns,
        rows: [...result.rows, ...(result.total ? [result.total] : [])],
        perStoreRows,
        stores: stores.filter((s) => spec.storeIds.includes(s.id)),
        missingStores,
        rules,
        unavailable: unavailableMeasures,
        meta: {
          from: spec.from,
          to: spec.to,
          groupBy: spec.groupBy,
          groupByLabel: groupByLabel(spec.groupBy),
          rangeLabel: rangeLabel(spec.from, spec.to),
          altLabel: spec.alt ? rangeLabel(spec.alt.from, spec.alt.to) : null,
          altMeasures: spec.alt?.measures ?? [],
          sort: spec.sort,
        },
      });
    } catch (e) {
      setError({ code: null, message: e.message || String(e) });
    } finally {
      setExporting(false);
    }
  }, [result, callBuild, stores, rules]);

  const stale = useMemo(() => {
    if (!result) return false;
    const s = result.spec;
    return (
      s.from !== from ||
      s.to !== to ||
      s.groupBy !== groupBy ||
      s.measures.join() !== orderedMeasures.join() ||
      (s.sort?.measure ?? null) !== (sort.measure ?? null) ||
      (s.sort?.dir ?? null) !== (sort.measure ? sort.dir : null) ||
      [...s.storeIds].sort().join() !== [...selectedStoreIds].sort().join()
    );
  }, [result, from, to, groupBy, orderedMeasures, selectedStoreIds, sort]);

  // Which of the report's columns cannot be answered yet. The columns
  // still appear — a report that silently drops them would look complete.
  const unavailableMeasures = useMemo(() => {
    if (priorYearAvailable !== false) return [];
    return orderedMeasures.filter((k) => needsPriorYear([k]));
  }, [priorYearAvailable, orderedMeasures]);

  return {
    catalog, catalogError, loadingCatalog, rules, ruleIndex,
    stores, currentStore, role, canSeePay: isAdmin(role),
    selectedStoreIds, setSelectedStoreIds, selectedStores,
    selectedMeasures: orderedMeasures, toggleMeasure, setMeasureGroup, setSelectedMeasures,
    groupBy, setGroupBy,
    sort, setSort, toggleSort,
    alt, setAlt, altWindow,
    columns, result, stale, running, exporting, error,
    from, to, rangePreset: preset,
    priorYearAvailable, unavailableMeasures,
    run, exportXlsx, applyPreset,
  };
}
