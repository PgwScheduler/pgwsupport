import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus, Lock, Check } from "lucide-react";
import { Card } from "../ui.jsx";
import { moneyCell, pct } from "../../lib/format.js";
import { daySales, dayPotential } from "../../lib/ticSheetMath.js";
import { SUMMARY_COLS, num, numToStr, toNum } from "../../lib/ticSheetFields.js";

// The tic sheet one day at a time -- the layout a manager gets on a phone,
// where the 20-odd-column month grid is unusable. Same data, same saves:
// every field commits on its own as soon as it changes, exactly like a grid
// cell. Mounted with key={day.iso}, so moving to another day starts clean.

const EDIT_COLS = SUMMARY_COLS.filter((s) => s.type === "edit");
const STEP_DELAY = 600; // ms of quiet after the last +/- tap before it saves

const dayTitle = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

function lockReason(day, readOnly) {
  if (readOnly) return "Read-only";
  if (day.isFuture) return "Not here yet — nothing to enter";
  if (day.isSunday) return "Sunday — closed";
  if (day.isHoliday) return "Holiday — closed";
  return null;
}

const bigInput =
  "h-11 rounded-md border border-hairline-strong bg-surface-input px-2 text-base text-content-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";
const stepBtn =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-surface-overlay text-content-primary active:bg-hairline-strong disabled:text-content-disabled";

