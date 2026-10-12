import React, { useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Card } from "../ui.jsx";
import { money, numOrDash } from "../../lib/format.js";

// The Tech Tracker one day at a time -- the layout a manager gets on a
// phone. The per-tech grid makes the end-of-day entry a matter of switching
// tech nine times and scrolling sideways each time; here every tech is a row
// with the day's three figures. Same saves as the grid (tech_daily, on blur),
// and the pay engine still computes whole weeks behind it.

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const shift = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return isoOf(d); };

const FIELDS = [
  ["hours_worked", "Hours", "hours"],
  ["flag_hours", "Flag hrs", "flag"],
  ["labor_sales", "Labor $", "labor"],
];

const bigInput =
  "h-11 w-full rounded-md border border-hairline-strong bg-surface-input px-2 text-right text-base text-content-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";
const stepBtn =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-surface-overlay text-content-primary disabled:text-content-disabled";

export function TechDayEntry({ slotViews, slotName, from, to, day, onPickDay, saveDaily }) {
  const listRef = useRef(null);

  // Each slot's computed day for the chosen date (the weeks already carry
  // hours/flag/labor/ELR for every day of every week touched by the range).
  const rows = useMemo(() => slotViews
    .slice()
    .sort((a, b) => a.slot.slot_index - b.slot.slot_index)
    .map((sv) => {
      const d = sv.weeks.flatMap((w) => w.days).find((x) => x.iso === day);
      return { sv, d: d ?? { hours: 0, flag: 0, labor: 0, elr: 0 } };
    }), [slotViews, day]);

  const total = rows.reduce((a, { d }) => ({
    hours: a.hours + (Number(d.hours) || 0),
    flag: a.flag + (Number(d.flag) || 0),
    labor: a.labor + (Number(d.labor) || 0),
  }), { hours: 0, flag: 0, labor: 0 });

  const commit = (slotId, field, el, prev) => {
    const raw = el.value.trim();
    const val = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(val) || val === Number(prev || 0)) return;
    saveDaily(slotId, day, { [field]: val });
  };

  // Enter (the keyboard's "Next") walks Hours -> Flag -> Labor -> next tech.
  const onKeyDown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const fields = [...(listRef.current?.querySelectorAll("input") ?? [])];
    const next = fields[fields.indexOf(e.currentTarget) + 1];
    if (next) { next.focus(); next.select?.(); } else e.currentTarget.blur();
  };

  const title = new Date(day + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  return (
    <div className="mb-5">
      <Card className="mb-3 flex items-center gap-2 p-2">
        <button onClick={() => onPickDay(shift(day, -1))} disabled={day <= from} aria-label="Previous day" className={stepBtn}>
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="pgw-display truncate text-base font-bold text-content-primary">{title}</p>
          <p className="text-xs text-content-muted">Changes save as you leave each field</p>
        </div>
        <button onClick={() => onPickDay(shift(day, 1))} disabled={day >= to} aria-label="Next day" className={stepBtn}>
          <ChevronRight className="h-5 w-5" />
        </button>
      </Card>

      <Card className="overflow-hidden">
        {rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-content-muted">No technician slots set up yet. Use Per tech to add one.</p>
        )}
        {/* Keyed by day: a new day starts from its own stored values. */}
        <div ref={listRef} key={day}>
          {rows.map(({ sv, d }) => {
            const name = slotName(sv, sv.slot.slot_index);
            const staffed = !!sv.slot.employee_id;
            return (
              <div key={sv.slot.id} className="border-b border-hairline px-4 py-3">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-content-primary">
                    <span className="mr-1 text-content-muted">{sv.slot.slot_index}.</span>{name}
                  </p>
                  <span className="shrink-0 text-[11px] text-content-muted">
                    {staffed ? `ELR ${d.elr ? money(d.elr) : "—"}` : "No technician in this slot"}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {FIELDS.map(([field, label, key]) => (
                    <label key={field} className="block">
                      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-content-muted">{label}</span>
                      <input type="number" inputMode="decimal" step="0.01" enterKeyHint="next" placeholder="0"
                        aria-label={`${name} ${label}`}
                        defaultValue={d[key] ? String(d[key]) : ""}
                        className={bigInput}
                        onKeyDown={onKeyDown}
                        onBlur={(e) => commit(sv.slot.id, field, e.target, d[key])} />
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {rows.length > 0 && (
          <div className="grid grid-cols-3 gap-2 bg-surface-overlay px-4 py-2.5 text-right">
            <div><p className="text-[10px] uppercase tracking-wide text-content-muted">Day hours</p><p className="text-sm font-semibold text-content-primary">{numOrDash(total.hours)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wide text-content-muted">Day flag</p><p className="text-sm font-semibold text-content-primary">{numOrDash(total.flag)}</p></div>
            <div><p className="text-[10px] uppercase tracking-wide text-content-muted">Day labor</p><p className="text-sm font-semibold text-content-primary">{money(total.labor)}</p></div>
          </div>
        )}
      </Card>
    </div>
  );
}
