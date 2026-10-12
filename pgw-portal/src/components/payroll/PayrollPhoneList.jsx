import React, { useState } from "react";
import { ChevronDown, Lock, Wrench } from "lucide-react";
import { Card, T } from "../ui.jsx";
import { numOrDash } from "../../lib/format.js";
import { todayStr } from "../../lib/scheduleMath.js";
import { DayInput } from "./DayCell.jsx";

// Payroll on a phone: one day of the week at a time, one row per person,
// one big field for that day -- the 20-plus-column grid is unusable at
// 375px. Each person's weekly figures (PTO, sales, work orders, ...) open
// under their row. Both brand screens use it; each passes its own weekly
// field list, so the brand rules stay where they already live.

// Phones open on one day at a time; the whole-week grid stays a tap away.
export const PAYROLL_LAYOUTS = [["day", "One day"], ["grid", "Whole week"]];

const bigField =
  "h-11 w-20 rounded-md border border-hairline-strong bg-surface-input px-2 text-right text-base text-content-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent";

export function PayrollPhoneList({
  rows, dates, dayLabels, isDaily, dayMode, modeLabel, saveDay, onOpenProfile, positionLabel,
  totalHours, weekly, val, commit, loading,
}) {
  const today = todayStr();
  const [pick, setPick] = useState(null);
  const day = dates.includes(pick) ? pick : dates.includes(today) ? today : dates[0];
  const [open, setOpen] = useState(null);

  const dayTotal = (d) => rows.reduce((a, r) => a + (Number(r.days?.[d]?.[dayMode]) || 0), 0);

  // Enter moves to the next person's field for the same day.
  const onKeyDown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const fields = [...document.querySelectorAll("input[data-pay-day]")];
    const next = fields[fields.indexOf(e.currentTarget) + 1];
    if (next) { next.focus(); next.select?.(); } else e.currentTarget.blur();
  };

  return (
    <div className="space-y-3">
      {isDaily && (
        <Card className="grid grid-cols-7 gap-1 p-1.5">
          {dates.map((d, i) => {
            const active = d === day;
            const total = dayTotal(d);
            return (
              <button key={d} onClick={() => setPick(d)} aria-pressed={active}
                aria-label={`${dayLabels[i][1]} ${Number(d.slice(8, 10))}, ${numOrDash(total)} ${modeLabel.toLowerCase()}`}
                className={"rounded-md py-1.5 text-center " + (active ? "" : "hover:bg-surface-overlay")}
                style={active ? { backgroundColor: T.accentSoftBg } : undefined}>
                <span className={"block text-[10px] font-semibold uppercase " + (active ? "" : "text-content-muted")}
                  style={active ? { color: T.accentSoftText } : undefined}>{dayLabels[i][1]}</span>
                <span className={"block text-base font-bold " + (d === today ? "underline decoration-2 underline-offset-4 " : "") + "text-content-primary"}>
                  {Number(d.slice(8, 10))}
                </span>
                <span className="block text-[10px] text-content-muted">{total ? numOrDash(total) : "—"}</span>
              </button>
            );
          })}
        </Card>
      )}

      <Card className="overflow-hidden">
        {isDaily && (
          <div className="flex items-baseline justify-between border-b border-hairline bg-surface-overlay px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-content-secondary">
              {new Date(day + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
            </span>
            <span className="text-[11px] text-content-muted">{modeLabel}</span>
          </div>
        )}
        {loading && <p className="px-4 py-8 text-center text-sm text-content-muted">Loading…</p>}
        {!loading && rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-content-muted">No employees on the roster yet. Add one below to start the week.</p>
        )}
        {rows.map((r) => {
          const empId = r.employee.id;
          const expanded = open === empId;
          return (
            <div key={empId} className="border-b border-hairline last:border-b-0">
              <div className="flex min-h-[64px] items-center gap-2 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => onOpenProfile(empId)}
                    className="block max-w-full truncate text-left text-sm font-medium text-accent-text">
                    {r.employee.full_name?.trim() || "Unnamed"}
                  </button>
                  <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-content-muted">
                    <span>{positionLabel(r.employee.position)}</span>
                    <span>· week {numOrDash(totalHours(r))} h</span>
                    {r.techSourced && <span className="inline-flex items-center gap-0.5"><Wrench className="h-3 w-3" /> Tech Tracker</span>}
                    {r.employee.termination_date && <span>· last day {r.employee.termination_date}</span>}
                  </p>
                </div>
                {isDaily && (
                  <div className="flex h-11 min-w-[5rem] items-center justify-end text-base text-content-secondary">
                    <DayInput empId={empId} date={day} field={dayMode} day={r.days?.[day]} saveDay={saveDay}
                      className={bigField} data-pay-day enterKeyHint="next" onKeyDown={onKeyDown}
                      aria-label={`${r.employee.full_name} ${modeLabel.toLowerCase()}`} />
                  </div>
                )}
                <button type="button" onClick={() => setOpen(expanded ? null : empId)} aria-expanded={expanded}
                  aria-label={`${r.employee.full_name} week details`}
                  className="flex h-11 w-9 shrink-0 items-center justify-center text-content-muted">
                  <ChevronDown className={"h-4 w-4 transition-transform " + (expanded ? "rotate-180" : "")} />
                </button>
              </div>
              {expanded && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 bg-surface-page px-4 py-3">
                  {weekly(r).map((f) => (
                    <label key={f.label} className="block">
                      <span className="block text-[10px] font-semibold uppercase tracking-wide text-content-muted">{f.label}</span>
                      {f.field ? (
                        <input className={bigField + " w-full"} inputMode="decimal" placeholder={f.placeholder ?? "0"}
                          value={val(empId, f.field, f.server)} onChange={(e) => commit(empId, f.field, e.target.value)} />
                      ) : (
                        <span className="flex h-11 items-center gap-1 text-base font-semibold text-content-primary">
                          {f.value}
                          {f.locked && <Lock className="h-3 w-3 text-content-muted" aria-label={f.locked} />}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
