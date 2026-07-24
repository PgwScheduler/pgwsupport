import React, { useMemo, useState } from "react";
import { X, Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { Card, Field, PrimaryBtn, GhostBtn, inputCls } from "../ui.jsx";
import { fmtTime, fmtHours, shiftHours, toMinutes, overlaps } from "../../lib/scheduleMath.js";

const prettyDate = (date) =>
  new Date(date + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

const blankForm = { employee_id: "", start_time: "09:00", end_time: "17:00", notes: "" };

// Day detail: lists the day's shifts with edit/delete, plus an add/edit form.
// Validates end > start in the UI (the db check enforces it too) and warns —
// without blocking — on an overlap with the same employee's other shifts.
export function DayDetailModal({ store, date, roster, shifts, onClose, addShift, updateShift, deleteShift }) {
  const [form, setForm] = useState(blankForm);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const endAfterStart = toMinutes(form.end_time) > toMinutes(form.start_time);

  const overlapWarning = useMemo(() => {
    if (!form.employee_id || !endAfterStart) return false;
    return shifts.some(
      (s) =>
        s.id !== editingId &&
        s.employee_id === form.employee_id &&
        overlaps(form.start_time, form.end_time, s.start_time, s.end_time)
    );
  }, [form, shifts, editingId, endAfterStart]);

  const startEdit = (s) => {
    setEditingId(s.id);
    setForm({
      employee_id: s.employee_id,
      start_time: String(s.start_time).slice(0, 5),
      end_time: String(s.end_time).slice(0, 5),
      notes: s.notes ?? "",
    });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(blankForm);
    setError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.employee_id) return setError("Choose an employee.");
    if (!endAfterStart) return setError("End time must be after start time.");
    setBusy(true);
    const payload = {
      employee_id: form.employee_id,
      shift_date: date,
      start_time: form.start_time,
      end_time: form.end_time,
      notes: form.notes,
    };
    const { error: err } = editingId ? await updateShift(editingId, payload) : await addShift(payload);
    setBusy(false);
    if (err) {
      return setError(
        /duplicate|unique/i.test(err.message)
          ? "That employee already has a shift starting at this time."
          : err.message
      );
    }
    cancelEdit();
  };

  const remove = async (id) => {
    setBusy(true);
    await deleteShift(id);
    setBusy(false);
    if (editingId === id) cancelEdit();
  };

  const empName = (s) =>
    s.employee?.full_name || roster.find((r) => r.id === s.employee_id)?.full_name || "—";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <Card className="max-h-[90vh] w-full max-w-lg overflow-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="pgw-display text-base font-bold text-content-primary">{prettyDate(date)}</h3>
            <p className="text-xs text-content-muted">
              #{store.store_number} · {store.name}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-4 space-y-1.5">
          {shifts.length === 0 ? (
            <p className="text-sm text-content-muted">No shifts scheduled.</p>
          ) : (
            shifts.map((s) => (
              <div
                key={s.id}
                className={
                  "flex items-center justify-between rounded-md border px-3 py-2 " +
                  (editingId === s.id ? "border-hairline-strong bg-surface-overlay" : "border-hairline bg-surface-overlay")
                }
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-content-primary">{empName(s)}</p>
                  <p className="text-xs text-content-secondary">
                    {fmtTime(s.start_time)}–{fmtTime(s.end_time)} · {fmtHours(shiftHours(s.start_time, s.end_time))} h
                    {s.notes ? ` · ${s.notes}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => startEdit(s)}
                    className="rounded p-1.5 text-content-secondary hover:bg-surface-overlay hover:text-content-primary"
                    title="Edit shift"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => remove(s.id)}
                    disabled={busy}
                    className="rounded p-1.5 text-content-secondary hover:bg-surface-overlay hover:text-danger disabled:text-content-disabled disabled:cursor-not-allowed"
                    title="Delete shift"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <form onSubmit={submit} className="space-y-3 border-t border-hairline pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-content-secondary">
            {editingId ? "Edit shift" : "Add shift"}
          </p>
          <Field label="Employee">
            <select className={inputCls} value={form.employee_id} onChange={set("employee_id")}>
              <option value="">Select employee…</option>
              {roster.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.full_name || "(unnamed)"}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <input type="time" className={inputCls} value={form.start_time} onChange={set("start_time")} />
            </Field>
            <Field label="End">
              <input type="time" className={inputCls} value={form.end_time} onChange={set("end_time")} />
            </Field>
          </div>
          {endAfterStart && (
            <p className="text-xs text-content-muted">{fmtHours(shiftHours(form.start_time, form.end_time))} scheduled hours</p>
          )}
          <Field label="Note (optional)">
            <input className={inputCls} value={form.notes} onChange={set("notes")} placeholder="e.g. covering front" />
          </Field>

          {overlapWarning && (
            <p className="flex items-center gap-1.5 rounded-md border border-warning-border bg-warning-tint px-2.5 py-1.5 text-xs text-warning">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              This overlaps another shift for the same employee. You can still save it.
            </p>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex items-center gap-2">
            <PrimaryBtn type="submit" disabled={busy}>
              {editingId ? (
                "Save changes"
              ) : (
                <>
                  <Plus className="h-4 w-4" /> Add shift
                </>
              )}
            </PrimaryBtn>
            {editingId && (
              <GhostBtn type="button" onClick={cancelEdit}>
                Cancel
              </GhostBtn>
            )}
          </div>
        </form>
      </Card>
    </div>
  );
}
