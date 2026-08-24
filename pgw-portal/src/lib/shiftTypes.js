// Shift-type presentation helpers for the Employee Schedule.
//
// A catalog row's `color_token` names a CSS custom property directly:
// 'shift-blue' resolves to var(--shift-blue) in index.css. That keeps the
// database naming a token rather than a hex, and needs no Tailwind
// safelist — the class names are never built by string concatenation.
//
// The allowlist is a guard, not a second source of truth. Only admin and
// master can write the catalog, but a typo there would otherwise render an
// invisible shift block; an unknown token falls back to the neutral colour
// so a mistyped row looks plain rather than disappearing.
export const SHIFT_TOKENS = [
  "shift-neutral", "shift-blue", "shift-slate",
  "shift-violet", "shift-teal", "shift-green", "shift-magenta",
];

const FALLBACK = "shift-neutral";

export const shiftColorVar = (token) =>
  `var(--${SHIFT_TOKENS.includes(token) ? token : FALLBACK})`;

// A null shift_type_id means an ordinary worked shift and MUST render
// exactly as it did before shift types existed: no colour bar, no
// abbreviation. Everything below keys off the catalog row, never off the
// column merely existing.
export const isTyped = (shift) => !!shift?.shift_type_id;

// Hours only count when the catalog says they do. An untyped shift counts —
// that is the pre-existing behaviour and the default for a worked shift.
// Unpaid time off and an open/unassigned placeholder do not: an open shift
// is a staffing gap, not somebody's hours, and must not inflate the weekly
// total the schedule shows.
export const countsTowardHours = (shift, typesById) => {
  if (!shift?.shift_type_id) return true;
  const t = typesById?.[shift.shift_type_id];
  return t ? t.counts_toward_hours : true;
};

export const abbrevOf = (shift, typesById) => {
  const t = shift?.shift_type_id ? typesById?.[shift.shift_type_id] : null;
  return t?.abbreviation?.trim() || "";
};

export const typeNameOf = (shift, typesById) => {
  const t = shift?.shift_type_id ? typesById?.[shift.shift_type_id] : null;
  return t?.name || "";
};
