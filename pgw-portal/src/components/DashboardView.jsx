import React, { useState } from "react";
import { Banknote, Clock, FileSpreadsheet } from "lucide-react";
import { useAuth } from "../context/AuthProvider.jsx";
import { useDashboard } from "../hooks/useDashboard.js";
import { computeTotals } from "../lib/drawerMath.js";
import { money } from "../lib/format.js";
import { weekLabel } from "../lib/weekUtils.js";
import { Card, GhostBtn, SectionHeader } from "./ui.jsx";
import { ExportRangeModal } from "./ExportRangeModal.jsx";
import { PayrollToSalesCard } from "./payroll/PayrollToSalesCard.jsx";

function StatCard({ label, value, sub, tone }) {
  const toneCls = tone === "pos" ? "text-success" : tone === "neg" ? "text-danger" : "text-content-primary";
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-content-secondary">{label}</p>
      <p className={"pgw-display mt-1 text-2xl font-bold " + toneCls}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-content-muted">{sub}</p>}
    </Card>
  );
}

export function DashboardView({ store, onNavigate }) {
  const { stores } = useAuth();
  const {
    latestDrawer, weekRows, docCount, week, cutover, isDaily, payrollToSales, loading, error,
  } = useDashboard(store.id);
  const [rangeOpen, setRangeOpen] = useState(false);
  const canExportRange = (stores?.length ?? 0) > 1;

  const totals = latestDrawer ? computeTotals(latestDrawer, store.drawer_float) : null;
  // Hours arrive from payroll_week_hours already summed per employee and
  // already resolved across the cutover — daily rows from the cutover,
  // the frozen weekly columns before it.
  const wkHours = weekRows.reduce((a, r) => a + (Number(r.total_hours) || 0), 0);
  const turned = weekRows.reduce((a, r) => a + (Number(r.total_turned) || 0), 0);
  const round1 = (n) => (n ? Math.round(n * 100) / 100 : 0);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Dashboard"
        subtitle={store.name}
        action={
          canExportRange && (
            <GhostBtn onClick={() => setRangeOpen(true)}>
              <FileSpreadsheet className="h-4 w-4" /> Export all stores' closeouts (Excel)
            </GhostBtn>
          )
        }
      />

      {error && (
        <p className="rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>
      )}

      {loading ? (
        <p className="px-1 py-6 text-center text-sm text-content-muted">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Over / Short"
              value={totals ? money(totals.diff) : "—"}
              sub={latestDrawer ? latestDrawer.business_date : "None yet"}
              tone={!totals ? "" : totals.diff < 0 ? "neg" : totals.diff > 0 ? "pos" : ""}
            />
            <StatCard label="Hours this week" value={round1(wkHours) || "—"} sub={week ? weekLabel(week, cutover) : ""} />
            <StatCard label="Hours turned" value={round1(turned) || "—"} sub="This week" />
            <StatCard label="Documents" value={docCount || "—"} sub="On file" />
          </div>

          <PayrollToSalesCard data={payrollToSales} onNavigate={onNavigate} isDaily={isDaily} cutover={cutover} />

          <Card className="p-5">
            <h3 className="pgw-display mb-3 text-sm font-bold text-content-primary">Recent activity</h3>
            <ul className="space-y-2 text-sm">
              {latestDrawer && (
                <li className="flex items-center gap-2 text-content-secondary">
                  <Banknote className="h-4 w-4 text-content-muted" />
                  Drawer counted {latestDrawer.business_date} — deposit {money(totals.storeDeposit)}, over/short {money(totals.diff)}
                </li>
              )}
              {weekRows.length > 0 && (
                <li className="flex items-center gap-2 text-content-secondary">
                  <Clock className="h-4 w-4 text-content-muted" />
                  {weekRows.length} employee{weekRows.length === 1 ? "" : "s"} logged for week of {weekLabel(week, cutover)}
                </li>
              )}
              {!latestDrawer && weekRows.length === 0 && (
                <li className="text-content-muted">No activity recorded for this store yet.</li>
              )}
            </ul>
          </Card>
        </>
      )}

      {rangeOpen && <ExportRangeModal storeCount={stores.length} onClose={() => setRangeOpen(false)} />}
    </div>
  );
}
