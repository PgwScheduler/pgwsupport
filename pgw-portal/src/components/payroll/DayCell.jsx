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
  const server = day?.[field] ?? 0;
  const fromTech = day?.source === "tech";
  const [draft, setDraft] = useState(null);

  // Drop any draft when the cell is pointed at something else — a week
  // change, a mode change, or a refetch after a rejected write.
  useEffect(() => { setDraft(null); }, [date, field, empId]);

  const edge = first ? " border-l border-hairline-strong" : "";

  if (fromTech || disabled) {
    return (
      <td
        className={roCell + edge}
        title={fromTech ? "Entered in the Tech Tracker" : "Read-only"}
      >
        <span className="inline-flex items-center gap-1">
          {numOrDash(server)}
          {fromTech && <Lock className="h-3 w-3 text-content-muted" />}
        </span>
      </td>
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
    <td className={"px-1 py-1.5 text-right" + edge}>
      <input
        className={cell}
        value={draft ?? (server === 0 ? "" : server)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitCell}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        inputMode="decimal"
        placeholder="0"
      />
    </td>
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
