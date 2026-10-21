import React, { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Info, X } from "lucide-react";
import { useGpBudget } from "../../hooks/useGpBudget.js";
import { Card } from "../ui.jsx";
import { buildGpBudget, trackTone } from "../../lib/gpBudget.js";
import { pct } from "../../lib/format.js";

// =====================================================================
// GP vs Budget — the year's gross profit against the full-year GP budget,
// projected at the current daily pace, by region (Lead) and district
// (Division), with each division's months on budget. Every number comes
// from lib/gpBudget.js.
// =====================================================================

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const usd = (v) => (v == null ? "" : `${v < 0 ? "-" : ""}$${Math.round(Math.abs(v)).toLocaleString()}`);
const toneCls = (t) => ({ over: "text-success", low: "text-danger" })[trackTone(t)] ?? "";

function VsBudget({ track }) {
  if (track == null) return <span className="text-content-muted">—</span>;
  return track >= 1
    ? <span className="inline-flex items-center gap-1 text-success"><ArrowUp className="h-3 w-3" /> Over</span>
    : <span className="inline-flex items-center gap-1 text-danger"><ArrowDown className="h-3 w-3" /> Under</span>;
}

function Tile({ label, value, hint }) {
  return (
    <Card className="p-3">
      <p className="text-[11px] text-content-secondary">{label}</p>
      <p className="pgw-display mt-1 text-xl font-bold text-accent tabular-nums">{value}</p>
      <p className="text-[11px] text-content-muted">{hint}</p>
    </Card>
  );
}

