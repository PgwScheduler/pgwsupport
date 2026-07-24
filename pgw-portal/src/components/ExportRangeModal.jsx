import React, { useState } from "react";
import { FileSpreadsheet, X } from "lucide-react";
import { useCloseoutRangeExport } from "../hooks/useCloseoutRangeExport.js";
import { Card, Field, GhostBtn, PrimaryBtn, inputCls } from "./ui.jsx";

/* Date-range picker -> multi-store .xlsx workbook. Scope is whatever the
   signed-in user can see (RLS): a store manager gets their store, a district/
   regional manager their district/region, admin/master every store. A single
   date is just From === To. Shared by the Dashboard and the Cash Drawer view. */
export function ExportRangeModal({ storeCount, onClose }) {
  const today = new Date().toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [done, setDone] = useState(null);
  const { exportRange, exporting, error } = useCloseoutRangeExport();

  const run = async () => {
    setDone(null);
    const { count } = await exportRange({ startDate, endDate });
    if (count > 0) setDone(count);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4" onClick={onClose}>
      <div className="mt-16 w-full max-w-md" onClick={(ev) => ev.stopPropagation()}>
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3">
            <div>
              <h3 className="pgw-display text-base font-bold text-content-primary">Export closeouts (Excel)</h3>
              <p className="text-xs text-content-muted">One workbook — a Summary sheet plus one sheet per store · {storeCount} stores in view</p>
            </div>
            <button onClick={onClose} className="rounded-md p-1.5 text-content-secondary hover:bg-surface-overlay hover:text-content-primary">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="From"><input type="date" className={inputCls} value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
              <Field label="To"><input type="date" className={inputCls} value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
            </div>
            <p className="text-[11px] text-content-muted">Pick the same day in both boxes for a single date. You'll only see the stores your access covers.</p>
            {error && <p className="rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}
            {done && <p className="rounded-md border border-success-border bg-success-tint px-3 py-2 text-sm text-success">Exported {done} closeout{done === 1 ? "" : "s"}. Check your downloads.</p>}
            <div className="flex justify-end gap-2">
              <GhostBtn onClick={onClose}>Close</GhostBtn>
              <PrimaryBtn onClick={run} disabled={exporting}>
                <FileSpreadsheet className="h-4 w-4" /> {exporting ? "Building…" : "Export workbook"}
              </PrimaryBtn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
