import React from "react";
import { AlertTriangle, X } from "lucide-react";
import { Card, GhostBtn } from "./ui.jsx";

// Small reusable "are you sure?" modal for destructive actions. Red confirm
// button; click-outside or the X cancels. Pass `busy` to disable while the
// action runs.
export function ConfirmDialog({ title, message, confirmLabel = "Confirm", onConfirm, onClose, busy = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <h3 className="pgw-display text-base font-bold text-white">{title}</h3>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        {message && <p className="mb-4 text-sm text-slate-300">{message}</p>}
        <div className="flex justify-end gap-2">
          <GhostBtn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </GhostBtn>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-red-500 focus:outline-none disabled:opacity-50"
          >
            {busy ? "Removing…" : confirmLabel}
          </button>
        </div>
      </Card>
    </div>
  );
}
