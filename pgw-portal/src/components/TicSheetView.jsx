import React, { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Target, X, Lock } from "lucide-react";
import { useMonthlyTicSheet } from "../hooks/useMonthlyTicSheet.js";
import { useMonthlyGoals } from "../hooks/useMonthlyGoals.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { SectionHeader, Card, PrimaryBtn, GhostBtn, Empty, inputCls, T } from "./ui.jsx";
import { money, moneyCell, pct, numOrDash } from "../lib/format.js";
import { computeTicSheet, daySales, dayPotential } from "../lib/ticSheetMath.js";

// --- date helpers (timezone-naive local dates; never UTC) -------------------
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n) => String(n).padStart(2, "0");
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function monthLabel(year, month) {
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function buildDayMeta(year, month, holidaySet, todayIso) {
  const n = new Date(year, month, 0).getDate();
  const meta = {};
  for (let d = 1; d <= n; d++) {
    const iso = `${year}-${pad2(month)}-${pad2(d)}`;
    const dow = new Date(year, month - 1, d).getDay();
    const isSunday = dow === 0;
    const isHoliday = holidaySet.has(iso);
    const isFuture = iso > todayIso;
    meta[iso] = { d, iso, dow, dowName: DOW[dow], isSunday, isHoliday, isFuture,
      editable: !isSunday && !isHoliday && !isFuture };
  }
  return meta;
}

const num = (v) => Number(v) || 0;
const numToStr = (n) => (n == null || Number(n) === 0 ? "" : String(n));
// Counts render whole where they are whole; paced/goal figures carry one
// decimal, and a negative New Goal keeps its minus sign (it means "ahead").
const fmtCount = (v) =>
  v == null || !Number.isFinite(v) ? "" : Number.isInteger(v) ? String(v) : v.toFixed(1);
function toNum(raw, kind) {
  const n = Number(raw);
  if (raw === "" || raw == null || !Number.isFinite(n)) return 0;
  const v = kind === "int" ? Math.trunc(n) : n;
  return v < 0 ? 0 : v;
}

// Day-summary columns, to the right of the service categories.
// zero_dollar_tickets took First Time Customers' slot (migration 25). It is a
// daily entry with no Horizon field, and it does NOT reduce ro_count — repair
// orders, capture rate and average estimate per car are untouched by it.
const SUMMARY_COLS = [
  { key: "ro_count", label: "Repair Orders", kind: "int", type: "edit" },
  { key: "zero_dollar_tickets", label: "Zero Dollar Tickets", kind: "int", type: "edit" },
  { key: "sales", label: "Sales", kind: "money", type: "sales" },
  { key: "declined_sales", label: "Declined Sales", kind: "money", type: "edit" },
  { key: "credit_apps", label: "CC Apps", kind: "int", type: "edit" },
  { key: "credit_dollars", label: "Credit $", kind: "money", type: "edit" },
  { key: "total_potential", label: "Total Potential", kind: "money", type: "calc" },
  { key: "ave_estimate", label: "Ave Estimate / Car", kind: "money", type: "calc" },
  { key: "capture_rate", label: "Sales Capture Rate", kind: "pct", type: "calc" },
];

// Per-day Sales breakdown panel. `role` marks revenue vs cost so the panel can
// show both a Sales total and Gross profit.
//
// Groupon is entered here but is NOT part of the Sales column — the source's
// Sales is Summary G+H+J+L+N, which skips the Groupon column M. It still feeds
// gross profit, where the source splits it 50/50 across labor and parts.
const BREAKDOWN_FIELDS = [
  { key: "sales_labor", label: "Labor Sales", role: "sales", computed: true }, // from Tech Tracker; read-only
  { key: "sales_parts", label: "Parts Sales", role: "sales" },
  { key: "cost_parts", label: "Parts Cost", role: "cost" },
  { key: "sales_tires", label: "Tire Sales", role: "sales" },
  { key: "cost_tires", label: "Tire Cost", role: "cost" },
  { key: "sales_supplies", label: "Supplies", role: "sales" },
  { key: "sales_groupon", label: "Groupon", role: "groupon" },
  { key: "sales_discounts", label: "Discounts", role: "discount" }, // signed both ways
];

// Discounts are signed BOTH ways and summed algebraically: Millwood's July
// carries -125.00, -396.53 and a +107.00 reversal. Nothing coerces the sign.
// Costs and plain sales lines stay >= 0.
function signedBreakdownValue(field, raw) {
  const n = Number(raw);
  const v = raw === "" || raw == null || !Number.isFinite(n) ? 0 : n;
  if (field.role === "discount" || field.role === "groupon") return v;
  return v < 0 ? 0 : v;
}

// sticky-layout constants (px) — HEAD_H fits the longest vertical label
const HEAD_H = 196;
const BAND_H = 26;
const DAY_W = 108;
const PRIVILEGED = ["admin", "master"];

// ---- goals strip (unchanged behaviour, month-aware) -----------------------
function GoalTile({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface-page p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-content-muted">{label}</p>
      <p className="pgw-display mt-1 text-lg font-bold text-content-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-content-muted">{sub}</p>}
    </div>
  );
}
function GoalsStrip({ goals, year, month }) {
  if (goals.loading && goals.gpTarget == null) return null;
  if (goals.gpTarget == null) return null;
  const paceValue = goals.dailyPace == null ? "—" : money(goals.dailyPace);
  return (
    <Card className="mb-4 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Target className="h-4 w-4 text-content-muted" />
        <h3 className="pgw-display text-sm font-bold text-content-primary">{monthLabel(year, month)} goals</h3>
        <span className="text-xs text-content-muted">Gross profit — technician labor cost included</span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <GoalTile label="Month GP target" value={money(goals.gpTarget)} sub="Gross profit" />
        <GoalTile label="Month to date" value={money(goals.mtdActual)} sub={`${goals.elapsed} of ${goals.daysOpen} days`} />
        <GoalTile label="Daily pace needed" value={paceValue}
          sub={goals.targetMet ? "Target met" : goals.remaining > 0 ? `over ${goals.remaining} days left` : "no days left"} />
        {goals.hasCarsGoal && (
          <GoalTile label="Cars / day (actual · goal)"
            value={`${numOrDash(goals.carsActual, 1)} · ${goals.carsGoal.toFixed(1)}`} />
        )}
      </div>
    </Card>
  );
}

