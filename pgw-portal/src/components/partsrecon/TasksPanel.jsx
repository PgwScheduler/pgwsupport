import React, { useMemo, useState } from "react";
import { Download, Search } from "lucide-react";
import { partsReconApi, usePartsReconTasks } from "../../hooks/usePartsRecon.js";
import { AP_TASK_KIND, vendorLabel } from "../../lib/partsRecon.js";
import { exportTasks } from "../../lib/partsReconWorkbook.js";
import { Card, GhostBtn, inputCls } from "../ui.jsx";
import { Notice, Pill, Segmented, fmt$, fmtDate, selectSm } from "./shared.jsx";

// My AP To-Do, AP Not On Statement, Unassigned and the warranty add-backs
// as one checklist (AP team only). Ticking one off records who and when.

function TaskRow({ t, onSaved }) {
  const [note, setNote] = useState(t.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async (done) => {
    setBusy(true); setErr(null);
    const r = await partsReconApi.taskDone(t.id, done, note);
    setBusy(false);
    if (r.error) setErr(r.error); else onSaved();
  };
  return (
    <tr className={"border-t border-hairline align-top " + (t.done_at ? "opacity-60" : "")}>
      <td className="py-2 pl-3 pr-2">
        <input type="checkbox" checked={!!t.done_at} disabled={busy} onChange={(e) => save(e.target.checked)} aria-label="Done" />
      </td>
      <td className="py-2 pr-2 text-sm">
        <p className="font-medium text-content-primary">{t.recon_store}</p>
        <p className="text-xs text-content-muted">{vendorLabel(t.vendor)}</p>
      </td>
      <td className="py-2 pr-2 text-sm">
        <Pill>{AP_TASK_KIND[t.kind] ?? t.kind}</Pill>
        <p className="mt-1 text-content-secondary">{t.task}</p>
        {t.detail && <p className="text-xs text-content-muted">{t.detail}</p>}
      </td>
      <td className="py-2 pr-2 font-mono text-xs">
        {t.invoice && <p>inv {t.invoice}</p>}
        {t.po && <p>PO {t.po}</p>}
        {t.txn_date && <p className="font-sans text-content-muted">{fmtDate(t.txn_date)}</p>}
      </td>
      <td className="py-2 pr-2 text-right text-sm tabular-nums">
        {t.stmt_amount !== null && <p>{fmt$(t.stmt_amount)}</p>}
        {t.ap_amount !== null && <p className="text-xs text-content-muted">AP {fmt$(t.ap_amount)}</p>}
      </td>
      <td className="py-2 pr-3">
        <input className={inputCls + " py-1 text-xs"} value={note} onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if ((t.note ?? "") !== note) save(!!t.done_at); }} placeholder="Note" />
        {t.done_at && <p className="mt-0.5 text-[11px] text-content-muted">{t.done_by_name}, {fmtDate(t.done_at)}</p>}
        {err && <p className="text-xs text-danger">{err}</p>}
      </td>
    </tr>
  );
}

export function TasksPanel({ month }) {
  const tasks = usePartsReconTasks(month, true);
  const [show, setShow] = useState("todo");
  const [kind, setKind] = useState("");
  const [store, setStore] = useState("");
  const [text, setText] = useState("");
  const all = tasks.data ?? [];
  const stores = useMemo(() => [...new Set(all.map((t) => t.recon_store))].sort(), [all]);
  const counts = useMemo(() => {
    const c = {};
    for (const t of all) if (!t.done_at) c[t.kind] = (c[t.kind] ?? 0) + 1;
    return c;
  }, [all]);
  const shown = useMemo(() => {
    const s = text.trim().toLowerCase();
    return all.filter((t) => (show === "all" || (show === "todo" ? !t.done_at : !!t.done_at))
      && (!kind || t.kind === kind) && (!store || t.recon_store === store)
      && (!s || [t.invoice, t.po, t.vendor, t.detail, t.task].some((v) => String(v ?? "").toLowerCase().includes(s))));
  }, [all, show, kind, store, text]);
  const LIMIT = 300;

  if (tasks.loading && !tasks.data) return <p className="text-sm text-content-muted">Loading the AP to-do list…</p>;
  if (tasks.error) return <Notice tone="error">{tasks.error}</Notice>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented options={[["todo", `To do (${all.filter((t) => !t.done_at).length})`], ["done", "Done"], ["all", "All"]]} value={show} onChange={setShow} />
        <select className={selectSm} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
          <option value="">Every type</option>
          {Object.entries(AP_TASK_KIND).map(([k, l]) => <option key={k} value={k}>{l}{counts[k] ? ` (${counts[k]})` : ""}</option>)}
        </select>
        <select className={selectSm} value={store} onChange={(e) => setStore(e.target.value)} aria-label="Store">
          <option value="">All stores</option>
          {stores.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-content-muted" />
          <input className={inputCls + " pl-8"} placeholder="Invoice, PO, vendor…" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <GhostBtn onClick={() => exportTasks(month, shown)} disabled={!shown.length}><Download className="h-4 w-4" /> Excel</GhostBtn>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-content-muted">
              <th className="py-2 pl-3 pr-2">Done</th><th className="py-2 pr-2">Store</th><th className="py-2 pr-2">What to do</th>
              <th className="py-2 pr-2">Invoice / PO</th><th className="py-2 pr-2 text-right">Amount</th><th className="py-2 pr-3">Note</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, LIMIT).map((t) => <TaskRow key={t.id + (t.done_at ?? "")} t={t} onSaved={tasks.reload} />)}
          </tbody>
        </table>
        {!shown.length && <p className="px-3 py-4 text-sm text-content-muted">Nothing here.</p>}
      </Card>
      {shown.length > LIMIT && <p className="text-sm text-content-muted">Showing {LIMIT} of {shown.length}. Narrow by type or store, or use Excel.</p>}
    </div>
  );
}
