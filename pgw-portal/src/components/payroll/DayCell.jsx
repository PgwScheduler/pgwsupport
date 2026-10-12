import React, { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { numOrDash } from "../../lib/format.js";

// Shared by both brand grids — payroll_daily is brand-agnostic, so a day
// cell behaves identically on a Midas and a SpeeDee store.

const cell =
  "w-16 rounded border border-hairline-strong bg-surface-overlay px-1 py-1 text-right text-sm text-content-primary outline-none focus:border-hairline-strong";
const roCell = "w-16 px-1 py-1 text-right text-sm text-content-secondary";

// One day's hours for one person.
//
// A day sourced from the Tech Tracker renders READ-ONLY. The figure is
// shown, because payroll has to see it, but it cannot be typed: one entry
// per person per day, in exactly one place. The database enforces the
// same rule (trg_payroll_daily_no_tech_overlap, migration 32), so this is
// the courteous version of a refusal that would happen anyway.
//
// Local draft state rather than a debounce: a keystroke should never race
// a write, and hours are committed on blur or Enter.
export function DayCell({ empId, date, field, day, saveDay, first, disabled }) {
  const edge = first ? " border-l border-hairline-strong" : "";
  const fromTech = day?.source === "tech";
  if (fromTech || disabled) {
    return (
      <td className={roCell + edge} title={fromTech ? "Entered in the Tech Tracker" : "Read-only"}>
        <DayInput {...{ empId, date, field, day, saveDay, disabled }} />
      </td>
    );
  }
  return (
    <td className={"px-1 py-1.5 text-right" + edge}>
      <DayInput {...{ empId, date, field, day, saveDay }} className={cell} />
    </td>
  );
}

// The cell's content without the <td>, so the phone list can use the same
// draft-and-commit behaviour with a bigger field.
export function DayInput({ empId, date, field, day, saveDay, disabled, className = cell, ...rest }) {
  const server = day?.[field] ?? 0;
  const fromTech = day?.source === "tech";
  const [draft, setDraft] = useState(null);

  // Drop any draft when the cell is pointed at something else — a week
  // change, a mode change, or a refetch after a rejected write.
  useEffect(() => { setDraft(null); }, [date, field, empId]);

  if (fromTech || disabled) {
    return (
      <span className="inline-flex items-center gap-1" title={fromTech ? "Entered in the Tech Tracker" : "Read-only"}>
        {numOrDash(server)}
        {fromTech && <Lock className="h-3 w-3 text-content-muted" aria-label="From the Tech Tracker" />}
      </span>
    );
  }

  const commitCell = () => {
    if (draft == null) return;
    const n = draft === "" ? 0 : Number(draft);
    setDraft(null);
    if (!Number.isFinite(n) || n === Number(server)) return;
    saveDay(empId, date, { [field]: n });
  };

  return (
    <input
      className={className}
      value={draft ?? (server === 0 ? "" : server)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commitCell}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      inputMode="decimal"
      placeholder="0"
      {...rest}
    />
  );
}

// Which figure the seven day columns show. Every weekly TOTAL stays on
// screen whichever is selected, so switching mode hides nothing — it only
// decides which of them is editable by day.
export function DayModeToggle({ modes, value, onChange }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-hairline-strong bg-surface-overlay p-0.5">
      {modes.map(([k, label]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={
            "rounded px-2 py-1.5 text-xs font-medium transition-colors " +
            (value === k
              ? "bg-surface-raised text-content-primary"
              : "text-content-muted hover:text-content-secondary")
          }
          title={`Show and edit ${label.toLowerCase()} by day`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
