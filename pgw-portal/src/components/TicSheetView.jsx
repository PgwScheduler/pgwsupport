import React, { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Target, X } from "lucide-react";
import { useMonthlyTicSheet } from "../hooks/useMonthlyTicSheet.js";
import { useMonthlyGoals } from "../hooks/useMonthlyGoals.js";
import { SectionHeader, Card, PrimaryBtn, GhostBtn, Empty, inputCls, T } from "./ui.jsx";
import { money, pct, numOrDash } from "../lib/format.js";

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
function buildDays(year, month, holidaySet, todayIso) {
  const n = new Date(year, month, 0).getDate();
  const days = [];
  for (let d = 1; d <= n; d++) {
    const iso = `${year}-${pad2(month)}-${pad2(d)}`;
    const dow = new Date(year, month - 1, d).getDay();
    const isSunday = dow === 0;
    const isHoliday = holidaySet.has(iso);
    const isFuture = iso > todayIso;
    days.push({ d, iso, dow, dowName: DOW[dow], isSunday, isHoliday, isFuture,
      editable: !isSunday && !isHoliday && !isFuture });
  }
  return days;
}

const num = (v) => Number(v) || 0;
const numToStr = (n) => (n == null || Number(n) === 0 ? "" : String(n));
function toNum(raw, kind) {
  const n = Number(raw);
  if (raw === "" || raw == null || !Number.isFinite(n)) return 0;
  const v = kind === "int" ? Math.trunc(n) : n;
  return v < 0 ? 0 : v;
}
// Sales = all revenue lines added (labor+parts+tires+supplies+groupon+discounts).
// Parts/Tire cost do NOT reduce Sales — they reduce gross profit (goals strip).
const SALES_KEYS = ["sales_labor", "sales_parts", "sales_tires", "sales_supplies", "sales_groupon", "sales_discounts"];
const COST_KEYS = ["cost_parts", "cost_tires"];
const salesOf = (row) => SALES_KEYS.reduce((s, k) => s + num(row?.[k]), 0);
const grossProfitOf = (row) => salesOf(row) - COST_KEYS.reduce((s, k) => s + num(row?.[k]), 0);
const potentialOf = (row) => salesOf(row) + num(row?.declined_sales);

// Day-summary columns, to the right of the service categories.
const SUMMARY_COLS = [
  { key: "ro_count", label: "Repair Orders", kind: "int", type: "edit" },
  { key: "first_time_customers", label: "First Time Customers", kind: "int", type: "edit" },
  { key: "sales", label: "Sales", kind: "money", type: "sales" },
  { key: "declined_sales", label: "Declined Sales", kind: "money", type: "edit" },
  { key: "credit_apps", label: "CC Apps", kind: "int", type: "edit" },
  { key: "credit_dollars", label: "Credit $", kind: "money", type: "edit" },
  { key: "total_potential", label: "Total Potential", kind: "money", type: "calc" },
  { key: "ave_estimate", label: "Ave Estimate / Car", kind: "money", type: "calc" },
  { key: "capture_rate", label: "Sales Capture Rate", kind: "pct", type: "calc" },
];
// Per-day Sales breakdown panel. `role` marks revenue vs cost so the panel can
// show both a Sales total (revenue) and Gross profit (revenue − costs).
const BREAKDOWN_FIELDS = [
  { key: "sales_labor", label: "Labor Sales", role: "sales" },
  { key: "sales_parts", label: "Parts Sales", role: "sales" },
  { key: "cost_parts", label: "Parts Cost", role: "cost" },
  { key: "sales_tires", label: "Tire Sales", role: "sales" },
  { key: "cost_tires", label: "Tire Cost", role: "cost" },
  { key: "sales_supplies", label: "Supplies", role: "sales" },
  { key: "sales_groupon", label: "Groupon", role: "sales" },
  { key: "sales_discounts", label: "Discounts", role: "discount" }, // negative: reduces Sales
];

// A discount is stored negative (reduces Sales); costs/sales stay >= 0. Whatever
// the manager types is coerced to the right sign so Sales math is always correct.
function signedBreakdownValue(field, raw) {
  const n = Number(raw);
  const v = raw === "" || raw == null || !Number.isFinite(n) ? 0 : n;
  if (field.role === "discount") return -Math.abs(v);
  return v < 0 ? 0 : v;
}

