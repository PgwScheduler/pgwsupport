import React from "react";
import { Download, Printer, X } from "lucide-react";
import { Card, GhostBtn, T } from "../ui.jsx";
import { money } from "../../lib/format.js";
import { computeTotals } from "../../lib/drawerMath.js";
import { exportCloseoutCSV, printCloseout } from "../../lib/drawerExport.js";
import { CountRecap, DetailRow, RecapTable } from "./shared.jsx";

export function CloseoutDetail({ record, store, onClose }) {
  const e = record;
  const t = computeTotals(record, store.drawer_float);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4" onClick={onClose}>
      <div className="mx-auto max-w-5xl" onClick={(ev) => ev.stopPropagation()}>
        <Card className="overflow-hidden">
          <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-5 py-3">
            <div>
              <h3 className="pgw-display text-base font-bold text-white">Closeout — {record.business_date}</h3>
              <p className="text-xs text-slate-500">
                #{store.store_number} · {store.name}
                {record.submitted_by_name ? ` · entered by ${record.submitted_by_name}` : ""}
                {record.created_at ? ` · saved ${new Date(record.created_at).toLocaleString()}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <GhostBtn onClick={() => exportCloseoutCSV(record, store)}><Download className="h-4 w-4" /> CSV</GhostBtn>
              <GhostBtn onClick={() => printCloseout(record, store)}><Printer className="h-4 w-4" /> Print / PDF</GhostBtn>
              <button onClick={onClose} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="space-y-5 p-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-lg p-3" style={{ backgroundColor: T.accentSoftBg }}>
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Cash to Deposit</p>
                <p className="pgw-display text-lg font-bold" style={{ color: T.accentSoftText }}>{money(t.cashToDeposit)}</p>
              </div>
              <div className="rounded-lg bg-slate-800/60 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Store Deposit to Bank</p>
                <p className="pgw-display text-lg font-bold text-white">{money(t.storeDeposit)}</p>
              </div>
              <div className={"rounded-lg p-3 " + (t.diff < 0 ? "bg-red-500/15" : t.diff > 0 ? "bg-emerald-500/15" : "bg-slate-800/60")}>
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Over / Short</p>
                <p className={"pgw-display text-lg font-bold " + (t.diff < 0 ? "text-red-400" : t.diff > 0 ? "text-emerald-400" : "text-slate-400")}>{money(t.diff)}</p>
              </div>
              <div className="rounded-lg bg-slate-800/60 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Petty Cash Used</p>
                <p className="pgw-display text-lg font-bold text-white">{money(t.pettyTotal)}</p>
              </div>
            </div>

            {(e.overage_why || e.shortage_why) && (
              <Card className="p-4">
                {e.overage_why && <p className="text-sm text-slate-300"><span className="font-semibold text-slate-200">Overage explanation: </span>{e.overage_why}</p>}
                {e.shortage_why && <p className="mt-1 text-sm text-slate-300"><span className="font-semibold text-slate-200">Shortage explanation: </span>{e.shortage_why}</p>}
              </Card>
            )}

            <div>
              <h4 className="pgw-display mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Drawer Cash Count</h4>
              <div className="grid gap-4 lg:grid-cols-2">
                <CountRecap title="Opening Cash Balance" qty={e.open_counts} total={t.openTotal} />
                <CountRecap title="Closing Cash Balance" qty={e.close_counts} total={t.closeTotal} />
              </div>
              <Card className="mt-4 p-4">
                <DetailRow label="Closing Cash Balance" value={money(t.closeTotal)} />
                <DetailRow label="Subtract Drawer Fund Amount" value={money(-t.float)} />
                <DetailRow label="Net Daily Cash Activity" value={money(t.netDailyCash)} />
                <DetailRow label="Total Cash to Deposit" value={money(t.cashToDeposit)} strong />
              </Card>
            </div>

            <div>
              <h4 className="pgw-display mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Daily Sales Summary</h4>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="p-4">
                  <DetailRow label="CASH" value={money(e.cash)} />
                  <DetailRow label="TOTAL Customer CHECKS" value={money(e.checks)} />
                  <DetailRow label="CASH, CHECKS TOTAL" value={money(t.cashChecksTotal)} strong />
                  <DetailRow label="Midas CC Totals (Bread)" value={money(e.bread)} />
                  <DetailRow label="Sync Car Care (Synchrony)" value={money(e.synchrony)} />
                  <DetailRow label="Visa, Disc, Amex, Debit, MC" value={money(e.cards)} />
                  <DetailRow label="American First Totals" value={money(e.american_first)} />
                  <DetailRow label="Koalifi Totals" value={money(e.koalifi)} />
                  <DetailRow label="Snap Totals" value={money(e.snap)} />
                  <DetailRow label="Advance Pay" value={money(e.advance_pay)} />
                  <DetailRow label="Prior Advance Pay" value={money(e.prior_advance)} />
                  <DetailRow label="Advance Minus Prior Advanced" value={money(t.advanceMinusPrior)} />
                  <DetailRow label="SALES TAX" value={money(e.sales_tax)} />
                </Card>
                <Card className="p-4">
                  <DetailRow label="Cash Overage" value={money(t.overage)} />
                  <DetailRow label="Cash Shortage" value={money(t.shortage)} />
                  <DetailRow label="Charges / Fleet invoices" value={money(t.fleetTotal)} />
                  <DetailRow label="POA's (Visa, Disc, Amex, Debit)" value={money(t.poaCardsTotal)} />
                  <DetailRow label="TOTAL SALES" value={money(t.totalSales)} strong />
                  <DetailRow label="TOTAL for Home Office" value={money(t.homeOffice)} strong />
                  <DetailRow label="Credit Cards minus CC POAs" value={money(t.cardsMinusPOA)} />
                  <DetailRow label="Store Deposit to Bank" value={money(t.storeDeposit)} strong />
                </Card>
              </div>
            </div>

            <div>
              <h4 className="pgw-display mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Invoices, POAs &amp; Payouts</h4>
              <div className="grid gap-4 lg:grid-cols-2">
                <RecapTable title="POA — Credit Cards" total={t.poaCardsTotal} rows={e.poa_cards}
                  cols={[{ key: "customer", label: "Customer" }, { key: "invoice", label: "Invoice" }, { key: "amount", label: "Amount", money: true }]} />
                <RecapTable title="POA — Checks or Cash & Vendor Rebates" total={t.poaChecksTotal} rows={e.poa_checks}
                  cols={[{ key: "invoice", label: "Invoice #" }, { key: "account", label: "Account or Vendor" }, { key: "amount", label: "Amount", money: true }]} />
                <RecapTable title="Fleet / Charge Invoices" total={t.fleetTotal} rows={e.fleet}
                  cols={[{ key: "invoice", label: "Invoice #" }, { key: "account", label: "Account" }, { key: "amount", label: "Amount", money: true }, { key: "auth", label: "Auth #" }]} />
                <RecapTable title="Cash Payouts Recap" total={t.pettyTotal} rows={e.payouts}
                  cols={[{ key: "vendor", label: "Vendor" }, { key: "ro", label: "RO/PO #" }, { key: "description", label: "Description" }, { key: "amount", label: "Amount", money: true }]} />
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
