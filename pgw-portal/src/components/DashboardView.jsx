import React from "react";
import { Banknote, Clock } from "lucide-react";
import { useDashboard } from "../hooks/useDashboard.js";
import { computeTotals } from "../lib/drawerMath.js";
import { money } from "../lib/format.js";
import { thisWeekStart, weekLabel } from "../lib/weekUtils.js";
import { Card, SectionHeader } from "./ui.jsx";

function StatCard({ label, value, sub, tone }) {
  const toneCls = tone === "pos" ? "text-emerald-400" : tone === "neg" ? "text-red-400" : "text-white";
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className={"pgw-display mt-1 text-2xl font-bold " + toneCls}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

export function DashboardView({ store }) {
  const { latestDrawer, weekRows, docCount, loading, error } = useDashboard(store.id);

  const totals = latestDrawer ? computeTotals(latestDrawer, store.drawer_float) : null;
  const wkHours = weekRows.reduce(
    (a, r) => a + (Number(r.clock_hours_other) || 0) + (Number(r.clock_hours) || 0), 0
  );
  const turned = weekRows.reduce(
    (a, r) => a + (Number(r.hrs_turned_other) || 0) + (Number(r.hrs_turned_here) || 0), 0
  );
  const week = thisWeekStart();

  return (
    <div className="space-y-4">
      <SectionHeader title="Dashboard" subtitle={store.name} />

      {error && (
        <p className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      {loading ? (
        <p className="px-1 py-6 text-center text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Over / Short"
              value={totals ? money(totals.diff) : "—"}
              sub={latestDrawer ? latestDrawer.business_date : "None yet"}
              tone={!totals ? "" : totals.diff < 0 ? "neg" : totals.diff > 0 ? "pos" : ""}
            />
            <StatCard label="Hours this week" value={wkHours || "—"} sub={weekLabel(week)} />
            <StatCard label="Hours turned" value={turned || "—"} sub="This week" />
            <StatCard label="Documents" value={docCount || "—"} sub="On file" />
          </div>

          <Card className="p-5">
            <h3 className="pgw-display mb-3 text-sm font-bold text-white">Recent activity</h3>
            <ul className="space-y-2 text-sm">
              {latestDrawer && (
                <li className="flex items-center gap-2 text-slate-300">
                  <Banknote className="h-4 w-4 text-slate-500" />
                  Drawer counted {latestDrawer.business_date} — deposit {money(totals.storeDeposit)}, over/short {money(totals.diff)}
                </li>
              )}
              {weekRows.length > 0 && (
                <li className="flex items-center gap-2 text-slate-300">
                  <Clock className="h-4 w-4 text-slate-500" />
                  {weekRows.length} employee{weekRows.length === 1 ? "" : "s"} logged for week of {weekLabel(week)}
                </li>
              )}
              {!latestDrawer && weekRows.length === 0 && (
                <li className="text-slate-500">No activity recorded for this store yet.</li>
              )}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
