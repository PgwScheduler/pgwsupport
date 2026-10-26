import React, { useRef, useState } from "react";
import { FileSpreadsheet, Trash2, Upload, UserPlus } from "lucide-react";
import { partsReconApi, usePartsReconOtherCredits, usePartsReconTeam } from "../../hooks/usePartsRecon.js";
import { buildImport, identify, loadWorkbook, sheetsOf } from "../../lib/partsReconImport.js";
import { monthShort } from "../../lib/partsRecon.js";
import { Card, Field, GhostBtn, PrimaryBtn, inputCls } from "../ui.jsx";
import { Notice, fmt$, fmtDate } from "./shared.jsx";
import { CreditBatchDialog } from "./CreditBatchDialog.jsx";

// AP's side: bring a run in, release it to the stores, close it; other
// credits for earlier months; who's on the AP team.

const SLOTS = [
  ["breakdown", "RO Cost Breakdown", true],
  ["detail", "Parts Recon Detail", true],
  ["tracker", "Filled tracker (New_SHARED_Deductions…)", false],
  ["responses", "Store Response Tracker (carries over statuses worked in Excel)", false],
];

function ImportCard({ onImported }) {
  const input = useRef(null);
  const [files, setFiles] = useState({});   // kind -> {name, size, modified, sheets}
  const [reading, setReading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const read = async (list) => {
    setReading(true); setMsg(null); setResult(null);
    const next = { ...files };
    for (const f of list) {
      try {
        const wb = await loadWorkbook(await f.arrayBuffer());
        const kind = identify(wb);
        if (!kind) { setMsg({ tone: "error", text: `${f.name}: not one of the recon's result workbooks.` }); continue; }
        next[kind] = { name: f.name, size: f.size, modified: f.lastModified ? new Date(f.lastModified).toISOString() : null, sheets: sheetsOf(wb, kind) };
      } catch (e) {
        setMsg({ tone: "error", text: `${f.name}: couldn't read it (${e.message}).` });
      }
    }
    setFiles(next);
    setReading(false);
  };

  const built = files.breakdown || files.detail ? buildImport({
    breakdown: files.breakdown?.sheets, detail: files.detail?.sheets, tracker: files.tracker?.sheets, responses: files.responses?.sheets,
  }) : null;

  const run = async () => {
    setProgress(0); setMsg(null);
    const meta = Object.values(files).map(({ name, size, modified }) => ({ name, size, modified }));
    const r = await partsReconApi.runImport(built, meta, setProgress);
    setProgress(null);
    if (r.error) { setMsg({ tone: "error", text: r.error }); return; }
    setResult(r.data);
    onImported(built.month);
  };

  const c = built?.check;
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="pgw-display text-base font-bold text-content-primary">Import a recon run</h3>
        <p className="text-sm text-content-secondary">
          Pick the workbooks run_all.py wrote to <span className="font-mono text-xs">AP Reconciliations\03 Results</span>.
          Re-importing a month updates the amounts and keeps every reply and review.
        </p>
      </div>
      <input ref={input} type="file" multiple accept=".xlsx" className="hidden"
        onChange={(e) => { if (e.target.files?.length) read([...e.target.files]); e.target.value = ""; }} />
      <GhostBtn onClick={() => input.current?.click()} disabled={reading}>
        <Upload className="h-4 w-4" /> {reading ? "Reading…" : "Choose workbooks"}
      </GhostBtn>
      <ul className="space-y-1 text-sm">
        {SLOTS.map(([k, label, needed]) => (
          <li key={k} className="flex items-center gap-2">
            <FileSpreadsheet className={"h-4 w-4 " + (files[k] ? "text-success" : "text-content-muted")} />
            <span className={files[k] ? "text-content-primary" : "text-content-muted"}>
              {label}{needed ? "" : " — optional"}{files[k] && <span className="text-content-muted"> · {files[k].name}</span>}
            </span>
          </li>
        ))}
      </ul>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {built?.errors?.length > 0 && <Notice tone="error">{built.errors.join(" ")}</Notice>}
      {c && (
        <>
          <div className="overflow-x-auto">
            <table className="text-sm">
              <tbody>
                {[
                  ["Month", monthShort(built.month)],
                  ["Store items (store emails)", `${c.store_items} · ${fmt$(c.store_amount)}`],
                  ["Divvy charges not in AP", `${c.divvy_items} · ${fmt$(c.divvy_amount)}`],
                  ["ARM stores (RO level)", fmt$(c.arm_amount)],
                  ["Total", fmt$(c.total)],
                  ["Summary tab total", c.summary_total === null ? "no saved value" : fmt$(c.summary_total)],
                  ["Tracker rows", `${built.tracker.length} · ${fmt$(c.tracker_total)}${c.tracker_other ? ` (incl. ${fmt$(c.tracker_other)} keyed by hand)` : ""}`],
                  ["AP to-do", c.ap_tasks],
                  ["Stock-but-ordered notes", c.notes],
                  ["Statuses carried over from Excel", c.responses],
                ].map(([k, v]) => (
                  <tr key={k} className="border-t border-hairline"><td className="py-1 pr-6 text-content-secondary">{k}</td><td className="py-1 font-medium tabular-nums">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {c.mismatches === 0 && c.tracker_mismatches === 0 && (
            <Notice tone="ok">Every Location × Vendor amount matches the Summary tab and the tracker.</Notice>
          )}
          {built.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
          {built.mismatches?.length > 0 && (
            <details className="text-xs text-content-secondary">
              <summary>Show the {built.mismatches.length} difference(s)</summary>
              {built.mismatches.slice(0, 50).map((m) => <p key={m.store + m.vendor}>{m.store} {m.vendor}: run {fmt$(m.script)}, portal {fmt$(m.portal)}</p>)}
            </details>
          )}
          <PrimaryBtn onClick={run} disabled={progress !== null || built.errors.length > 0}>
            {progress !== null ? `Importing… ${Math.round(progress * 100)}%` : `Import ${monthShort(built.month)}`}
          </PrimaryBtn>
        </>
      )}
      {result && (
        <Notice tone="ok">
          Imported {result.items} items ({fmt$(result.items_amount)}).
          {result.items_dropped > 0 && ` ${result.items_dropped} item(s) no longer in the run were hidden.`}
          {result.responses_applied > 0 && ` ${result.responses_applied} status(es) carried over from Excel.`}
          {result.unmapped_stores?.length > 0 && ` Not matched to a portal store: ${result.unmapped_stores.join(", ")}.`}
        </Notice>
      )}
    </Card>
  );
}

function MonthCard({ monthRow, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!monthRow) return null;
  const set = async (released, closed, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setErr(null);
    const r = await partsReconApi.setMonth(monthRow.month, released, closed);
    setBusy(false);
    if (r.error) setErr(r.error); else onChanged();
  };
  const released = !!monthRow.released_at, closed = !!monthRow.closed_at;
  return (
    <Card className="space-y-2 p-4">
      <h3 className="pgw-display text-base font-bold text-content-primary">{monthRow.label}</h3>
      <p className="text-sm text-content-secondary">
        {monthRow.imported_at
          ? <>Imported {fmtDate(monthRow.imported_at)} by {monthRow.imported_by_name ?? "—"}</>
          : "No recon imported yet: this month only holds Other bills until its run is imported"} ·{" "}
        {closed ? `closed ${fmtDate(monthRow.closed_at)}` : released ? `released to stores ${fmtDate(monthRow.released_at)}` : "not released to stores yet"}
      </p>
      {monthRow.files?.length > 0 && <p className="text-xs text-content-muted">Files: {monthRow.files.map((f) => f.name).join(", ")}</p>}
      <div className="flex flex-wrap gap-2">
        {!released && <PrimaryBtn disabled={busy} onClick={() => set(true, false, "Release this month? Every store will see its items and can reply.")}>Release to stores</PrimaryBtn>}
        {released && !closed && <GhostBtn disabled={busy} onClick={() => set(false, false, "Hide this month from the stores again?")}>Hide from stores</GhostBtn>}
        {released && !closed && <PrimaryBtn disabled={busy} onClick={() => set(true, true, "Close the month? Replies and reviews lock, and what's left is the deduction.")}>Close the month</PrimaryBtn>}
        {closed && <GhostBtn disabled={busy} onClick={() => set(true, false)}>Reopen</GhostBtn>}
      </div>
      {err && <Notice tone="error">{err}</Notice>}
    </Card>
  );
}

function OtherCredits({ month }) {
  const list = usePartsReconOtherCredits(month, true);
  const blank = { store: "", vendor: "", creditNo: "", creditDate: "", origInvoice: "", ro: "", parts: "", amount: "", forMonth: "", notes: "" };
  const [v, setV] = useState(blank);
  const [err, setErr] = useState(null);
  const [viewBatch, setViewBatch] = useState(null);
  const save = async () => {
    setErr(null);
    const r = await partsReconApi.saveOtherCredit(month, v);
    if (r.error) setErr(r.error); else { setV(blank); list.reload(); }
  };
  const del = async (id) => {
    if (!window.confirm("Remove this credit?")) return;
    const r = await partsReconApi.deleteOtherCredit(id);
    if (r.error) setErr(r.error); else list.reload();
  };
  const rows = list.data ?? [];
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="pgw-display text-base font-bold text-content-primary">Credits for earlier months</h3>
        <p className="text-sm text-content-secondary">Credits a store sent this month that clear a prior month's items. They don't change this month's left to deduct.</p>
      </div>
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t border-hairline align-top">
                  <td className="py-1 pr-2 font-medium">{c.recon_store}</td><td className="py-1 pr-2">{c.vendor}</td>
                  <td className="py-1 pr-2 font-mono">{c.credit_no}</td><td className="py-1 pr-2">{fmtDate(c.credit_date)}</td>
                  <td className="py-1 pr-2">RO {c.ro ?? "—"} · inv {c.orig_invoice ?? "—"}</td><td className="py-1 pr-2">{c.parts}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{fmt$(c.amount)}</td><td className="py-1 pr-2">{c.for_month}</td>
                  <td className="py-1 pr-2 text-content-muted">
                    {c.notes}
                    {c.batch_id && <button className="ml-1 text-accent-text hover:underline" onClick={() => setViewBatch(c.batch_id)}>See the credit</button>}
                  </td>
                  <td className="py-1"><button onClick={() => del(c.id)} title="Remove" className="text-content-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-5">
        {[["store", "Store"], ["vendor", "Vendor"], ["creditNo", "Credit #"], ["amount", "Credit $"], ["forMonth", "For month"]].map(([k, l]) => (
          <Field key={k} label={l}><input className={inputCls} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>
        ))}
        {[["creditDate", "Credit date"], ["origInvoice", "Original invoice"], ["ro", "RO #"], ["parts", "Part(s)"], ["notes", "Notes"]].map(([k, l]) => (
          <Field key={k} label={l}>
            <input type={k === "creditDate" ? "date" : "text"} className={inputCls} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      <GhostBtn onClick={save} disabled={!v.store.trim()}>Add credit</GhostBtn>
      {viewBatch && <CreditBatchDialog batchId={viewBatch} onClose={() => setViewBatch(null)} />}
    </Card>
  );
}

function Team() {
  const team = usePartsReconTeam(true);
  const [email, setEmail] = useState("");
  const [err, setErr] = useState(null);
  const set = async (e, on) => {
    setErr(null);
    const r = await partsReconApi.teamSet(e, on);
    if (r.error) setErr(r.error); else { setEmail(""); team.reload(); }
  };
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="pgw-display text-base font-bold text-content-primary">AP team</h3>
        <p className="text-sm text-content-secondary">Master and admin are always on it. Add the logins that import, review replies and work the AP to-do.</p>
      </div>
      {(team.data ?? []).map((m) => (
        <div key={m.user_id} className="flex items-center justify-between gap-2 text-sm">
          <span>{m.name} <span className="text-content-muted">· {m.email} · {m.role}</span></span>
          <GhostBtn onClick={() => set(m.email, false)}>Remove</GhostBtn>
        </div>
      ))}
      {team.data && !team.data.length && <p className="text-sm text-content-muted">No one added yet.</p>}
      <div className="flex gap-2">
        <input className={inputCls} placeholder="Login email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <GhostBtn onClick={() => set(email, true)} disabled={!email.trim()}><UserPlus className="h-4 w-4" /> Add</GhostBtn>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
    </Card>
  );
}

export function ImportPanel({ month, monthRow, managesTeam, onImported, onChanged }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-4">
        <MonthCard monthRow={monthRow} onChanged={onChanged} />
        <ImportCard onImported={onImported} />
      </div>
      <div className="space-y-4">
        {month && <OtherCredits key={month} month={month} />}
        {managesTeam && <Team />}
      </div>
    </div>
  );
}
