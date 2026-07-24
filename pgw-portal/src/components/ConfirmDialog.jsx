import React from "react";
import { AlertTriangle, X } from "lucide-react";
import { Card, GhostBtn } from "./ui.jsx";

// Small reusable "are you sure?" modal for destructive actions. Red confirm
// button; click-outside or the X cancels. Pass `busy` to disable while the
// action runs.
export function ConfirmDialog({ title, message, confirmLabel = "Confirm", onConfirm, onClose, busy = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-danger-tint text-danger">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <h3 className="pgw-display text-base font-bold text-content-primary">{title}</h3>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary">
            <X className="h-5 w-5" />
          </button>
        </div>
        {message && <p className="mb-4 text-sm text-content-secondary">{message}</p>}
        <div className="flex justify-end gap-2">
          <GhostBtn type="button" onClick={onClose} disabled={busy}>
            Cancel
          </GhostBtn>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-danger px-3.5 py-2 text-sm font-semibold text-content-primary hover:bg-danger-hover focus:outline-none disabled:text-content-disabled disabled:cursor-not-allowed"
          >
            {busy ? "Removing…" : confirmLabel}
          </button>
        </div>
      </Card>
    </div>
  );
}
