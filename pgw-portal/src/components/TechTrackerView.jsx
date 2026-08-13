import React, { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Wrench, Lock } from "lucide-react";
import { Card, SectionHeader, GhostBtn, PrimaryBtn, Empty, Field, inputCls } from "./ui.jsx";
import { money, pct, numOrDash } from "../lib/format.js";
import { useTechTracker } from "../hooks/useTechTracker.js";
import { rateForDate } from "../lib/techPayMath.js";

const pad2 = (n) => String(n).padStart(2, "0");
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const monthLabel = (y, m) => `${MONTHS[m - 1]} ${y}`;
const dayOfMonth = (iso) => Number(iso.slice(8, 10));
const inMonth = (iso, y, m) => iso.slice(0, 7) === `${y}-${pad2(m)}`;

export function TechTrackerView({ store }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [selIdx, setSelIdx] = useState(1);

  const tt = useTechTracker(store.id, year, month);
  const { privileged, loading, error, slotViews, storeSummary, employees } = tt;

  const curYm = now.getFullYear() * 12 + now.getMonth();
  const atCurrentMonth = year * 12 + (month - 1) >= curYm;
  const shiftMonth = (delta) => {
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    if (y * 12 + (m - 1) > curYm) return;
    setYear(y); setMonth(m);
  };
  const onPickMonth = (e) => {
    const [y, m] = e.target.value.split("-").map(Number);
    if (y && m && y * 12 + (m - 1) <= curYm) { setYear(y); setMonth(m); }
  };

  const slotByIndex = useMemo(() => {
    const m = {};
    for (const sv of slotViews) m[sv.slot.slot_index] = sv;
    return m;
  }, [slotViews]);
  const selView = slotByIndex[selIdx] || null;
  const slotName = (sv, idx) =>
    sv?.slot?.employee?.full_name || sv?.slot?.label || `Slot ${idx}`;

  return (
    <div>
      <SectionHeader
        title="Tech Tracker"
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

      <StoreStrip s={storeSummary} privileged={privileged} year={year} month={month} />

      {/* Slot selector */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {Array.from({ length: 9 }, (_, i) => i + 1).map((idx) => {
          const sv = slotByIndex[idx];
          const active = idx === selIdx;
          return (
            <button key={idx} onClick={() => setSelIdx(idx)}
              className={"rounded-md border px-2.5 py-1.5 text-xs font-medium " +
                (active ? "border-accent bg-accent text-on-accent"
                        : "border-hairline-strong bg-surface-overlay text-content-secondary hover:text-content-primary")}>
              <span className="opacity-60">{idx}.</span> {sv ? slotName(sv, idx) : "empty"}
            </button>
          );
        })}
      </div>

      {loading ? (
        <Card className="p-8"><p className="text-sm text-content-muted">Loading {monthLabel(year, month)}…</p></Card>
      ) : selView ? (
        <TechMonth key={`${selView.slot.id}-${year}-${month}`}
          view={selView} privileged={privileged} year={year} month={month} tt={tt} />
      ) : (
        <EmptySlot idx={selIdx} employees={employees} privileged={privileged}
          onAssign={(patch) => tt.saveSlot(selIdx, patch)} />
      )}

      <StoreTechSummary slotViews={slotViews} privileged={privileged} slotName={slotName} />

      {privileged && (
        <RateEditor slotViews={slotViews} ratesByEmp={tt.ratesByEmp}
          defaultDate={`${year}-${pad2(month)}-01`} onSave={tt.saveRate} />
      )}
    </div>
  );
}

// ---- Store summary strip -------------------------------------------------
function StoreStrip({ s, privileged, year, month }) {
  const Tile = ({ label, value, locked }) => (
    <div className="rounded-lg border border-hairline bg-surface-card px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-content-muted">
        {locked && <Lock className="h-3 w-3" />}{label}
      </div>
      <div className="text-sm font-semibold text-content-primary">{value}</div>
    </div>
  );
  return (
    <div className="mb-4">
      <h3 className="pgw-display mb-2 text-sm font-bold text-content-primary">{monthLabel(year, month)} store totals</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Labor Sales" value={money(s.laborSales)} />
        <Tile label="Flag Hours" value={numOrDash(s.flagHours)} />
        <Tile label="Hours Worked" value={numOrDash(s.hoursWorked)} />
        <Tile label="ELR" value={money(s.elr)} />
        <Tile label="Shop Proficiency" value={pct(s.shopProficiency)} />
        {privileged
          ? <Tile label="Labor Cost" value={s.laborCost == null ? "—" : money(s.laborCost)} locked />
          : <Tile label="Labor Cost" value="—" locked />}
        {privileged && <Tile label="Avg Tech Cost / Sold Hr" value={s.avgTechCostPerSoldHr == null ? "—" : money(s.avgTechCostPerSoldHr)} locked />}
      </div>
    </div>
  );
}

// ---- Per-technician monthly grid -----------------------------------------
function TechMonth({ view, privileged, year, month, tt }) {
  const gridRef = useRef(null);
  const slotId = view.slot.id;

  const cellInput = "h-7 w-20 bg-transparent text-right text-xs text-content-primary outline-none focus:bg-surface-overlay [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";
  const td = "border-b border-r border-hairline px-2 py-1 text-right text-xs whitespace-nowrap";
  const th = "border-b border-r border-hairline px-2 py-1 text-right text-[11px] font-semibold uppercase tracking-wide text-content-secondary whitespace-nowrap";

  const moveDown = (field, curKey) => {
    const nodes = [...(gridRef.current?.querySelectorAll(`input[data-f="${field}"]`) || [])];
    const idx = nodes.findIndex((n) => n.dataset.k === curKey);
    if (idx >= 0 && nodes[idx + 1]) { nodes[idx + 1].focus(); nodes[idx + 1].select?.(); }
  };
  const commit = (iso, field, el, prev) => {
    const raw = el.value.trim();
    const val = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(val) || val === Number(prev)) return;
    tt.saveDaily(slotId, iso, { [field]: val });
  };

  const editable = (iso, field, prev) => (
    <input type="number" inputMode="decimal" step="0.01" defaultValue={prev ? String(prev) : ""}
      data-f={field} data-k={iso} className={cellInput}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); moveDown(field, iso); } }}
      onBlur={(e) => commit(iso, field, e.target, prev)} />
  );

  const payCols = privileged;
  const m = view.month; // month totals (privileged) or null

  return (
    <Card className="mb-5 overflow-x-auto p-0">
      <table ref={gridRef} className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-overlay">
            <th className={th + " text-left"}>Work Day&nbsp;#</th>
            <th className={th + " text-left"}>Day</th>
            <th className={th}>Hrs Worked</th>
            <th className={th}>Flag Hours</th>
            <th className={th}>Labor Sales</th>
            <th className={th}>ELR</th>
            {payCols && <><th className={th}>Guar Pay</th><th className={th}>Commission</th><th className={th}>O/T</th><th className={th}>Total Pay</th></>}
          </tr>
        </thead>
        {view.weeks.map((wk, wi) => (
          <tbody key={wk.weekStart}>
            <tr>
              <td colSpan={payCols ? 10 : 6} className="border-b border-hairline bg-surface-inverse/5 px-2 py-1 text-[11px] font-semibold text-content-secondary">
                Week {wi + 1}
                {wk.countdown > 0 && (
                  <span className="ml-2 font-normal text-content-muted">
                    · Tech will be on overtime in {numOrDash(wk.countdown)} more worked hours
                  </span>
                )}
              </td>
            </tr>
            {wk.days.map((d, di) => {
              const iso = addDays(wk.weekStart, di);
              const wd = inMonth(iso, year, month) ? dayOfMonth(iso) : "";
              const dow = DOW[new Date(iso + "T00:00:00").getDay()];
              return (
                <tr key={iso} className="hover:bg-surface-overlay/40">
                  <td className={td + " text-left text-content-muted"}>{wd}</td>
                  <td className={td + " text-left text-content-muted"}>{dow}</td>
                  <td className={td + " p-0"}>{editable(iso, "hours_worked", d.hours)}</td>
                  <td className={td + " p-0"}>{editable(iso, "flag_hours", d.flag)}</td>
                  <td className={td + " p-0"}>{editable(iso, "labor_sales", d.labor)}</td>
                  <td className={td + " text-content-secondary"}>{d.elr ? money(d.elr) : "—"}</td>
                  {payCols && <>
                    <td className={td}>{money(d.guaranteePay)}</td>
                    <td className={td}>{money(d.commission)}</td>
                    <td className={td + " text-content-muted"}>—</td>
                    <td className={td + " text-content-muted"}>—</td>
                  </>}
                </tr>
              );
            })}
            {/* weekly totals */}
            <tr className="bg-surface-overlay font-semibold">
              <td className={td + " text-left"} colSpan={2}>Week {wi + 1} total</td>
              <td className={td}>{numOrDash(wk.hoursTotal)}</td>
              <td className={td}>{numOrDash(wk.flagTotal)}</td>
              <td className={td}>{money(wk.laborTotal)}</td>
              <td className={td}>{wk.elrWeek ? money(wk.elrWeek) : "—"}</td>
              {payCols && <>
                <td className={td}>{money(wk.guarTotal)}</td>
                <td className={td}>{money(wk.commTotal)}</td>
                <td className={td}>{money(wk.overtime)}</td>
                <td className={td + " text-accent"}>{money(wk.totalPay)}</td>
              </>}
            </tr>
          </tbody>
        ))}
        {payCols && m && (
          <tfoot>
            <tr className="bg-surface-inverse/10 font-bold">
              <td className={td + " text-left"} colSpan={2}>Month totals</td>
              <td className={td}>{numOrDash(m.hoursTotal)}</td>
              <td className={td}>{numOrDash(m.flagTotal)}</td>
              <td className={td}>{money(m.laborTotal)}</td>
              <td className={td}>{m.elr ? money(m.elr) : "—"}</td>
              <td className={td}>{money(m.guarTotal)}</td>
              <td className={td}>{money(m.commTotal)}</td>
              <td className={td}>{money(m.overtime)}</td>
              <td className={td + " text-accent"}>{money(m.totalPay)}</td>
            </tr>
          </tfoot>
        )}
        {!payCols && (
          <tfoot>
            <tr className="bg-surface-inverse/10 font-bold">
              <td className={td + " text-left"} colSpan={2}>Month totals</td>
              <td className={td}>{numOrDash(view.store.hours)}</td>
              <td className={td}>{numOrDash(view.store.flag)}</td>
              <td className={td}>{money(view.store.labor)}</td>
              <td className={td}>{view.store.elr ? money(view.store.elr) : "—"}</td>
            </tr>
          </tfoot>
        )}
      </table>
      {privileged && <OtherPayRow view={view} onSave={tt.saveOtherPay} />}
    </Card>
  );
}

