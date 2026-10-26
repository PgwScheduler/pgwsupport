import React, { useMemo, useState } from "react";
import { Download, PackageSearch, ReceiptText, Search } from "lucide-react";
import { usePartsReconItemBatches, usePartsReconItems, usePartsReconNotes } from "../../hooks/usePartsRecon.js";
import { groupItems, itemTotals, matchesFilter, matchesSearch, vendorLabel, KIND_LABEL } from "../../lib/partsRecon.js";
import { exportItems } from "../../lib/partsReconWorkbook.js";
import { Card, Empty, GhostBtn, inputCls } from "../ui.jsx";
import { ItemRow } from "./ItemRow.jsx";
import { MassCreditPanel } from "./MassCreditPanel.jsx";
import { Notice, Segmented, Stat, fmt$, selectSm } from "./shared.jsx";

// The store items for a month. A store login sees its own store; DMs,
// RMs, office and AP pick a store (or all of theirs).

const FILTERS_STORE = [["open", "Needs your reply"], ["answered", "Waiting on AP"], ["done", "Reviewed"], ["all", "All"]];
const FILTERS_AP = [["answered", "Needs AP review"], ["open", "Waiting on store"], ["done", "Reviewed"], ["all", "All"]];

function StockNotes({ notes }) {
  const [open, setOpen] = useState(false);
  if (!notes.length) return null;
  return (
    <Card className="p-3">
      <button onClick={() => setOpen((o) => !o)} className="text-sm font-semibold text-content-primary">
        Note: {notes.length} part(s) marked Stock on the RO but ordered on that RO's invoice {open ? "▾" : "▸"}
      </button>
      <p className="text-xs text-content-muted">Not a deduction. Mark parts ordered for the job as NonStock.</p>
      {open && (
        <table className="mt-2 w-full text-xs">
          <tbody>
            {notes.map((n, i) => (
              <tr key={i} className="border-t border-hairline">
                <td className="py-1 pr-2">{n.recon_store}</td>
                <td className="py-1 pr-2">{vendorLabel(n.vendor)}</td>
                <td className="py-1 pr-2">RO {n.ro}</td>
                <td className="py-1 pr-2 font-mono">{n.part}</td>
                <td className="py-1 pr-2">{n.description}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{fmt$(n.cost)}</td>
                <td className="py-1 text-content-muted">{n.ordered_on}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function ItemsPanel({ month, monthRow, isAp, isStore, storeLocationId, onChanged, canCredit }) {
  const items = usePartsReconItems(month, isStore ? storeLocationId : null);
  // Mass credits (migration 91): which credit each item is on, and the entry screen.
  const batches = usePartsReconItemBatches(month, isStore ? storeLocationId : null);
  const batchOf = useMemo(() => new Map((batches.data ?? []).map((b) => [b.item_id, b])), [batches.data]);
  const [crediting, setCrediting] = useState(false);
  const notes = usePartsReconNotes(month, isStore ? storeLocationId : null);
  const [filter, setFilter] = useState(isAp ? "answered" : "open");
  const [store, setStore] = useState("");
  const [vendor, setVendor] = useState("");
  const [kind, setKind] = useState("");
  const [text, setText] = useState("");

  const all = items.data ?? [];
  const stores = useMemo(() => [...new Set(all.map((i) => i.recon_store))].sort(), [all]);
  const inStore = useMemo(() => (store ? all.filter((i) => i.recon_store === store) : all), [all, store]);
  const vendors = useMemo(() => [...new Set(inStore.map((i) => i.vendor))].sort(), [inStore]);
  const shown = useMemo(() => inStore.filter((i) =>
    (!vendor || i.vendor === vendor) && (!kind || i.kind === kind) && matchesFilter(i, filter) && matchesSearch(i, text)),
  [inStore, vendor, kind, filter, text]);
  const totals = useMemo(() => itemTotals(inStore), [inStore]);
  const groups = useMemo(() => groupItems(shown), [shown]);
  const reload = () => { items.reload(); batches.reload(); onChanged?.(); };
  const closed = !!monthRow?.closed_at;
  const LIMIT = 400;

  if (crediting) {
    return <MassCreditPanel defaultLocationId={isStore ? storeLocationId : ""} onClose={() => setCrediting(false)} onSubmitted={reload} />;
  }
  if (items.loading && !items.data) return <p className="text-sm text-content-muted">Loading items…</p>;
  if (items.error) return <Notice tone="error">{items.error}</Notice>;
  if (!all.length) return <Empty icon={PackageSearch} title="Nothing to answer for this month" hint="No store items were imported for your stores." />;

  let count = 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Items" value={totals.items} />
        <Stat label={isStore ? "Need your reply" : "Waiting on store"} value={totals.open} />
        <Stat label="Waiting on AP" value={totals.answered} />
        <Stat label="Amount in question" value={fmt$(totals.amount)} sub={totals.credited > 0 ? `${fmt$(totals.credited)} cleared` : null} />
        <Stat label="Left to deduct" value={fmt$(totals.left)} />
      </div>

      {isStore && !closed && (
        <Notice>
          RO costs can't be changed, so any part on a vendor invoice that isn't on the RO needs to be returned to the vendor.
          Open each item, send the credit # (or tell us which vendor or RO it belongs to) and attach the credit memo.
          Anything not resolved by month-end close is deducted from the store's gross profit.
        </Notice>
      )}
      {closed && <Notice tone="warn">This month is closed. What's left is the deduction.</Notice>}

      <div className="flex flex-wrap items-center gap-2">
        <Segmented options={isAp ? FILTERS_AP : FILTERS_STORE} value={filter} onChange={setFilter} />
        {!isStore && stores.length > 1 && (
          <select className={selectSm} value={store} onChange={(e) => { setStore(e.target.value); setVendor(""); }} aria-label="Store">
            <option value="">All stores ({stores.length})</option>
            {stores.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <select className={selectSm} value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Vendor">
          <option value="">All vendors</option>
          {vendors.map((v) => <option key={v} value={v}>{vendorLabel(v)}</option>)}
        </select>
        <select className={selectSm} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {Object.entries(KIND_LABEL).filter(([k]) => isAp || k !== "arm").map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-content-muted" />
          <input className={inputCls + " pl-8"} placeholder="RO #, invoice, vendor…" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {canCredit && (
          <GhostBtn onClick={() => setCrediting(true)} title="One credit invoice applied to every item it covers">
            <ReceiptText className="h-4 w-4" /> Enter a vendor credit
          </GhostBtn>
        )}
        {!isStore && (
          <GhostBtn onClick={() => exportItems(month, shown)} disabled={!shown.length}>
            <Download className="h-4 w-4" /> Excel
          </GhostBtn>
        )}
      </div>

      {!shown.length && <p className="text-sm text-content-muted">No items match.</p>}
      {groups.map((g) => (
        <div key={g.store} className="space-y-2">
          {(!isStore || stores.length > 1) && (
            <div className="flex items-baseline justify-between px-1">
              <h3 className="pgw-display text-sm font-bold text-content-primary">{g.store}</h3>
              <span className="text-xs text-content-muted">{g.totals.items} item(s) · {fmt$(g.totals.left)} left</span>
            </div>
          )}
          {g.vendors.map((v) => {
            if (count >= LIMIT) return null;
            const list = v.items.slice(0, Math.max(LIMIT - count, 0));
            count += list.length;
            return (
              <Card key={v.vendor} className="overflow-hidden">
                <div className="flex items-baseline justify-between border-b border-hairline bg-surface-page px-3 py-2">
                  <span className="text-sm font-semibold text-content-primary">{vendorLabel(v.vendor)}</span>
                  <span className="text-xs text-content-muted">
                    {v.totals.items} · {fmt$(v.totals.amount)} in question · {fmt$(v.totals.left)} left
                  </span>
                </div>
                {list.map((i) => (
                  <ItemRow key={i.id} item={i} month={month} isAp={isAp} monthClosed={closed} showStore={false} onChanged={reload} batch={batchOf.get(i.id)} />
                ))}
              </Card>
            );
          })}
        </div>
      ))}
      {count >= LIMIT && shown.length > LIMIT && (
        <p className="text-sm text-content-muted">Showing the first {LIMIT} of {shown.length}. Pick a store or vendor to narrow it.</p>
      )}
      <StockNotes notes={(notes.data ?? []).filter((n) => !store || n.recon_store === store)} />
    </div>
  );
}
