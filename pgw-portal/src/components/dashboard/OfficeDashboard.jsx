import React, { useEffect, useMemo, useState } from "react";
import { Banknote, FileSpreadsheet } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
import { supabase } from "../../lib/supabaseClient.js";
import { revenueStores } from "../../lib/homeOffice.js";
import { computeTotals } from "../../lib/drawerMath.js";
import { money } from "../../lib/format.js";
import { addDays, todayStr } from "../../lib/scheduleMath.js";
import { Card, Empty, GhostBtn, SectionHeader } from "../ui.jsx";
import { ExportRangeModal } from "../ExportRangeModal.jsx";

// How far back "latest closeout" looks. A store with nothing in this window
// shows as "none in N days" rather than a stale date.
const LOOKBACK_DAYS = 30;

const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);

// The Dashboard for the office role (migration 78). The regular one is
// built around payroll -- hours this week, payroll % of sales -- which this
// role must not see, so it gets its own: the closeout export admins have,
// and every store's latest closeout so a missing one stands out.
export function OfficeDashboard({ onNavigate }) {
  const { stores: allStores, setSelectedStoreId } = useAuth();
  const stores = useMemo(() => revenueStores(allStores), [allStores]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const today = todayStr();

  useEffect(() => {
    let live = true;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from("cash_drawer_closeouts")
        .select("*")
        .gte("business_date", addDays(today, -LOOKBACK_DAYS))
        .order("business_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (!live) return;
      setError(err ? err.message : null);
      setRows(data ?? []);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [today]);

  // One line per store: its newest closeout in the window, or none.
  const latest = useMemo(() => {
    const byStore = {};
    for (const r of rows) if (!byStore[r.location_id]) byStore[r.location_id] = r;
    return [...stores]
      .sort((a, b) => String(a.store_number).localeCompare(String(b.store_number), undefined, { numeric: true }))
      .map((s) => {
        const r = byStore[s.id];
        return { store: s, record: r, totals: r ? computeTotals(r, s.drawer_float) : null, age: r ? daysBetween(r.business_date, today) : null };
      });
  }, [rows, stores, today]);

  const missing = latest.filter((l) => !l.record || l.age > 1).length;

  const openStore = (id) => {
    setSelectedStoreId(id);
    onNavigate("drawer");
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Dashboard"
        subtitle={`Cash drawer closeouts · all ${stores.length} stores · read-only`}
        action={
          <GhostBtn onClick={() => setRangeOpen(true)}>
            <FileSpreadsheet className="h-4 w-4" /> Closeouts (Excel)
          </GhostBtn>
        }
      />

      {error && (
        <p className="rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>
      )}

      <Card className="overflow-x-auto">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4">
          <h3 className="pgw-display text-sm font-bold text-content-primary">Latest closeout by store</h3>
          {!loading && (
            <p className="text-xs text-content-muted">
              {missing === 0 ? "Every store is up to date." : `${missing} store${missing === 1 ? "" : "s"} without a closeout for yesterday or today.`}
              {" "}Click a store to open its Cash Drawer.
            </p>
          )}
        </div>
        {loading ? (
          <p className="px-4 py-6 text-center text-sm text-content-muted">Loading…</p>
        ) : latest.length === 0 ? (
          <Empty icon={Banknote} title="No stores" hint="No stores are visible to this login." />
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="bg-surface-overlay text-left text-xs uppercase tracking-wide text-content-secondary">
              <tr>
                <th className="px-4 py-2">Store</th>
                <th className="px-4 py-2">Last closeout</th>
                <th className="px-4 py-2">Deposit</th>
                <th className="px-4 py-2">Over / Short</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {latest.map(({ store: s, record: r, totals: t, age }) => (
                <tr key={s.id} className="cursor-pointer odd:bg-surface-stripe hover:bg-surface-overlay" onClick={() => openStore(s.id)}>
                  <td className="px-4 py-2.5 text-content-primary">
                    <span className="font-medium">#{s.store_number}</span> · {s.name}
                  </td>
                  <td className={"px-4 py-2.5 " + (!r || age > 1 ? "font-semibold text-warning" : "text-content-secondary")}>
                    {!r ? `None in ${LOOKBACK_DAYS} days` : `${r.business_date}${age === 0 ? " · today" : age === 1 ? " · yesterday" : ` · ${age} days ago`}`}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-content-primary">{t ? money(t.storeDeposit) : "—"}</td>
                  <td className={"px-4 py-2.5 font-semibold " + (!t ? "text-content-muted" : t.diff < 0 ? "text-danger" : t.diff > 0 ? "text-success" : "text-content-muted")}>
                    {t ? money(t.diff) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {rangeOpen && <ExportRangeModal storeCount={stores.length} onClose={() => setRangeOpen(false)} />}
    </div>
  );
}
