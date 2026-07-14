import React from "react";
import logo from "../assets/pgw-logo.png";

export const T = {
  accent: "#F5A623",
  accentText: "#141821",
  accentSoftBg: "rgba(245,166,35,0.14)",
  accentSoftText: "#F6B24A",
};

export const inputCls =
  "w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-600";

export function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}

export function Card({ children, className = "", ...rest }) {
  return <div className={"rounded-xl border border-slate-800 bg-slate-900 " + className} {...rest}>{children}</div>;
}

export function Empty({ icon: Icon, title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900 px-6 py-12 text-center">
      {Icon && <Icon className="mb-3 h-7 w-7 text-slate-600" />}
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function PrimaryBtn({ children, className = "", ...p }) {
  return (
    <button
      {...p}
      style={{ backgroundColor: T.accent, color: T.accentText }}
      className={"inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-semibold hover:opacity-90 focus:outline-none disabled:opacity-50 " + className}
    >
      {children}
    </button>
  );
}

export function GhostBtn({ children, className = "", ...p }) {
  return (
    <button
      {...p}
      className={"inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 focus:outline-none " + className}
    >
      {children}
    </button>
  );
}

export function SectionHeader({ title, subtitle, action }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="pgw-display text-lg font-bold text-white">{title}</h2>
        {subtitle && <p className="text-sm text-slate-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function LogoMark({ size = "sm" }) {
  const h = size === "lg" ? "h-14" : "h-8";
  return (
    <div className={"inline-flex items-center justify-center rounded-lg bg-white " + (size === "lg" ? "px-4 py-3" : "px-2.5 py-1.5")}>
      <img src={logo} alt="Palmetto Garage Works" className={h + " w-auto"} />
    </div>
  );
}
