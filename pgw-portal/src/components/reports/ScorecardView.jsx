import React, { useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, FileSpreadsheet, Info } from "lucide-react";
import { useScorecard } from "../../hooks/useScorecard.js";
import { PRESETS, buildMarkets, buildScorecard, buildTires, sortRows } from "../../lib/scorecard.js";
import { cellStyle, evaluate } from "../../lib/scorecardRules.js";
import { Card, GhostBtn } from "../ui.jsx";

// =====================================================================
// Matt's daily reports on screen: Report 1 (Daily Scorecard), Report 2
// (Market Summary), Report 5 (Tire Contest) and the five presets that
// sort or filter them. Column order and headers follow his workbook; the
// numbers come from lib/scorecard.js and every colour from
// lib/scorecardRules.js -- the same rules the Excel export writes.
// =====================================================================

// Named on hover, so colour is never the only signal (Matt's gold and
// yellow are nearly the same shade; they never share a column).
const TOKEN_LABEL = { green: "On or above target", red: "Below target", yellow: "Close to target",
  gold: "Gold tier", silver: "Silver tier", bronze: "Bronze tier" };

const $ = (v) => (v === null || v === undefined ? "" : v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const pct = (v) => (v === null || v === undefined ? "" : `${Math.round(v * 100)}%`);
const d1 = (v) => (v === null || v === undefined ? "" : v.toFixed(1));
const int = (v) => (v === null || v === undefined ? "" : Math.round(v).toLocaleString());

// Report 1 in Matt's column order (Current Month A–AD, minus his empty
// spacer columns and the empty "% of Sales"; Battery shows only when a
// store has counted batteries this month).
const R1_COLS = [
  ["dailyGp", "Daily GP", $], ["dailyGold", "Daily Gold", $], ["dailySilver", "Daily Silver", $], ["dailyBronze", "Daily Bronze", $],
  ["dailySales", "Daily Sales Budget", $], ["name", "Store", null],
  ["cars", "Cars", int], ["estPerCar", "Est/Car", $], ["aro", "ARO", $], ["capture", "Sales Capture %", pct],
  ["battery", "Battery Contest MTD", int],
  ["sales", "Sales", $], ["gp", "Total GP $", $], ["gpPct", "Total GP%", pct],
  ["mtdSales", "MTD Sales", $], ["mtdGp", "MTD GP", $], ["projGp", "Projected Monthly GP", $],
  ["salesBudget", "Sales Budget", $], ["salesProj", "Sales Projection", $], ["pctOfGoal", "% of goal", pct],
  ["pySales", "2025 Sales", $], ["vs2025", "vs 2025", $],
  ["gpBudget", "GP Budget", $], ["goldGp", "Gold GP", $], ["silverGp", "Silver GP", $], ["bronzeGp", "Bronze GP", $],
  ["salesGoalToday", "Sales Goal Today", $],
];
const R2_COLS = [
  ["gpBudget", "GP Budget", $], ["name", "Market", null],
  ["carsPerDayPerStore", "MTD Cars/Day per Store", d1], ["carsVs2025", "Cars vs 2025", d1],
  ["weeklyGoalPerStore", "Weekly Sales Goal per Store", $], ["weeklyProjPerStore", "Weekly Projection per Store", $],
  ["weeklyProjVs2025", "Projection vs 2025", pct],
  ["gpYesterdayPerStore", "Daily GP $ Yesterday per Store", $], ["pctOfBudget", "% of Budget", pct],
  ["projGp", "Projected Monthly GP", $], ["goldGp", "Gold", $], ["silverGp", "Silver", $], ["bronzeGp", "Bronze", $],
  ["pctToBudget", "% to Budget", pct],
];
const R5_COLS = [
  ["pySold", "2025 Sold", int], ["mtd", "MTD", int], ["monthGoal", "Month Tire Goal", int], ["dailyGoal", "Daily Goal", d1],
  ["name", "Store", null], ["tiresYest", "Tires Yest", int], ["alignYest", "Align Yest", int],
  ["tiresPerDay", "Monthly Tires/Day", d1], ["mtdProjection", "MTD Projection", int], ["projVsLy", "Projection vs LY", int],
  ["payout", "AM Payout", $], ["vs2025", "Sales Proj vs 25", $], ["carsVs2025", "Cars/Day vs 2025", d1],
];

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

function Table({ report, cols, rows, footer = [], settings, hidden = new Set() }) {
  const shown = cols.filter(([k]) => !hidden.has(k));
  const cell = (row, [key, , fmt]) => {
    if (key === "name") return <StoreName row={row} />;
    const token = row.isTotal ? null : evaluate(report, key, row, settings);
    const text = fmt(row[key] ?? null);
    return (
      <span className="inline-block min-w-full rounded px-1.5 py-0.5" style={cellStyle(token)} title={token ? TOKEN_LABEL[token] : undefined}>
        {text === "" && !row.isTotal ? <span className="text-content-muted">·</span> : text}
      </span>
    );
  };
  return (
    <div className="overflow-x-auto rounded-lg border border-hairline">
      <table className="min-w-full text-right text-xs">
        <thead className="bg-surface-overlay text-[11px] text-content-secondary">
          <tr>
            {shown.map(([k, label]) => (
              <th key={k} className={"whitespace-nowrap px-2 py-2 font-medium " + (k === "name" ? "text-left" : "")}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((r) => (
            <tr key={r.id ?? r.marketId ?? r.name} className="hover:bg-surface-overlay">
              {shown.map((c) => (
                <td key={c[0]} className={"px-1 py-1 " + (c[0] === "name" ? "text-left" : "")}>{cell(r, c)}</td>
              ))}
            </tr>
          ))}
          {footer.map((r) => (
            <tr key={"t-" + r.name} className="bg-surface-page font-semibold">
              {shown.map((c) => (
                <td key={c[0]} className={"px-1 py-1 " + (c[0] === "name" ? "text-left" : "")}>{cell(r, c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TABS = [["scorecard", "Daily Scorecard"], ["markets", "Market Summary"], ["tires", "Tire Contest"]];

export function ScorecardView() {
  const s = useScorecard();
  const [tab, setTab] = useState("scorecard");
  const [sortKey, setSortKey] = useState(null);
  const [activePreset, setActivePreset] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  const built = useMemo(() => {
    if (!s.data) return null;
    const { facts, markets, ctx } = s.data;
    const scorecard = buildScorecard(facts, ctx);
    return {
      scorecard,
      markets: buildMarkets(scorecard.rows, markets, ctx),
      tires: buildTires(scorecard.rows, markets, ctx),
      settings: ctx.settings,
      hasBonus: !!ctx.brackets,
    };
  }, [s.data]);

  const applyPreset = (p) => {
    setActivePreset(p.key);
    setTab(p.report);
    setSortKey(p.sort ?? null);
  };
  const pickTab = (t) => { setTab(t); setSortKey(null); setActivePreset(null); };

  const doExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const { downloadScorecardWorkbook } = await import("../../lib/scorecardWorkbook.js");
      await downloadScorecardWorkbook({ built, reportDate: s.reportDate, ctx: s.data.ctx });
    } catch (e) {
      setExportError(e.message ?? String(e));
    }
    setExporting(false);
  };

  const batteryEmpty = built ? built.scorecard.rows.every((r) => !r.battery) : true;
  const entered = s.data?.enteredCount ?? 0;
  const storeCount = s.data?.facts.length ?? 0;

  return (
    <div className="space-y-4">
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-xs text-content-secondary">
            <CalendarDays className="h-4 w-4" /> Report date
            <input type="date" value={s.reportDate ?? ""} onChange={(e) => e.target.value && s.setReportDate(e.target.value)}
              className="rounded-md border border-hairline-strong bg-surface-input px-2 py-1 text-sm text-content-primary" />
          </label>
          <span className="mx-1 h-5 w-px bg-hairline" />
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => applyPreset(p)}
              className={"rounded-full border px-3 py-1.5 text-xs font-medium " +
                (activePreset === p.key
                  ? "border-accent bg-accent-tint text-accent-text"
                  : "border-hairline-strong bg-surface-overlay text-content-primary hover:bg-hairline-strong")}>
              {p.label}
            </button>
          ))}
          <GhostBtn className="ml-auto" onClick={doExport} disabled={!built || exporting}>
            <FileSpreadsheet className="h-4 w-4" /> {exporting ? "Building…" : "Export to Excel"}
          </GhostBtn>
        </div>
      </Card>

      {s.error && (
        <p className="flex items-center gap-2 rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">
          <AlertTriangle className="h-4 w-4" /> {s.error}
        </p>
      )}
      {exportError && <p className="rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{exportError}</p>}

      {s.data && (
        <p className={"flex items-start gap-2 rounded-md border px-3 py-2 text-xs " +
          (entered < storeCount ? "border-warning-border bg-warning-tint text-warning" : "border-hairline bg-surface-overlay text-content-secondary")}>
          <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            <strong>{entered} of {storeCount} stores</strong> entered their tic sheet for {s.reportDate}.
            {entered < storeCount && " A store that has not entered shows a dot, not a zero, and is never coloured."}
            {" "}Day {s.data.ctx.elapsed ?? "?"} of {s.data.ctx.daysOpen ?? "?"} open days this month.
          </span>
        </p>
      )}

      <div role="tablist" className="flex gap-1 border-b border-hairline">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => pickTab(k)}
            className={"border-b-2 px-3 py-2 text-sm font-medium " + (tab === k ? "border-accent text-content-primary" : "border-transparent text-content-secondary hover:text-content-primary")}>
            {label}
          </button>
        ))}
      </div>

      {s.loading && <p className="text-sm text-content-secondary">Loading…</p>}

      {built && !s.loading && tab === "scorecard" && (
        <Table report="scorecard" cols={R1_COLS} settings={built.settings}
          rows={sortRows(built.scorecard.rows, sortKey)}
          footer={[built.scorecard.total, built.scorecard.scTotal].filter(Boolean)}
          hidden={batteryEmpty ? new Set(["battery"]) : new Set()} />
      )}
      {built && !s.loading && tab === "markets" && (
        <>
          <Table report="markets" settings={built.settings}
            cols={built.hasBonus ? [...R2_COLS, ["bonusPct", "Proj Bonus % of Salary", (v) => (v === null || v === undefined ? "" : `${Math.round(v * 100)}%`)]] : R2_COLS}
            rows={built.markets.rows.map((m) => ({ ...m, bonusPct: m.bonus?.payoutPct ?? null }))}
            footer={[{ ...built.markets.total, bonusPct: built.markets.total.bonus?.payoutPct ?? null }]} />
          {built.hasBonus && (
            <p className="text-xs text-content-muted">
              Proj Bonus is shown to admin and master only. At 100% of budget or more it is 65% of salary plus 5% of the
              improvement over budget, which is added separately.
            </p>
          )}
        </>
      )}
      {built && !s.loading && tab === "tires" && (
        <Table report="tires" cols={R5_COLS} settings={built.settings}
          rows={sortRows(built.tires.rows, sortKey)}
          footer={[...built.tires.markets, built.tires.total]} />
      )}
    </div>
  );
}
