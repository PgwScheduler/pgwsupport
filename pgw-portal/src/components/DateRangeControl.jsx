import React, { useEffect, useRef, useState } from "react";
import { Calendar, ChevronDown, Check } from "lucide-react";
import { useDateRange } from "../context/DateRangeProvider.jsx";
import { PRESETS, rangeLabel, rangeFor, daysBetween } from "../lib/dateRange.js";

// The shared range picker. Built once, used on the Dashboard, the Tech
// Tracker and Payroll — the range itself lives in DateRangeProvider, so
// changing it here changes it everywhere for the rest of the session.
//
// Custom is two plain date inputs with NO min/max: any start, any end,
// any length, across months and years freely. The only correction made
// is swapping a backwards pair, which is a slip rather than an intent.
export function DateRangeControl({ className = "" }) {
  const { preset, from, to, setPreset, setCustom } = useDateRange();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from, to });
  const wrap = useRef(null);

  useEffect(() => { setDraft({ from, to }); }, [from, to]);

  // Close on an outside click or Escape — a menu that traps the pointer
  // is worse than one that closes a little eagerly.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (key) => {
    if (key === "custom") { setPreset("custom"); return; } // keep the menu open to pick dates
    setPreset(key);
    setOpen(false);
  };

  const applyCustom = () => {
    if (!draft.from || !draft.to) return;
    setCustom(draft.from, draft.to);
    setOpen(false);
  };

  const days = from && to ? daysBetween(from, to) : 0;

  return (
    <div ref={wrap} className={"relative " + className}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md border border-hairline-strong bg-surface-overlay px-3 py-2 text-sm font-medium text-content-primary hover:bg-surface-raised"
        title="Change the date range"
      >
        <Calendar className="h-4 w-4 text-content-muted" />
        <span>{rangeLabel(from, to)}</span>
        <span className="text-xs font-normal text-content-muted">
          {PRESETS.find(([k]) => k === preset)?.[1]}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-content-muted" />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-hairline-strong bg-surface-card p-1 shadow-xl">
          {PRESETS.map(([key, label]) => {
            const active = preset === key;
            // Show each preset's actual span, so "Last 3 months" is not a
            // guess about what the portal means by it.
            const r = key === "custom" ? null : rangeFor(key);
            return (
              <button
                key={key}
                onClick={() => choose(key)}
                className={
                  "flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-sm " +
                  (active ? "bg-surface-overlay text-content-primary" : "text-content-secondary hover:bg-surface-overlay")
                }
              >
                <span className="flex items-center gap-1.5">
                  {active ? <Check className="h-3.5 w-3.5" /> : <span className="w-3.5" />}
                  {label}
                </span>
                {r && (
                  <span className="text-[11px] text-content-muted">{rangeLabel(r.from, r.to)}</span>
                )}
              </button>
            );
          })}

          {preset === "custom" && (
            <div className="mt-1 border-t border-hairline p-2">
              <div className="flex items-center gap-2">
                <label className="flex-1">
                  <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-content-muted">From</span>
                  <input
                    type="date"
                    value={draft.from ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                    className="w-full rounded border border-hairline-strong bg-surface-overlay px-1.5 py-1 text-xs text-content-primary outline-none"
                  />
                </label>
                <label className="flex-1">
                  <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-content-muted">To</span>
                  <input
                    type="date"
                    value={draft.to ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                    className="w-full rounded border border-hairline-strong bg-surface-overlay px-1.5 py-1 text-xs text-content-primary outline-none"
                  />
                </label>
              </div>
              <button
                onClick={applyCustom}
                disabled={!draft.from || !draft.to}
                className="mt-2 w-full rounded px-2 py-1.5 text-xs font-semibold disabled:opacity-40"
                style={{ backgroundColor: "var(--accent)", color: "var(--on-accent)" }}
              >
                Apply
              </button>
            </div>
          )}

          <p className="border-t border-hairline px-2.5 py-1.5 text-[11px] text-content-muted">
            {days} day{days === 1 ? "" : "s"} · weeks run Sunday–Saturday
          </p>
        </div>
      )}
    </div>
  );
}
