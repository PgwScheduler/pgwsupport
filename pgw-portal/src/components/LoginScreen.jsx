import React, { useState } from "react";
import { useAuth } from "../context/AuthProvider.jsx";
import { Card, Field, LogoMark, T, inputCls } from "./ui.jsx";

export function LoginScreen() {
  const { signIn, authError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    setSubmitting(true);
    await signIn(email, password);
    setSubmitting(false);
  };

  return (
    <div className="pgw-root flex min-h-screen items-center justify-center bg-slate-950 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <LogoMark size="lg" />
          <p className="text-xs uppercase tracking-widest text-slate-500">Operations Portal</p>
        </div>
        <Card className="p-5">
          <form onSubmit={handleSubmit}>
            <h1 className="pgw-display mb-1 text-xl font-bold text-white">Sign in</h1>
            <p className="mb-4 text-sm text-slate-400">Use your store or office login.</p>
            <div className="space-y-3">
              <Field label="Email">
                <input
                  className={inputCls}
                  type="email"
                  autoComplete="email"
                  placeholder="you@pgwsupport.com"
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
              {authError && <p className="text-sm text-red-400">{authError}</p>}
              <button
                type="submit"
                disabled={submitting}
                style={{ backgroundColor: T.accent, color: T.accentText }}
                className="mt-1 w-full rounded-md px-4 py-2.5 text-sm font-semibold hover:opacity-90 focus:outline-none disabled:opacity-60"
              >
                {submitting ? "Signing in…" : "Sign in"}
              </button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
