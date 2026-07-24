import React from "react";
import { Trash2, Plus } from "lucide-react";
import { Card } from "../ui.jsx";
import { COINS, BILLS, num } from "../../lib/denoms.js";
import { money } from "../../lib/format.js";

export const cashCell =
  "w-28 rounded border border-hairline-strong bg-surface-overlay px-2 py-1 text-right text-sm text-content-primary outline-none focus:border-hairline-strong";
export const tblInput =
  "w-full rounded border border-hairline-strong bg-surface-overlay px-2 py-1 text-sm text-content-primary outline-none focus:border-hairline-strong";

/* A read-only computed figure */
export function Calc({ label, value, hint, tone, big }) {
  const toneCls = tone === "neg" ? "text-danger" : tone === "pos" ? "text-success" : "text-content-primary";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-2 last:border-0">
      <div>
        <p className={"font-medium " + (big ? "text-sm text-content-primary" : "text-sm text-content-secondary")}>{label}</p>
        {hint && <p className="text-[11px] text-content-muted">{hint}</p>}
      </div>
      <p className={"pgw-display flex-shrink-0 font-bold " + (big ? "text-lg " : "text-sm ") + toneCls}>{money(value)}</p>
    </div>
  );
}

/* A typed-in money figure */
export function Entry({ label, hint, value, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-hairline py-2 last:border-0">
      <div>
        <p className="text-sm font-medium text-content-secondary">{label}</p>
        {hint && <p className="text-[11px] text-content-muted">{hint}</p>}
      </div>
      <input className={cashCell} value={value} onChange={(e) => onChange(e.target.value)} placeholder="0.00" />
    </div>
  );
}

export function CountGrid({ title, qty, onChange, total }) {
  const row = ([k, label, d]) => (
    <div key={k} className="flex items-center justify-between gap-2 py-1">
      <span className="w-20 text-sm text-content-secondary">{label}</span>
      <input
        className="w-16 rounded border border-hairline-strong bg-surface-overlay px-2 py-1 text-center text-sm text-content-primary outline-none focus:border-hairline-strong"
        value={qty[k] ?? ""}
        onChange={(e) => onChange(k, e.target.value)}
        placeholder="0"
      />
      <span className="w-20 text-right text-sm text-content-secondary">{money(num(qty[k]) * d)}</span>
    </div>
  );
  return (
    <Card className="p-4">
      <h4 className="pgw-display mb-2 text-sm font-bold text-content-primary">{title}</h4>
      <div className="mb-1 flex justify-between text-[11px] uppercase tracking-wide text-content-muted">
        <span className="w-20">Currency</span><span className="w-16 text-center">Qty</span><span className="w-20 text-right">Amount</span>
      </div>
      <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-content-muted">Coins</p>
      {COINS.map(row)}
      <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-content-muted">Bills</p>
      {BILLS.map(row)}
      <div className="mt-3 flex items-center justify-between border-t border-hairline-strong pt-2">
        <span className="text-sm font-semibold text-content-primary">Total Cash</span>
        <span className="pgw-display text-base font-bold text-content-primary">{money(total)}</span>
      </div>
    </Card>
  );
}

export function CountRecap({ title, qty, total }) {
  const used = [...COINS, ...BILLS].filter(([k]) => num(qty?.[k]) > 0);
  return (
    <Card className="p-4">
      <h4 className="pgw-display mb-2 text-sm font-bold text-content-primary">{title}</h4>
      {used.length === 0 ? (
        <p className="py-2 text-sm text-content-muted">Nothing counted.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-content-muted">
              <th className="pb-1 text-left font-medium">Currency</th>
              <th className="pb-1 text-center font-medium">Qty</th>
              <th className="pb-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {used.map(([k, label, dn]) => (
              <tr key={k}>
                <td className="py-0.5 text-content-secondary">{label}</td>
                <td className="py-0.5 text-center text-content-primary">{num(qty[k])}</td>
                <td className="py-0.5 text-right text-content-secondary">{money(num(qty[k]) * dn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-2 flex items-center justify-between border-t border-hairline-strong pt-2">
        <span className="text-sm font-semibold text-content-primary">Total Cash</span>
        <span className="pgw-display text-base font-bold text-content-primary">{money(total)}</span>
      </div>
    </Card>
  );
}

export function MiniTable({ title, note, cols, rows, onCell, onAddRow, onDelRow, total }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-hairline px-4 py-2.5">
        <h4 className="pgw-display text-sm font-bold text-content-primary">{title}</h4>
        {note && <p className="text-[11px] text-content-muted">{note}</p>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-overlay text-left text-[11px] uppercase tracking-wide text-content-muted">
            <tr>{cols.map((c) => <th key={c.key} className="px-3 py-2">{c.label}</th>)}<th className="px-2 py-2"></th></tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r) => (
              <tr key={r.id}>
                {cols.map((c) => (
                  <td key={c.key} className="px-3 py-1.5">
                    <input
                      className={tblInput + (c.money ? " text-right" : "")}
                      value={r[c.key] ?? ""}
                      onChange={(e) => onCell(r.id, c.key, e.target.value)}
                      placeholder={c.money ? "0.00" : ""}
                    />
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right">
                  <button onClick={() => onDelRow(r.id)} className="text-content-muted hover:text-danger">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-hairline px-4 py-2">
        <button onClick={onAddRow} className="inline-flex items-center gap-1 text-xs font-medium text-content-secondary hover:text-content-primary">
          <Plus className="h-3.5 w-3.5" /> Add row
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-content-muted">Total</span>
          <span className="pgw-display text-sm font-bold text-content-primary">{money(total)}</span>
        </div>
      </div>
    </Card>
  );
}

export function DetailRow({ label, value, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-1.5 last:border-0">
      <span className={"text-sm " + (strong ? "font-semibold text-content-primary" : "text-content-secondary")}>{label}</span>
      <span className={"pgw-display flex-shrink-0 font-bold " + (strong ? "text-base text-content-primary" : "text-sm text-content-primary")}>{value}</span>
    </div>
  );
}

export function RecapTable({ title, cols, rows, total }) {
  const filled = (rows || []).filter((r) => cols.some((c) => String(r[c.key] ?? "").trim() !== ""));
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-hairline px-4 py-2.5">
        <h4 className="pgw-display text-sm font-bold text-content-primary">{title}</h4>
      </div>
      {filled.length === 0 ? (
        <p className="px-4 py-3 text-sm text-content-muted">No entries.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-overlay text-left text-[11px] uppercase tracking-wide text-content-muted">
              <tr>{cols.map((c) => <th key={c.key} className={"px-3 py-2 " + (c.money ? "text-right" : "")}>{c.label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {filled.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c.key} className={"px-3 py-1.5 " + (c.money ? "text-right text-content-primary" : "text-content-secondary")}>
                      {c.money ? money(num(r[c.key])) : (String(r[c.key] ?? "").trim() || "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-hairline px-4 py-2">
        <span className="text-[11px] uppercase tracking-wide text-content-muted">Total</span>
        <span className="pgw-display text-sm font-bold text-content-primary">{money(total)}</span>
      </div>
    </Card>
  );
}
