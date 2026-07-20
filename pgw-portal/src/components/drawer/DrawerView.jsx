import React, { useState } from "react";
import { Banknote, Check, Download, Eye, FileSpreadsheet, Pencil, Trash2, X } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
import { useCashDrawer } from "../../hooks/useCashDrawer.js";
import { blankEntry, computeTotals, entryFromRecord } from "../../lib/drawerMath.js";
import { exportSummaryCSV } from "../../lib/drawerExport.js";
import { money } from "../../lib/format.js";
import { Card, Empty, Field, GhostBtn, PrimaryBtn, SectionHeader, T, inputCls } from "../ui.jsx";
import { Calc, CountGrid, Entry, MiniTable } from "./shared.jsx";
import { CloseoutDetail } from "./CloseoutDetail.jsx";
import { ExportRangeModal } from "../ExportRangeModal.jsx";

export function DrawerView({ store }) {
  const { role, stores } = useAuth();
  const { rows: saved, loading, error, saveCloseout, updateCloseout, deleteCloseout } = useCashDrawer(store.id);
  const [d, setD] = useState(blankEntry);
  const [editingId, setEditingId] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const float = store.drawer_float;
  const canDelete = role === "master";
  const canExportRange = (stores?.length ?? 0) > 1;

  const set = (k) => (v) => setD((p) => ({ ...p, [k]: v }));
  const setQty = (side) => (k, v) => setD((p) => ({ ...p, [side]: { ...p[side], [k]: v } }));
  const setCell = (tbl) => (id, key, v) =>
    setD((p) => ({ ...p, [tbl]: p[tbl].map((r) => (r.id === id ? { ...r, [key]: v } : r)) }));
  const addRow = (tbl, shape) => () => setD((p) => ({ ...p, [tbl]: [...p[tbl], { ...shape, id: Date.now() }] }));
  const delRow = (tbl) => (id) => setD((p) => ({ ...p, [tbl]: p[tbl].filter((r) => r.id !== id) }));

  const t = computeTotals(d, float);

  const save = async () => {
    if (!d.business_date || saving) return;
    setSaving(true);
    const { error } = editingId ? await updateCloseout(editingId, d) : await saveCloseout(d);
    setSaving(false);
    if (!error) {
      setD(blankEntry());
      setEditingId(null);
    }
  };

  const startEdit = (record) => {
    setViewing(null);
    setEditingId(record.id);
    setD(entryFromRecord(record));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelEdit = () => {
    setD(blankEntry());
    setEditingId(null);
  };

  const editing = saved.find((r) => r.id === editingId) || null;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Cash Drawer Closeout"
        subtitle={`#${store.store_number} · ${store.name}`}
        action={
          <div className="flex items-center gap-2">
            {editingId && (
              <GhostBtn onClick={cancelEdit}><X className="h-4 w-4" /> Cancel edit</GhostBtn>
            )}
            <input type="date" className={inputCls + " w-auto"} value={d.business_date} onChange={(e) => set("business_date")(e.target.value)} />
            <PrimaryBtn onClick={save} disabled={saving}>
              <Check className="h-4 w-4" />
              {saving ? "Saving…" : editingId ? "Update closeout" : "Save closeout"}
            </PrimaryBtn>
          </div>
        }
      />

      {error && (
        <p className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {editingId && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-700/60 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-300">
          <span className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Editing the closeout saved for <strong>{editing?.business_date || d.business_date}</strong>. Saving updates that record — it won't create a new one.
          </span>
          <button onClick={cancelEdit} className="text-xs font-medium text-amber-200 underline-offset-2 hover:underline">Cancel</button>
        </div>
      )}

      <div className="flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm"
        style={{ borderColor: T.accentSoftText, backgroundColor: T.accentSoftBg, color: T.accentSoftText }}>
        <Banknote className="h-4 w-4" />
        <span>This drawer keeps a <strong>{money(float)}</strong> cash fund at all times.</span>
      </div>

      <div>
        <h3 className="pgw-display mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">1 · Drawer Cash Count</h3>
        <div className="grid gap-4 lg:grid-cols-2">
          <CountGrid title="Opening Cash Balance" qty={d.open_counts} onChange={setQty("open_counts")} total={t.openTotal} />
          <CountGrid title="Closing Cash Balance" qty={d.close_counts} onChange={setQty("close_counts")} total={t.closeTotal} />
        </div>
      </div>

      <div>
        <h3 className="pgw-display mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">2 · Cash to Deposit</h3>
        <Card className="p-4">
          <Calc label="Closing Cash Balance" value={t.closeTotal} />
          <Calc label="Subtract Drawer Fund Amount" value={-float} />
          <Calc label="Net Daily Cash Activity" value={t.netDailyCash} />
          <div className="mt-2 flex items-center justify-between rounded-lg px-3 py-2.5" style={{ backgroundColor: T.accentSoftBg }}>
            <div>
              <p className="pgw-display text-sm font-bold" style={{ color: T.accentSoftText }}>Total Cash to Deposit</p>
              <p className="text-[11px] text-slate-500">Put this amount in your deposit envelope</p>
            </div>
            <p className="pgw-display text-xl font-bold" style={{ color: T.accentSoftText }}>{money(t.cashToDeposit)}</p>
          </div>
        </Card>
      </div>

      <div>
        <h3 className="pgw-display mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">3 · Daily Sales Summary</h3>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <Entry label="CASH" hint="From your summary" value={d.cash} onChange={set("cash")} />
            <Entry label="TOTAL Customer CHECKS" hint="Must have approval to accept checks" value={d.checks} onChange={set("checks")} />
            <Calc label="CASH, CHECKS TOTAL" hint="Must match your Sales Summary" value={t.cashChecksTotal} />
            <Entry label="Midas CC Totals (Bread)" value={d.bread} onChange={set("bread")} />
            <Entry label="Sync Car Care Totals (Synchrony)" value={d.synchrony} onChange={set("synchrony")} />
            <Entry label="Visa, Disc, Amex, Debit, MC" value={d.cards} onChange={set("cards")} />
            <Entry label="American First Totals" value={d.american_first} onChange={set("american_first")} />
            <Entry label="Koalifi Totals" value={d.koalifi} onChange={set("koalifi")} />
            <Entry label="Snap Totals" value={d.snap} onChange={set("snap")} />
            <Entry label="Advance Pay" value={d.advance_pay} onChange={set("advance_pay")} />
            <Entry label="Prior Advance Pay" value={d.prior_advance} onChange={set("prior_advance")} />
            <Calc label="Advance Minus Prior Advanced" hint="For SSC" value={t.advanceMinusPrior} />
            <Entry label="SALES TAX" hint="This must match daily sales summary" value={d.sales_tax} onChange={set("sales_tax")} />
          </Card>

          <div className="space-y-4">
            <Card className="p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className={"rounded-lg px-3 py-2 " + (t.overage > 0 ? "bg-emerald-500/15" : "bg-slate-800/60")}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Cash Overage</p>
                  <p className={"pgw-display text-lg font-bold " + (t.overage > 0 ? "text-emerald-400" : "text-slate-500")}>{money(t.overage)}</p>
                </div>
                <div className={"rounded-lg px-3 py-2 " + (t.shortage < 0 ? "bg-red-500/15" : "bg-slate-800/60")}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Cash Shortage</p>
                  <p className={"pgw-display text-lg font-bold " + (t.shortage < 0 ? "text-red-400" : "text-slate-500")}>{money(t.shortage)}</p>
                </div>
              </div>
              {t.overage > 0 && (
                <div className="mt-3"><Field label="Explain overage"><input className={inputCls} value={d.overage_why} onChange={(e) => set("overage_why")(e.target.value)} /></Field></div>
              )}
              {t.shortage < 0 && (
                <div className="mt-3"><Field label="Explain shortage"><input className={inputCls} value={d.shortage_why} onChange={(e) => set("shortage_why")(e.target.value)} /></Field></div>
              )}
              <p className="mt-3 text-[11px] text-slate-500">Petty cash is already deducted from your deposit — no need to add it to the short/why box.</p>
            </Card>

            <Card className="p-4">
              <Calc label="Charges / Fleet invoices" value={t.fleetTotal} />
              <Calc label="POA's (Visa, Disc, Amex, Debit)" value={t.poaCardsTotal} />
              <Calc label="TOTAL SALES" value={t.totalSales} big />
              <Calc label="TOTAL for Home Office" hint="Cash, Checks, CC, Financing · must exactly match deposit to the bank" value={t.homeOffice} big />
              <Calc label="Credit Cards minus Credit Card POAs" value={t.cardsMinusPOA} />
              <Calc label="Store Deposit to Bank" value={t.storeDeposit} big />
            </Card>
          </div>
        </div>
      </div>

      <div>
        <h3 className="pgw-display mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">4 · Invoices, POAs &amp; Payouts</h3>
        <div className="grid gap-4 lg:grid-cols-2">
          <MiniTable
            title="POA — Credit Cards" note="Visa, Disc, Amex, Debit"
            cols={[{ key: "customer", label: "Customer" }, { key: "invoice", label: "Invoice" }, { key: "amount", label: "Amount", money: true }]}
            rows={d.poa_cards} onCell={setCell("poa_cards")} onAddRow={addRow("poa_cards", { customer: "", invoice: "", amount: "" })}
            onDelRow={delRow("poa_cards")} total={t.poaCardsTotal}
          />
          <MiniTable
            title="POA — Checks or Cash & Vendor Rebates" note="Leave invoice blank if rebate"
            cols={[{ key: "invoice", label: "Invoice #" }, { key: "account", label: "Account or Vendor" }, { key: "amount", label: "Amount", money: true }]}
            rows={d.poa_checks} onCell={setCell("poa_checks")} onAddRow={addRow("poa_checks", { invoice: "", account: "", amount: "" })}
            onDelRow={delRow("poa_checks")} total={t.poaChecksTotal}
          />
          <MiniTable
            title="Fleet / Charge Invoices" note="Email copies of each invoice"
            cols={[{ key: "invoice", label: "Invoice #" }, { key: "account", label: "Fleet/Charge Account" }, { key: "amount", label: "Amount", money: true }, { key: "auth", label: "Authorization #" }]}
            rows={d.fleet} onCell={setCell("fleet")} onAddRow={addRow("fleet", { invoice: "", account: "", amount: "", auth: "" })}
            onDelRow={delRow("fleet")} total={t.fleetTotal}
          />
          <MiniTable
            title="Cash Payouts Recap" note="Anything out of drawer — use store credit card first. Receipts must accompany this form."
            cols={[{ key: "vendor", label: "Vendor" }, { key: "ro", label: "RO/PO #" }, { key: "description", label: "Description" }, { key: "amount", label: "Amount", money: true }]}
            rows={d.payouts} onCell={setCell("payouts")} onAddRow={addRow("payouts", { vendor: "", ro: "", description: "", amount: "" })}
            onDelRow={delRow("payouts")} total={t.pettyTotal}
          />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          All purchases go through Shari before using anything from the cash drawer. Anything needing further approval, she takes to John or Gus.
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="pgw-display text-sm font-bold uppercase tracking-wide text-slate-400">Saved closeouts</h3>
          <div className="flex items-center gap-2">
            {canExportRange && (
              <GhostBtn onClick={() => setRangeOpen(true)}><FileSpreadsheet className="h-4 w-4" /> Export range (Excel)</GhostBtn>
            )}
            {saved.length > 0 && (
              <GhostBtn onClick={() => exportSummaryCSV(saved, store)}><Download className="h-4 w-4" /> Export all to CSV</GhostBtn>
            )}
          </div>
        </div>
        {loading ? (
          <p className="px-1 py-6 text-center text-sm text-slate-500">Loading…</p>
        ) : saved.length === 0 ? (
          <Empty icon={Banknote} title="No closeouts saved yet" hint="Fill out the sheet above and hit Save closeout." />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-2">Date</th><th className="px-4 py-2">Deposit</th>
                  <th className="px-4 py-2">Over / Short</th><th className="px-4 py-2">Petty cash</th>
                  <th className="px-4 py-2">Home Office</th><th className="px-4 py-2"></th>
                  {canDelete && <th className="px-4 py-2"></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {saved.map((r) => {
                  const rt = computeTotals(r, float);
                  return (
                    <tr key={r.id} className="cursor-pointer hover:bg-slate-800/40" onClick={() => setViewing(r)}>
                      <td className="px-4 py-2.5 text-slate-300">{r.business_date}</td>
                      <td className="px-4 py-2.5 font-medium text-white">{money(rt.storeDeposit)}</td>
                      <td className={"px-4 py-2.5 font-semibold " + (rt.diff < 0 ? "text-red-400" : rt.diff > 0 ? "text-emerald-400" : "text-slate-500")}>{money(rt.diff)}</td>
                      <td className="px-4 py-2.5 text-slate-400">{money(rt.pettyTotal)}</td>
                      <td className="px-4 py-2.5 text-slate-400">{money(rt.homeOffice)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={(ev) => { ev.stopPropagation(); startEdit(r); }}
                            className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-white"
                          >
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </button>
                          <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: T.accentSoftText }}>
                            <Eye className="h-3.5 w-3.5" /> View sheet
                          </span>
                        </div>
                      </td>
                      {canDelete && (
                        <td className="px-4 py-2.5 text-right">
                          <button onClick={(ev) => { ev.stopPropagation(); deleteCloseout(r.id); }} className="text-slate-600 hover:text-red-400">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {viewing && <CloseoutDetail record={viewing} store={store} onClose={() => setViewing(null)} onEdit={() => startEdit(viewing)} />}
      {rangeOpen && <ExportRangeModal storeCount={stores.length} onClose={() => setRangeOpen(false)} />}
    </div>
  );
}
