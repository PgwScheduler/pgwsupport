import React, { useMemo, useState } from "react";
import {
  AlertTriangle, ArrowDown, ArrowUp, CalendarClock, Database, FileSpreadsheet, Info, Play, Table2,
} from "lucide-react";
import { useReportBuilder } from "../../hooks/useReportBuilder.js";
import { useAuth } from "../../context/AuthProvider.jsx";
import { DateRangeControl } from "../DateRangeControl.jsx";
import { Card, Empty, GhostBtn, PrimaryBtn, SectionHeader, T } from "../ui.jsx";
import { StoreMultiSelect } from "./StoreMultiSelect.jsx";
import { MeasurePicker } from "./MeasurePicker.jsx";
import { PriorYearImportModal } from "./PriorYearImportModal.jsx";
import {
  GROUP_BY, PRESETS, formatCell, groupByLabel, hasAttributedPay, hasRepeatedMonthly,
} from "../../lib/reportSpec.js";
import { formatWithRules, tokenStyle } from "../../lib/reportFormat.js";
import { rangeLabel, presetLabel } from "../../lib/dateRange.js";

// =====================================================================
// Report Builder — the generic builder, and the five reports leadership
// already circulates sitting on top of it.
//
// Every number comes back from report_build(). Nothing is re-derived
// here, and in particular the TOTAL row is the function's, computed over
// the whole result rather than summed down the column — which is what
// makes the Market Review's PGW row mix averages and totals correctly
// without a special case.
//
// COLOUR IS DATA. The fills come from report_format_rules; this file
// knows how to apply a rule, never what a threshold is.
// =====================================================================