// Master-only weekly Other Pay editor (kept out of the store-visible grid).
function OtherPayRow({ view, onSave }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-hairline px-3 py-2">
      <span className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-content-muted"><Lock className="h-3 w-3" />Other Pay (weekly)</span>
      {view.weeks.map((wk, wi) => (
        <label key={wk.weekStart} className="flex items-center gap-1 text-xs text-content-secondary">
          Wk{wi + 1}
          <input type="number" step="0.01" defaultValue={wk.otherPay ? String(wk.otherPay) : ""}
            onBlur={(e) => { const v = e.target.value.trim(); if (Number(v || 0) !== Number(wk.otherPay || 0)) onSave(view.slot.id, wk.weekStart, v); }}
            className="h-7 w-20 rounded border border-hairline-strong bg-surface-input px-2 text-right text-xs outline-none focus:border-accent" />
        </label>
      ))}
    </div>
  );
}

// ---- Store technician summary (Summary!P25:T34) --------------------------
function StoreTechSummary({ slotViews, privileged, slotName }) {
  const td = "border-b border-r border-hairline px-3 py-1.5 text-right text-xs whitespace-nowrap";
  const th = "border-b border-r border-hairline px-3 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wide text-content-secondary";
  return (
    <Card className="mb-5 overflow-x-auto p-0">
      <div className="border-b border-hairline px-3 py-2 text-xs font-semibold text-content-secondary">Technician summary</div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-overlay">
            <th className={th + " text-left"}>Technician</th>
            <th className={th}>Proficiency</th>
            <th className={th}>ELR</th>
            {privileged && <><th className={th}>Labor GP %</th><th className={th}>Cost / Hour</th></>}
          </tr>
        </thead>
        <tbody>
          {slotViews.map((sv) => {
            const st = sv.store, mo = sv.month;
            const hasData = st.hours || st.flag || st.labor;
            return (
              <tr key={sv.slot.id} className="hover:bg-surface-overlay/40">
                <td className={td + " text-left text-content-primary"}>{slotName(sv, sv.slot.slot_index)}</td>
                <td className={td}>{hasData ? pct(st.proficiency) : "—"}</td>
                <td className={td}>{st.elr ? money(st.elr) : "—"}</td>
                {privileged && <>
                  <td className={td}>{mo && mo.elr ? pct(mo.laborGpPct) : "—"}</td>
                  <td className={td}>{mo && mo.flagTotal ? money(mo.costPerHour) : "—"}</td>
                </>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// ---- Empty slot assignment ----------------------------------------------
function EmptySlot({ idx, employees, privileged, onAssign }) {
  const [empId, setEmpId] = useState("");
  const [label, setLabel] = useState("");
  if (!privileged) return <Empty icon={Wrench} title={`Slot ${idx} is empty`} hint="Ask a manager to assign a technician to this slot." />;
  return (
    <Card className="mb-5 p-4">
      <p className="mb-3 text-sm font-medium text-content-primary">Assign slot {idx}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56"><Field label="Technician">
          <select className={inputCls} value={empId} onChange={(e) => setEmpId(e.target.value)}>
            <option value="">— none —</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </Field></div>
        <div className="w-56"><Field label="…or placeholder label">
          <input className={inputCls} value={label} placeholder="e.g. MANAGER OR SA" onChange={(e) => setLabel(e.target.value)} />
        </Field></div>
        <PrimaryBtn disabled={!empId && !label.trim()}
          onClick={() => onAssign(empId ? { employee_id: empId, label: null } : { employee_id: null, label: label.trim(), is_manager_or_sa: /manager|sa/i.test(label) })}>
          Assign
        </PrimaryBtn>
      </div>
    </Card>
  );
}

// ---- Master rate editor (effective-dated) --------------------------------
function RateEditor({ slotViews, ratesByEmp, defaultDate, onSave }) {
  const assigned = slotViews.filter((sv) => sv.slot.employee_id);
  if (!assigned.length) return null;
  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-1 text-sm font-semibold text-content-primary"><Lock className="h-3.5 w-3.5" />Pay rates <span className="font-normal text-content-muted">(master/admin only · effective-dated)</span></div>
      <p className="mb-3 text-xs text-content-muted">Authoritative flat rate — the Payroll flat rate mirrors this value.</p>
      <div className="space-y-2">
        {assigned.map((sv) => (
          <RateRow key={sv.slot.employee_id} sv={sv}
            rates={ratesByEmp[sv.slot.employee_id] ?? []} defaultDate={defaultDate} onSave={onSave} />
        ))}
      </div>
    </Card>
  );
}

function RateRow({ sv, rates, defaultDate, onSave }) {
  const cur = rateForDate(rates, defaultDate);
  const [date, setDate] = useState(cur?.effective_date || defaultDate);
  const cell = "h-8 w-24 rounded border border-hairline-strong bg-surface-input px-2 text-right text-xs outline-none focus:border-accent";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-40 truncate text-sm text-content-primary">{sv.slot.employee?.full_name}</span>
      <label className="flex items-center gap-1 text-xs text-content-secondary">Effective
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="h-8 rounded border border-hairline-strong bg-surface-input px-2 text-xs outline-none focus:border-accent" />
      </label>
      <label className="flex items-center gap-1 text-xs text-content-secondary">Flat $/flag hr
        <input type="number" step="0.01" defaultValue={cur?.flat_rate ?? ""} placeholder="0.00"
          onBlur={(e) => { const v = Number(e.target.value || 0); if (date) onSave(sv.slot.employee_id, date, { flat_rate: v, guarantee_rate: Number(cur?.guarantee_rate || 0) }); }}
          className={cell} />
      </label>
      <label className="flex items-center gap-1 text-xs text-content-secondary">Guarantee $/hr
        <input type="number" step="0.01" defaultValue={cur?.guarantee_rate ?? ""} placeholder="0.00"
          onBlur={(e) => { const v = Number(e.target.value || 0); if (date) onSave(sv.slot.employee_id, date, { guarantee_rate: v, flat_rate: Number(cur?.flat_rate || 0) }); }}
          className={cell} />
      </label>
    </div>
  );
}
