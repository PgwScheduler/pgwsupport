import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { supabase } from "../../lib/supabaseClient.js";
import { usePartsReconItems, usePartsReconTracker } from "../../hooks/usePartsRecon.js";
import { buildDeductionReport } from "../../lib/partsReconDeduction.js";
import { statusLabel, vendorLabel } from "../../lib/partsRecon.js";
import { exportDeductionReport } from "../../lib/partsReconWorkbook.js";
import { Card, GhostBtn } from "../ui.jsx";
import { Notice, Pill, Stat, fmt$, fmtDate, selectSm } from "./shared.jsx";

// Deduction Report: read-only, for the month-end GP audit. What each
// store is left to deduct for the month, by the existing rules (see
// lib/partsReconDeduction.js), with the Tracker's figure beside it.
// AP team only: the tab is offered to is_ap (master, admin, the AP
// team list); the RPCs scope what any caller can read.

function useLocations() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    supabase.from("locations").select("id, store_number, name, is_sandbox, is_home_office")
      .then(({ data: d, error: e }) => { setError(e?.message ?? null); setData(d ?? []); });
  }, []);
  return { data, error };
}

const money = (n) => <span className="tabular-nums">{fmt$(n)}</span>;

function StoreRows({ s, open, onToggle }) {
  return (
    <>
      <tr className="cursor-pointer border-t border-hairline hover:bg-surface-overlay" onClick={onToggle}>
        <td className="py-1.5 pl-3 pr-2">
          {s.count ? (open ? <ChevronDown className="h-4 w-4 text-content-muted" /> : <ChevronRight className="h-4 w-4 text-content-muted" />) : null}
        </td>
        <td className="py-1.5 pr-2 tabular-nums text-content-secondary">{s.storeNumber ?? "—"}</td>
        <td className="py-1.5 pr-2 font-medium text-content-primary">{s.name}</td>
        <td className="py-1.5 pr-2 text-right tabular-nums">{s.count || "—"}</td>
        <td className="py-1.5 pr-2 text-right font-semibold">{money(s.left)}</td>
        <td className="py-1.5 pr-2 text-right text-content-secondary">{money(s.trackerLeft)}</td>
        <td className={"py-1.5 pr-3 text-right " + (s.diff ? "font-semibold text-danger" : "text-content-muted")}>{s.diff ? fmt$(s.diff) : "✓"}</td>
      </tr>
      {open && s.count > 0 && (
        <tr className="bg-surface-page">
          <td />
          <td colSpan={6} className="pb-3 pr-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-content-muted">
                  <th className="py-1 pr-2">Kind</th><th className="py-1 pr-2">Vendor</th><th className="py-1 pr-2">RO #</th>
                  <th className="py-1 pr-2">Invoices</th><th className="py-1 pr-2">Status</th>
                  <th className="py-1 pr-2 text-right">Item amount</th><th className="py-1 pr-2 text-right">AP credit $</th>
                  <th className="py-1 text-right">Left to deduct</th>
                </tr>
              </thead>
              <tbody>
                {s.lines.map((l, i) => (
                  <tr key={i} className="border-t border-hairline align-top">
                    <td className="whitespace-nowrap py-1 pr-2">{l.kind === "arm" ? <Pill tone="info">ARM</Pill> : l.kindLabel}</td>
                    <td className="py-1 pr-2">{vendorLabel(l.vendor)}</td>
                    <td className="py-1 pr-2 font-mono">{l.ro ?? "—"}</td>
                    <td className="max-w-[220px] truncate py-1 pr-2 font-mono" title={l.invoices ?? ""}>{l.invoices ?? "—"}</td>
                    <td className="py-1 pr-2">{l.status ? statusLabel(l.status) : "—"}</td>
                    <td className="py-1 pr-2 text-right">{money(l.amount)}</td>
                    <td className="py-1 pr-2 text-right">{l.credit === null ? "—" : money(l.credit)}</td>
                    <td className="py-1 text-right font-semibold">{money(l.left)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

export function DeductionPanel({ month, monthRow }) {
  const items = usePartsReconItems(month, null);
  const tracker = usePartsReconTracker(month);
  const locations = useLocations();
  const [storeKey, setStoreKey] = useState("");
  const [open, setOpen] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const report = useMemo(() => (items.data && tracker.data && locations.data
    ? buildDeductionReport({ items: items.data, tracker: tracker.data, locations: locations.data }) : null),
  [items.data, tracker.data, locations.data]);

  const error = items.error || tracker.error || locations.error;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!report) return <p className="text-sm text-content-muted">Loading the deduction report…</p>;

  const shown = storeKey ? report.stores.filter((s) => s.key === storeKey) : report.stores;
  const closed = !!monthRow?.closed_at;
  const toggle = (k) => setOpen((o) => { const n = new Set(o); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allOpen = shown.filter((s) => s.count).every((s) => open.has(s.key));
  const shownTotal = (k) => Math.round(shown.reduce((a, s) => a + s[k], 0) * 100) / 100;

  const exportXlsx = async () => {
    setBusy(true);
    try { await exportDeductionReport(monthRow, report, storeKey); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      {closed ? (
        <Notice tone="ok">
          {monthRow.label} is <strong>closed</strong> ({fmtDate(monthRow.closed_at)}). These are the month's final deductions.
        </Notice>
      ) : (
        <Notice tone="warn">
          {monthRow?.label} is still <strong>open</strong>. Stores can still reply and AP can still review, so these figures can change until AP closes the month.
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Month's deduction" value={fmt$(report.total)} sub={closed ? "final" : "so far"} />
        <Stat label="Tracker left to deduct" value={fmt$(report.trackerTotal)} />
        <Stat label="Stores matching the Tracker" value={`${report.stores.length - report.mismatches} of ${report.stores.length}`}
          sub={report.mismatches ? `${fmt$(report.diff)} difference` : "exact"} />
        <Stat label="Lines with a deduction" value={report.lineCount} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select className={selectSm} value={storeKey} onChange={(e) => setStoreKey(e.target.value)} aria-label="Store">
          <option value="">All stores ({report.stores.length})</option>
          {report.stores.map((s) => <option key={s.key} value={s.key}>{s.storeNumber ? `#${s.storeNumber} ` : ""}{s.name}</option>)}
        </select>
        <GhostBtn onClick={() => setOpen(allOpen ? new Set() : new Set(shown.filter((s) => s.count).map((s) => s.key)))}>
          {allOpen ? "Collapse all" : "Expand all"}
        </GhostBtn>
        <div className="flex-1" />
        <GhostBtn onClick={exportXlsx} disabled={busy}>
          <Download className="h-4 w-4" /> {busy ? "Building…" : "Excel"}
        </GhostBtn>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-content-muted">
              <th className="w-6 py-2 pl-3" /><th className="py-2 pr-2">Store #</th><th className="py-2 pr-2">Store</th>
              <th className="py-2 pr-2 text-right">Lines</th><th className="py-2 pr-2 text-right">Left to deduct</th>
              <th className="py-2 pr-2 text-right">Tracker</th><th className="py-2 pr-3 text-right">Difference</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => <StoreRows key={s.key} s={s} open={open.has(s.key)} onToggle={() => s.count && toggle(s.key)} />)}
          </tbody>
          <tfoot>
            <tr className="border-t border-hairline-strong font-semibold">
              <td className="py-2 pl-3" colSpan={3}>{storeKey ? "Store total" : "Grand total"}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{shown.reduce((a, s) => a + s.count, 0)}</td>
              <td className="py-2 pr-2 text-right">{money(shownTotal("left"))}</td>
              <td className="py-2 pr-2 text-right">{money(shownTotal("trackerLeft"))}</td>
              <td className={"py-2 pr-3 text-right " + (shownTotal("diff") ? "text-danger" : "text-content-muted")}>{shownTotal("diff") ? fmt$(shownTotal("diff")) : "✓"}</td>
            </tr>
          </tfoot>
        </table>
      </Card>
      <p className="text-xs text-content-muted">
        Left to deduct per item follows its status: Credit received and Explained are $0, Partial credit is the amount less the credit,
        anything else is the full amount. Tracker lines with no items (e.g. Agero Towing) count at the Tracker's amount. Sandbox and Home Office are left out.
      </p>
    </div>
  );
}
