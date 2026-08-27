import React from "react";
import { AlertTriangle, FileSpreadsheet, Info, Play, Table2 } from "lucide-react";
import { useReportBuilder } from "../../hooks/useReportBuilder.js";
import { DateRangeControl } from "../DateRangeControl.jsx";
import { Card, Empty, GhostBtn, PrimaryBtn, SectionHeader, T } from "../ui.jsx";
import { StoreMultiSelect } from "./StoreMultiSelect.jsx";
import { MeasurePicker } from "./MeasurePicker.jsx";
import { GROUP_BY, PRESETS, formatCell, groupByLabel, hasAttributedPay } from "../../lib/reportSpec.js";
import { rangeLabel } from "../../lib/dateRange.js";

// =====================================================================
// Report Builder — four choices and a table.
//
// Every number on this screen comes back from report_build(). Nothing is
// re-derived here, and in particular the TOTAL row is the function's,
// computed over the whole result set rather than summed down the column.
// A capture rate or a gross-profit percentage cannot be added up; the
// tic sheet's Weekly Totals row has followed that rule since migration
// 25 and this one does too.
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
    tone === "danger"
      ? "border-danger-border bg-danger-tint text-danger"
      : tone === "warn"
      ? "border-hairline-strong bg-surface-overlay text-content-secondary"
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
  const { result } = b;

  const canRun = b.selectedMeasures.length > 0 && b.selectedStoreIds.length > 0;
  const rows = result?.rows ?? [];
  // The table renders the columns the RESULT was built with, never the
  // live picker. Ticking a measure after a run must not slide a header
  // onto a column of numbers it does not describe — the table stays as
  // it was and is marked stale until the report is run again.
  const cols = result?.columns ?? [];
  const splitLabel = groupByLabel(result?.spec.groupBy ?? b.groupBy);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Reports"
        subtitle="Build a report over tic sheet, technician and cash drawer data, then take it to Excel."
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

      {/* Presets. A blank builder is a builder nobody uses. */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-content-muted">Start from</span>
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
        </div>
      </Card>

      {b.catalogError && (
        <Notice tone="danger" icon={AlertTriangle}>
          Could not load the measure list: {b.catalogError}
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

        <Panel title="Group by" hint="One row per…">
          <div className="grid grid-cols-3 gap-1.5">
            {GROUP_BY.map(([key, label]) => {
              const active = b.groupBy === key;
              return (
                <button
                  key={key}
                  onClick={() => b.setGroupBy(key)}
                  style={active ? { backgroundColor: T.accent, color: T.accentText } : {}}
                  className={
                    "rounded-md border px-2 py-2 text-xs font-medium " +
                    (active
                      ? "border-transparent"
                      : "border-hairline-strong bg-surface-overlay text-content-secondary hover:bg-hairline-strong")
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 space-y-2">
            <p className="text-[11px] text-content-muted">
              {rangeLabel(b.from, b.to)} · {b.selectedStoreIds.length} store
              {b.selectedStoreIds.length === 1 ? "" : "s"} · {b.selectedMeasures.length} measure
              {b.selectedMeasures.length === 1 ? "" : "s"}
            </p>
            {b.groupBy === "week" && (
              <p className="text-[11px] text-content-muted">Weeks run Sunday–Saturday, as everywhere else in the portal.</p>
            )}
            {b.groupBy === "store" && b.selectedStoreIds.length > 1 && (
              <p className="text-[11px] text-content-muted">
                The Excel export adds a tab per store, each holding that store's days, plus the summary.
              </p>
            )}
            {hasAttributedPay(b.selectedMeasures, b.groupBy) && (
              <Notice tone="warn" icon={AlertTriangle}>
                Overtime and other pay belong to a whole week. Grouped by day they are split across the days by hours
                worked, so a single day's figure is indicative — the week, month and store totals are exact.
              </Notice>
            )}
            {!b.canSeePay && (
              <p className="text-[11px] text-content-muted">
                Per-technician pay is not available at your access level. Labor cost — the store-level total the gross
                profit figure already uses — is.
              </p>
            )}
          </div>
        </Panel>
      </div>

      {b.error && (
        <Notice tone="danger" icon={AlertTriangle}>
          {b.error.message}
        </Notice>
      )}

      {!result && !b.running && (
        <Empty
          icon={Table2}
          title="Nothing built yet"
          hint={
            canRun
              ? "Press Run report to build the table."
              : "Pick at least one store and one measure, then run the report."
          }
        />
      )}

      {result && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
            <div>
              <h3 className="pgw-display text-sm font-bold text-content-primary">
                {rows.length} row{rows.length === 1 ? "" : "s"} by {splitLabel.toLowerCase()}
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
                    {cols.map((c) => (
                      <th
                        key={c.key}
                        title={c.group}
                        className="whitespace-nowrap border-b border-hairline px-3 py-2 text-right text-xs font-semibold text-content-secondary"
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.bucket_key + "|" + (r.store_id ?? "")} className="hover:bg-surface-overlay/60">
                      <td className="sticky left-0 z-10 whitespace-nowrap border-b border-hairline bg-surface-card px-3 py-1.5 text-content-primary">
                        {r.bucket_label}
                      </td>
                      {cols.map((c) => (
                        <td
                          key={c.key}
                          className="whitespace-nowrap border-b border-hairline px-3 py-1.5 text-right tabular-nums text-content-secondary"
                        >
                          {formatCell(c.kind, r.measures?.[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {result.total && (
                  <tfoot>
                    <tr className="bg-surface-overlay font-semibold">
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-surface-overlay px-3 py-2 text-content-primary">
                        TOTAL
                      </td>
                      {cols.map((c) => (
                        <td key={c.key} className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-content-primary">
                          {formatCell(c.kind, result.total.measures?.[c.key])}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          <p className="border-t border-hairline px-4 py-2 text-[11px] text-content-muted">
            Totals are computed over the whole result, not summed down the column — a capture rate or a percentage of
            cars has no meaningful sum.
          </p>
        </Card>
      )}
    </div>
  );
}
