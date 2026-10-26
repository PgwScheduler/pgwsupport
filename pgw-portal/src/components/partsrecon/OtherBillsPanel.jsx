import React, { useMemo, useRef, useState } from "react";
import { Paperclip, Pencil, Trash2, Upload } from "lucide-react";
import { otherBillApi, partsReconApi, usePartsReconOtherBillStores, usePartsReconOtherBills } from "../../hooks/usePartsRecon.js";
import { Card, Field, GhostBtn, PrimaryBtn, inputCls } from "../ui.jsx";
import { Notice, Pill, Segmented, StatusPill, fmt$, fmtDate } from "./shared.jsx";

// Other bills (migration 92): bills that never come in on a vendor
// statement (e.g. a towing charge to a store), entered by AP so they
// count as Parts Recon deductions. Each is an ordinary item of kind
// 'other' in its month, so the store sees and answers it like any item,
// and the Tracker and the Deduction Report count it with no extra math.
// Editable and deletable until its month is closed.

const thisMonth = () => new Date().toISOString().slice(0, 7);
const toDate = (ym) => (ym ? `${ym}-01` : null);
const blank = () => ({ locationId: "", vendor: "", month: thisMonth(), repeat: false, endMonth: "", amount: "", billNo: "", ro: "", description: "" });

function monthPill(b) {
  if (b.month_closed) return <Pill tone="muted">Closed</Pill>;
  if (!b.month_imported) return <Pill tone="info" title="No recon imported for this month yet; stores see it once the month is imported and released">Upcoming</Pill>;
  if (!b.month_released) return <Pill tone="warn">Not released</Pill>;
  return <Pill tone="good">Open</Pill>;
}

function EditRow({ b, onDone, onCancel }) {
  const [v, setV] = useState({ vendor: b.vendor, amount: String(b.amount), billNo: b.bill_no ?? "", ro: b.ro ?? "", description: b.description ?? "" });
  const [err, setErr] = useState(null);
  const save = async () => {
    const r = await otherBillApi.update(b.id, v);
    if (r.error) setErr(r.error); else onDone();
  };
  return (
    <tr className="border-t border-hairline bg-surface-page align-top">
      <td colSpan={10} className="space-y-2 px-2 py-2">
        <div className="grid gap-2 sm:grid-cols-5">
          {[["vendor", "Vendor"], ["amount", "Amount $"], ["billNo", "Bill / invoice #"], ["ro", "RO # (optional)"], ["description", "Description"]].map(([k, l]) => (
            <Field key={k} label={l}><input className={inputCls} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>
          ))}
        </div>
        {err && <Notice tone="error">{err}</Notice>}
        <div className="flex gap-2"><PrimaryBtn onClick={save}>Save</PrimaryBtn><GhostBtn onClick={onCancel}>Cancel</GhostBtn></div>
      </td>
    </tr>
  );
}

