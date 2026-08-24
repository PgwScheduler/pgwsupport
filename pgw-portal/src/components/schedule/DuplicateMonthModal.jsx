import React, { useEffect, useState } from "react";
import { X, AlertTriangle, Copy } from "lucide-react";
import { Card, PrimaryBtn, GhostBtn, Field, inputCls } from "../ui.jsx";

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const monthLabel = (iso) => {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
const firstOf = (iso) => `${iso}-01`;

// Duplicate a month of shifts onto another month.
//
// Nothing writes until the user confirms a summary, and the summary comes
// from the same server-side plan the commit runs — so what they approve is
// what happens. Replace mode additionally needs a second confirmation that
// names the month and the number of shifts it will delete, because it is
// the only path here that destroys existing work in bulk.
export function DuplicateMonthModal({ store, year, month, canReplace, previewCopy, commitCopy, onClose, onDone }) {
  const thisMonth = `${year}-${String(month + 1).padStart(2, "0")}`;
  const nextMonth = (() => {
    const d = new Date(year, month + 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();

  const [source, setSource] = useState(thisMonth);
  const [target, setTarget] = useState(nextMonth);
  const [mode, setMode] = useState("fill");
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [done, setDone] = useState(null);

  const sameMonth = source === target;

  // Re-preview whenever the inputs move. Read-only on the server.
  useEffect(() => {
    let live = true;
    setDone(null);
    setConfirmReplace(false);
    if (sameMonth) { setPlan(null); setErr("Pick two different months."); return; }
    setErr(null);
    setBusy(true);
    previewCopy(firstOf(source), firstOf(target), mode).then(({ data, error }) => {
      if (!live) return;
      setBusy(false);
      if (error) { setErr(error.message); setPlan(null); }
      else setPlan(data);
    });
    return () => { live = false; };
  }, [source, target, mode, sameMonth, previewCopy]);

  const run = async () => {
    setBusy(true);
    setErr(null);
    const { data, error } = await commitCopy(firstOf(source), firstOf(target), mode);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setDone(data);
    onDone?.();
  };

  const s = plan?.skipped ?? {};
  const names = plan?.inactive_names ?? [];
  const nothingToDo = plan && plan.to_create === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <Card className="w-full max-w-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="pgw-display text-base font-bold text-content-primary">
            Duplicate a month · #{store.store_number}
          </h3>
          <button onClick={onClose} className="text-content-muted hover:text-content-primary">
            <X className="h-4 w-4" />
          </button>
        </div>

        {done ? (
          <>
            <div className="rounded-lg border border-success-border bg-success-tint p-4">
              <p className="text-sm font-semibold text-content-primary">
                {done.created} shift{done.created === 1 ? "" : "s"} created in {monthLabel(done.target_month)}
              </p>
              {done.to_delete > 0 && (
                <p className="mt-1 text-xs text-content-secondary">
                  {done.to_delete} existing shift{done.to_delete === 1 ? "" : "s"} were replaced.
                </p>
              )}
            </div>
            <div className="mt-5 flex justify-end">
              <PrimaryBtn onClick={onClose}>Done</PrimaryBtn>
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Copy from">
                <input type="month" className={inputCls} value={source}
                  onChange={(e) => setSource(e.target.value)} />
              </Field>
              <Field label="Copy to">
                <input type="month" className={inputCls} value={target}
                  onChange={(e) => setTarget(e.target.value)} />
              </Field>
            </div>

            <fieldset className="mt-4">
              <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-content-secondary">
                If the target month already has shifts
              </legend>
              <label className="flex items-start gap-2 py-1">
                <input type="radio" name="mode" checked={mode === "fill"} onChange={() => setMode("fill")} className="mt-1" />
                <span className="text-sm text-content-primary">
                  Fill empty only
                  <span className="ml-1 text-xs text-content-muted">
                    — leaves every existing shift untouched
                  </span>
                </span>
              </label>
              <label className={"flex items-start gap-2 py-1 " + (canReplace ? "" : "opacity-50")}>
                <input type="radio" name="mode" checked={mode === "replace"} disabled={!canReplace}
                  onChange={() => setMode("replace")} className="mt-1" />
                <span className="text-sm text-content-primary">
                  Replace
                  <span className="ml-1 text-xs text-content-muted">
                    — clears the target month first{canReplace ? "" : " · admin only"}
                  </span>
                </span>
              </label>
            </fieldset>

            {/* Preview. Nothing has been written at this point. */}
            <div className="mt-4 rounded-lg border border-hairline bg-surface-page p-4">
              {busy && !plan ? (
                <p className="text-sm text-content-muted">Working out the copy…</p>
              ) : err ? (
                <p className="text-sm text-danger">{err}</p>
              ) : plan ? (
                <>
                  <p className="text-sm font-semibold text-content-primary">
                    Copy {monthLabel(plan.source_month)} → {monthLabel(plan.target_month)}
                  </p>
                  <p className="mt-1 text-sm text-content-primary">
                    {plan.to_create} shift{plan.to_create === 1 ? "" : "s"} will be created
                  </p>
                  <ul className="mt-1 space-y-0.5 text-xs text-content-muted">
                    {s.time_off > 0 && <li>{s.time_off} skipped — time-off types are not duplicated</li>}
                    {s.inactive > 0 && (
                      <li>
                        {s.inactive} skipped — {names.join(", ")}{" "}
                        {names.length === 1 ? "is" : "are"} no longer active at this location
                      </li>
                    )}
                    {s.existing > 0 && (
                      <li>{s.existing} skipped — {monthLabel(plan.target_month)} already has shifts on those days (Fill empty only)</li>
                    )}
                    {s.overflow > 0 && (
                      <li>{s.overflow} skipped — those weeks run past the end of {monthLabel(plan.target_month)}</li>
                    )}
                  </ul>
                  {mode === "replace" && plan.to_delete > 0 && (
                    <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-warning">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {plan.to_delete} existing shift{plan.to_delete === 1 ? "" : "s"} in {monthLabel(plan.target_month)} will be deleted first.
                    </p>
                  )}
                  {nothingToDo && (
                    <p className="mt-2 text-xs text-content-muted">Nothing would be created — nothing will be written.</p>
                  )}
                </>
              ) : null}
            </div>

            {/* Replace needs a second, explicit confirmation naming both the
                month and the count, so the destructive half is never one click. */}
            {mode === "replace" && plan && plan.to_delete > 0 && (
              <label className="mt-3 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-tint p-3">
                <input type="checkbox" checked={confirmReplace} className="mt-0.5"
                  onChange={(e) => setConfirmReplace(e.target.checked)} />
                <span className="text-xs text-content-secondary">
                  I understand this permanently deletes{" "}
                  <span className="font-semibold text-content-primary">
                    {plan.to_delete} shift{plan.to_delete === 1 ? "" : "s"} in {monthLabel(plan.target_month)}
                  </span>{" "}
                  before copying.
                </span>
              </label>
            )}

            <p className="mt-3 text-[11px] text-content-muted">
              Time off, sick and holiday entries are never duplicated. Shifts for employees who have left
              are skipped. The whole copy runs as one transaction — if any part fails, nothing is written.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <GhostBtn onClick={onClose} disabled={busy}>Cancel</GhostBtn>
              <PrimaryBtn
                onClick={run}
                disabled={
                  busy || !plan || !!err || nothingToDo ||
                  (mode === "replace" && plan.to_delete > 0 && !confirmReplace)
                }>
                <Copy className="mr-1 inline h-3.5 w-3.5" />
                {mode === "replace" ? "Replace and copy" : "Copy shifts"}
              </PrimaryBtn>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
