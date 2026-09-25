import React, { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CalendarDays, FileSpreadsheet, Info, Pencil, X } from "lucide-react";
import { useWhoSoldWhat } from "../../hooks/useWhoSoldWhat.js";
import { useAuth } from "../../context/AuthProvider.jsx";
import { buildWhoSoldWhat, tokenFor, CLOSE } from "../../lib/whoSoldWhat.js";
import { cellStyle } from "../../lib/scorecardRules.js";
import { Card, GhostBtn, PrimaryBtn } from "../ui.jsx";

// =====================================================================
// Who Sold What (migration 70) — Matt's service penetration report.
// Every number comes from lib/whoSoldWhat.js; colours are green at goal,
// amber from 75% of goal, red below, and a blank is never coloured.
// =====================================================================

const TOKEN_LABEL = { green: "At or above goal", yellow: "Close to goal", red: "Below goal" };

const pct0 = (v) => (v === null || v === undefined ? "" : `${Math.round(v * 100)}%`);
const pct1 = (v) => (v === null || v === undefined ? "" : `${(v * 100).toFixed(1)}%`);
const dec1 = (v) => (v === null || v === undefined ? "" : v.toFixed(1));
const int = (v) => (v === null || v === undefined ? "" : Math.round(v).toLocaleString());

const fmtFor = (measure) => (measure === "pct" ? pct0 : measure === "per_day" ? dec1 : int);
const goalText = (g) => (g.goal === null ? "" : g.measure === "pct" ? pct0(g.goal) : `${dec1(g.goal)}`);

const monthLabel = (ym) => {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
};

function Val({ value, goal, fmt, isTotal }) {
  const token = isTotal ? null : tokenFor(value, goal);
  const text = fmt(value);
  return (
    <span className="inline-block min-w-full rounded px-1.5 py-0.5" style={cellStyle(token)} title={token ? TOKEN_LABEL[token] : undefined}>
      {text === "" && !isTotal ? <span className="text-content-muted">·</span> : text}
    </span>
  );
}

function Delta({ value }) {
  if (value === null || value === undefined) return <span className="text-content-muted">·</span>;
  const pts = value * 100;
  if (Math.abs(pts) < 0.05) return <span className="text-content-muted">0.0 pts</span>;
  const up = pts > 0;
  return (
    <span className={"inline-flex items-center gap-0.5 whitespace-nowrap " + (up ? "text-success" : "text-danger")}
      title={up ? "Higher than last month" : "Lower than last month"}>
      {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(pts).toFixed(1)} pts
    </span>
  );
}

function StoreName({ row }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-content-primary">
      {row.fill && !row.isTotal && (
        <span aria-hidden="true" className="inline-block h-3 w-3 flex-shrink-0 rounded-sm border border-hairline"
          style={{ backgroundColor: `#${row.fill}` }} />
      )}
      {row.name}
    </span>
  );
}