function Panel({ title, hint, children }) {
  return (
    <Card className="flex min-h-0 flex-col p-4">
      <div className="mb-2">
        <h3 className="pgw-display text-sm font-bold text-content-primary">{title}</h3>
        {hint && <p className="text-[11px] text-content-muted">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

function Notice({ tone = "info", icon: Icon = Info, children }) {
  const cls =
    tone === "danger" ? "border-danger-border bg-danger-tint text-danger"
    : tone === "warn" ? "border-warning-border bg-warning-tint text-warning"
    : "border-hairline bg-surface-overlay text-content-secondary";
  return (
    <div className={"flex items-start gap-2 rounded-md border px-3 py-2 text-xs " + cls}>
      <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function ReportsView() {
  const b = useReportBuilder();
  const { role } = useAuth();
  const { result } = b;
  const [showImport, setShowImport] = useState(false);

  const canRun = b.selectedMeasures.length > 0 && b.selectedStoreIds.length > 0;
  const rows = result?.rows ?? [];
  const cols = result?.columns ?? [];
  const splitLabel = groupByLabel(result?.spec.groupBy ?? b.groupBy);
  const unavailable = useMemo(() => new Set(b.unavailableMeasures), [b.unavailableMeasures]);

  // A cell: its value, then whatever a format rule has to say about it.
  // `rank` is the row's 1-based position, so a rank-based rule can
  // colour the top of a sorted report without knowing any thresholds.
  const renderCell = (c, r, rank) => {
    if (unavailable.has(c.key)) {
      return (
        <span className="text-content-muted" title="Needs 2025 actuals — none are loaded yet">
          n/a
        </span>
      );
    }
    const raw = r.measures?.[c.key];
    const formatted = formatCell(c.kind, raw);
    const { text, token } = formatWithRules(b.ruleIndex.for(c.key), c.key, raw, formatted, { rank });
    const st = tokenStyle(token);
    if (!st) return text;
    return (
      <span className="rounded px-1.5 py-0.5 font-medium" style={{ backgroundColor: st.bg, color: st.fg }}>
        {text}
      </span>
    );
  };

  const SortArrow = ({ active, dir }) =>
    !active ? null : dir === "asc"
      ? <ArrowUp className="ml-1 inline h-3 w-3" />
      : <ArrowDown className="ml-1 inline h-3 w-3" />;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Reports"
        subtitle="The five leadership reports, and a builder to make others."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeControl />
            <PrimaryBtn onClick={b.run} disabled={!canRun || b.running}>
              <Play className="h-4 w-4" /> {b.running ? "Running…" : "Run report"}
            </PrimaryBtn>
            <GhostBtn onClick={b.exportXlsx} disabled={!result || b.exporting}>
              <FileSpreadsheet className="h-4 w-4" /> {b.exporting ? "Building…" : "Export to Excel"}
            </GhostBtn>
          </div>
        }
      />

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-content-muted">Reports</span>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => b.applyPreset(p)}
              title={p.hint}
              disabled={b.loadingCatalog}
              className="rounded-full border border-hairline-strong bg-surface-overlay px-3 py-1.5 text-xs font-medium text-content-primary hover:bg-hairline-strong disabled:opacity-40"
            >
              {p.label}
            </button>
          ))}
          {(role === "admin" || role === "master") && (
            <button
              onClick={() => setShowImport(true)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-hairline-strong px-3 py-1.5 text-xs font-medium text-content-secondary hover:bg-surface-overlay"
            >
              <Database className="h-3.5 w-3.5" /> Import 2025 actuals
            </button>
          )}
        </div>
      </Card>

      {b.catalogError && (
        <Notice tone="danger" icon={AlertTriangle}>Could not load the measure list: {b.catalogError}</Notice>
      )}

      {b.priorYearAvailable === false && (
        <Notice tone="warn" icon={AlertTriangle}>
          <strong>No 2025 actuals are loaded.</strong> Market Review and Sales Projection vs Last Year will render
          their comparison columns as <em>n/a</em> rather than as zero — a store with no prior year is not a store
          that improved infinitely. Import sales, gross profit and car counts by store by month to switch them on.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Stores" hint="Only the stores your access covers appear here.">
          <StoreMultiSelect stores={b.stores} selected={b.selectedStoreIds} onChange={b.setSelectedStoreIds} />
        </Panel>

        <Panel title="Measures" hint="Grouped by where the number comes from.">
          <MeasurePicker
            catalog={b.catalog}
            selected={b.selectedMeasures}
            onToggle={b.toggleMeasure}
            onSetGroup={b.setMeasureGroup}
          />
        </Panel>

        <Panel title="Group by & sort" hint="One row per…">
          <div className="grid grid-cols-3 gap-1.5">
            {GROUP_BY.map(([key, label]) => {
              const active = b.groupBy === key;
              return (
                <button
                  key={key}
                  onClick={() => b.setGroupBy(key)}
                  style={active ? { backgroundColor: T.accent, color: T.accentText } : {}}
                  className={"rounded-md border px-2 py-2 text-xs font-medium " +
                    (active ? "border-transparent"
                            : "border-hairline-strong bg-surface-overlay text-content-secondary hover:bg-hairline-strong")}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-content-muted">Sorted by</span>
              <span className="text-xs font-medium text-content-primary">
                {b.sort.measure
                  ? (b.catalog.find((m) => m.measure_key === b.sort.measure)?.label ?? b.sort.measure)
                  : splitLabel}
              </span>
              {b.sort.measure && (
                <button
                  onClick={() => b.toggleSort(b.sort.measure)}
                  className="rounded border border-hairline-strong px-1.5 py-0.5 text-[10px] text-content-secondary hover:bg-surface-overlay"
                >
                  {b.sort.dir === "desc" ? "high → low" : "low → high"}
                </button>
              )}
            </div>
            <p className="text-[11px] text-content-muted">Click any column header to sort by it.</p>

            {b.alt?.range && b.altWindow && (
              <Notice icon={CalendarClock}>
                {b.alt.measures.length} column{b.alt.measures.length === 1 ? "" : "s"} read{" "}
                <strong>{presetLabel(b.alt.range).toLowerCase()}</strong> ({rangeLabel(b.altWindow.from, b.altWindow.to)}),
                not the main range. Those headers say so.
              </Notice>
            )}

            <p className="text-[11px] text-content-muted">
              {rangeLabel(b.from, b.to)} · {b.selectedStoreIds.length} store
              {b.selectedStoreIds.length === 1 ? "" : "s"} · {b.selectedMeasures.length} measure
              {b.selectedMeasures.length === 1 ? "" : "s"}
            </p>
            {b.groupBy === "week" && (
              <p className="text-[11px] text-content-muted">Weeks run Sunday–Saturday, as everywhere else in the portal.</p>
            )}
            {hasRepeatedMonthly(b.selectedMeasures, b.groupBy) && (
              <Notice tone="warn" icon={AlertTriangle}>
                Budgets, tier thresholds and prior-year figures are MONTHLY. Grouped by {b.groupBy} they repeat the same
                monthly number on every row rather than splitting across it.
              </Notice>
            )}
            {hasAttributedPay(b.selectedMeasures, b.groupBy) && (
              <Notice tone="warn" icon={AlertTriangle}>
                Overtime and other pay belong to a whole week. Grouped by day they are split across days by hours
                worked, so a single day's figure is indicative — week, month and store totals are exact.
              </Notice>
            )}
            {!b.canSeePay && (
              <p className="text-[11px] text-content-muted">
                Per-technician pay is not available at your access level. Labor cost — the store-level total gross
                profit already uses — is.
              </p>
            )}
          </div>
        </Panel>
      </div>

      {b.error && <Notice tone="danger" icon={AlertTriangle}>{b.error.message}</Notice>}

      {!result && !b.running && (
        <Empty
          icon={Table2}
          title="Nothing built yet"
          hint={canRun ? "Pick a report above, or press Run report."
                       : "Pick at least one store and one measure, then run the report."}
        />
      )}

      {result && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
            <div>
              <h3 className="pgw-display text-sm font-bold text-content-primary">
                {rows.length} row{rows.length === 1 ? "" : "s"} by {splitLabel.toLowerCase()}
                {result.spec.sort && (
                  <span className="ml-2 font-normal text-content-muted">
                    sorted by {cols.find((c) => c.key === result.spec.sort.measure)?.label ?? result.spec.sort.measure}
                    {result.spec.sort.dir === "desc" ? " ↓" : " ↑"}
                  </span>
                )}
              </h3>
              <p className="text-[11px] text-content-muted">
                {rangeLabel(result.spec.from, result.spec.to)} · {result.spec.storeIds.length} store
                {result.spec.storeIds.length === 1 ? "" : "s"}
              </p>
            </div>
            {b.stale && (
              <span className="rounded-full border border-hairline-strong bg-surface-overlay px-2.5 py-1 text-[11px] text-content-secondary">
                Controls changed — run again to refresh
              </span>
            )}
          </div>

          {rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-content-muted">
              No data for that range and selection.
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="min-w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-surface-overlay">
                    <th className="sticky left-0 z-20 whitespace-nowrap border-b border-hairline bg-surface-overlay px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-content-secondary">
                      {splitLabel}
                    </th>
                    {cols.map((c) => {
                      const active = result.spec.sort?.measure === c.key;
                      return (
                        <th
                          key={c.key}
                          title={c.group}
                          className="whitespace-nowrap border-b border-hairline px-3 py-2 text-right text-xs font-semibold text-content-secondary"
                        >
                          <button
                            onClick={() => { b.toggleSort(c.key); }}
                            className={"inline-flex items-center hover:text-content-primary " + (active ? "text-content-primary" : "")}
                            title="Sort by this column"
                          >
                            {c.label}
                            <SortArrow active={active} dir={result.spec.sort?.dir} />
                          </button>
                          {c.altWindow && (
                            <span className="block text-[9px] font-normal uppercase tracking-wide text-accent-text">
                              {presetLabel(c.altWindow)}
                            </span>
                          )}
                          {unavailable.has(c.key) && (
                            <span className="block text-[9px] font-normal uppercase tracking-wide text-warning">
                              no 2025 data
                            </span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.bucket_key + "|" + (r.store_id ?? "")} className="hover:bg-surface-overlay/60">
                      <td className="sticky left-0 z-10 whitespace-nowrap border-b border-hairline bg-surface-card px-3 py-1.5 text-content-primary">
                        {r.bucket_label}
                      </td>
                      {cols.map((c) => (
                        <td key={c.key} className="whitespace-nowrap border-b border-hairline px-3 py-1.5 text-right tabular-nums text-content-secondary">
                          {renderCell(c, r, i + 1)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {result.total && (
                  <tfoot>
                    <tr className="bg-surface-overlay font-semibold">
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-surface-overlay px-3 py-2 text-content-primary">
                        {result.spec.groupBy === "district" || result.spec.groupBy === "region" ? "PGW TOTAL" : "TOTAL"}
                      </td>
                      {cols.map((c) => (
                        <td key={c.key} className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-content-primary">
                          {renderCell(c, result.total, 0)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          <p className="border-t border-hairline px-4 py-2 text-[11px] text-content-muted">
            Totals are computed over the whole result, not summed down the column. Per-store figures stay averages at
            every level and dollar totals stay totals, which is why the company row mixes the two.
          </p>
        </Card>
      )}

      {showImport && <PriorYearImportModal onClose={() => setShowImport(false)} />}
    </div>
  );
}
