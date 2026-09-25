// Offline checks for the Home Office rules (migration 68).
// Run: node src/lib/homeOffice.test.mjs
import { isHomeOffice, viewAllowed, revenueStores, HOME_OFFICE_DEFAULT_VIEW } from "./homeOffice.js";
import { positionsForBrand, canBeSalaried } from "./payrollMath.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const ho = { id: "h", store_number: "1515", brand: "midas", is_home_office: true };
const store = { id: "s", store_number: "3303", brand: "midas", is_home_office: false };
const old = { id: "o", store_number: "3276", brand: "speedee" }; // row loaded before the column existed

eq("HO detected", isHomeOffice(ho), true);
eq("store is not HO", isHomeOffice(store), false);
eq("missing flag is not HO", isHomeOffice(old), false);
eq("null store is not HO", isHomeOffice(null), false);

for (const v of ["dashboard", "drawer", "tic", "techtracker", "bonus"]) {
  eq(`${v} hidden at HO`, viewAllowed(v, ho), false);
  eq(`${v} shown at a store`, viewAllowed(v, store), true);
}
for (const v of ["hours", "schedule", "documents", "training", "directory", "reports", "users"]) {
  eq(`${v} shown at HO`, viewAllowed(v, ho), true);
}
eq("fallback view is itself allowed", viewAllowed(HOME_OFFICE_DEFAULT_VIEW, ho), true);

eq("revenueStores drops HO only", revenueStores([store, ho, old]).map((s) => s.id), ["s", "o"]);
eq("revenueStores tolerates null", revenueStores(null), []);

eq("HO positions", positionsForBrand("midas", true).map(([k]) => k), ["office"]);
eq("Midas positions unchanged", positionsForBrand("midas").map(([k]) => k), ["manager", "front", "tech"]);
eq("SpeeDee positions unchanged", positionsForBrand("speedee").map(([k]) => k),
   ["manager", "front", "cashier", "labor_pct_tech", "pitman", "hood_tech"]);
eq("office can be salaried", canBeSalaried("office"), true);
eq("manager can be salaried", canBeSalaried("manager"), true);
eq("tech cannot", canBeSalaried("tech"), false);
eq("front cannot", canBeSalaried("front"), false);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
