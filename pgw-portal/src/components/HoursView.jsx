import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Printer, Plus, Trash2, Lock } from "lucide-react";
import { usePayroll } from "../hooks/usePayroll.js";
import { thisWeekStart, weekLabel, shiftWeek } from "../lib/weekUtils.js";
import {
  computeStoreRow, computePayRow, computePayrollSummary, POSITIONS, TARGETS,
} from "../lib/payrollMath.js";
import { money, pct, numOrDash } from "../lib/format.js";
import { exportPayrollCSV, printPayroll } from "../lib/payrollExport.js";
import { SpeedeeHoursView } from "./SpeedeeHoursView.jsx";
import { Card, GhostBtn, PrimaryBtn, SectionHeader, T } from "./ui.jsx";
import { ConfirmDialog } from "./ConfirmDialog.jsx";

// The Employee Hours tab follows the store's brand — managers never toggle it.
export function HoursView({ store }) {
  return store.brand === "speedee"
    ? <SpeedeeHoursView store={store} />
    : <MidasHoursView store={store} />;
}

// Which mutator a field routes to.
const ENTRY_FIELDS = [
  "pto_days", "clock_hours_other", "clock_hours",
  "hrs_turned_other", "hrs_turned_here", "actual_sales", "work_orders", "sales_required",
];
const RATE_FIELDS = ["hourly_rate", "flat_rate_per_hour", "manager_salary"];
const PAY_FIELDS = ["bonus", "incentives"];

const cell =
  "w-16 rounded border border-hairline-strong bg-surface-overlay px-1 py-1 text-right text-sm text-content-primary outline-none focus:border-hairline-strong";
const roCell = "w-16 px-1 py-1 text-right text-sm text-content-secondary";
const compCell = "px-2 py-1 text-right text-sm font-semibold text-content-primary whitespace-nowrap";

function Th({ children, className = "" }) {
  return <th className={"px-2 py-2 text-right font-medium whitespace-nowrap " + className}>{children}</th>;
}

