import React, { useEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, T } from "../ui.jsx";
import { inMonth, weekSummary, fmtTime, fmtHours, shortName } from "../../lib/scheduleMath.js";
import { shiftColorVar } from "../../lib/shiftTypes.js";
import { CelebrationLine } from "./Celebrations.jsx";

const weekOf = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

// Per-employee hours for one Monday-Sunday week. Shared by the month grid's
// expanded row and the phone agenda.
export function WeekHoursDetail({ week, summary, className = "" }) {
  return (
    <div className={"bg-surface-overlay px-4 py-3 " + className}>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-secondary">
        Week of {weekOf(week[0])} — per employee
      </p>
      {summary.employees.length === 0 ? (
        <p className="text-sm text-content-muted">No shifts scheduled this week.</p>
      ) : (
        <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {summary.employees.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-content-primary">{e.name}</span>
              <span className="flex-shrink-0 font-medium text-content-secondary">{fmtHours(e.hours)} h</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The schedule on a phone: one row per day, every shift listed in full
// (the 8-column month grid leaves each day ~40px wide there). Tapping a day
// opens the same day panel as the grid. Days outside the month stay, dimmed,
// because each week's hours count the whole Monday-Sunday week.
export function ScheduleAgenda({ grid, byDate, typesById, month, today, celebrations, maxCelebrations,
  readOnly, expandedWeek, setExpandedWeek, onOpenDay }) {
  // Open on this week rather than the 1st; once per month shown.
  const todayRef = useRef(null);
  const scrolledFor = useRef(null);
  useEffect(() => {
    if (!todayRef.current || scrolledFor.current === grid[0]?.[0]) return;
    scrolledFor.current = grid[0]?.[0];
    todayRef.current.scrollIntoView({ block: "start" });
  }, [grid]);

  return (
    <div className="space-y-3">
      {grid.map((week, wi) => {
        const summary = weekSummary(week, byDate, typesById);
        const expanded = expandedWeek === wi;
        return (
          <div key={week[0]} ref={week.includes(today) ? todayRef : undefined} className="scroll-mt-3">
            <Card className="overflow-hidden">
              <button onClick={() => setExpandedWeek(expanded ? null : wi)} aria-expanded={expanded}
                className="flex w-full items-center justify-between bg-surface-overlay px-3 py-2.5 text-left">
                <span className="text-xs font-semibold uppercase tracking-wide text-content-secondary">Week of {weekOf(week[0])}</span>
                <span className="flex items-center gap-1 text-sm font-bold text-content-primary">
                  {fmtHours(summary.total)} <span className="text-[10px] font-medium uppercase text-content-muted">hrs</span>
                  <ChevronDown className={"h-4 w-4 text-content-muted transition-transform " + (expanded ? "rotate-180" : "")} />
                </span>
              </button>
              {expanded && <WeekHoursDetail week={week} summary={summary} className="border-t border-hairline" />}
  
              {week.map((date) => {
                const shifts = byDate[date] ?? [];
                const dayCelebrations = celebrations[date] ?? [];
                const dim = !inMonth(date, month);
                const isToday = date === today;
                const d = new Date(date + "T00:00:00");
                return (
                  <button key={date} onClick={() => onOpenDay(date)}
                    aria-label={`${d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}, ${shifts.length} shift${shifts.length === 1 ? "" : "s"}`}
                    className={"flex w-full items-start gap-3 border-t border-hairline px-3 py-2.5 text-left active:bg-surface-overlay " + (dim ? "bg-surface-page" : "")}>
                    <div className="w-11 shrink-0 pt-0.5 text-center">
                      <p className={"text-[10px] font-semibold uppercase tracking-wide " + (dim ? "text-content-muted" : "text-content-secondary")}>
                        {d.toLocaleDateString(undefined, { weekday: "short" })}
                      </p>
                      <p className={"mx-auto mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-base font-bold " + (dim ? "text-content-muted" : "text-content-primary")}
                        style={isToday ? { backgroundColor: T.accent, color: T.accentText } : undefined}>
                        {d.getDate()}
                      </p>
                    </div>
                    <div className="min-w-0 flex-1 space-y-1 py-0.5">
                      {dayCelebrations.slice(0, maxCelebrations).map((c) => <CelebrationLine key={c.kind + c.id} c={c} compact />)}
                      {maxCelebrations && dayCelebrations.length > maxCelebrations && (
                        <p className="text-xs font-medium" style={{ color: T.accentSoftText }}>
                          +{dayCelebrations.length - maxCelebrations} more
                        </p>
                      )}
                      {shifts.length === 0 && dayCelebrations.length === 0 && (
                        <p className="py-1 text-sm text-content-muted">{readOnly || dim ? "No shifts" : "No shifts · tap to add"}</p>
                      )}
                      {shifts.map((s) => {
                        const t = s.shift_type_id ? typesById[s.shift_type_id] : null;
                        const abbr = t?.abbreviation?.trim();
                        return (
                          <div key={s.id} title={t ? t.name : undefined}
                            className="flex items-center gap-2 rounded bg-surface-overlay px-2 py-1.5 text-sm text-content-primary"
                            style={t ? { borderLeft: `3px solid ${shiftColorVar(t.color_token)}` } : undefined}>
                            <span className={"min-w-0 flex-1 truncate font-medium " + (s.employee_id ? "" : "italic text-content-secondary")}>
                              {s.employee_id ? shortName(s.employee?.full_name) : "Unassigned"}
                            </span>
                            <span className="shrink-0 text-content-secondary">{fmtTime(s.start_time)}–{fmtTime(s.end_time)}</span>
                            {abbr && (
                              <span className="w-9 shrink-0 text-right text-xs font-bold" style={{ color: shiftColorVar(t.color_token) }}>{abbr}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-content-muted" />
                  </button>
                );
              })}
            </Card>
          </div>
        );
      })}
    </div>
  );
}
