import React, { useEffect, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { creditApi, partsReconApi } from "../../hooks/usePartsRecon.js";
import { CREDIT_ACTIONS } from "../../lib/partsReconCredit.js";
import { vendorLabel } from "../../lib/partsRecon.js";
import { Card } from "../ui.jsx";
import { Notice, Pill, StatusPill, fmt$, fmtDate } from "./shared.jsx";

// One mass credit (migration 91) with every line: who entered it, the
// memo, and what happened to each item. Read-only -- a batch is history.

export function CreditBatchDialog({ batchId, onClose }) {
  const [b, setB] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    creditApi.batch(batchId).then((r) => {
      if (r.error) setErr(r.error);
      else if (!r.data) setErr("You can't see this credit.");
      else setB(r.data);
    });
  }, [batchId]);
  const action = b && (CREDIT_ACTIONS.find(([k]) => k === b.store_action)?.[1] ?? b.store_action);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4" onClick={onClose}>
      <div className="mt-12 w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <Card className="overflow-hidden">
          <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-3">
            <div>
              <h3 className="pgw-display text-base font-bold text-content-primary">
                Credit # {b?.credit_no ?? "…"}
              </h3>
              {b && (
                <p className="text-xs text-content-muted">
                  {b.store_number ? `#${b.store_number} ` : ""}{b.recon_store} · {vendorLabel(b.vendor)} · {fmt$(b.total)}
                  {b.credit_date && ` · dated ${fmtDate(b.credit_date)}`} · entered by {b.submitted_by_name ?? "—"}, {fmtDate(b.submitted_at)}
                </p>
              )}
            </div>
            <button onClick={onClose} className="text-content-muted hover:text-content-primary" aria-label="Close"><X className="h-5 w-5" /></button>
          </div>
          <div className="space-y-3 px-5 py-4">
            {err && <Notice tone="error">{err}</Notice>}
            {!b && !err && <p className="text-sm text-content-muted">Loading…</p>}
            {b && (
              <>
                <p className="text-sm text-content-secondary">
                  {action}{b.note && <> · {b.note}</>}
                </p>
                {b.file_path && (
                  <button onClick={() => partsReconApi.openFile(b.file_path)} className="flex items-center gap-1.5 text-sm text-accent-text hover:underline">
                    <Paperclip className="h-3.5 w-3.5" /> {b.file_name ?? "Credit memo"}
                  </button>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-xs">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-content-muted">
                        <th className="py-1 pr-2">Month</th><th className="py-1 pr-2">RO #</th><th className="py-1 pr-2">Invoices</th>
                        <th className="py-1 pr-2 text-right">Item</th><th className="py-1 pr-2 text-right">Credit</th><th className="py-1">Now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.lines.map((l) => (
                        <tr key={l.item_id} className="border-t border-hairline align-top">
                          <td className="py-1 pr-2">{l.month_label}</td>
                          <td className="py-1 pr-2 font-mono">{l.ro ?? "—"}</td>
                          <td className="max-w-[200px] truncate py-1 pr-2 font-mono" title={l.invoices ?? ""}>{l.invoices ?? "—"}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{fmt$(l.item_amount)}</td>
                          <td className="py-1 pr-2 text-right font-semibold tabular-nums">{fmt$(l.amount)}</td>
                          <td className="py-1">
                            {l.outcome === "earlier_month"
                              ? <Pill tone="info">Earlier month: logged for AP</Pill>
                              : <StatusPill status={l.status} />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-hairline-strong font-semibold">
                        <td className="py-1.5" colSpan={4}>{b.lines.length} item(s)</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmt$(b.lines.reduce((a, l) => a + Number(l.amount), 0))}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
