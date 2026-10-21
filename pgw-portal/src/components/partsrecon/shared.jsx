import React from "react";
import { STATUS } from "../../lib/partsRecon.js";

export const fmt$ = (n) =>
  n === null || n === undefined || n === "" ? "—"
    : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

export const fmtDate = (d) => {
  if (!d) return "";
  const x = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T12:00:00") : new Date(d);
  return isNaN(x) ? "" : x.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
};

const TONE = {
  good: "border-success-border bg-success-tint text-success",
  warn: "border-warning-border bg-warning-tint text-warning",
  bad: "border-danger-border bg-danger-tint text-danger",
  info: "border-hairline-strong bg-surface-overlay text-content-primary",
  muted: "border-hairline bg-surface-page text-content-muted",
};

export function Pill({ tone = "muted", children, title }) {
  return (
    <span title={title} className={"inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium " + (TONE[tone] ?? TONE.muted)}>
      {children}
    </span>
  );
}

export function StatusPill({ status }) {
  const s = STATUS[status];
  return <Pill tone={s?.tone} title={s?.hint}>{s?.label ?? status}</Pill>;
}

export function Notice({ tone = "info", children }) {
  const cls = tone === "error" ? "border-danger-border bg-danger-tint text-danger"
    : tone === "ok" ? "border-success-border bg-success-tint text-success"
    : tone === "warn" ? "border-warning-border bg-warning-tint text-warning"
    : "border-hairline bg-surface-page text-content-secondary";
  return <div className={"rounded-md border px-3 py-2 text-sm " + cls}>{children}</div>;
}

export function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface-card px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-content-muted">{label}</p>
      <p className="pgw-display text-lg font-bold text-content-primary">{value}</p>
      {sub && <p className="text-xs text-content-muted">{sub}</p>}
    </div>
  );
}

// Small segmented filter: options = [[key, label], ...]
export function Segmented({ options, value, onChange }) {
  return (
    <div className="inline-flex flex-wrap rounded-md border border-hairline-strong bg-surface-overlay p-0.5 text-sm" role="group">
      {options.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} aria-pressed={value === k}
          className={"rounded px-2.5 py-1 font-medium " + (value === k ? "bg-surface-raised text-content-primary" : "text-content-secondary hover:text-content-primary")}>
          {label}
        </button>
      ))}
    </div>
  );
}

export const selectSm = "rounded-md border border-hairline-strong bg-surface-input px-2 py-1.5 text-sm text-content-primary outline-none focus:border-accent";
