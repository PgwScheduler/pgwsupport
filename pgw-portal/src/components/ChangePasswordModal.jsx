import React, { useState } from "react";
import { X } from "lucide-react";
import { useAuth } from "../context/AuthProvider.jsx";
import { supabase } from "../lib/supabaseClient.js";
import { Card, Field, PrimaryBtn, inputCls } from "./ui.jsx";

const MIN_LEN = 8;

export function ChangePasswordModal({ onClose }) {
  const { user, updatePassword } = useAuth();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_LEN) {
      setError(`New password must be at least ${MIN_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    if (password === current) {
      setError("New password must be different from your current one.");
      return;
    }
    setSubmitting(true);

    // Re-authenticate to confirm the current password is correct before changing it.
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: current,
    });
    if (signInError) {
      setSubmitting(false);
      setError("Current password is incorrect.");
      return;
    }

    const { error: updateError } = await updatePassword(password);
    setSubmitting(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDone(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="pgw-display text-base font-bold text-content-primary">Change password</h3>
          <button onClick={onClose} className="rounded-md p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary">
            <X className="h-5 w-5" />
          </button>
        </div>

        {done ? (
          <div className="space-y-3">
            <p className="text-sm text-content-secondary">Your password has been updated.</p>
            <PrimaryBtn onClick={onClose} className="w-full justify-center">Done</PrimaryBtn>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <Field label="Current password">
              <input
                className={inputCls}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label="New password">
              <input
                className={inputCls}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="Confirm new password">
              <input
                className={inputCls}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            {error && <p className="text-sm text-danger">{error}</p>}
            <PrimaryBtn type="submit" disabled={submitting} className="w-full justify-center">
              {submitting ? "Saving…" : "Update password"}
            </PrimaryBtn>
          </form>
        )}
      </Card>
    </div>
  );
}