function SectionTable({ sec, report }) {
  const avgLabel = `Avg of ${sec.avgCount}`;
  const line = (row, key, cls = "") => {
    const v = row.cur;
    return (
      <tr key={key} className={cls}>
        <td className="sticky left-0 z-10 bg-inherit px-2 py-1 text-left"><StoreName row={row} /></td>
        <td className="px-1 py-1">{v ? int(v.cars) : <span className="text-content-muted">·</span>}</td>
        {sec.cols.map((c) => (
          <td key={c.service_key} className="px-1 py-1">
            <Val value={v?.values[c.service_key] ?? null} goal={c.goal} fmt={fmtFor(c.measure)} isTotal={row.isTotal} />
          </td>
        ))}
        <td className="border-l border-hairline px-1 py-1 font-semibold">
          <Val value={v?.avg[sec.section] ?? null} goal={sec.avgGoal} fmt={pct1} isTotal={row.isTotal} />
        </td>
        <td className="px-2 py-1">{row.isTotal ? "" : (row.rank?.[sec.section] ?? <span className="text-content-muted">·</span>)}</td>
        <td className="px-2 py-1"><Delta value={row.delta?.[sec.section]} /></td>
      </tr>
    );
  };
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-hairline px-4 py-2.5">
        <h3 className="pgw-display text-sm font-bold text-content-primary">{sec.title}</h3>
        <p className="text-[11px] text-content-muted">
          % of cars, against each service's goal. {avgLabel} ={" "}
          {sec.cols.filter((c) => c.in_average).map((c) => c.label).join(", ")}; ranked across every store shown.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-right text-xs">
          <thead className="bg-surface-overlay text-[11px] text-content-secondary">
            <tr>
              <th className="sticky left-0 z-20 bg-surface-overlay px-2 py-2 text-left font-medium">Store</th>
              <th className="px-2 py-2 font-medium">Cars</th>
              {sec.cols.map((c) => <th key={c.service_key} className="whitespace-nowrap px-2 py-2 font-medium">{c.label}</th>)}
              <th className="whitespace-nowrap border-l border-hairline px-2 py-2 font-medium">{avgLabel}</th>
              <th className="px-2 py-2 font-medium">Rank</th>
              <th className="whitespace-nowrap px-2 py-2 font-medium">vs {monthLabel(report.prevMonth).split(" ")[0]}</th>
            </tr>
            <tr className="text-[10px] text-content-muted">
              <th className="sticky left-0 z-20 bg-surface-overlay px-2 pb-1.5 text-left font-normal">Goal</th>
              <th />
              {sec.cols.map((c) => (
                <th key={c.service_key} className="px-2 pb-1.5 font-normal">
                  {goalText(c)}{c.measure === "per_day" && c.goal !== null ? "/day" : ""}
                </th>
              ))}
              <th className="border-l border-hairline px-2 pb-1.5 font-normal">{sec.avgGoal === null ? "" : pct1(sec.avgGoal)}</th>
              <th /><th />
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline bg-surface-card">
            {report.built.groups.map((g) => (
              <React.Fragment key={g.market.id}>
                {g.rows.map((r) => line(r, r.id, "hover:bg-surface-overlay"))}
                {report.built.groups.length > 1 && line({ ...g.total, name: g.total.name }, "t-" + g.market.id, "bg-surface-page font-semibold")}
              </React.Fragment>
            ))}
            {line(report.built.total, "total", "bg-surface-overlay font-semibold")}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function GoalsEditor({ goals, onSave, onClose }) {
  const editable = goals.filter((g) => g.measure !== "count").sort((a, b) => a.section - b.section || a.sort_order - b.sort_order);
  const [draft, setDraft] = useState(() => Object.fromEntries(editable.map((g) => [
    g.service_key, g.goal === null ? "" : g.measure === "pct" ? String(+(g.goal * 100).toFixed(2)) : String(g.goal),
  ])));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    setBusy(true); setMsg(null);
    for (const g of editable) {
      const raw = draft[g.service_key].trim();
      const val = raw === "" ? null : Number(raw);
      if (raw !== "" && (!Number.isFinite(val) || val < 0)) { setBusy(false); return setMsg(`${g.label}: enter a number, or leave it blank for no goal.`); }
      const goal = val === null ? null : g.measure === "pct" ? +(val / 100).toFixed(4) : val;
      if (goal === g.goal) continue;
      const err = await onSave(g.service_key, goal);
      if (err) { setBusy(false); return setMsg(`${g.label}: ${err.message}`); }
    }
    setBusy(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Who Sold What goals">
      <Card className="max-h-[85vh] w-full max-w-md overflow-y-auto p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="pgw-display text-sm font-bold text-content-primary">Who Sold What goals</h3>
          <button onClick={onClose} className="text-content-muted hover:text-content-primary" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <p className="mb-3 text-xs text-content-muted">
          % of cars, except LOF + Premium (oil changes per day). Blank = no goal (the column is not coloured). Changes apply for everyone.
        </p>
        {[1, 2, 3].map((s) => (
          <div key={s} className="mb-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-content-secondary">
              {({ 1: "Low Hanging Fruit", 2: "Flushes", 3: "Tires & Repairs" })[s]}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {editable.filter((g) => g.section === s).map((g) => (
                <label key={g.service_key} className="flex items-center justify-between gap-2 rounded border border-hairline px-2 py-1 text-xs text-content-primary">
                  {g.label}
                  <span className="flex items-center gap-1">
                    <input className="w-14 rounded border border-hairline-strong bg-surface-input px-1 py-0.5 text-right text-xs"
                      inputMode="decimal" value={draft[g.service_key]}
                      onChange={(e) => setDraft((d) => ({ ...d, [g.service_key]: e.target.value }))} />
                    <span className="w-6 text-content-muted">{g.measure === "pct" ? "%" : "/day"}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
        {msg && <p className="mb-2 rounded border border-danger-border bg-danger-tint px-2 py-1 text-xs text-danger">{msg}</p>}
        <div className="flex justify-end gap-2">
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <PrimaryBtn onClick={save} disabled={busy}>{busy ? "Saving…" : "Save goals"}</PrimaryBtn>
        </div>
      </Card>
    </div>
  );
}

export function WhoSoldWhatView() {
  const w = useWhoSoldWhat();
  const { role } = useAuth();
  const [marketId, setMarketId] = useState("");
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const canEdit = role === "admin" || role === "master";

  const report = useMemo(() => {
    if (!w.data) return null;
    return {
      ...w.data,
      built: buildWhoSoldWhat(w.data.stores, w.data.markets, w.data.goals, { marketId: marketId || null }),
    };
  }, [w.data, marketId]);

  const doExport = async () => {
    setExporting(true); setExportError(null);
    try {
      const { downloadWhoSoldWhatWorkbook } = await import("../../lib/whoSoldWhatWorkbook.js");
      await downloadWhoSoldWhatWorkbook(report);
    } catch (e) {
      setExportError(e.message ?? String(e));
    }
    setExporting(false);
  };

  const marketsShown = (w.data?.markets ?? []).filter((m) => w.data.stores.some((s) => s.marketId === m.id));

  return (
    <div className="space-y-4">
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-xs text-content-secondary">
            <CalendarDays className="h-4 w-4" /> Month
            <input type="month" value={w.month ?? ""} onChange={(e) => e.target.value && w.setMonth(e.target.value)}
              className="rounded-md border border-hairline-strong bg-surface-input px-2 py-1 text-sm text-content-primary" />
          </label>
          <select value={marketId} onChange={(e) => setMarketId(e.target.value)} aria-label="Market"
            className="rounded-md border border-hairline-strong bg-surface-input px-2 py-1.5 text-sm text-content-primary">
            <option value="">All markets</option>
            {marketsShown.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <div className="ml-auto flex items-center gap-2">
            {canEdit && (
              <GhostBtn onClick={() => setEditing(true)} disabled={!w.data}>
                <Pencil className="h-4 w-4" /> Goals
              </GhostBtn>
            )}
            <GhostBtn onClick={doExport} disabled={!report || exporting}>
              <FileSpreadsheet className="h-4 w-4" /> {exporting ? "Building…" : "Export to Excel"}
            </GhostBtn>
          </div>
        </div>
      </Card>

      {w.error && (
        <p className="flex items-center gap-2 rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">
          <AlertTriangle className="h-4 w-4" /> {w.error}
        </p>
      )}
      {exportError && <p className="rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{exportError}</p>}

      {report && (
        <p className={"flex items-start gap-2 rounded-md border px-3 py-2 text-xs " +
          (report.built.enteredCount < report.built.storeCount ? "border-warning-border bg-warning-tint text-warning" : "border-hairline bg-surface-overlay text-content-secondary")}>
          <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            <strong>{report.built.enteredCount} of {report.built.storeCount} stores</strong> have tic sheets for {monthLabel(report.month)}.
            {report.built.enteredCount < report.built.storeCount && " A store with none shows a dot, not a zero, and is not ranked."}
            {" "}Green is at goal, amber from {Math.round(CLOSE * 100)}% of goal, red below. Compared with {monthLabel(report.prevMonth)}.
          </span>
        </p>
      )}

      {w.loading && <p className="text-sm text-content-secondary">Loading…</p>}
      {report && !w.loading && report.built.sections.map((sec) => <SectionTable key={sec.section} sec={sec} report={report} />)}

      {editing && w.data && <GoalsEditor goals={w.data.goals} onSave={w.saveGoal} onClose={() => setEditing(false)} />}
    </div>
  );
}
