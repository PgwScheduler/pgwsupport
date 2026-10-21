import React, { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { usePartsReconTracker } from "../../hooks/usePartsRecon.js";
import { vendorLabel } from "../../lib/partsRecon.js";
import { exportTracker } from "../../lib/partsReconWorkbook.js";
import { Card, GhostBtn } from "../ui.jsx";
import { Notice, Pill, Segmented, Stat, fmt$, selectSm } from "./shared.jsx";

// Management's tracker, live: one row per Location x Vendor. Amount = what's
// still left to deduct on that row's items; a row with no items keeps what
// the run (or management) put on it. Exports in the MONTHLY LOG layout.

const tone = (s) => (s === "COMPLETE" ? "good" : s === "WAITING ON RESPONSE" ? "warn" : "muted");

export function TrackerPanel({ month }) {
  const t = usePartsReconTracker(month);
  const [show, setShow] = useState("money");
  const [region, setRegion] = useState("");
  const all = t.data ?? [];
  const regions = useMemo(() => [...new Set(all.map((l) => l.region).filter(Boolean))].sort(), [all]);
  const shown = useMemo(() => all.filter((l) => (!region || l.region === region)
    && (show === "all" || (show === "money" ? Number(l.left_to_deduct) !== 0 || Number(l.script_amount) !== 0 : l.status === "WAITING ON RESPONSE"))), [all, region, show]);
  const sum = (k, list) => list.reduce((a, l) => a + (Number(l[k]) || 0), 0);
  const byStore = useMemo(() => {
    const m = new Map();
    for (const l of shown) {
      if (!m.has(l.recon_store)) m.set(l.recon_store, []);
      m.get(l.recon_store).push(l);
    }
    return [...m.entries()];
  }, [shown]);

  if (t.loading && !t.data) return <p className="text-sm text-content-muted">Loading the tracker…</p>;
  if (t.error) return <Notice tone="error">{t.error}</Notice>;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Run's amount" value={fmt$(sum("script_amount", all))} sub="what the recon put on the tracker" />
        <Stat label="Cleared since" value={fmt$(sum("credited", all))} />
        <Stat label="Left to deduct" value={fmt$(sum("left_to_deduct", all))} />
        <Stat label="Rows waiting" value={all.filter((l) => l.status === "WAITING ON RESPONSE").length} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented options={[["money", "Rows with an amount"], ["waiting", "Waiting on response"], ["all", "Every row"]]} value={show} onChange={setShow} />
        {regions.length > 1 && (
          <select className={selectSm} value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region">
            <option value="">All regions</option>
            {regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        <div className="flex-1" />
        <GhostBtn onClick={() => exportTracker(month, all)} disabled={!all.length}>
          <Download className="h-4 w-4" /> Tracker (MONTHLY LOG layout)
        </GhostBtn>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-content-muted">
              <th className="py-2 pl-3 pr-2">Location</th><th className="py-2 pr-2">Vendor</th><th className="py-2 pr-2">Status</th>
              <th className="py-2 pr-2 text-right">Run's amount</th><th className="py-2 pr-2 text-right">Items open</th>
              <th className="py-2 pr-2 text-right">Cleared</th><th className="py-2 pr-3 text-right">Left to deduct</th>
            </tr>
          </thead>
          <tbody>
            {byStore.map(([store, lines]) => (
              <React.Fragment key={store}>
                {lines.map((l, i) => (
                  <tr key={l.key} className={"border-t border-hairline " + (i === 0 ? "border-hairline-strong" : "")}>
                    <td className="py-1.5 pl-3 pr-2 font-medium text-content-primary">{i === 0 ? store : ""}</td>
                    <td className="py-1.5 pr-2">{vendorLabel(l.vendor)}</td>
                    <td className="py-1.5 pr-2"><Pill tone={tone(l.status)}>{l.status || "—"}</Pill></td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{fmt$(l.script_amount)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{l.items ? `${l.open_items + l.to_review} of ${l.items}` : "—"}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{Number(l.credited) ? fmt$(l.credited) : "—"}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{fmt$(l.left_to_deduct)}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
          {shown.length > 0 && (
            <tfoot>
              <tr className="border-t border-hairline-strong font-semibold">
                <td className="py-2 pl-3" colSpan={3}>Total ({shown.length} rows)</td>
                <td className="py-2 pr-2 text-right tabular-nums">{fmt$(sum("script_amount", shown))}</td>
                <td />
                <td className="py-2 pr-2 text-right tabular-nums">{fmt$(sum("credited", shown))}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmt$(sum("left_to_deduct", shown))}</td>
              </tr>
            </tfoot>
          )}
        </table>
        {!shown.length && <p className="px-3 py-4 text-sm text-content-muted">No rows.</p>}
      </Card>
    </div>
  );
}
