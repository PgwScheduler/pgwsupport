import React, { useState } from "react";
import { useAuth } from "../context/AuthProvider.jsx";
import { Card, Field, LogoMark, inputCls } from "./ui.jsx";

const MIN_LEN = 8;

export function SetPasswordScreen() {
  const { updatePassword, clearRecoveryMode, signOut } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_LEN) {
      setError(`Password must be at least ${MIN_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    const { error: updateError } = await updatePassword(password);
    setSubmitting(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    clearRecoveryMode();
  };

  const handleCancel = async () => {
    clearRecoveryMode();
    await signOut();
  };

  return (
    <div className="pgw-root flex min-h-screen items-center justify-center bg-surface-page p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <LogoMark size="lg" />
          <p className="text-xs uppercase tracking-widest text-content-muted">Operations Portal</p>
        </div>
        <Card className="p-5">
          <form onSubmit={handleSubmit}>
            <h1 className="pgw-display mb-1 text-xl font-bold text-content-primary">Set a new password</h1>
            <p className="mb-4 text-sm text-content-secondary">Choose a new password for your account.</p>
            <div className="space-y-3">
              <Field label="New password">
                <input
                  className={inputCls}
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label="Confirm new password">
                <input
                  className={inputCls}
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </Field>
              {error && <p className="text-sm text-danger">{error}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="mt-1 w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover focus:outline-none disabled:bg-surface-overlay disabled:text-content-disabled disabled:cursor-not-allowed"
              >
                {submitting ? "Saving…" : "Save password"}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                className="w-full text-center text-xs text-content-muted hover:text-content-secondary"
              >
                Cancel
              </button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
