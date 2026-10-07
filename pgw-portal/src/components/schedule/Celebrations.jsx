import React from "react";
import { Cake, PartyPopper } from "lucide-react";
import { shortName } from "../../lib/scheduleMath.js";

// Birthday / work-anniversary lines for the schedule (migration 67).
// `compact` is the month-grid cell; otherwise the day modal's full names.
export function CelebrationLine({ c, compact = false }) {
  const Icon = c.kind === "birthday" ? Cake : PartyPopper;
  const what = c.kind === "birthday" ? "Birthday" : `${c.years} year${c.years === 1 ? "" : "s"}`;
  const where = c.store ? ` · #${c.store.number} ${c.store.name}` : "";
  const label = `${c.name} · ${c.kind === "birthday" ? "birthday" : `${what} with PGW`}${where}`;
  return (
    <div
      title={label}
      className={
        "flex items-center gap-1 truncate text-content-primary " +
        (compact ? "px-1 text-[11px] leading-tight" : "text-sm")
      }
    >
      <Icon className={(compact ? "h-3 w-3" : "h-4 w-4") + " shrink-0 text-accent"} aria-hidden="true" />
      {/* The name gives way before the years do, like a shift's code. */}
      <span className={"truncate font-medium" + (c.store && compact ? " min-w-[2.5rem]" : "")}>{compact ? shortName(c.name) : c.name}</span>
      {!(compact && c.kind === "birthday") && (
        <span className="shrink-0 text-content-secondary">· {compact ? `${c.years}y` : what}</span>
      )}
      {/* All-stores view (migration 79): which store they are at. In a
          narrow cell it gives way first, so the name always shows; the
          full store is in the hover text and the day's detail. */}
      {c.store && (
        <span className={(compact ? "min-w-0 truncate [flex-shrink:20]" : "shrink-0") + " text-content-muted"}>
          · #{c.store.number}{compact ? "" : ` ${c.store.name}`}
        </span>
      )}
    </div>
  );
}