export function OtherBillsPanel({ onChanged }) {
  const stores = usePartsReconOtherBillStores();
  const list = usePartsReconOtherBills();
  const [f, setF] = useState(blank);
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [show, setShow] = useState("open");
  const [editing, setEditing] = useState(null);
  const fileInput = useRef(null);
  const attachFor = useRef(null);
  const attachInput = useRef(null);

  const reload = () => { list.reload(); onChanged?.(); };
  const rows = useMemo(() => (list.data ?? []).filter((b) => show === "all" || !b.month_closed), [list.data, show]);
  const repeatCount = useMemo(() => {
    if (!f.repeat || !f.month || !f.endMonth) return 1;
    const [y1, m1] = f.month.split("-").map(Number), [y2, m2] = f.endMonth.split("-").map(Number);
    return (y2 * 12 + m2) - (y1 * 12 + m1) + 1;
  }, [f.repeat, f.month, f.endMonth]);

  const create = async () => {
    setBusy(true); setMsg(null);
    const r = await otherBillApi.create({ ...f, month: toDate(f.month), endMonth: toDate(f.endMonth) });
    if (r.error) { setMsg({ tone: "error", text: r.error }); setBusy(false); return; }
    let attachErr = null;
    if (file) {
      // The bill's copy goes on each month's item (parts_recon_item_files is per item).
      for (const it of r.data ?? []) {
        const a = await partsReconApi.attach({ id: it.id }, it.month, file);
        if (a.error) { attachErr = a.error; break; }
      }
    }
    setBusy(false);
    const n = r.data?.length ?? 0;
    setMsg({ tone: attachErr ? "warn" : "ok", text: `Entered ${n} bill${n === 1 ? "" : "s"}.${attachErr ? ` The bill copy didn't attach: ${attachErr}` : ""}` });
    setF((x) => ({ ...blank(), locationId: x.locationId }));
    setFile(null);
    reload();
  };

  const del = async (b) => {
    if (!window.confirm(`Delete the ${b.vendor} bill ${b.bill_no} (${fmt$(b.amount)}) for ${b.recon_store}, ${b.month_label}?`)) return;
    const r = await otherBillApi.remove(b.id);
    if (r.error) setMsg({ tone: "error", text: r.error }); else reload();
  };

  const attachExisting = async (fileList) => {
    const b = attachFor.current;
    if (!b || !fileList?.length) return;
    const a = await partsReconApi.attach({ id: b.id }, b.month, fileList[0]);
    if (a.error) setMsg({ tone: "error", text: a.error }); else reload();
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div>
          <h3 className="pgw-display text-base font-bold text-content-primary">Enter an other bill</h3>
          <p className="text-sm text-content-secondary">
            A charge to a store that isn't on a vendor statement, e.g. a towing bill. It counts as a deduction in its month,
            the store sees it and can reply, and it shows on the Tracker and the Deduction Report.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label="Store">
            <select className={inputCls} value={f.locationId} onChange={(e) => set({ locationId: e.target.value })}>
              <option value="">Pick the store…</option>
              {(stores.data ?? []).map((s) => <option key={s.location_id} value={s.location_id}>#{s.store_number} {s.recon_store}</option>)}
            </select>
          </Field>
          <Field label="Vendor">
            <input className={inputCls} value={f.vendor} onChange={(e) => set({ vendor: e.target.value })} placeholder="e.g. Allegro Towing" />
          </Field>
          <Field label={f.repeat ? "First month" : "Month"}>
            <input type="month" className={inputCls} value={f.month} onChange={(e) => set({ month: e.target.value })} />
          </Field>
          <Field label="Amount $">
            <input className={inputCls} inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^\d.,$]/g, "") })} placeholder="0.00" />
          </Field>
          <Field label="Bill / invoice #">
            <input className={inputCls} value={f.billNo} onChange={(e) => set({ billNo: e.target.value })} />
          </Field>
          <Field label="RO # (optional)">
            <input className={inputCls} value={f.ro} onChange={(e) => set({ ro: e.target.value })} />
          </Field>
          <Field label="Description">
            <input className={inputCls} value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="What the charge is for" />
          </Field>
          <div className="flex flex-col justify-end gap-1">
            <label className="flex items-center gap-2 text-sm text-content-secondary">
              <input type="checkbox" checked={f.repeat} onChange={(e) => set({ repeat: e.target.checked })} className="accent-[var(--accent)]" />
              Repeat monthly
            </label>
            {f.repeat && (
              <input type="month" className={inputCls} value={f.endMonth} min={f.month} onChange={(e) => set({ endMonth: e.target.value })} aria-label="Last month" />
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" className="hidden" accept="image/*,application/pdf"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          <GhostBtn onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4" /> {file ? "Change bill copy" : "Attach the bill (optional)"}</GhostBtn>
          {file && <span className="text-sm text-content-secondary">{file.name} <button className="text-content-muted hover:text-danger" onClick={() => setFile(null)}>remove</button></span>}
        </div>
        <p className="text-xs text-content-muted">
          The month can be any month AP hasn't closed, or the current month or a later one. A month with no recon yet is held as
          "Upcoming" until its run is imported.{f.repeat && repeatCount > 1 ? ` Repeat creates ${repeatCount} separate bills, one per month.` : ""}
        </p>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <PrimaryBtn onClick={create} disabled={busy || !f.locationId || !f.vendor.trim() || !f.billNo.trim() || !f.amount || !f.month || (f.repeat && !f.endMonth)}>
          {busy ? "Saving…" : f.repeat && repeatCount > 1 ? `Enter ${repeatCount} monthly bills` : "Enter bill"}
        </PrimaryBtn>
      </Card>

      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="pgw-display text-sm font-bold text-content-primary">Other bills</h3>
          <Segmented options={[["open", "Open months"], ["all", "All"]]} value={show} onChange={setShow} />
        </div>
        {list.error && <Notice tone="error">{list.error}</Notice>}
        {list.loading && !list.data && <p className="text-sm text-content-muted">Loading…</p>}
        {list.data && !rows.length && <p className="text-sm text-content-muted">No other bills{show === "open" ? " in open months" : ""}.</p>}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-content-muted">
                  <th className="py-1 pr-2">Month</th><th className="py-1 pr-2">Store</th><th className="py-1 pr-2">Vendor</th>
                  <th className="py-1 pr-2">Bill #</th><th className="py-1 pr-2">Description</th><th className="py-1 pr-2 text-right">Amount</th>
                  <th className="py-1 pr-2">Status</th><th className="py-1 pr-2 text-right">Left</th><th className="py-1 pr-2">Entered</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => editing === b.id ? (
                  <EditRow key={b.id} b={b} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />
                ) : (
                  <tr key={b.id} className="border-t border-hairline align-top">
                    <td className="whitespace-nowrap py-1.5 pr-2">{b.month_label} {monthPill(b)}</td>
                    <td className="py-1.5 pr-2 font-medium">#{b.store_number} {b.recon_store}</td>
                    <td className="py-1.5 pr-2">{b.vendor}</td>
                    <td className="py-1.5 pr-2 font-mono">{b.bill_no}{b.ro && <div className="text-content-muted">RO {b.ro}</div>}</td>
                    <td className="max-w-[220px] py-1.5 pr-2">{b.description}{b.series_id && <div className="text-content-muted">monthly</div>}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{fmt$(b.amount)}</td>
                    <td className="py-1.5 pr-2"><StatusPill status={b.status} /></td>
                    <td className="py-1.5 pr-2 text-right font-semibold tabular-nums">{fmt$(b.left_to_deduct)}</td>
                    <td className="py-1.5 pr-2 text-content-muted">{b.created_by_name}, {fmtDate(b.created_at)}{b.files ? <div><Paperclip className="inline h-3 w-3" /> {b.files}</div> : null}</td>
                    <td className="whitespace-nowrap py-1.5 text-right">
                      {!b.month_closed && (
                        <span className="inline-flex gap-2">
                          <button title="Attach the bill" className="text-content-muted hover:text-content-primary"
                            onClick={() => { attachFor.current = b; attachInput.current?.click(); }}><Upload className="h-3.5 w-3.5" /></button>
                          <button title="Edit" className="text-content-muted hover:text-content-primary" onClick={() => setEditing(b.id)}><Pencil className="h-3.5 w-3.5" /></button>
                          <button title="Delete" className="text-content-muted hover:text-danger" onClick={() => del(b)}><Trash2 className="h-3.5 w-3.5" /></button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <input ref={attachInput} type="file" className="hidden" accept="image/*,application/pdf"
          onChange={(e) => { attachExisting([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </Card>
    </div>
  );
}
