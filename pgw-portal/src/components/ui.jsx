import React from "react";
import logo from "../assets/pgw-logo.png";

// Accent tokens for the few places that set color via inline style (active nav,
// badges). These resolve to the same CSS variables the Tailwind names use, so
// there is still a single source of truth in src/index.css.
export const T = {
  accent: "var(--accent)",
  accentText: "var(--on-accent)",
  accentSoftBg: "var(--accent-tint)",
  accentSoftText: "var(--accent-text)",
};

export const inputCls =
  "w-full rounded-md border border-hairline-strong bg-surface-input px-3 py-2 text-sm text-content-primary placeholder-content-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent";

export function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-content-secondary">{label}</span>
      {children}
    </label>
  );
}

export function Card({ children, className = "", ...rest }) {
  return <div className={"rounded-xl border border-hairline bg-surface-card " + className} {...rest}>{children}</div>;
}

export function Empty({ icon: Icon, title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-hairline-strong bg-surface-card px-6 py-12 text-center">
      {Icon && <Icon className="mb-3 h-7 w-7 text-content-muted" />}
      <p className="text-sm font-medium text-content-primary">{title}</p>
      {hint && <p className="mt-1 text-xs text-content-muted">{hint}</p>}
    </div>
  );
}

export function PrimaryBtn({ children, className = "", ...p }) {
  return (
    <button
      {...p}
      className={"inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover focus:outline-none disabled:bg-surface-overlay disabled:text-content-disabled disabled:cursor-not-allowed " + className}
    >
      {children}
    </button>
  );
}

export function GhostBtn({ children, className = "", ...p }) {
  return (
    <button
      {...p}
      className={"inline-flex items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-overlay px-3 py-2 text-sm font-medium text-content-primary hover:bg-hairline-strong focus:outline-none " + className}
    >
      {children}
    </button>
  );
}

export function SectionHeader({ title, subtitle, action }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="pgw-display text-lg font-bold text-content-primary">{title}</h2>
        {subtitle && <p className="text-sm text-content-secondary">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function LogoMark({ size = "sm" }) {
  const h = size === "lg" ? "h-14" : "h-8";
  return (
    <div className={"inline-flex items-center justify-center rounded-lg bg-surface-inverse " + (size === "lg" ? "px-4 py-3" : "px-2.5 py-1.5")}>
      <img src={logo} alt="Palmetto Garage Works" className={h + " w-auto"} />
    </div>
  );
}