function MidasHoursView({ store }) {
  const [week, setWeek] = useState(() => thisWeekStart());
  const [pendingRemove, setPendingRemove] = useState(null); // { id, name } awaiting confirmation
  const {
    rows, privileged, rpcSummary, flatFlags, loading, error,
    addEmployee, updateEmployee, removeEmployee, saveEntry, saveRate, savePay,
  } = usePayroll(store.id, week, "midas");

  const [ov, setOv] = useState({}); // { [employeeId]: { field: rawValue } }
  const timers = useRef({});
  const [newName, setNewName] = useState("");
  const [newPos, setNewPos] = useState("tech");

  // Reset optimistic overrides when the store or week changes.
  useEffect(() => {
    setOv({});
  }, [store.id, week]);

  const setLocal = (empId, field, value) =>
    setOv((prev) => ({ ...prev, [empId]: { ...prev[empId], [field]: value } }));

  const persist = (empId, field, value) => {
    const key = empId + ":" + field;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      if (field === "sales_required") {
        saveEntry(empId, { sales_required: value === "" ? null : Number(value) || 0 });
      } else if (ENTRY_FIELDS.includes(field)) {
        saveEntry(empId, { [field]: value === "" ? 0 : Number(value) || 0 });
      } else if (RATE_FIELDS.includes(field)) {
        saveRate(empId, { [field]: value === "" ? 0 : Number(value) || 0 });
      } else if (PAY_FIELDS.includes(field)) {
        savePay(empId, { [field]: value === "" ? 0 : Number(value) || 0 });
      }
    }, 500);
  };

  const commit = (empId, field, value) => {
    setLocal(empId, field, value);
    persist(empId, field, value);
  };

  // Merge overrides over server values for live compute.
  const merged = useMemo(
    () =>
      rows.map((r) => {
        const o = ov[r.employee.id] || {};
        const entry = { ...r.entry, ...o };
        const rate = { ...(r.rate || {}), ...o };
        const pay = { ...(r.pay || {}), ...o };
        // FLAT flag: privileged compute it locally from rates; store users
        // get just the boolean from the flat_flags_for_week RPC.
        const flatFlag = privileged
          ? computePayRow(entry, rate, pay).flatFlag
          : !!flatFlags[r.employee.id];
        return { ...r, mEntry: entry, mRate: rate, mPay: pay, flatFlag };
      }),
    [rows, ov, privileged, flatFlags]
  );

  // Master/admin: dollars + percentages computed live. Store: RPC percentages.
  const summary = useMemo(() => {
    if (!privileged) return rpcSummary;
    return computePayrollSummary(
      merged.map((r) => ({ entry: r.mEntry, rate: r.mRate, pay: r.mPay }))
    );
  }, [privileged, rpcSummary, merged]);

  const totalPct = privileged ? summary?.totalPct : summary?.total_payroll_pct;
  const cstPct = privileged ? summary?.cstPct : summary?.cst_payroll_pct;
  const vstPct = privileged ? summary?.vstPct : summary?.vst_payroll_pct;
  const actualSales = privileged ? summary?.actualSales : summary?.actual_sales;

  const val = (empId, field, serverVal) => {
    const o = ov[empId];
    if (o && field in o) return o[field];
    return serverVal ?? "";
  };

  const onAdd = async () => {
    await addEmployee({ full_name: newName.trim(), position: newPos });
    setNewName("");
    setNewPos("tech");
  };

  return (
    <div>
      <SectionHeader
        title="Employee Hours & Payroll"
        subtitle={`${store.name}${privileged ? "" : " · pay figures are managed by the office"}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <GhostBtn onClick={() => setWeek((w) => shiftWeek(w, -1))}>
                <ChevronLeft className="h-4 w-4" />
              </GhostBtn>
              <div className="rounded-md border border-hairline-strong bg-surface-overlay px-3 py-2 text-sm font-medium text-content-primary">
                Week of {weekLabel(week)}
              </div>
              <GhostBtn onClick={() => setWeek((w) => shiftWeek(w, 1))}>
                <ChevronRight className="h-4 w-4" />
              </GhostBtn>
            </div>
            <GhostBtn onClick={() => exportPayrollCSV(store, week, merged, privileged, summary)} disabled={rows.length === 0}>
              <Download className="h-4 w-4" /> CSV
            </GhostBtn>
            <GhostBtn onClick={() => printPayroll(store, week, merged, privileged, summary)} disabled={rows.length === 0}>
              <Printer className="h-4 w-4" /> Print / PDF
            </GhostBtn>
          </div>
        }
      />

      {error && (
        <p className="mb-3 rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>
      )}

      {/* Payroll % summary */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryStat label="Actual Sales" value={actualSales == null ? "—" : money(actualSales)} />
        <SummaryStat label="Total Payroll %" value={pct(totalPct)} target={TARGETS.total} ratio={totalPct} />
        <SummaryStat label="CST % (mgr + front)" value={pct(cstPct)} target={TARGETS.cst} ratio={cstPct} />
        <SummaryStat label="VST % (techs)" value={pct(vstPct)} target={TARGETS.vst} ratio={vstPct} />
      </div>
      {privileged && summary && (
        <p className="mb-3 text-xs text-content-muted">
          Payroll dollars: <span className="font-semibold text-content-secondary">{money(summary.payrollDollars || 0)}</span>{" "}
          — visible to office roles only.
        </p>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-overlay text-left text-xs uppercase tracking-wide text-content-secondary">
            <tr>
              <Th className="text-left">Position</Th>
              <Th className="text-left">Employee</Th>
              <Th>PTO</Th>
              <Th>Clk Other</Th>
              <Th>Clk Here</Th>
              <Th>Total Hrs</Th>
              <Th>Turn Other</Th>
              <Th>Turn Here</Th>
              <Th>Total Turn</Th>
              <Th>Prod.</Th>
              <Th>Actual Sales</Th>
              <Th>Sales Req.</Th>
              <Th>% Goal</Th>
              <Th>WOs</Th>
              <Th>ARO</Th>
              <Th>FLAT</Th>
              {privileged && (
                <>
                  <Th className="border-l border-hairline-strong">Rate / Sal</Th>
                  <Th>Flat Rate</Th>
                  <Th>Hrly Earn</Th>
                  <Th>OT</Th>
                  <Th>Tot Hrly</Th>
                  <Th>Tot Flat</Th>
                  <Th>Bonus</Th>
                  <Th>Incent.</Th>
                  <Th>Paycheck</Th>
                </>
              )}
              <Th></Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {merged.map((r) => {
              const empId = r.employee.id;
              const sc = computeStoreRow(r.mEntry);
              const pc = privileged ? computePayRow(r.mEntry, r.mRate, r.mPay) : null;
              const isManager = r.employee.position === "manager";
              return (
                <tr key={empId} className="odd:bg-surface-stripe hover:bg-surface-overlay">
                  <td className="px-2 py-1.5">
                    <select
                      className="rounded border border-transparent bg-transparent py-1 text-sm text-content-primary outline-none focus:border-hairline-strong focus:bg-surface-overlay"
                      value={r.employee.position}
                      onChange={(e) => updateEmployee(empId, { position: e.target.value })}
                    >
                      {POSITIONS.map(([k, l]) => (
                        <option key={k} value={k}>{l}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      className="w-36 rounded border border-transparent bg-transparent px-1 py-1 text-sm font-medium text-content-primary outline-none focus:border-hairline-strong focus:bg-surface-overlay"
                      value={val(empId, "full_name", r.employee.full_name)}
                      onChange={(e) => {
                        setLocal(empId, "full_name", e.target.value);
                        const key = empId + ":full_name";
                        clearTimeout(timers.current[key]);
                        timers.current[key] = setTimeout(
                          () => updateEmployee(empId, { full_name: e.target.value }), 500
                        );
                      }}
                      placeholder="Name"
                    />
                  </td>
                  <NumCell {...{ empId, field: "pto_days", val, commit, server: r.mEntry.pto_days }} />
                  <NumCell {...{ empId, field: "clock_hours_other", val, commit, server: r.mEntry.clock_hours_other }} />
                  <NumCell {...{ empId, field: "clock_hours", val, commit, server: r.mEntry.clock_hours }} />
                  <td className={compCell}>{numOrDash(sc.totalHours)}</td>
                  <NumCell {...{ empId, field: "hrs_turned_other", val, commit, server: r.mEntry.hrs_turned_other }} />
                  <NumCell {...{ empId, field: "hrs_turned_here", val, commit, server: r.mEntry.hrs_turned_here }} />
                  <td className={compCell}>{numOrDash(sc.totalTurned)}</td>
                  <td className={compCell}>{sc.productivity == null ? "—" : sc.productivity.toFixed(2)}</td>
                  <NumCell {...{ empId, field: "actual_sales", val, commit, server: r.mEntry.actual_sales }} />
                  {/* Sales Required: master edits, store sees read-only */}
                  {privileged ? (
                    <NumCell {...{ empId, field: "sales_required", val, commit, server: r.mEntry.sales_required }} />
                  ) : (
                    <td className={roCell} title="Set by the office">
                      {r.mEntry.sales_required == null ? "—" : numOrDash(r.mEntry.sales_required)}
                    </td>
                  )}
                  <td className={compCell}>{pct(sc.pctOfGoal)}</td>
                  <NumCell {...{ empId, field: "work_orders", val, commit, server: r.mEntry.work_orders }} />
                  <td className={compCell}>{sc.aro == null ? "—" : sc.aro.toFixed(2)}</td>
                  <td className="px-1 py-1.5 text-center">
                    {r.flatFlag && (
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ backgroundColor: T.accentSoftBg, color: T.accentSoftText }}>FLAT</span>
                    )}
                  </td>

                  {privileged && (
                    <>
                      {/* Rate / Salary */}
                      <td className="border-l border-hairline-strong px-1 py-1.5 text-right">
                        {isManager ? (
                          <NumCell inline field="manager_salary" empId={empId} val={val} commit={commit} server={r.mRate.manager_salary} placeholder="salary" />
                        ) : (
                          <NumCell inline field="hourly_rate" empId={empId} val={val} commit={commit} server={r.mRate.hourly_rate} />
                        )}
                      </td>
                      <td className="px-1 py-1.5 text-right">
                        {isManager ? <span className="text-content-muted">x</span> : (
                          <NumCell inline field="flat_rate_per_hour" empId={empId} val={val} commit={commit} server={r.mRate.flat_rate_per_hour} />
                        )}
                      </td>
                      <td className={compCell}>{isManager ? "x" : money(pc.hourlyEarned)}</td>
                      <td className={compCell}>{isManager ? "x" : money(pc.otEarned)}</td>
                      <td className={compCell}>{isManager ? "x" : money(pc.totalHourly)}</td>
                      <td className={compCell}>{isManager ? "x" : money(pc.totalFlat)}</td>
                      <NumCell {...{ empId, field: "bonus", val, commit, server: r.mPay.bonus }} />
                      <NumCell {...{ empId, field: "incentives", val, commit, server: r.mPay.incentives }} />
                      <td className={compCell} style={{ color: T.accentSoftText }}>{money(pc.paycheck)}</td>
                    </>
                  )}

                  <td className="px-2 py-1.5 text-right">
                    <button onClick={() => setPendingRemove({ id: empId, name: r.employee.full_name })} className="text-content-muted hover:text-danger" title="Remove employee">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={privileged ? 26 : 17} className="px-4 py-10 text-center text-sm text-content-muted">
                  No employees on the roster yet. Add one below to start the week.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={privileged ? 26 : 17} className="px-4 py-10 text-center text-sm text-content-muted">Loading…</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Add employee to roster */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="w-48 rounded border border-hairline-strong bg-surface-overlay px-2 py-2 text-sm text-content-primary outline-none focus:border-hairline-strong"
          placeholder="New employee name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && newName.trim() && onAdd()}
        />
        <select
          className="rounded border border-hairline-strong bg-surface-overlay px-2 py-2 text-sm text-content-primary outline-none focus:border-hairline-strong"
          value={newPos}
          onChange={(e) => setNewPos(e.target.value)}
        >
          {POSITIONS.map(([k, l]) => (
            <option key={k} value={k}>{l}</option>
          ))}
        </select>
        <PrimaryBtn onClick={onAdd} disabled={!newName.trim()}>
          <Plus className="h-4 w-4" /> Add employee
        </PrimaryBtn>
        <p className="ml-auto text-xs text-content-muted">
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
  return inline ? (
    <input
      className={cell}
      value={val(empId, field, server)}
      onChange={(e) => commit(empId, field, e.target.value)}
      placeholder={placeholder}
      inputMode="decimal"
    />
  ) : (
    <td className="px-1 py-1.5 text-right">
      <input
        className={cell}
        value={val(empId, field, server)}
        onChange={(e) => commit(empId, field, e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
      />
    </td>
  );
}

function SummaryStat({ label, value, target, ratio }) {
  const over = target != null && ratio != null && ratio > target;
  return (
    <Card className="p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-content-secondary">{label}</p>
      <p className={"pgw-display mt-0.5 text-xl font-bold " + (over ? "text-danger" : "text-content-primary")}>{value}</p>
      {target != null && (
        <p className="text-[11px] text-content-muted">
          target ≤ {Math.round(target * 100)}%{over ? " · over" : ""}
        </p>
      )}
    </Card>
  );
}
