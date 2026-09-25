// The Home Office (#1515, migration 68): a real location that earns no
// revenue. It holds corporate staff, payroll and the schedule, and is left
// out of every sales/payroll rollup in SQL. Here it decides which screens
// make sense and which stores belong in multi-store pickers.

export const isHomeOffice = (store) => store?.is_home_office === true;

// Screens that are about a store's sales, cash or technicians. The Home
// Office has none of those, so they are hidden while it is selected.
export const HOME_OFFICE_HIDDEN_VIEWS = new Set(["dashboard", "drawer", "tic", "techtracker", "bonus"]);

// Where the Home Office lands when the current screen is hidden for it.
export const HOME_OFFICE_DEFAULT_VIEW = "hours";

export const viewAllowed = (view, store) => !(isHomeOffice(store) && HOME_OFFICE_HIDDEN_VIEWS.has(view));

// Revenue stores only — for pickers and exports that sum sales.
export const revenueStores = (stores) => (stores ?? []).filter((s) => !isHomeOffice(s));
