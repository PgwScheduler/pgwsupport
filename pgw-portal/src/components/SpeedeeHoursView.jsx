import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Printer, Plus, Trash2, Lock } from "lucide-react";
import { usePayroll } from "../hooks/usePayroll.js";
import { thisWeekStart, weekLabel, shiftWeek } from "../lib/weekUtils.js";
import {
  computeSpeedeeStoreRow, computeSpeedeeRefRow, computeSpeedeeSummary,
  SPEEDEE_POSITIONS, SPEEDEE_TARGET, num,
} from "../lib/payrollMath.js";
import { money, pct, numOrDash } from "../lib/format.js";
import { exportSpeedeeCSV, printSpeedee } from "../lib/payrollExport.js";
import { Card, GhostBtn, PrimaryBtn, SectionHeader, T } from "./ui.jsx";
import { ConfirmDialog } from "./ConfirmDialog.jsx";

// Field -> saver routing.
const EMP_FIELDS = ["full_name", "position", "labor_pct_rate", "sales_expectation_flat"];
const RATE_FIELDS = ["hourly_rate"];
const PAY_FIELDS = ["paycheck_amount"];
// everything else (pto/clock/spiffs/labor_sales) goes through saveEntry.

const cell =
  "w-16 rounded border border-slate-700 bg-slate-800 px-1 py-1 text-right text-sm text-slate-100 outline-none focus:border-slate-500";
const roCell = "w-16 px-1 py-1 text-right text-sm text-slate-400";
const compCell = "px-2 py-1 text-right text-sm font-semibold text-white whitespace-nowrap";

function Th({ children, className = "" }) {
  return <th className={"px-2 py-2 text-right font-medium whitespace-nowrap " + className}>{children}</th>;
}