// sticky-layout constants (px) — HEAD_H fits the longest vertical label
const HEAD_H = 196;
const DAY_W = 108;

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
        <span className="text-xs text-content-muted">GP before labor — technician labor not yet deducted</span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <GoalTile label="Month GP target" value={money(goals.gpTarget)} sub="GP before labor" />
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
function SalesDetailModal({ dateIso, row, onSave, onClose }) {
  const [vals, setVals] = useState(() => {
    const o = {};
    for (const f of BREAKDOWN_FIELDS) o[f.key] = numToStr(row?.[f.key]);
    return o;
  });
  const [busy, setBusy] = useState(false);
  // Sales = revenue lines + discounts (discounts are negative); costs are separate.
  const salesTotal = BREAKDOWN_FIELDS.filter((f) => f.role !== "cost").reduce((s, f) => s + signedBreakdownValue(f, vals[f.key]), 0);
  const costTotal = BREAKDOWN_FIELDS.filter((f) => f.role === "cost").reduce((s, f) => s + signedBreakdownValue(f, vals[f.key]), 0);
  const label = new Date(...dateIso.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))))
    .toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  const save = async () => {
    setBusy(true);
    const patch = {};
    for (const f of BREAKDOWN_FIELDS) patch[f.key] = signedBreakdownValue(f, vals[f.key]);
    await onSave(patch);
    setBusy(false);
    onClose();
  };

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
                {f.label} ($){f.role === "cost" ? " · cost" : f.role === "discount" ? " · reduces sales" : ""}
              </span>
              <input type="number" inputMode="decimal" step="0.01" min={f.role === "discount" ? undefined : "0"}
                className={inputCls} value={vals[f.key]} placeholder={f.role === "discount" ? "-0.00" : "0"}
                onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))} />
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
            <span className="text-sm font-semibold text-content-primary">{money(salesTotal - costTotal)}</span>
          </div>
        </div>
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
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-based

  const sheet = useMonthlyTicSheet(store, year, month);
  const { categories, holidaySet, loading, error, kpiByDate, unitsByDate, saveSummary, saveUnit } = sheet;
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

  const days = useMemo(() => buildDays(year, month, holidaySet, today), [year, month, holidaySet, today]);

  // Month-to-date aggregates (for the Actual % band and the totals row).
  const agg = useMemo(() => {
    let mtdRo = 0;
    const mtdUnits = {};
    const sum = { ro_count: 0, first_time_customers: 0, declined_sales: 0, credit_apps: 0, credit_dollars: 0, sales: 0, total_potential: 0 };
    for (const day of days) {
      const row = kpiByDate[day.iso];
      if (!row) continue;
      mtdRo += num(row.ro_count);
      sum.ro_count += num(row.ro_count);
      sum.first_time_customers += num(row.first_time_customers);
      sum.declined_sales += num(row.declined_sales);
      sum.credit_apps += num(row.credit_apps);
      sum.credit_dollars += num(row.credit_dollars);
      sum.sales += salesOf(row);
      sum.total_potential += potentialOf(row);
      const u = unitsByDate[day.iso] || {};
      for (const c of categories) mtdUnits[c.id] = (mtdUnits[c.id] || 0) + num(u[c.id]);
    }
    return { mtdRo, mtdUnits, sum };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, categories, kpiByDate, unitsByDate, sheet]);

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

  const actualPct = (catId) => (agg.mtdRo > 0 ? (agg.mtdUnits[catId] || 0) / agg.mtdRo : null);

  const cellInput = "h-7 w-full bg-transparent text-center text-xs text-content-primary outline-none focus:bg-surface-overlay [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";
  const th = "border-b border-r border-hairline";
  const td = "border-b border-r border-hairline";

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
                      style={{ top: 0, height: HEAD_H, width: 52, minWidth: 52 }}>
                      <div className="mx-auto whitespace-nowrap text-[11px] font-medium text-content-primary" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
                        {s.label}
                      </div>
                    </th>
                  ))}
                </tr>
                {/* header band: Actual % of Cars (Goal % / Goal Units hidden until penetration goals exist) */}
                <tr>
                  <th className={`sticky left-0 z-50 bg-surface-card ${th} text-left p-2 font-medium text-content-secondary`}
                    style={{ top: HEAD_H, width: DAY_W, minWidth: DAY_W }}>
                    Actual % of Cars
                  </th>
                  {categories.map((c) => (
                    <td key={c.id} className={`sticky z-40 bg-surface-card ${td} text-center text-content-muted`} style={{ top: HEAD_H }}>
                      {actualPct(c.id) == null ? "" : pct(actualPct(c.id), 0)}
                    </td>
                  ))}
                  {SUMMARY_COLS.map((s) => (
                    <td key={s.key} className={`sticky z-40 bg-surface-card ${td}`} style={{ top: HEAD_H }} />
                  ))}
                </tr>
              </thead>

              <tbody>
                {days.map((day, r) => {
                  const row = kpiByDate[day.iso];
                  const muted = !day.editable;
                  const dayBg = muted ? "bg-surface-page" : "bg-surface-card";
                  const sales = salesOf(row);
                  const potential = potentialOf(row);
                  const ro = num(row?.ro_count);
                  const calc = {
                    total_potential: potential > 0 ? potential : null,
                    ave_estimate: ro > 0 ? potential / ro : null,
                    capture_rate: potential > 0 ? sales / potential : null,
                  };
                  return (
                    <tr key={day.iso} className={muted ? "text-content-disabled" : ""}>
                      <th className={`sticky left-0 z-30 ${dayBg} ${th} whitespace-nowrap p-2 text-left font-medium`}
                        style={{ width: DAY_W, minWidth: DAY_W }}>
                        <span className={muted ? "text-content-muted" : "text-content-primary"}>{day.dowName} {month}/{day.d}</span>
                        {day.isHoliday && <span className="ml-1 text-[10px] uppercase text-content-muted">hol</span>}
                      </th>

                      {categories.map((c) => (
                        <td key={c.id} className={`${td} ${muted ? "bg-surface-page" : ""} p-0`}>
                          {muted ? <div className="h-7" /> : (
                            <input type="number" inputMode="numeric" min="0"
                              data-r={r} data-c={`u${c.id}`} className={cellInput}
                              defaultValue={numToStr(unitsByDate[day.iso]?.[c.id])}
                              onKeyDown={(e) => onCellKey(e, `u${c.id}`, r)}
                              onBlur={(e) => commitUnit(day.iso, c.id, e.target.value)} />
                          )}
                        </td>
                      ))}

                      {SUMMARY_COLS.map((s) => {
                        if (s.type === "edit") {
                          return (
                            <td key={s.key} className={`${td} ${muted ? "bg-surface-page" : ""} p-0`}>
                              {muted ? <div className="h-7" /> : (
                                <input type="number" inputMode={s.kind === "int" ? "numeric" : "decimal"}
                                  step={s.kind === "int" ? "1" : "0.01"} min="0"
                                  data-r={r} data-c={s.key} className={cellInput}
                                  defaultValue={numToStr(row?.[s.key])}
                                  onKeyDown={(e) => onCellKey(e, s.key, r)}
                                  onBlur={(e) => commitField(day.iso, s.key, s.kind, e.target.value)} />
                              )}
                            </td>
                          );
                        }
                        if (s.type === "sales") {
                          return (
                            <td key={s.key} className={`${td} ${muted ? "bg-surface-page" : ""} p-0 text-center`}>
                              {muted ? <div className="h-7" /> : (
                                <button onClick={() => setDetailDate(day.iso)}
                                  className="h-7 w-full text-xs text-content-primary underline decoration-dotted underline-offset-2 hover:bg-surface-overlay">
                                  {sales === 0 ? "" : money(sales)}
                                </button>
                              )}
                            </td>
                          );
                        }
                        // computed read-only
                        const v = calc[s.key];
                        return (
                          <td key={s.key} className={`${td} ${muted ? "bg-surface-page" : ""} px-1 text-center text-content-secondary`}>
                            {v == null ? "" : s.kind === "pct" ? pct(v, 0) : money(v)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}

                {/* totals row (month to date) */}
                <tr className="font-semibold">
                  <th className={`sticky left-0 z-30 bg-surface-overlay ${th} p-2 text-left text-content-primary`} style={{ width: DAY_W, minWidth: DAY_W }}>
                    Totals
                  </th>
                  {categories.map((c) => (
                    <td key={c.id} className={`${td} bg-surface-overlay text-center text-content-primary`}>
                      {agg.mtdUnits[c.id] ? agg.mtdUnits[c.id] : ""}
                    </td>
                  ))}
                  {SUMMARY_COLS.map((s) => {
                    let out = "";
                    if (s.type === "edit" || s.key === "ro_count") out = agg.sum[s.key] ? (s.kind === "money" ? money(agg.sum[s.key]) : agg.sum[s.key]) : "";
                    else if (s.type === "sales") out = agg.sum.sales ? money(agg.sum.sales) : "";
                    else if (s.key === "total_potential") out = agg.sum.total_potential ? money(agg.sum.total_potential) : "";
                    else if (s.key === "ave_estimate") out = agg.mtdRo > 0 ? money(agg.sum.total_potential / agg.mtdRo) : "";
                    else if (s.key === "capture_rate") out = agg.sum.total_potential > 0 ? pct(agg.sum.sales / agg.sum.total_potential, 0) : "";
                    return (
                      <td key={s.key} className={`${td} bg-surface-overlay px-1 text-center text-content-primary`}>{out}</td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {detailDate && (
        <SalesDetailModal
          dateIso={detailDate}
          row={kpiByDate[detailDate]}
          onSave={async (patch) => { await saveSummary(detailDate, patch); scheduleGoals(); }}
          onClose={() => setDetailDate(null)}
        />
      )}
    </div>
  );
}
