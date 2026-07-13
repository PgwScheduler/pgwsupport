import React, { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Printer, Plus, Trash2 } from "lucide-react";
import { useEmployeeHours } from "../hooks/useEmployeeHours.js";
import { DAYS, thisWeekStart, weekLabel, shiftWeek, sumDays } from "../lib/weekUtils.js";
import { exportHoursCSV, printHours } from "../lib/hoursExport.js";
import { Card, GhostBtn, SectionHeader, T } from "./ui.jsx";

const cellCls =
  "w-14 rounded border border-slate-700 bg-slate-800 px-1.5 py-1 text-center text-sm text-slate-100 outline-none focus:border-slate-500";

export function HoursView({ store }) {
  const [week, setWeek] = useState(() => thisWeekStart());
  const { rows, loading, error, addRow, updateRowLocal, saveRow, deleteRow } = useEmployeeHours(store.id, week);
  const timers = useRef({});

  const weekTotal = rows.reduce((a, r) => a + sumDays(r), 0);
  const turnedTotal = rows.reduce((a, r) => a + (Number(r.hours_turned) || 0), 0);

  const commit = (id, field, patch) => {
    updateRowLocal(id, patch);
    const key = id + ":" + field;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => saveRow(id, patch), 500);
  };

  const onNameChange = (id, value) => commit(id, "employee_name", { employee_name: value });
  const onDayChange = (id, day, value) =>
    commit(id, day, { [day]: value === "" ? 0 : Number(value) || 0 });
  const onTurnedChange = (id, value) =>
    commit(id, "hours_turned", { hours_turned: value === "" ? null : Number(value) || 0 });
  const onNotesChange = (id, value) => commit(id, "notes", { notes: value });

  return (
    <div>
      <SectionHeader
        title="Employee Hours"
        subtitle={store.name}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <GhostBtn onClick={() => setWeek((w) => shiftWeek(w, -1))}>
                <ChevronLeft className="h-4 w-4" />
              </GhostBtn>
              <div className="rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200">
                Week of {weekLabel(week)}
              </div>
              <GhostBtn onClick={() => setWeek((w) => shiftWeek(w, 1))}>
                <ChevronRight className="h-4 w-4" />
              </GhostBtn>
            </div>
            <div className="flex items-center gap-2">
              <GhostBtn onClick={() => exportHoursCSV(store, week, rows)} disabled={rows.length === 0}>
                <Download className="h-4 w-4" /> CSV
              </GhostBtn>
              <GhostBtn onClick={() => printHours(store, week, rows)} disabled={rows.length === 0}>
                <Printer className="h-4 w-4" /> Print / PDF
              </GhostBtn>
            </div>
          </div>
        }
      />

      {error && (
        <p className="mb-3 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-2.5">Employee</th>
              {DAYS.map(([k, l]) => (
                <th key={k} className="px-2 py-2.5 text-center">{l}</th>
              ))}
              <th className="px-2 py-2.5 text-center">Total</th>
              <th className="px-2 py-2.5 text-center">Hrs Turned</th>
              <th className="px-3 py-2.5">Notes</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2">
                  <input
                    className="w-40 rounded border border-transparent bg-transparent px-1 py-1 text-sm font-medium text-white outline-none focus:border-slate-600 focus:bg-slate-800"
                    value={r.employee_name ?? ""}
                    onChange={(e) => onNameChange(r.id, e.target.value)}
                    placeholder="Name"
                  />
                </td>
                {DAYS.map(([k]) => (
                  <td key={k} className="px-1 py-2 text-center">
                    <input
                      className={cellCls}
                      value={r[k] ?? ""}
                      onChange={(e) => onDayChange(r.id, k, e.target.value)}
                    />
                  </td>
                ))}
                <td className="px-2 py-2 text-center font-semibold text-white">{sumDays(r)}</td>
                <td className="px-2 py-2 text-center">
                  <input
                    className={cellCls}
                    style={{ borderColor: T.accentSoftText }}
                    value={r.hours_turned ?? ""}
                    onChange={(e) => onTurnedChange(r.id, e.target.value)}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    className="w-44 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100 outline-none focus:border-slate-500"
                    value={r.notes ?? ""}
                    onChange={(e) => onNotesChange(r.id, e.target.value)}
                    placeholder="e.g. covering from #3936"
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => deleteRow(r.id)}
                    className="text-slate-600 hover:text-red-400"
                    title="Delete row"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center text-sm text-slate-500">
                  No hours logged for this week. Add an employee to start.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={11} className="px-4 py-10 text-center text-sm text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-slate-700 bg-slate-800/40 font-semibold text-white">
                <td className="px-4 py-2 text-xs uppercase tracking-wide text-slate-400">Week total</td>
                {DAYS.map(([k]) => (
                  <td key={k} className="px-1 py-2 text-center text-slate-300">
                    {rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)}
                  </td>
                ))}
                <td className="px-2 py-2 text-center">{weekTotal}</td>
                <td className="px-2 py-2 text-center" style={{ color: T.accentSoftText }}>{turnedTotal}</td>
                <td></td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </Card>
      <div className="mt-3 flex items-center justify-between">
        <GhostBtn onClick={addRow}>
          <Plus className="h-4 w-4" /> Add employee
        </GhostBtn>
        <p className="text-xs text-slate-500">Tap a cell to fix a mistype — changes save automatically.</p>
      </div>
    </div>
  );
}