export function SpeedeeHoursView({ store }) {
  const [week, setWeek] = useState(() => thisWeekStart());
  const {
    rows, privileged, rpcSummary, weekSales, loading, error,
    addEmployee, updateEmployee, removeEmployee, saveEntry, saveRate, savePay, saveWeekSales,
  } = usePayroll(store.id, week, "speedee");

  const [ov, setOv] = useState({});
  const [salesInput, setSalesInput] = useState("");
  const timers = useRef({});
  const [newName, setNewName] = useState("");
  const [newPos, setNewPos] = useState("cashier");
  const [pendingRemove, setPendingRemove] = useState(null); // { id, name } awaiting confirmation

  useEffect(() => { setOv({}); }, [store.id, week]);
  useEffect(() => {
    setSalesInput(weekSales?.actual_weekly_sales != null ? String(weekSales.actual_weekly_sales) : "");
  }, [weekSales, week, store.id]);

  const setLocal = (empId, field, value) =>
    setOv((prev) => ({ ...prev, [empId]: { ...prev[empId], [field]: value } }));

  const persist = (empId, field, value) => {
    const key = empId + ":" + field;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      if (EMP_FIELDS.includes(field)) {
        const v = field === "full_name" ? value
          : field === "labor_pct_rate" || field === "sales_expectation_flat"
            ? (value === "" ? null : Number(value) || 0)
            : value;
        updateEmployee(empId, { [field]: v });
      } else if (RATE_FIELDS.includes(field)) {
        saveRate(empId, { [field]: value === "" ? 0 : Number(value) || 0 });
      } else if (PAY_FIELDS.includes(field)) {
        savePay(empId, { [field]: value === "" ? null : Number(value) || 0 });
      } else {
        // pto/clock (core) + spiffs/labor_sales (ext) — saveEntry splits them.
        saveEntry(empId, { [field]: value === "" ? (field === "labor_sales" ? null : 0) : Number(value) || 0 });
      }
    }, 500);
  };

  const commit = (empId, field, value) => {
    setLocal(empId, field, value);
    persist(empId, field, value);
  };

  const val = (empId, field, serverVal) => {
    const o = ov[empId];
    if (o && field in o) return o[field];
    return serverVal ?? "";
  };

  const merged = useMemo(
    () =>
      rows.map((r) => {
        const o = ov[r.employee.id] || {};
        const entry = { ...r.entry, ...o };
        const rate = { ...(r.rate || {}), ...o };
        const pay = { ...(r.pay || {}), ...o };
        return { ...r, mEntry: entry, mRate: rate, mPay: pay };
      }),
    [rows, ov]
  );

  // Sales Required = sum of every row's sales expectation (store-derivable).
  const salesRequired = useMemo(
    () => merged.reduce((a, r) => a + computeSpeedeeStoreRow(r.mEntry, r.roleSalesRate).salesExpectation, 0),
    [merged]
  );

  const actualWeeklySales = salesInput === "" ? 0 : Number(salesInput) || 0;

  // Master computes dollars locally; store gets them (allowed for Speedee)
  // from the RPC, which never exposes an individual paycheck.
  const summary = useMemo(() => {
    if (privileged) {
      const s = computeSpeedeeSummary(
        merged.map((r) => ({ entry: r.mEntry, pay: r.mPay, roleSalesRate: r.roleSalesRate })),
        actualWeeklySales
      );
      return { payrollDollars: s.payrollDollars, payrollPct: s.payrollPct };
    }
    return {
      payrollDollars: rpcSummary?.total_payroll_dollars ?? null,
      payrollPct: rpcSummary?.payroll_pct ?? null,
    };
  }, [privileged, merged, actualWeeklySales, rpcSummary]);

  const onAdd = async () => {
    await addEmployee({ full_name: newName.trim(), position: newPos });
    setNewName("");
    setNewPos("cashier");
  };

  const exportRows = merged.map((r) => ({ ...r, actualWeeklySales, salesRequired }));

  return (
    <div>
      <SectionHeader
        title="Employee Hours & Payroll"
        subtitle={`${store.name} · Speedee${privileged ? "" : " · pay is managed by the office"}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <GhostBtn onClick={() => setWeek((w) => shiftWeek(w, -1))}><ChevronLeft className="h-4 w-4" /></GhostBtn>
              <div className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200">
                Week of {weekLabel(week)}
              </div>
              <GhostBtn onClick={() => setWeek((w) => shiftWeek(w, 1))}><ChevronRight className="h-4 w-4" /></GhostBtn>
            </div>
            <GhostBtn onClick={() => exportSpeedeeCSV(store, week, exportRows, privileged, summary)} disabled={rows.length === 0}>
              <Download className="h-4 w-4" /> CSV
            </GhostBtn>
            <GhostBtn onClick={() => printSpeedee(store, week, exportRows, privileged, summary)} disabled={rows.length === 0}>
              <Printer className="h-4 w-4" /> Print / PDF
            </GhostBtn>
          </div>
        }
      />

      {error && (
        <p className="mb-3 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      <p className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: T.accentSoftText }}>
        Do not include any holiday pay hours.
      </p>

      {/* Summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryStat label="Sales Required" value={money(salesRequired)} />
        <SummaryStat
          label="Actual Weekly Sales"
          value={
            <input
              className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-right text-lg font-bold text-white outline-none focus:border-slate-500"
              value={salesInput}
              onChange={(e) => {
                setSalesInput(e.target.value);
                clearTimeout(timers.current.__sales);
                timers.current.__sales = setTimeout(() => saveWeekSales(e.target.value), 500);
              }}
              placeholder="excl. tax"
              inputMode="decimal"
            />
          }
        />
        <SummaryStat
          label="Total Payroll $"
          value={summary.payrollDollars == null ? "—" : money(summary.payrollDollars)}
        />
        <SummaryStat label="Payroll %" value={pct(summary.payrollPct)} target={SPEEDEE_TARGET} ratio={summary.payrollPct} />
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <Th className="text-left">Position</Th>
              <Th className="text-left">Employee</Th>
              <Th>PTO</Th>
              <Th>Clk Other</Th>
              <Th>Clk Here</Th>
              <Th>Total Hrs</Th>
              <Th>Labor %</Th>
              <Th>Elig</Th>
              <Th>Labor Sales</Th>
              <Th>Spiffs</Th>
              <Th>Total Incent.</Th>
              <Th>Sales Exp.</Th>
              {privileged && (
                <>
                  <Th className="border-l border-slate-700">Hourly Rate</Th>
                  <Th>Hrly Earn</Th>
                  <Th>OT</Th>
                  <Th>Hrly & OT</Th>
                  <Th>Labor % Pay</Th>
                  <Th>Paycheck (entered)</Th>
                </>
              )}
              <Th></Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {merged.map((r) => {
              const empId = r.employee.id;
              const sc = computeSpeedeeStoreRow(r.mEntry, r.roleSalesRate);
              const ref = privileged ? computeSpeedeeRefRow(r.mEntry, r.mRate) : null;
              const eligible = !!r.employee.labor_pct_eligible;
              return (
                <tr key={empId}>
                  <td className="px-2 py-1.5">
                    <select
                      className="rounded border border-transparent bg-transparent py-1 text-sm text-slate-200 outline-none focus:border-slate-600 focus:bg-slate-800"
                      value={r.employee.position}
                      onChange={(e) => updateEmployee(empId, { position: e.target.value })}
                    >
                      {SPEEDEE_POSITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      className="w-36 rounded border border-transparent bg-transparent px-1 py-1 text-sm font-medium text-white outline-none focus:border-slate-600 focus:bg-slate-800"
                      value={val(empId, "full_name", r.employee.full_name)}
                      onChange={(e) => commit(empId, "full_name", e.target.value)}
                      placeholder="Name"
                    />
                  </td>
                  <NumCell {...{ empId, field: "pto_days", val, commit, server: r.mEntry.pto_days }} />
                  <NumCell {...{ empId, field: "clock_hours_other", val, commit, server: r.mEntry.clock_hours_other }} />
                  <NumCell {...{ empId, field: "clock_hours", val, commit, server: r.mEntry.clock_hours }} />
                  <td className={compCell}>{numOrDash(sc.totalHours)}</td>

                  {/* Labor % rate + eligibility: master edits, store read-only */}
                  {privileged ? (
                    <NumCell {...{ empId, field: "labor_pct_rate", val, commit, server: r.employee.labor_pct_rate, placeholder: "0.10" }} />
                  ) : (
                    <td className={roCell}>{r.employee.labor_pct_rate == null ? "—" : numOrDash(r.employee.labor_pct_rate, 4)}</td>
                  )}
                  <td className="px-1 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={eligible}
                      disabled={!privileged}
                      onChange={(e) => updateEmployee(empId, { labor_pct_eligible: e.target.checked })}
                      className="h-4 w-4 accent-amber-500 disabled:opacity-60"
                    />
                  </td>
                  {privileged ? (
                    <NumCell {...{ empId, field: "labor_sales", val, commit, server: r.mEntry.labor_sales }} />
                  ) : (
                    <td className={roCell} title="Set by the office">
                      {r.mEntry.labor_sales == null ? "—" : numOrDash(r.mEntry.labor_sales)}
                    </td>
                  )}
                  <NumCell {...{ empId, field: "spiffs", val, commit, server: r.mEntry.spiffs }} />
                  <td className={compCell}>{money(sc.totalIncentive)}</td>
                  <td className={compCell}>{money(sc.salesExpectation)}</td>

                  {privileged && (
                    <>
                      <td className="border-l border-slate-700 px-1 py-1.5 text-right">
                        <NumCell inline field="hourly_rate" empId={empId} val={val} commit={commit} server={r.mRate.hourly_rate} />
                      </td>
                      <td className={compCell + " text-slate-400"}>{money(ref.hourlyEarned)}</td>
                      <td className={compCell + " text-slate-400"}>{money(ref.otEarned)}</td>
                      <td className={compCell + " text-slate-400"}>{money(ref.hourlyAndOt)}</td>
                      <td className={compCell + " text-slate-400"}>{money(sc.laborPctPay)}</td>
                      <td className="px-1 py-1.5 text-right">
                        <input
                          className={cell + " w-20"}
                          style={{ borderColor: T.accentSoftText }}
                          value={val(empId, "paycheck_amount", r.mPay.paycheck_amount)}
                          onChange={(e) => commit(empId, "paycheck_amount", e.target.value)}
                          placeholder="enter"
                          inputMode="decimal"
                        />
                      </td>
                    </>
                  )}

                  <td className="px-2 py-1.5 text-right">
                    <button onClick={() => setPendingRemove({ id: empId, name: r.employee.full_name })} className="text-slate-600 hover:text-red-400" title="Remove employee">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={privileged ? 19 : 13} className="px-4 py-10 text-center text-sm text-slate-500">
                No employees on the roster yet. Add one below to start the week.
              </td></tr>
            )}
            {loading && (
              <tr><td colSpan={privileged ? 19 : 13} className="px-4 py-10 text-center text-sm text-slate-500">Loading…</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {privileged && (
        <p className="mt-2 text-xs text-slate-500">
          Hourly / OT / Labor % Pay are <span className="font-medium text-slate-400">reference figures</span> to
          sanity-check the paycheck you enter — they do not calculate it.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="w-48 rounded border border-slate-700 bg-slate-800 px-2 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
          placeholder="New employee name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && newName.trim() && onAdd()}
        />
        <select
          className="rounded border border-slate-700 bg-slate-800 px-2 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
          value={newPos}
          onChange={(e) => setNewPos(e.target.value)}
        >
          {SPEEDEE_POSITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <PrimaryBtn onClick={onAdd} disabled={!newName.trim()}>
          <Plus className="h-4 w-4" /> Add employee
        </PrimaryBtn>
        <p className="ml-auto text-xs text-slate-500">
          {privileged ? "Changes save automatically." : (
            <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" /> Pay data is office-only. Changes save automatically.</span>
          )}
        </p>
      </div>

      {pendingRemove && (
        <ConfirmDialog
          title="Remove employee?"
          message={`Remove ${pendingRemove.name?.trim() || "this employee"} from the roster? Their past weekly history is kept, but they'll no longer appear on the payroll grid or the schedule. Reactivating them requires an administrator.`}
          confirmLabel="Remove"
          onConfirm={() => {
            removeEmployee(pendingRemove.id);
            setPendingRemove(null);
          }}
          onClose={() => setPendingRemove(null)}
        />
      )}
    </div>
  );
}

function NumCell({ empId, field, val, commit, server, inline = false, placeholder }) {
  const input = (
    <input
      className={cell}
      value={val(empId, field, server)}
      onChange={(e) => commit(empId, field, e.target.value)}
      placeholder={placeholder}
      inputMode="decimal"
    />
  );
  return inline ? input : <td className="px-1 py-1.5 text-right">{input}</td>;
}

function SummaryStat({ label, value, target, ratio }) {
  const over = target != null && ratio != null && ratio > target;
  return (
    <Card className="p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <div className={"pgw-display mt-0.5 text-xl font-bold " + (over ? "text-red-400" : "text-white")}>{value}</div>
      {target != null && (
        <p className="text-[11px] text-slate-500">target ≤ {Math.round(target * 100)}%{over ? " · over" : ""}</p>
      )}
    </Card>
  );
}
