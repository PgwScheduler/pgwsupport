import React, { useRef, useState } from "react";
import { ChevronDown, ChevronRight, Paperclip, Upload, Check } from "lucide-react";
import { partsReconApi } from "../../hooks/usePartsRecon.js";
import { REVIEW_STATUSES, STORE_ACTIONS, STATUS, storeActionLabel } from "../../lib/partsRecon.js";
import { Field, GhostBtn, PrimaryBtn, inputCls } from "../ui.jsx";
import { Notice, StatusPill, fmt$, fmtDate } from "./shared.jsx";

// One store item: the RO, what's off, what the store is asked to do;
// opened, the vendor's invoice lines and RO parts, the store's reply,
// AP's review and the credit memos.

function Lines({ detail }) {
  const parts = detail?.parts ?? [], lines = detail?.lines ?? [];
  if (!parts.length && !lines.length) return null;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {lines.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-content-muted">Vendor invoice lines</p>
          <table className="w-full text-xs">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-hairline align-top">
                  <td className="py-1 pr-2 font-mono">{l.inv}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{fmt$(l.amt)}</td>
                  <td className="py-1 pr-2 font-medium">{l.result}</td>
                  <td className="py-1 text-content-muted">{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {parts.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-content-muted">This vendor's parts on the RO</p>
          <table className="w-full text-xs">
            <tbody>
              {parts.map((p, i) => (
                <tr key={i} className="border-t border-hairline align-top">
                  <td className="py-1 pr-2 font-mono">{p.part}</td>
                  <td className="py-1 pr-2">{p.desc}{p.stock && <span className="ml-1 text-content-muted">(Stock)</span>}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{fmt$(p.cost)}</td>
                  <td className="py-1 text-content-muted">{p.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReplyForm({ item, onDone }) {
  const [v, setV] = useState({ action: item.kind === "divvy" ? "entered_in_ap" : "returned", creditNo: "", creditAmt: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (p) => setV((x) => ({ ...x, ...p }));
  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await partsReconApi.respond(item.id, v);
    setBusy(false);
    if (r.error) setErr(r.error); else onDone();
  };
  return (
    <div className="space-y-2 rounded-lg border border-hairline bg-surface-page p-3">
      <p className="text-sm font-semibold text-content-primary">{item.status === "open" ? "Reply" : "Reply again"}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="What you did">
          <select className={inputCls} value={v.action} onChange={(e) => set({ action: e.target.value })}>
            {STORE_ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Credit #">
          <input className={inputCls} value={v.creditNo} onChange={(e) => set({ creditNo: e.target.value })} />
        </Field>
        <Field label="Credit $">
          <input className={inputCls} inputMode="decimal" value={v.creditAmt} onChange={(e) => set({ creditAmt: e.target.value.replace(/[^\d.]/g, "") })} />
        </Field>
      </div>
      <Field label="Note">
        <textarea className={inputCls + " min-h-[60px]"} value={v.note} onChange={(e) => set({ note: e.target.value })}
          placeholder="Which part went back, which vendor it came from, or why the charge is right" />
      </Field>
      {err && <Notice tone="error">{err}</Notice>}
      <PrimaryBtn onClick={submit} disabled={busy}>{busy ? "Sending…" : "Send reply"}</PrimaryBtn>
    </div>
  );
}

function ReviewForm({ item, onDone }) {
  const [v, setV] = useState({
    status: item.status === "open" || item.status === "answered" ? (item.store_credit_no ? "credit_received" : "explained") : item.status,
    creditNo: item.credit_no ?? item.store_credit_no ?? "",
    creditAmt: item.credit_amt ?? item.store_credit_amt ?? "",
    creditDate: item.credit_date ?? "",
    note: item.ap_note ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (p) => setV((x) => ({ ...x, ...p }));
  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await partsReconApi.review(item.id, v);
    setBusy(false);
    if (r.error) setErr(r.error); else onDone();
  };
  return (
    <div className="space-y-2 rounded-lg border border-hairline bg-surface-page p-3">
      <p className="text-sm font-semibold text-content-primary">AP review</p>
      <div className="grid gap-2 sm:grid-cols-4">
        <Field label="Status">
          <select className={inputCls} value={v.status} onChange={(e) => set({ status: e.target.value })}>
            {REVIEW_STATUSES.map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
          </select>
        </Field>
        <Field label="Credit #">
          <input className={inputCls} value={v.creditNo} onChange={(e) => set({ creditNo: e.target.value })} />
        </Field>
        <Field label="Credit $">
          <input className={inputCls} inputMode="decimal" value={v.creditAmt}
            onChange={(e) => set({ creditAmt: e.target.value.replace(/[^\d.]/g, "") })}
            placeholder={v.status === "credit_received" ? fmt$(item.amount) : ""} />
        </Field>
        <Field label="Credit date">
          <input type="date" className={inputCls} value={v.creditDate} onChange={(e) => set({ creditDate: e.target.value })} />
        </Field>
      </div>
      <Field label="AP note">
        <input className={inputCls} value={v.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      {err && <Notice tone="error">{err}</Notice>}
      <PrimaryBtn onClick={submit} disabled={busy}><Check className="h-4 w-4" /> {busy ? "Saving…" : "Save review"}</PrimaryBtn>
    </div>
  );
}

function Files({ item, month, onDone }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const add = async (fileList) => {
    setBusy(true); setErr(null);
    for (const f of fileList) {
      const r = await partsReconApi.attach(item, month, f);
      if (r.error) { setErr(r.error); break; }
    }
    setBusy(false);
    onDone();
  };
  return (
    <div className="space-y-1">
      {item.files.map((f) => (
        <button key={f.id} onClick={() => partsReconApi.openFile(f.path)} className="flex items-center gap-1.5 text-sm text-accent-text hover:underline">
          <Paperclip className="h-3.5 w-3.5" /> {f.name} <span className="text-xs text-content-muted">({f.by}, {fmtDate(f.at)})</span>
        </button>
      ))}
      {item.can_answer && (
        <>
          <input ref={input} type="file" multiple className="hidden" accept="image/*,application/pdf"
            onChange={(e) => { if (e.target.files?.length) add([...e.target.files]); e.target.value = ""; }} />
          <GhostBtn onClick={() => input.current?.click()} disabled={busy}>
            <Upload className="h-4 w-4" /> {busy ? "Uploading…" : "Attach credit memo / receipt"}
          </GhostBtn>
        </>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}

export function ItemRow({ item, month, isAp, monthClosed, showStore, onChanged }) {
  const [open, setOpen] = useState(false);
  const cleared = item.status === "credit_received" || item.status === "explained";
  const amount = item.amount > 0 ? fmt$(item.amount)
    : item.ro_higher ? <span className="text-content-muted">RO {fmt$(item.ro_higher)} higher</span> : fmt$(0);
  return (
    <div className="border-t border-hairline first:border-t-0">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-overlay">
        {open ? <ChevronDown className="mt-0.5 h-4 w-4 flex-shrink-0 text-content-muted" /> : <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-content-muted" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {showStore && <span className="text-sm font-semibold text-content-primary">{item.recon_store}</span>}
            <span className="text-sm font-medium text-content-primary">
              {item.kind === "divvy" ? `Divvy · ${item.invoices ?? ""}` : `RO ${item.ro ?? "—"}`}
            </span>
            {item.kind !== "divvy" && item.invoices && <span className="font-mono text-xs text-content-muted">inv {item.invoices}</span>}
            {item.kind === "divvy" && item.txn_date && <span className="text-xs text-content-muted">{fmtDate(item.txn_date)}</span>}
            <StatusPill status={item.status} />
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-content-secondary">{item.asked}</p>
        </div>
        <div className="flex-shrink-0 text-right">
          <p className="text-sm font-semibold tabular-nums text-content-primary">{amount}</p>
          {item.left_to_deduct !== item.amount && item.amount > 0 && (
            <p className="text-xs tabular-nums text-content-muted">{fmt$(item.left_to_deduct)} left</p>
          )}
        </div>
      </button>
      {open && (
        <div className="space-y-3 px-3 pb-3 pl-9">
          {item.why && <p className="text-sm text-content-secondary"><span className="font-medium text-content-primary">Why: </span>{item.why}</p>}
          {item.kind === "ro_cost" && (
            <p className="text-xs text-content-muted">
              Vendor billed {fmt$(item.billed)} · RO cost (this vendor) {fmt$(item.ro_cost)}
              {Number(item.core) > 0 && ` · ${fmt$(item.core)} not tracked (core / tire-ticket item), left off`}
            </p>
          )}
          <Lines detail={item.detail} />
          {item.answered_at && (
            <div className="rounded-lg border border-hairline px-3 py-2 text-sm">
              <p className="font-medium text-content-primary">Store reply · {item.answered_by_name}, {fmtDate(item.answered_at)}</p>
              <p className="text-content-secondary">
                {storeActionLabel(item.store_action)}
                {item.store_credit_no && ` · credit # ${item.store_credit_no}`}
                {item.store_credit_amt !== null && item.store_credit_amt !== undefined && ` · ${fmt$(item.store_credit_amt)}`}
              </p>
              {item.store_note && <p className="text-content-secondary">{item.store_note}</p>}
            </div>
          )}
          {item.reviewed_at && (
            <div className="rounded-lg border border-hairline px-3 py-2 text-sm">
              <p className="font-medium text-content-primary">AP · {item.reviewed_by_name}, {fmtDate(item.reviewed_at)}</p>
              <p className="text-content-secondary">
                {STATUS[item.status]?.label}
                {item.credit_no && ` · credit # ${item.credit_no}`}
                {item.credit_amt !== null && item.credit_amt !== undefined && ` · ${fmt$(item.credit_amt)}`}
                {item.credit_date && ` · ${fmtDate(item.credit_date)}`}
              </p>
              {item.ap_note && <p className="text-content-secondary">{item.ap_note}</p>}
            </div>
          )}
          <Files item={item} month={month} onDone={onChanged} />
          {item.can_answer && !cleared && !isAp && <ReplyForm item={item} onDone={onChanged} />}
          {/* AP reviews ARM items too (no store reply for those). */}
          {isAp && !monthClosed && <ReviewForm item={item} onDone={onChanged} />}
          {!isAp && !item.can_answer && !cleared && monthClosed && (
            <p className="text-xs text-content-muted">This month is closed.</p>
          )}
        </div>
      )}
    </div>
  );
}