function Cells({ r }) {
  return (
    <>
      <td className="px-2 py-1 text-right tabular-nums">{r.budget == null ? <span className="text-content-muted">No budget</span> : usd(r.budget)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{r.ytd == null ? <span className="text-content-muted">Not entered</span> : usd(r.ytd)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{usd(r.daily)}</td>
      <td className="px-2 py-1 text-right tabular-nums">{usd(r.proj)}</td>
      <td className={"px-2 py-1 text-right tabular-nums " + toneCls(r.track)}>{r.track == null ? "—" : pct(r.track)}</td>
      <td className="px-2 py-1 text-right"><VsBudget track={r.track} /></td>
    </>
  );
}

function TotalRow({ t, strong }) {
  return (
    <tr className={"border-y border-accent/40 font-semibold " + (strong ? "bg-accent/15" : "bg-surface-overlay")}>
      <td colSpan={3} className="whitespace-nowrap px-2 py-1 text-right text-warning">◆ {t.label}</td>
      <Cells r={t} />
    </tr>
  );
}

function MonthCell({ c }) {
  if (c.state === "future") return <td className="px-1 py-1 text-center text-content-muted">·</td>;
  if (c.state === "none") return <td className="px-1 py-1 text-center text-content-muted" title="Nothing entered">—</td>;
  const hit = c.state === "hit";
  return (
    <td className="px-1 py-1 text-center" title={`GP ${usd(c.gp)} vs budget ${usd(c.budget)}`}>
      {hit ? <Check className="mx-auto h-3.5 w-3.5 text-success" /> : <X className="mx-auto h-3.5 w-3.5 text-danger" />}
    </td>
  );
}

function GridRow({ label, g, strong }) {
  return (
    <tr className={strong ? "bg-surface-overlay font-semibold" : ""}>
      <td className="whitespace-nowrap px-2 py-1">{label}</td>
      {g.cells.map((c) => <MonthCell key={c.month} c={c} />)}
      <td className={"whitespace-nowrap px-2 py-1 text-right font-semibold tabular-nums " + (g.hits === g.done && g.done ? "text-success" : g.hits === 0 && g.done ? "text-danger" : "")}>
        {g.hits} of {g.done}
      </td>
    </tr>
  );
}

export function GpBudgetView() {
  const r = useGpBudget();
  const [speedee, setSpeedee] = useState(false);
  const report = useMemo(() => (r.raw ? buildGpBudget(r.raw, { includeSpeedee: speedee }) : null), [r.raw, speedee]);
  const throughLabel = r.month === r.thisMonth && r.raw ? `${LONG[r.month - 1]} ${Number(r.raw.through.slice(8))}` : LONG[r.month - 1];

  return (
    <div className="space-y-4">
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-content-secondary">
            Through
            <select value={r.month} onChange={(e) => r.setMonth(Number(e.target.value))}
              className="rounded-md border border-hairline-strong bg-surface-input px-2 py-1.5 text-sm text-content-primary outline-none focus:border-accent">
              {MONTHS.slice(0, r.thisMonth).map((m, i) => (
                <option key={m} value={i + 1}>{LONG[i]} {r.year}{i + 1 === r.thisMonth ? " (to date)" : ""}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-content-secondary">
            <input type="checkbox" checked={speedee} onChange={(e) => setSpeedee(e.target.checked)} className="accent-[var(--accent)]" />
            Include SpeeDee
          </label>
        </div>
      </Card>

      {r.error && (
        <p className="flex items-center gap-2 rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">
          <AlertTriangle className="h-4 w-4" /> {r.error}
        </p>
      )}
      {r.loading && <p className="text-sm text-content-secondary">Loading…</p>}

      {report && !r.loading && (
        <>
          <h2 className="pgw-display text-lg font-bold text-content-primary">
            {r.year} Gross Profit vs Budget — Through {throughLabel}
          </h2>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Total Budget" value={usd(report.total.budget)} hint="Full year" />
            <Tile label="GP Tracked" value={usd(report.total.ytd)} hint="YTD actual" />
            <Tile label="Projected Full Yr" value={usd(report.total.proj)} hint="At current pace" />
            <Tile label="Tracking %" value={report.total.track == null ? "—" : pct(report.total.track)} hint="vs budget" />
          </div>

          {(report.withGp < report.storeCount || report.withBudget < report.storeCount) && (
            <p className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-tint px-3 py-2 text-xs text-warning">
              <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span>
                {report.withGp} of {report.storeCount} stores have GP entered and {report.withBudget} have a {r.year} budget.
                {" "}A store with no budget is left out of its division's Tracking %.
              </span>
            </p>
          )}

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-content-primary">
                <thead className="bg-surface-overlay text-[11px] text-accent">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-semibold">Lead</th>
                    <th className="px-2 py-1.5 text-left font-semibold">Division</th>
                    <th className="px-2 py-1.5 text-left font-semibold">Store</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Budget</th>
                    <th className="whitespace-nowrap px-2 py-1.5 text-right font-semibold">YTD GP $</th>
                    <th className="whitespace-nowrap px-2 py-1.5 text-right font-semibold">Daily GP $</th>
                    <th className="whitespace-nowrap px-2 py-1.5 text-right font-semibold">Proj. Full Yr</th>
                    <th className="whitespace-nowrap px-2 py-1.5 text-right font-semibold">Track %</th>
                    <th className="whitespace-nowrap px-2 py-1.5 text-right font-semibold">vs Budget</th>
                  </tr>
                </thead>
                <tbody>
                  {report.leads.map((L) => (
                    <React.Fragment key={L.id}>
                      {L.divisions.map((D) => (
                        <React.Fragment key={D.id}>
                          {D.stores.map((s, i) => (
                            <tr key={s.id} className="hover:bg-surface-overlay">
                              <td className="whitespace-nowrap px-2 py-1 font-semibold text-accent">{i === 0 ? L.name : ""}</td>
                              <td className="whitespace-nowrap px-2 py-1 text-accent">{i === 0 ? D.name : ""}</td>
                              <td className="whitespace-nowrap px-2 py-1 font-medium" title={`#${s.storeNumber}`}>{s.name}</td>
                              <Cells r={s} />
                            </tr>
                          ))}
                          <TotalRow t={D.total} />
                        </React.Fragment>
                      ))}
                      {L.divisions.length > 1 && <TotalRow t={L.total} strong />}
                    </React.Fragment>
                  ))}
                  {report.leads.length > 1 && <TotalRow t={report.total} strong />}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <h3 className="px-3 pb-1 pt-3 text-sm font-bold text-content-primary">Months on budget</h3>
            <p className="px-3 pb-2 text-[11px] text-content-muted">
              Each finished month's GP against that month's budget. ✓ made it, ✗ missed, — nothing entered.
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-content-primary">
                <thead className="bg-surface-overlay text-[11px] text-content-secondary">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">Division</th>
                    {MONTHS.map((m) => <th key={m} className="px-1 py-1.5 text-center font-medium">{m}</th>)}
                    <th className="px-2 py-1.5 text-right font-medium">Made</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {report.leads.flatMap((L) => L.divisions).map((D) => <GridRow key={D.id} label={D.name} g={D.grid} />)}
                  <GridRow label="PGW" g={report.grid} strong />
                </tbody>
              </table>
            </div>
          </Card>

          <p className="text-[11px] italic text-content-muted">
            Data through {r.raw.through} · {r.raw.elapsed} of {r.raw.yearDays} open days (Mon–Sat, less holidays) ·
            Tracking = projected full year at the current daily pace ÷ full-year GP budget
          </p>
        </>
      )}
    </div>
  );
}
