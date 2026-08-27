import React from "react";
// The dark-UI master: the wordmark is lightened so "PALMETTO GARAGE
// WORKS" reads on the near-black sidebar, and the tire stays dark. The
// raw original is transparent but 42% near-black with an entirely black
// wordmark, which disappears completely on this theme — it must not be
// used here. `pgw-logo-reverse-480w.png` sits alongside as the
// everything-reversed-to-light alternate, unused unless BDC prefers it.
import logo480 from "../assets/logo/pgw-logo-dark-ui-480w.png";

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

// Intrinsic pixels of the master asset. Passed as width/height attributes
// so the browser knows the aspect ratio BEFORE the image loads and can
// reserve the space — without them the sidebar header reflows as the
// logo arrives, because the CSS sets a height and lets width follow.
const LOGO_W = 480;
const LOGO_H = 248;

// Sizes are heights; the width always follows from the aspect ratio.
// The sidebar is w-60 (240px) less p-4 padding, so ~200px is the usable
// width — h-20 lands at 155px and leaves the wordmark comfortably
// readable without crowding the rail.
const LOGO_HEIGHTS = { sm: "h-10", md: "h-16", lg: "h-20", xl: "h-24" };

// Sits directly on the surface: no plate, no card, no border. The old
// white plate existed only because the black wordmark was invisible on
// near-black; the dark-UI master removes that need.
export function LogoMark({ size = "lg", className = "" }) {
  return (
    <img
      src={logo480}
      width={LOGO_W}
      height={LOGO_H}
      alt="Palmetto Garage Works"
      className={(LOGO_HEIGHTS[size] ?? LOGO_HEIGHTS.lg) + " w-auto " + className}
    />
  );
}
