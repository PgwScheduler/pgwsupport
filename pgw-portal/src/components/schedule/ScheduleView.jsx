import React, { useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { useSchedule } from "../../hooks/useSchedule.js";
import { SectionHeader, Card, GhostBtn, T } from "../ui.jsx";
import { inMonth, weekSummary, fmtTime, fmtHours, shortName, todayStr } from "../../lib/scheduleMath.js";
import { DayDetailModal } from "./DayDetailModal.jsx";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_VISIBLE = 3; // shifts shown per day cell before "+N more"

export function ScheduleView({ store }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-based
  const [openDay, setOpenDay] = useState(null);
  const [expandedWeek, setExpandedWeek] = useState(null);

  const { grid, byDate, roster, loading, error, addShift, updateShift, deleteShift } = useSchedule(store, year, month);

  const monthInputValue = `${year}-${String(month + 1).padStart(2, "0")}`;
  const today = todayStr();

  const shiftMonth = (delta) => {
    let m = month + delta;
    let y = year;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    setMonth(m);
    setYear(y);
    setExpandedWeek(null);
  };

  const onPickMonth = (e) => {
    const [y, m] = e.target.value.split("-").map(Number);
    if (y && m) {
      setYear(y);
      setMonth(m - 1);
      setExpandedWeek(null);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Employee Schedule"
        subtitle={`#${store.store_number} · ${store.name}`}
        action={
          <div className="flex items-center gap-2">
            <GhostBtn onClick={() => shiftMonth(-1)} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </GhostBtn>
            <input
              type="month"
              value={monthInputValue}
              onChange={onPickMonth}
              className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-slate-500"
            />
            <GhostBtn onClick={() => shiftMonth(1)} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </GhostBtn>
          </div>
        }
      />

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <Card className="overflow-hidden">
        <div className="grid grid-cols-8 border-b border-slate-800 bg-slate-950/40 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {WEEKDAYS.map((d) => (
            <div key={d} className="px-2 py-2">
              {d}
            </div>
          ))}
          <div className="px-2 py-2 text-right">Hours</div>
        </div>

        <div className="grid grid-cols-8">
          {grid.map((week, wi) => {
            const summary = weekSummary(week, byDate);
            const expanded = expandedWeek === wi;
            return (
              <React.Fragment key={week[0]}>
                {week.map((date) => {
                  const dayShifts = byDate[date] ?? [];
                  const dim = !inMonth(date, month);
                  const isToday = date === today;
                  const dnum = Number(date.slice(8, 10));
                  return (
                    <button
                      key={date}
                      onClick={() => setOpenDay(date)}
                      className={
                        "min-h-[112px] border-b border-r border-slate-800 p-1.5 text-left align-top hover:bg-slate-800/40 " +
                        (dim ? "bg-slate-950/30" : "")
                      }
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span
                          className={
                            isToday
                              ? "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold"
                              : "text-xs font-medium " + (dim ? "text-slate-600" : "text-slate-300")
                          }
                          style={isToday ? { backgroundColor: T.accent, color: T.accentText } : {}}
                        >
                          {dnum}
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {dayShifts.slice(0, MAX_VISIBLE).map((s) => (
                          <div
                            key={s.id}
                            className="truncate rounded bg-slate-800/70 px-1 py-0.5 text-[11px] leading-tight text-slate-200"
                          >
                            <span className="font-medium">{shortName(s.employee?.full_name)}</span>{" "}
                            <span className="text-slate-400">
                              {fmtTime(s.start_time)}–{fmtTime(s.end_time)}
                            </span>
                          </div>
                        ))}
                        {dayShifts.length > MAX_VISIBLE && (
                          <div className="px-1 text-[11px] font-medium" style={{ color: T.accentSoftText }}>
                            +{dayShifts.length - MAX_VISIBLE} more
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}

                <button
                  onClick={() => setExpandedWeek(expanded ? null : wi)}
                  className="min-h-[112px] border-b border-slate-800 bg-slate-950/40 p-2 text-right hover:bg-slate-800/40"
                >
                  <div className="flex items-center justify-end gap-1 text-sm font-bold text-white">
                    {fmtHours(summary.total)}
                    <ChevronDown
                      className={"h-3.5 w-3.5 text-slate-500 transition-transform " + (expanded ? "rotate-180" : "")}
                    />
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">hrs</div>
                </button>

                {expanded && (
                  <div className="col-span-8 border-b border-slate-800 bg-slate-950/60 px-4 py-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Week of{" "}
                      {new Date(week[0] + "T00:00:00").toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      — per employee
                    </p>
                    {summary.employees.length === 0 ? (
                      <p className="text-sm text-slate-500">No shifts scheduled this week.</p>
                    ) : (
                      <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                        {summary.employees.map((e) => (
                          <div key={e.id} className="flex items-center justify-between gap-3 text-sm">
                            <span className="truncate text-slate-200">{e.name}</span>
                            <span className="flex-shrink-0 font-medium text-slate-400">{fmtHours(e.hours)} h</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </Card>

      {loading && <p className="mt-3 text-sm text-slate-500">Loading…</p>}

      {openDay && (
        <DayDetailModal
          store={store}
          date={openDay}
          roster={roster}
          shifts={byDate[openDay] ?? []}
          onClose={() => setOpenDay(null)}
          addShift={addShift}
          updateShift={updateShift}
          deleteShift={deleteShift}
        />
      )}
    </div>
  );
}
