import React, { useState } from "react";
import { useAuth } from "../context/AuthProvider.jsx";
import { Card, Field, LogoMark, inputCls } from "./ui.jsx";

export function LoginScreen() {
  const { signIn, authError, requestPasswordReset } = useAuth();
  const [mode, setMode] = useState("signin"); // "signin" | "forgot"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resetError, setResetError] = useState(null);
  const [resetSent, setResetSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    setSubmitting(true);
    await signIn(email, password);
    setSubmitting(false);
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (!email) return;
    setResetError(null);
    setSubmitting(true);
    const { error } = await requestPasswordReset(email);
    setSubmitting(false);
    if (error) setResetError(error.message);
    else setResetSent(true);
  };

  const goForgot = () => {
    setMode("forgot");
    setResetError(null);
    setResetSent(false);
  };

  const goSignin = () => {
    setMode("signin");
    setResetError(null);
    setResetSent(false);
  };

  return (
    <div className="pgw-root flex min-h-screen items-center justify-center bg-surface-page p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <LogoMark size="lg" />
          <p className="text-xs uppercase tracking-widest text-content-muted">Operations Portal</p>
        </div>
        <Card className="p-5">
          {mode === "signin" ? (
            <form onSubmit={handleSubmit}>
              <h1 className="pgw-display mb-1 text-xl font-bold text-content-primary">Sign in</h1>
              <p className="mb-4 text-sm text-content-secondary">Use your store or office login.</p>
              <div className="space-y-3">
                <Field label="Email">
                  <input
                    className={inputCls}
                    type="email"
                    autoComplete="email"
                    placeholder="you@pgwus.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field label="Password">
                  <input
                    className={inputCls}
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                {authError && <p className="text-sm text-danger">{authError}</p>}
                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-1 w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover focus:outline-none disabled:bg-surface-overlay disabled:text-content-disabled disabled:cursor-not-allowed"
                >
                  {submitting ? "Signing in…" : "Sign in"}
                </button>
                <button
                  type="button"
                  onClick={goForgot}
                  className="w-full text-center text-xs text-content-muted hover:text-content-secondary"
                >
                  Forgot password?
                </button>
              </div>
            </form>
          ) : resetSent ? (
            <div>
              <h1 className="pgw-display mb-1 text-xl font-bold text-content-primary">Check your email</h1>
              <p className="mb-4 text-sm text-content-secondary">
                If an account exists for <span className="text-content-primary">{email}</span>, we've sent a link to
                reset your password. Follow it to choose a new one.
              </p>
              <button
                type="button"
                onClick={goSignin}
                className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover focus:outline-none"
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleReset}>
              <h1 className="pgw-display mb-1 text-xl font-bold text-content-primary">Reset password</h1>
              <p className="mb-4 text-sm text-content-secondary">
                Enter your account email and we'll send you a link to set a new password.
              </p>
              <div className="space-y-3">
                <Field label="Email">
                  <input
                    className={inputCls}
                    type="email"
                    autoComplete="email"
                    placeholder="you@pgwus.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                {resetError && <p className="text-sm text-danger">{resetError}</p>}
                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-1 w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover focus:outline-none disabled:bg-surface-overlay disabled:text-content-disabled disabled:cursor-not-allowed"
                >
                  {submitting ? "Sending…" : "Send reset link"}
                </button>
                <button
                  type="button"
                  onClick={goSignin}
                  className="w-full text-center text-xs text-content-muted hover:text-content-secondary"
                >
                  Back to sign in
                </button>
              </div>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