// ---- per-day sales breakdown panel ----------------------------------------
function SalesDetailModal({ dateIso, row, laborSales, onSave, onClose }) {
  const [vals, setVals] = useState(() => {
    const o = {};
    for (const f of BREAKDOWN_FIELDS) if (!f.computed) o[f.key] = numToStr(row?.[f.key]);
    return o;
  });
  const [busy, setBusy] = useState(false);
  const labor = num(laborSales);
  const at = (key) => signedBreakdownValue(BREAKDOWN_FIELDS.find((f) => f.key === key), vals[key]);
  // Sales = tech-tracker labor + parts + tires + supplies + discounts.
  // Groupon and the two cost lines are excluded; gross profit adds groupon
  // back and then deducts the costs.
  const salesTotal = labor + at("sales_parts") + at("sales_tires") + at("sales_supplies") + at("sales_discounts");
  const grossProfit = salesTotal + at("sales_groupon") - at("cost_parts") - at("cost_tires");
  const label = new Date(...dateIso.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))))
    .toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  const save = async () => {
    setBusy(true);
    const patch = {};
    for (const f of BREAKDOWN_FIELDS) if (!f.computed) patch[f.key] = signedBreakdownValue(f, vals[f.key]);
    await onSave(patch);
    setBusy(false);
    onClose();
  };

  const noteFor = (f) =>
    f.computed ? " · from Tech Tracker"
      : f.role === "cost" ? " · cost"
      : f.role === "groupon" ? " · not in Sales"
      : f.role === "discount" ? " · signed, reduces sales"
      : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <Card className="w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="pgw-display text-base font-bold text-content-primary">Sales breakdown · {label}</h3>
          <button onClick={onClose} className="text-content-muted hover:text-content-primary"><X className="h-4 w-4" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {BREAKDOWN_FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className={"mb-1 block text-xs font-medium uppercase tracking-wide " + (f.role === "cost" ? "text-content-muted" : "text-content-secondary")}>
                {f.label} ($){noteFor(f)}
              </span>
              {f.computed ? (
                <div className={inputCls + " flex items-center justify-between bg-surface-page text-content-muted"}>
                  <span>{money(labor)}</span><Lock className="h-3.5 w-3.5" />
                </div>
              ) : (
                <input type="number" inputMode="decimal" step="0.01"
                  min={f.role === "discount" || f.role === "groupon" ? undefined : "0"}
                  className={inputCls} value={vals[f.key]}
                  placeholder={f.role === "discount" ? "-0.00" : "0"}
                  onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))} />
              )}
            </label>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-md border border-hairline bg-surface-page px-3 py-2">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-content-muted">Sales total</span>
            <span className="text-sm font-semibold text-content-primary">{money(salesTotal)}</span>
          </div>
          <div className="rounded-md border border-hairline bg-surface-page px-3 py-2">
            <span className="block text-[11px] font-medium uppercase tracking-wide text-content-muted">Gross profit</span>
            <span className="text-sm font-semibold text-content-primary">{money(grossProfit)}</span>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-content-muted">
          Gross profit here is before technician labor cost; the goals strip above the grid shows the full figure.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <GhostBtn onClick={onClose} disabled={busy}>Cancel</GhostBtn>
          <PrimaryBtn onClick={save} disabled={busy}>Save</PrimaryBtn>
        </div>
      </Card>
    </div>
  );
}

