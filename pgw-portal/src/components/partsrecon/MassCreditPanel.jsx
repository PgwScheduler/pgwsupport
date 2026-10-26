import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, Trash2, Upload } from "lucide-react";
import {
  creditApi, usePartsReconCreditBatchList, usePartsReconCreditStores, usePartsReconCreditVendors,
} from "../../hooks/usePartsRecon.js";
import { CREDIT_ACTIONS, creditLinesPayload, validateCredit } from "../../lib/partsReconCredit.js";
import { vendorLabel } from "../../lib/partsRecon.js";
import { Card, Field, GhostBtn, PrimaryBtn, inputCls } from "../ui.jsx";
import { CreditBatchDialog } from "./CreditBatchDialog.jsx";
import { Notice, Pill, StatusPill, fmt$, fmtDate } from "./shared.jsx";

// Mass Credit Import (migration 91): a store enters one vendor credit
// invoice once and applies it to every item it covers. Each item gets
// exactly what "Send reply" gives it and goes to AP's review; an item in
// a month AP already closed is logged for AP instead (the item itself
// stays as it is). Once submitted a credit can't be edited.

const blank = (locationId = "") => ({
  locationId, vendor: "", creditNo: "", creditDate: "", total: "", action: "returned", note: "",
});

function History({ onOpen }) {
  const list = usePartsReconCreditBatchList(null);
  const rows = list.data ?? [];
  if (!rows.length) return null;
  return (
    <Card className="p-4">
      <h3 className="pgw-display mb-2 text-sm font-bold text-content-primary">Credits entered</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="cursor-pointer border-t border-hairline hover:bg-surface-overlay" onClick={() => onOpen(b.id)}>
                <td className="py-1.5 pr-2 font-medium">{b.recon_store}</td>
                <td className="py-1.5 pr-2">{vendorLabel(b.vendor)}</td>
                <td className="py-1.5 pr-2 font-mono">{b.credit_no}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{fmt$(b.total)}</td>
                <td className="py-1.5 pr-2">{b.lines} item(s){b.earlier_month ? ` · ${b.earlier_month} earlier month` : ""}</td>
                <td className="py-1.5 text-content-muted">{b.submitted_by_name}, {fmtDate(b.submitted_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function MassCreditPanel({ defaultLocationId, onClose, onSubmitted }) {
  const stores = usePartsReconCreditStores();
  const [h, setH] = useState(() => blank(defaultLocationId ?? ""));
  const set = (p) => setH((x) => ({ ...x, ...p }));
  const vendors = usePartsReconCreditVendors(h.locationId || null);
  const [lines, setLines] = useState([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState(null);
  const [searching, setSearching] = useState(false);
  const [used, setUsed] = useState([]);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const [viewBatch, setViewBatch] = useState(null);
  const fileInput = useRef(null);
  // One id per credit being entered, kept across a failed submit so the
  // memo upload is reused.
  const batchId = useRef(crypto.randomUUID());
  const uploaded = useRef(null); // { file, path }

  // A single store login has exactly one store.
  useEffect(() => {
    if (!h.locationId && stores.data?.length === 1) set({ locationId: stores.data[0].location_id });
  }, [stores.data, h.locationId]);

  // Search as the user types, scoped to the header's store and vendor.
  useEffect(() => {
    if (!h.locationId || !h.vendor || query.trim().length < 2) { setFound(null); return; }
    let live = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const r = await creditApi.candidates(h.locationId, h.vendor, query.trim());
      if (!live) return;
      setSearching(false);
      if (r.error) setErr(r.error); else setFound(r.data ?? []);
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [h.locationId, h.vendor, query]);

  // Has this credit # been used at this store? A warning only.
  useEffect(() => {
    if (!h.locationId || !h.creditNo.trim()) { setUsed([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      const r = await creditApi.creditNoUsed(h.locationId, h.creditNo.trim());
      if (live) setUsed(r.data ?? []);
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [h.locationId, h.creditNo]);

  const v = useMemo(() => validateCredit(h, lines), [h, lines]);
  const store = stores.data?.find((s) => s.location_id === h.locationId);

  const changeStore = (locationId) => { set({ locationId, vendor: "" }); setLines([]); setQuery(""); };
  const changeVendor = (vendor) => { set({ vendor }); setLines([]); setQuery(""); };
  // The search row's `amount` is the item's; the line's `amount` is the credit typed for it.
  const add = (c) => setLines((ls) => (ls.some((l) => l.id === c.id) ? ls : [...ls, { ...c, item_amount: c.amount, amount: "" }]));
  const setAmount = (id, amount) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, amount } : l)));
  const remove = (id) => setLines((ls) => ls.filter((l) => l.id !== id));
  const fill = () => {
    // Put whatever is left of the total on the last line.
    if (!lines.length || v.remaining === null) return;
    const last = lines[lines.length - 1];
    const cur = parseFloat(String(last.amount).replace(/[$,\s]/g, "")) || 0;
    setAmount(last.id, (Math.round((cur + v.remaining) * 100) / 100).toFixed(2));
  };

  const submit = async () => {
    const earlier = lines.filter((l) => l.month_closed).length;
    const msg = `Submit credit # ${h.creditNo.trim()} for ${fmt$(v.total)} on ${lines.length} item(s)?`
      + (earlier ? `\n\n${earlier} item(s) are in a month AP has closed: those go to AP as credits for an earlier month and the items stay as they are.` : "")
      + "\n\nOnce submitted it can't be edited.";
    if (!window.confirm(msg)) return;
    setBusy(true); setErr(null);
    let memo = null;
    if (file) {
      if (uploaded.current?.file !== file) {
        const u = await creditApi.uploadMemo(batchId.current, file);
        if (u.error) { setErr(`Couldn't upload the memo: ${u.error}`); setBusy(false); return; }
        uploaded.current = { file, path: u.data };
      }
      memo = { path: uploaded.current.path, name: file.name, size: file.size };
    }
    const r = await creditApi.submit(batchId.current, h, creditLinesPayload(lines), memo);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setDone({ ...r.data, credit_no: h.creditNo.trim() });
    batchId.current = crypto.randomUUID();
    uploaded.current = null;
    setH(blank(h.locationId)); setLines([]); setQuery(""); setFound(null); setFile(null); setUsed([]);
    onSubmitted?.();
  };

  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="pgw-display text-base font-bold text-content-primary">Enter a vendor credit</h3>
            <p className="text-sm text-content-secondary">
              One credit invoice, applied to every item it covers. Each item goes to AP for review as if you'd replied to it.
            </p>
          </div>
          <GhostBtn onClick={onClose}>Back to items</GhostBtn>
        </div>

        {done && (
          <Notice tone="ok">
            Credit # {done.credit_no} sent: {done.replied} item(s) to AP for review
            {done.earlier_month ? `, ${done.earlier_month} logged for AP as credits for an earlier month` : ""}.{" "}
            <button className="underline" onClick={() => setViewBatch(done.batch_id)}>See the lines</button>
          </Notice>
        )}

        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Store">
            {(stores.data?.length ?? 0) > 1 ? (
              <select className={inputCls} value={h.locationId} onChange={(e) => changeStore(e.target.value)}>
                <option value="">Pick the store…</option>
                {stores.data.map((s) => <option key={s.location_id} value={s.location_id}>#{s.store_number} {s.recon_store}</option>)}
              </select>
            ) : (
              <input className={inputCls} disabled value={store ? `#${store.store_number} ${store.recon_store}` : stores.loading ? "Loading…" : "No store with items to credit"} />
            )}
          </Field>
          <Field label="Vendor">
            <select className={inputCls} value={h.vendor} onChange={(e) => changeVendor(e.target.value)} disabled={!h.locationId}>
              <option value="">Pick the vendor…</option>
              {(vendors.data ?? []).map((x) => <option key={x.vendor} value={x.vendor}>{vendorLabel(x.vendor)} ({x.items})</option>)}
            </select>
          </Field>
          <Field label="What it's for">
            <select className={inputCls} value={h.action} onChange={(e) => set({ action: e.target.value })}>
              {CREDIT_ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="Credit #">
            <input className={inputCls} value={h.creditNo} onChange={(e) => set({ creditNo: e.target.value })} />
          </Field>
          <Field label="Credit date">
            <input type="date" className={inputCls} value={h.creditDate} onChange={(e) => set({ creditDate: e.target.value })} />
          </Field>
          <Field label="Credit total $">
            <input className={inputCls} inputMode="decimal" value={h.total}
              onChange={(e) => set({ total: e.target.value.replace(/[^\d.,$]/g, "") })} placeholder="0.00" />
          </Field>
        </div>
        <Field label="Note">
          <input className={inputCls} value={h.note} onChange={(e) => set({ note: e.target.value })}
            placeholder="Optional: anything AP should know about this credit" />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" className="hidden" accept="image/*,application/pdf"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          <GhostBtn onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4" /> {file ? "Change credit memo" : "Attach credit memo"}</GhostBtn>
          {file && <span className="text-sm text-content-secondary">{file.name} <button className="text-content-muted hover:text-danger" onClick={() => setFile(null)}>remove</button></span>}
        </div>
        {used.length > 0 && (
          <Notice tone="warn">
            Credit # {h.creditNo.trim()} was already used at this store:{" "}
            {used.slice(0, 5).map((u, i) => <span key={i}>{i ? "; " : ""}{u.source}{u.ro ? `, RO ${u.ro}` : ""}{u.amount != null ? `, ${fmt$(u.amount)}` : ""}</span>)}
            {used.length > 5 && ` and ${used.length - 5} more`}. You can still submit if this is right.
          </Notice>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="pgw-display text-sm font-bold text-content-primary">Items this credit covers</h3>
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-content-muted" />
          <input className={inputCls + " pl-8"} value={query} onChange={(e) => setQuery(e.target.value)}
            disabled={!h.vendor} placeholder={h.vendor ? "RO # or invoice #" : "Pick the store and vendor first"} />
        </div>
        {searching && <p className="text-xs text-content-muted">Searching…</p>}
        {found && !searching && (
          found.length ? (
            <div className="overflow-x-auto rounded-lg border border-hairline">
              <table className="w-full min-w-[560px] text-xs">
                <tbody>
                  {found.map((c) => {
                    const added = lines.some((l) => l.id === c.id);
                    return (
                      <tr key={c.id} className="border-t border-hairline first:border-t-0">
                        <td className="py-1.5 pl-2 pr-2">{c.month_label}{c.month_closed && <Pill tone="muted">closed</Pill>}</td>
                        <td className="py-1.5 pr-2 font-mono">RO {c.ro ?? "—"}</td>
                        <td className="max-w-[220px] truncate py-1.5 pr-2 font-mono" title={c.invoices ?? ""}>{c.invoices ?? "—"}</td>
                        <td className="py-1.5 pr-2"><StatusPill status={c.status} /></td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmt$(c.left_to_deduct)} left</td>
                        <td className="py-1.5 pr-2 text-right">
                          <GhostBtn onClick={() => add(c)} disabled={added}><Plus className="h-3.5 w-3.5" /> {added ? "Added" : "Add"}</GhostBtn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="text-xs text-content-muted">No {vendorLabel(h.vendor)} item with something left to deduct matches “{query.trim()}”.</p>
        )}

        {lines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-content-muted">
                  <th className="py-1 pr-2">RO #</th><th className="py-1 pr-2">Invoices</th>
                  <th className="py-1 pr-2 text-right">Item amount</th><th className="py-1 pr-2 text-right">Left to deduct</th>
                  <th className="py-1 pr-2 text-right">Credit $</th><th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t border-hairline align-top">
                    <td className="py-1.5 pr-2 font-mono">
                      {l.ro ?? "—"}
                      <div className="font-sans text-[11px] text-content-muted">{l.month_label}</div>
                      {l.month_closed && <div className="font-sans text-[11px] text-warning">Earlier month: logged for AP</div>}
                    </td>
                    <td className="max-w-[220px] truncate py-1.5 pr-2 font-mono text-xs" title={l.invoices ?? ""}>{l.invoices ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{fmt$(l.item_amount)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{fmt$(l.left_to_deduct)}</td>
                    <td className="py-1.5 pr-2 text-right">
                      <input className={inputCls + " w-28 text-right"} inputMode="decimal" value={l.amount}
                        onChange={(e) => setAmount(l.id, e.target.value.replace(/[^\d.,$]/g, ""))} placeholder="0.00" />
                      {v.lineErrors[l.id] && <div className="mt-0.5 text-[11px] text-danger">{v.lineErrors[l.id]}</div>}
                    </td>
                    <td className="py-1.5 text-right">
                      <button onClick={() => remove(l.id)} title="Remove" className="text-content-muted hover:text-danger"><Trash2 className="h-4 w-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-hairline pt-3 text-sm">
          <span>Lines: <strong className="tabular-nums">{fmt$(v.sum)}</strong></span>
          <span>Credit total: <strong className="tabular-nums">{v.total === null ? "—" : fmt$(v.total)}</strong></span>
          <span className={v.remaining ? "text-warning" : "text-content-muted"}>
            Left to place: <strong className="tabular-nums">{v.remaining === null ? "—" : fmt$(v.remaining)}</strong>
          </span>
          {lines.length > 0 && v.remaining ? <GhostBtn onClick={fill}>Put the rest on the last line</GhostBtn> : null}
        </div>
        {v.errors.length > 0 && (lines.length > 0 || h.creditNo || h.total) && (
          <ul className="list-disc pl-5 text-xs text-content-secondary">{v.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}
        {err && <Notice tone="error">{err}</Notice>}
        <PrimaryBtn onClick={submit} disabled={busy || v.errors.length > 0}>
          {busy ? "Submitting…" : `Submit credit${lines.length ? ` (${lines.length} item${lines.length > 1 ? "s" : ""})` : ""}`}
        </PrimaryBtn>
      </Card>

      <History onOpen={setViewBatch} />
      {viewBatch && <CreditBatchDialog batchId={viewBatch} onClose={() => setViewBatch(null)} />}
    </div>
  );
}
