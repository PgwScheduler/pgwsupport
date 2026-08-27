import React, { useMemo, useState } from "react";
import { Check, Lock, Minus, Search } from "lucide-react";
import { groupCatalog } from "../../lib/reportSpec.js";
import { inputCls } from "../ui.jsx";

// The measure picker, grouped by source. The list is whatever
// report_measure_catalog() returns for this user, so the sixty-odd
// category measures arrive as data and a category added to a brand
// appears here with no code change.
//
// The pay-breakdown group is absent for anyone but admin/master, and
// that is a COURTESY, not the control. report_build() refuses those
// measures on the way in; hiding the checkbox only spares a district
// manager from asking for something they will be told no about.

function Row({ checked, indeterminate, onClick, children, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={"flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-surface-overlay " + className}
    >
      <span
        className={
          "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border " +
          (!checked && !indeterminate ? "border-hairline-strong bg-surface-input" : "border-transparent")
        }
        style={!checked && !indeterminate ? {} : { backgroundColor: "var(--accent)", color: "var(--on-accent)" }}
      >
        {checked && <Check className="h-3 w-3" />}
        {indeterminate && !checked && <Minus className="h-3 w-3" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function MeasurePicker({ catalog, selected, onToggle, onSetGroup }) {
  const [q, setQ] = useState("");

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = groupCatalog(catalog);
    if (!needle) return all;
    return all
      .map((g) => ({
        ...g,
        measures: g.measures.filter(
          (m) =>
            m.label.toLowerCase().includes(needle) ||
            g.label.toLowerCase().includes(needle) ||
            m.measure_key.toLowerCase().includes(needle)
        ),
      }))
      .filter((g) => g.measures.length);
  }, [catalog, q]);

  const chosen = useMemo(() => new Set(selected), [selected]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-content-muted">{selected.length} selected</span>
        <div className="relative w-40">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-content-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a measure"
            className={inputCls + " !py-1 !pl-7 !text-xs"}
          />
        </div>
      </div>

      <div className="max-h-72 min-h-0 overflow-auto rounded-md border border-hairline bg-surface-page p-1.5">
        {groups.length === 0 && <p className="px-2 py-3 text-xs text-content-muted">No measure matches “{q}”.</p>}

        {groups.map((g) => {
          const keys = g.measures.map((m) => m.measure_key);
          const n = keys.filter((k) => chosen.has(k)).length;
          const restricted = g.measures.some((m) => m.restricted);
          return (
            <div key={g.label} className="mb-1.5 last:mb-0">
              <Row
                checked={n === keys.length && n > 0}
                indeterminate={n > 0 && n < keys.length}
                onClick={() => onSetGroup(keys, n !== keys.length)}
                className="text-[11px] font-semibold uppercase tracking-wide text-content-secondary"
              >
                <span className="flex items-center gap-1.5">
                  {g.label}
                  {restricted && <Lock className="h-3 w-3 text-content-muted" />}
                  <span className="ml-auto text-[10px] font-normal normal-case text-content-muted">{keys.length}</span>
                </span>
              </Row>
              {g.measures.map((m) => (
                <div key={m.measure_key} className="ml-3">
                  <Row
                    checked={chosen.has(m.measure_key)}
                    onClick={() => onToggle(m.measure_key)}
                    className="text-xs text-content-primary"
                  >
                    {m.label}
                  </Row>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