export function TicSheetView({ store }) {
  const now = new Date();
  const { role } = useAuth();
  const canEditGoals = PRIVILEGED.includes(role);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-based

  const sheet = useMonthlyTicSheet(store, year, month);
  const { categories, holidaySet, loading, error, kpiByDate, unitsByDate, laborSalesByDate,
    categoryGoals, zeroDollarPct, daysOpen, saveSummary, saveUnit, saveCategoryGoal, saveZeroDollarPct } = sheet;
  const goals = useMonthlyGoals(store, `${year}-${pad2(month)}-01`, todayLocal());

  const [detailDate, setDetailDate] = useState(null);
  const [cellError, setCellError] = useState(null);
  const gridRef = useRef(null);
  const goalsTimer = useRef(null);

  const today = todayLocal();
  const curYm = now.getFullYear() * 12 + now.getMonth(); // month index of "today"
  const thisYm = year * 12 + (month - 1);
  const atCurrentMonth = thisYm >= curYm;

  const shiftMonth = (delta) => {
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    if (y * 12 + (m - 1) > curYm) return; // no future months
    setYear(y); setMonth(m);
  };
  const onPickMonth = (e) => {
    const [y, m] = e.target.value.split("-").map(Number);
    if (y && m && y * 12 + (m - 1) <= curYm) { setYear(y); setMonth(m); }
  };

  const scheduleGoals = () => {
    clearTimeout(goalsTimer.current);
    goalsTimer.current = setTimeout(() => goals.reload(), 600);
  };

  const dayMeta = useMemo(() => buildDayMeta(year, month, holidaySet, today), [year, month, holidaySet, today]);

  // Week blocks, weekly/monthly totals, self-correcting goals and PACE.
  const sheetTotals = useMemo(
    () => computeTicSheet({ year, month, categories, kpiByDate, unitsByDate, laborByDate: laborSalesByDate, daysOpen, categoryGoals }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [year, month, categories, kpiByDate, unitsByDate, laborSalesByDate, daysOpen, categoryGoals, sheet]
  );

  // Enter moves down the same column to the next editable day.
  const moveDown = (colId, curR) => {
    const nodes = [...(gridRef.current?.querySelectorAll(`input[data-c="${CSS.escape(colId)}"]`) || [])]
      .map((n) => ({ n, r: Number(n.dataset.r) }))
      .filter((x) => x.r > curR && !x.n.disabled)
      .sort((a, b) => a.r - b.r);
    if (nodes[0]) { nodes[0].n.focus(); nodes[0].n.select?.(); }
  };
  const onCellKey = (e, colId, r) => { if (e.key === "Enter") { e.preventDefault(); moveDown(colId, r); } };

  const commitUnit = async (dateIso, catId, raw) => {
    const val = toNum(raw, "int");
    if (val === num(unitsByDate[dateIso]?.[catId])) return;
    const { error: err } = await saveUnit(dateIso, catId, val);
    if (err) setCellError(err.message); else { setCellError(null); scheduleGoals(); }
  };
  const commitField = async (dateIso, key, kind, raw) => {
    const val = toNum(raw, kind);
    if (val === num(kpiByDate[dateIso]?.[key])) return;
    const { error: err } = await saveSummary(dateIso, { [key]: val });
    if (err) setCellError(err.message); else { setCellError(null); scheduleGoals(); }
  };
  // Header band edits. Goal % is typed as a percentage (35 -> 0.35).
  const commitGoalPct = async (catId, raw) => {
    const v = Math.max(0, Number(raw) || 0) / 100;
    if (v === num(categoryGoals[catId]?.goal_pct_of_cars)) return;
    const { error: err } = await saveCategoryGoal(catId, { goal_pct_of_cars: v });
    setCellError(err ? err.message : null);
  };
  const commitAvgSale = async (catId, raw) => {
    const v = Math.max(0, Number(raw) || 0);
    if (v === num(categoryGoals[catId]?.average_sale)) return;
    const { error: err } = await saveCategoryGoal(catId, { average_sale: v });
    setCellError(err ? err.message : null);
  };
  const commitZeroPct = async (raw) => {
    const v = Math.max(0, Number(raw) || 0) / 100;
    if (v === num(zeroDollarPct)) return;
    const { error: err } = await saveZeroDollarPct(v);
    setCellError(err ? err.message : null);
  };

  const cellInput = "h-7 w-full bg-transparent text-center text-xs text-content-primary outline-none focus:bg-surface-overlay [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";
  const bandInput = "h-6 w-full bg-transparent text-center text-[11px] text-content-primary outline-none focus:bg-surface-overlay [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";
  const th = "border-b border-r border-hairline";
  const td = "border-b border-r border-hairline";

  // One totals/goal cell for a summary column.
  const totalsCell = (col, totals) => {
    const v = totals?.[col.key];
    if (v == null) return "";
    if (col.kind === "pct") return pct(v, 1);
    if (col.kind === "money") return moneyCell(v);
    return fmtCount(v);
  };

  // A whole non-day row (Weekly Totals / Monthly Total / PACE / New Goal /
  // Weekly % of Cars). `catValue` and `sumValue` return the rendered content.
  const SummaryRow = ({ label, sub, catValue, sumValue, tone = "bg-surface-overlay", bold = true }) => (
    <tr className={bold ? "font-semibold" : ""}>
      <th className={`sticky left-0 z-30 ${tone} ${th} p-2 text-left text-content-primary`} style={{ width: DAY_W, minWidth: DAY_W }}>
        {label}
        {sub && <span className="ml-1 block text-[10px] font-normal uppercase tracking-wide text-content-muted">{sub}</span>}
      </th>
      {categories.map((c) => (
        <td key={c.id} className={`${td} ${tone} px-1 text-center text-content-primary`}>{catValue(c)}</td>
      ))}
      {SUMMARY_COLS.map((s) => (
        <td key={s.key} className={`${td} ${tone} px-1 text-center text-content-primary`}>{sumValue ? sumValue(s) : ""}</td>
      ))}
    </tr>
  );

  // Header band rows share the sticky stack under the column headers.
  const BandRow = ({ index, label, children }) => (
    <tr>
      <th className={`sticky left-0 z-50 bg-surface-card ${th} p-2 text-left text-[11px] font-medium text-content-secondary`}
        style={{ top: HEAD_H + index * BAND_H, height: BAND_H, width: DAY_W, minWidth: DAY_W }}>
        {label}
      </th>
      {children}
    </tr>
  );

  const zeroGoalPct = zeroDollarPct == null ? 0.1 : zeroDollarPct;
  const zeroActualPct = sheetTotals.month.ro_count > 0
    ? sheetTotals.month.zero_dollar_tickets / sheetTotals.month.ro_count : null;

  let dayRowIndex = 0; // running index across week blocks, for Enter navigation

  return (
    <div>
      <SectionHeader
        title="Daily Tic Sheet"
        subtitle={`#${store.store_number} · ${store.name}`}
        action={
          <div className="flex items-center gap-2">
            <GhostBtn onClick={() => shiftMonth(-1)} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></GhostBtn>
            <input type="month" value={`${year}-${pad2(month)}`} max={`${now.getFullYear()}-${pad2(now.getMonth() + 1)}`}
              onChange={onPickMonth}
              className="rounded-md border border-hairline-strong bg-surface-overlay px-2 py-1.5 text-sm text-content-primary outline-none" />
            <GhostBtn onClick={() => shiftMonth(1)} disabled={atCurrentMonth} aria-label="Next month"><ChevronRight className="h-4 w-4" /></GhostBtn>
          </div>
        }
      />

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {cellError && <p className="mb-3 text-sm text-danger">{cellError}</p>}

      <GoalsStrip goals={goals} year={year} month={month} />

      {categories.length === 0 ? (
        <Empty title="No service categories for this store"
          hint={store.brand === "speedee" ? "SpeeDee categories are set up per the SpeeDee list." : "No active categories are configured for this brand."} />
      ) : loading ? (
        <Card className="p-8"><p className="text-sm text-content-muted">Loading {monthLabel(year, month)}…</p></Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="text-xs text-content-muted px-3 py-2 border-b border-hairline">
            Enter units per category per day. Tab moves across a day, Enter moves down a column. Changes save automatically. Scroll sideways for all columns.
          </div>
          <div ref={gridRef} className="overflow-auto" style={{ maxHeight: "72vh" }} key={`${store.id}-${year}-${month}`}>
            <table className="border-separate border-spacing-0 text-xs">
              <thead>
                {/* column header row */}
                <tr>
                  <th className={`sticky left-0 top-0 z-50 bg-surface-overlay ${th} text-left align-bottom p-2`}
                    style={{ width: DAY_W, minWidth: DAY_W, height: HEAD_H }}>
                    <span className="pgw-display font-bold text-content-primary">{monthLabel(year, month)}</span>
                  </th>
                  {categories.map((c) => (
                    <th key={c.id} title={c.display_name}
                      className={`sticky top-0 z-40 bg-surface-overlay ${th} align-bottom`}
                      style={{ top: 0, height: HEAD_H, width: 40, minWidth: 40 }}>
                      <div className="mx-auto whitespace-nowrap text-[11px] text-content-secondary" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
                        {c.display_name}
                      </div>
                    </th>
                  ))}
                  {SUMMARY_COLS.map((s) => (
                    <th key={s.key} title={s.label}
                      className={`sticky top-0 z-40 bg-surface-overlay ${th} align-bottom`}
                      style={{ top: 0, height: HEAD_H, width: 56, minWidth: 56 }}>
                      <div className="mx-auto whitespace-nowrap text-[11px] font-medium text-content-primary" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
                        {s.label}
                      </div>
                    </th>
                  ))}
                </tr>

                {/* --- header band, frozen with the day column ------------- */}
                {/* 1. Goals % of Cars — entered, per store per category */}
                <BandRow index={0} label="Goals % of Cars">
                  {categories.map((c) => (
                    <td key={c.id} className={`sticky z-40 bg-surface-card ${td} p-0`} style={{ top: HEAD_H }}>
                      {canEditGoals ? (
                        <input type="number" inputMode="decimal" step="1" min="0" className={bandInput}
                          defaultValue={numToStr(Math.round(num(categoryGoals[c.id]?.goal_pct_of_cars) * 1000) / 10)}
                          title={`${c.display_name} — goal % of cars`}
                          onBlur={(e) => commitGoalPct(c.id, e.target.value)} />
                      ) : (
                        <span className="block text-center text-[11px] text-content-secondary">
                          {categoryGoals[c.id] ? pct(categoryGoals[c.id].goal_pct_of_cars, 0) : ""}
                        </span>
                      )}
                    </td>
                  ))}
                  {SUMMARY_COLS.map((s) => (
                    <td key={s.key} className={`sticky z-40 bg-surface-card ${td} p-0 text-center`} style={{ top: HEAD_H }}>
                      {s.key !== "zero_dollar_tickets" ? null : canEditGoals ? (
                        <input type="number" inputMode="decimal" step="1" min="0" className={bandInput}
                          defaultValue={String(Math.round(zeroGoalPct * 1000) / 10)}
                          title="Zero dollar tickets — goal % of repair orders"
                          onBlur={(e) => commitZeroPct(e.target.value)} />
                      ) : (
                        <span className="text-[11px] text-content-secondary">{pct(zeroGoalPct, 0)}</span>
                      )}
                    </td>
                  ))}
                </BandRow>

                {/* 2. Actual % of Cars — monthly units / monthly ROs */}
                <BandRow index={1} label="Actual % of Cars">
                  {categories.map((c) => (
                    <td key={c.id} className={`sticky z-40 bg-surface-card ${td} text-center text-content-muted`} style={{ top: HEAD_H + BAND_H }}>
                      {sheetTotals.actualPct[c.id] == null ? "" : pct(sheetTotals.actualPct[c.id], 1)}
                    </td>
                  ))}
                  {SUMMARY_COLS.map((s) => (
                    <td key={s.key} className={`sticky z-40 bg-surface-card ${td} text-center`} style={{ top: HEAD_H + BAND_H }}>
                      {s.key === "zero_dollar_tickets" && zeroActualPct != null && (
                        <span className={zeroActualPct > zeroGoalPct ? "font-semibold text-danger" : "text-success"}
                          title={zeroActualPct > zeroGoalPct ? `Over the ${pct(zeroGoalPct, 0)} goal` : `Within the ${pct(zeroGoalPct, 0)} goal`}>
                          {pct(zeroActualPct, 1)}
                        </span>
                      )}
                    </td>
                  ))}
                </BandRow>

                {/* 3. Average Sale — entered, per store per category */}
                <BandRow index={2} label="Average Sale">
                  {categories.map((c) => (
                    <td key={c.id} className={`sticky z-40 bg-surface-card ${td} p-0`} style={{ top: HEAD_H + 2 * BAND_H }}>
                      {canEditGoals ? (
                        <input type="number" inputMode="decimal" step="0.01" min="0" className={bandInput}
                          defaultValue={numToStr(num(categoryGoals[c.id]?.average_sale))}
                          title={`${c.display_name} — average sale`}
                          onBlur={(e) => commitAvgSale(c.id, e.target.value)} />
                      ) : (
                        <span className="block text-center text-[11px] text-content-secondary">
                          {moneyCell(categoryGoals[c.id]?.average_sale)}
                        </span>
                      )}
                    </td>
                  ))}
                  {SUMMARY_COLS.map((s) => (
                    <td key={s.key} className={`sticky z-40 bg-surface-card ${td}`} style={{ top: HEAD_H + 2 * BAND_H }} />
                  ))}
                </BandRow>

                {/* 4. Actual Sales — monthly units x average sale (derived) */}
                <BandRow index={3} label="Actual Sales">
                  {categories.map((c) => (
                    <td key={c.id} className={`sticky z-40 bg-surface-card ${td} px-1 text-center text-[11px] text-content-muted`} style={{ top: HEAD_H + 3 * BAND_H }}>
                      {sheetTotals.actualSales[c.id] ? moneyCell(sheetTotals.actualSales[c.id]) : ""}
                    </td>
                  ))}
                  {SUMMARY_COLS.map((s) => (
                    <td key={s.key} className={`sticky z-40 bg-surface-card ${td}`} style={{ top: HEAD_H + 3 * BAND_H }} />
                  ))}
                </BandRow>

                {/* 5. Goal Units — goal % x projected repair orders (derived) */}
                <BandRow index={4} label="Goal Units" >
                  {categories.map((c) => (
                    <td key={c.id} className={`sticky z-40 bg-surface-card ${td} px-1 text-center text-[11px] text-content-muted`} style={{ top: HEAD_H + 4 * BAND_H }}>
                      {sheetTotals.monthlyGoal[c.id] ? sheetTotals.monthlyGoal[c.id].toFixed(1) : ""}
                    </td>
                  ))}
                  {SUMMARY_COLS.map((s) => (
                    <td key={s.key} className={`sticky z-40 bg-surface-card ${td} px-1 text-center text-[11px] text-content-muted`} style={{ top: HEAD_H + 4 * BAND_H }}>
                      {s.key === "ro_count" && sheetTotals.projectedRo > 0 ? sheetTotals.projectedRo.toFixed(1) : ""}
                    </td>
                  ))}
                </BandRow>
              </thead>

              <tbody>
                {sheetTotals.weeks.map((week) => (
                  <React.Fragment key={week.startIso}>
                    {week.days.map((iso) => {
                      const day = dayMeta[iso];
                      const row = kpiByDate[iso];
                      const r = dayRowIndex++;
                      const muted = !day.editable;
                      const dayBg = muted ? "bg-surface-page" : "bg-surface-card";
                      const sales = daySales(row, laborSalesByDate[iso]);
                      const potential = dayPotential(row, laborSalesByDate[iso]);
                      const ro = num(row?.ro_count);
                      const calc = {
                        total_potential: potential !== 0 ? potential : null,
                        ave_estimate: ro > 0 ? potential / ro : null,
                        capture_rate: potential !== 0 ? sales / potential : null,
                      };
                      return (
                        <tr key={iso} className={muted ? "text-content-disabled" : ""}>
                          <th className={`sticky left-0 z-30 ${dayBg} ${th} whitespace-nowrap p-2 text-left font-medium`}
                            style={{ width: DAY_W, minWidth: DAY_W }}>
                            <span className={muted ? "text-content-muted" : "text-content-primary"}>{day.dowName} {month}/{day.d}</span>
                            {day.isHoliday && <span className="ml-1 text-[10px] uppercase text-content-muted">hol</span>}
                          </th>

                          {categories.map((c) => (
                            <td key={c.id} className={`${td} ${muted ? "bg-surface-page" : ""} p-0`}>
                              {muted ? (
                                <div className="h-7 text-center leading-7 text-content-muted">{numToStr(unitsByDate[iso]?.[c.id])}</div>
                              ) : (
                                <input type="number" inputMode="numeric" min="0"
                                  data-r={r} data-c={`u${c.id}`} className={cellInput}
                                  defaultValue={numToStr(unitsByDate[iso]?.[c.id])}
                                  onKeyDown={(e) => onCellKey(e, `u${c.id}`, r)}
                                  onBlur={(e) => commitUnit(iso, c.id, e.target.value)} />
                              )}
                            </td>
                          ))}

                          {SUMMARY_COLS.map((s) => {
                            if (s.type === "edit") {
                              return (
                                <td key={s.key} className={`${td} ${muted ? "bg-surface-page" : ""} p-0`}>
                                  {muted ? (
                                    <div className="h-7 text-center leading-7 text-content-muted">{numToStr(row?.[s.key])}</div>
                                  ) : (
                                    <input type="number" inputMode={s.kind === "int" ? "numeric" : "decimal"}
                                      step={s.kind === "int" ? "1" : "0.01"} min="0"
                                      data-r={r} data-c={s.key} className={cellInput}
                                      defaultValue={numToStr(row?.[s.key])}
                                      onKeyDown={(e) => onCellKey(e, s.key, r)}
                                      onBlur={(e) => commitField(iso, s.key, s.kind, e.target.value)} />
                                  )}
                                </td>
                              );
                            }
                            if (s.type === "sales") {
                              return (
                                <td key={s.key} className={`${td} ${muted ? "bg-surface-page" : ""} p-0 text-center`}>
                                  {muted ? (
                                    <div className="h-7 leading-7 text-content-muted">{sales === 0 ? "" : moneyCell(sales)}</div>
                                  ) : (
                                    <button onClick={() => setDetailDate(iso)}
                                      className="h-7 w-full text-xs text-content-primary underline decoration-dotted underline-offset-2 hover:bg-surface-overlay">
                                      {sales === 0 ? "" : moneyCell(sales)}
                                    </button>
                                  )}
                                </td>
                              );
                            }
                            const v = calc[s.key];
                            return (
                              <td key={s.key} className={`${td} ${muted ? "bg-surface-page" : ""} px-1 text-center text-content-secondary`}>
                                {v == null ? "" : s.kind === "pct" ? pct(v, 1) : moneyCell(v)}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}

                    {/* Weekly Totals — the two ratio columns recompute, never sum */}
                    <SummaryRow
                      label={`Weekly Totals`}
                      sub={`Week ${week.index + 1}`}
                      catValue={(c) => (week.totals.units[c.id] ? week.totals.units[c.id] : "")}
                      sumValue={(s) => totalsCell(s, week.totals)}
                    />
                    {/* New Goal — cumulative remaining units. Negative means the
                        category is ahead; the minus sign is never hidden. */}
                    <SummaryRow
                      label="New Goal"
                      catValue={(c) => (
                        <span className={week.newGoal[c.id] < 0 ? "text-success" : ""}>
                          {week.newGoal[c.id] == null ? "" : week.newGoal[c.id].toFixed(1)}
                        </span>
                      )}
                      sumValue={null}
                      tone="bg-surface-page"
                      bold={false}
                    />
                    <SummaryRow
                      label="Weekly % of Cars"
                      catValue={(c) => (week.pctOfCars[c.id] == null ? "" : pct(week.pctOfCars[c.id], 1))}
                      sumValue={null}
                      tone="bg-surface-page"
                      bold={false}
                    />
                  </React.Fragment>
                ))}

                {/* Monthly Total — the sum of the Weekly Totals rows */}
                <SummaryRow
                  label="Monthly Total"
                  catValue={(c) => (sheetTotals.month.units[c.id] ? sheetTotals.month.units[c.id] : "")}
                  sumValue={(s) => totalsCell(s, sheetTotals.month)}
                />
                <SummaryRow
                  label="PACE"
                  sub={`${sheetTotals.daysElapsed} of ${sheetTotals.daysOpen} days`}
                  catValue={(c) => (sheetTotals.pace ? fmtCount(Math.round(sheetTotals.pace.units[c.id] * 10) / 10) : "")}
                  sumValue={(s) => (sheetTotals.pace ? totalsCell(s, sheetTotals.pace) : "")}
                />
              </tbody>
            </table>
          </div>
          <p className="border-t border-hairline px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-content-muted">
            PACE — means how you will do if nothing changes.
          </p>
        </Card>
      )}

      {detailDate && (
        <SalesDetailModal
          dateIso={detailDate}
          row={kpiByDate[detailDate]}
          laborSales={laborSalesByDate[detailDate]}
          onSave={async (patch) => { await saveSummary(detailDate, patch); scheduleGoals(); }}
          onClose={() => setDetailDate(null)}
        />
      )}
    </div>
  );
}