export function TicDayEntry({
  day, categories, row, units, laborSales, monthUnits, monthlyGoal, readOnly,
  canGoBack, canGoForward, onStep, saveSummary, saveUnit, onSaved, onOpenSales,
}) {
  const reason = lockReason(day, readOnly);
  const locked = !!reason;

  // Field keys: "u<categoryId>" for a service unit, the column key otherwise.
  const stored = (key) => (!SUMMARY_COLS.some((s) => s.key === key)
    ? num(units?.[key.slice(1)]) : num(row?.[key]));
  const [vals, setVals] = useState(() => {
    const o = {};
    for (const c of categories) o["u" + c.id] = numToStr(units?.[c.id]);
    for (const s of EDIT_COLS) o[s.key] = numToStr(row?.[s.key]);
    return o;
  });
  const valsRef = useRef(vals);
  valsRef.current = vals;

  // What was last sent per field, so a commit fires only on a real change and
  // never compares against a row that has not come back yet.
  const sent = useRef(null);
  if (sent.current === null) {
    sent.current = {};
    for (const c of categories) sent.current["u" + c.id] = stored("u" + c.id);
    for (const s of EDIT_COLS) sent.current[s.key] = stored(s.key);
  }
  // One save in flight per field, in order: rapid +/- taps can never land
  // out of sequence and leave the earlier number standing.
  const chains = useRef({});
  const timers = useRef({});
  const [pending, setPending] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState(null);

  const commit = (key) => {
    clearTimeout(timers.current[key]);
    delete timers.current[key];
    const isUnit = !SUMMARY_COLS.some((s) => s.key === key);
    const kind = isUnit ? "int" : SUMMARY_COLS.find((s) => s.key === key).kind;
    const val = toNum(valsRef.current[key], kind);
    if (val === sent.current[key]) return;
    const prev = sent.current[key];
    sent.current[key] = val;
    setPending((n) => n + 1);
    const run = async () => {
      const { error } = isUnit
        ? await saveUnit(day.iso, categories.find((c) => "u" + c.id === key).id, val)
        : await saveSummary(day.iso, { [key]: val });
      if (error) sent.current[key] = prev; // the next change retries
      else setLastSavedAt(Date.now());
      setPending((n) => n - 1);
      onSaved(error ?? null);
    };
    // Nothing queued: start now, not a microtask later -- the flush on
    // unmount must reach the sheet before a month change reloads it.
    const p = chains.current[key] ? chains.current[key].then(run) : run();
    chains.current[key] = p;
    p.then(() => { if (chains.current[key] === p) delete chains.current[key]; });
  };

  // Moving to another day (or another screen) must not drop a +/- tap that
  // is still waiting out its delay.
  useEffect(() => () => {
    for (const key of Object.keys(timers.current)) commit(key);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setVal = (key, v) => setVals((p) => ({ ...p, [key]: v }));
  const bump = (key, delta) => {
    const next = Math.max(0, toNum(valsRef.current[key], "int") + delta);
    const str = numToStr(next);
    valsRef.current = { ...valsRef.current, [key]: str };
    setVal(key, str);
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => commit(key), STEP_DELAY);
  };

  // Enter (the keyboard's "Next") moves to the next field down the form.
  const formRef = useRef(null);
  const onKeyDown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const fields = [...(formRef.current?.querySelectorAll("input[data-entry]") ?? [])];
    const i = fields.indexOf(e.currentTarget);
    if (fields[i + 1]) { fields[i + 1].focus(); fields[i + 1].select?.(); } else e.currentTarget.blur();
  };

  const sales = daySales(row, laborSales);
  const potential = dayPotential(row, laborSales);
  const ro = num(row?.ro_count);

  const status = locked ? reason
    : pending > 0 ? "Saving…"
    : lastSavedAt ? "Saved"
    : "Changes save as you go";

  const numberField = (key, kind, label) => (
    locked ? (
      <span className="w-28 text-right text-base text-content-secondary">
        {kind === "money" ? (stored(key) ? moneyCell(stored(key)) : "—") : numToStr(stored(key)) || "—"}
      </span>
    ) : (
      <input type="number" data-entry aria-label={label}
        inputMode={kind === "int" ? "numeric" : "decimal"} step={kind === "int" ? "1" : "0.01"} min="0"
        enterKeyHint="next" placeholder="0"
        className={bigInput + " w-28 text-right"} value={vals[key]}
        onChange={(e) => setVal(key, e.target.value)}
        onBlur={() => commit(key)} onKeyDown={onKeyDown} />
    )
  );

  return (
    <div ref={formRef}>
      {/* Day picker */}
      <Card className="mb-3 flex items-center gap-2 p-2">
        <button onClick={() => onStep(-1)} disabled={!canGoBack} aria-label="Previous day" className={stepBtn}>
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="pgw-display truncate text-base font-bold text-content-primary">{dayTitle(day.iso)}</p>
          <p className={"flex items-center justify-center gap-1 text-xs " + (locked ? "text-content-muted" : status === "Saved" ? "text-success" : "text-content-muted")}
            aria-live="polite">
            {locked && <Lock className="h-3 w-3" />}
            {status === "Saved" && <Check className="h-3 w-3" />}
            {status}
          </p>
        </div>
        <button onClick={() => onStep(1)} disabled={!canGoForward} aria-label="Next day" className={stepBtn}>
          <ChevronRight className="h-5 w-5" />
        </button>
      </Card>

      {/* Day totals */}
      <Card className="mb-3 overflow-hidden">
        <h3 className="border-b border-hairline px-4 py-2 text-xs font-semibold uppercase tracking-wide text-content-secondary">Day totals</h3>
        {SUMMARY_COLS.filter((s) => s.type !== "calc").map((s) => (
          <div key={s.key} className="flex min-h-[56px] items-center justify-between gap-3 border-b border-hairline px-4 py-1.5">
            <span className="text-sm font-medium text-content-primary">{s.label}</span>
            {s.type === "sales" ? (
              // The Sales figure is built from its breakdown; tapping it opens
              // the same panel the grid's Sales cell does.
              <button onClick={onOpenSales} disabled={!day.editable}
                className="flex h-11 items-center gap-1 rounded-md px-2 text-base text-content-primary underline decoration-dotted underline-offset-4 disabled:no-underline disabled:text-content-muted">
                {sales === 0 ? (locked ? "—" : "Enter") : moneyCell(sales)}
                {day.editable && <ChevronRight className="h-4 w-4 text-content-muted" />}
              </button>
            ) : numberField(s.key, s.kind, s.label)}
          </div>
        ))}
        <div className="grid grid-cols-3 divide-x divide-hairline bg-surface-page text-center">
          {[
            ["Potential", potential !== 0 ? moneyCell(potential) : "—"],
            ["Avg / car", ro > 0 ? moneyCell(potential / ro) : "—"],
            ["Capture", potential !== 0 ? pct(sales / potential, 1) : "—"],
          ].map(([label, v]) => (
            <div key={label} className="px-2 py-2">
              <p className="text-[10px] font-medium uppercase tracking-wide text-content-muted">{label}</p>
              <p className="text-sm font-semibold text-content-primary">{v}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Service units */}
      <Card className="overflow-hidden">
        <div className="flex items-baseline justify-between border-b border-hairline px-4 py-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-content-secondary">Service units</h3>
          <span className="text-[11px] text-content-muted">month to date · goal</span>
        </div>
        {categories.map((c) => {
          const key = "u" + c.id;
          const mtd = monthUnits[c.id] ?? 0;
          const goal = monthlyGoal[c.id];
          return (
            <div key={c.id} className="flex min-h-[60px] items-center gap-2 border-b border-hairline px-4 py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight text-content-primary">{c.display_name}</p>
                <p className="text-[11px] text-content-muted">
                  {mtd} so far{goal ? ` · goal ${goal.toFixed(1)}` : ""}
                </p>
              </div>
              {locked ? (
                <span className="w-16 text-center text-base text-content-secondary">{numToStr(stored(key)) || "—"}</span>
              ) : (
                <>
                  <button type="button" onClick={() => bump(key, -1)} disabled={toNum(vals[key], "int") === 0}
                    aria-label={`One fewer ${c.display_name}`} className={stepBtn}>
                    <Minus className="h-4 w-4" />
                  </button>
                  <input type="number" data-entry aria-label={c.display_name}
                    inputMode="numeric" min="0" step="1" enterKeyHint="next" placeholder="0"
                    className={bigInput + " w-14 text-center"} value={vals[key]}
                    onChange={(e) => setVal(key, e.target.value)}
                    onBlur={() => commit(key)} onKeyDown={onKeyDown} />
                  <button type="button" onClick={() => bump(key, 1)}
                    aria-label={`One more ${c.display_name}`} className={stepBtn}>
                    <Plus className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
