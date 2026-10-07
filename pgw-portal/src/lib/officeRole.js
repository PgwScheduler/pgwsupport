// The Office role (migration 78): read-only, every store, no payroll.
// For office staff who need the cash drawer closeouts, tic sheets and
// reports but nothing on the payroll side.
//
// Not to be confused with the Home Office LOCATION (lib/homeOffice.js),
// which an office login never sees.
//
// Hiding screens here is tidiness, not the boundary: migration 78 gives
// the role select-only policies on exactly the tables these screens read
// and opts in only report_build, tech_ranks, the two tic-sheet labor
// functions and schedule_people. Every other table and RPC returns
// nothing to it.

export const isOfficeRole = (role) => role === "office";

// Payroll is left out on purpose: payroll hours, wages and payroll %. The
// Dashboard is the office's own (components/dashboard/OfficeDashboard.jsx),
// since the regular one is built around those. The Employee Schedule is in
// (read-only; names come from schedule_people(), never the employee record).
export const OFFICE_VIEWS = new Set(["dashboard", "drawer", "tic", "schedule", "reports", "training", "directory"]);

// Where an office login lands, and falls back to from a hidden screen.
export const OFFICE_DEFAULT_VIEW = "dashboard";

export const roleViewAllowed = (view, role) => !isOfficeRole(role) || OFFICE_VIEWS.has(view);
