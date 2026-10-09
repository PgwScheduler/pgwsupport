// The Change Log (migration 81): turns audit_log rows into plain English.
// Everything here is pure, so it is tested offline (auditLog.test.mjs).
//
// Who sees what is decided in the database (audit_log RLS), not here:
// admin/master everything; district/regional their stores minus pay
// rates, pay amounts and logins; store and office nothing.
import { money } from "./format.js";
import { csvEsc } from "./csv.js";

export const AUDIT_ROLES = new Set(["admin", "master", "district", "regional"]);
export const canSeeAuditLog = (role) => AUDIT_ROLES.has(role);

export const AREAS = [
  { key: "tic", label: "Tic sheet" },
  { key: "adjustments", label: "Adjustments" },
  { key: "payroll", label: "Payroll" },
  { key: "pay_rates", label: "Pay rates" },
  { key: "bonus", label: "Bonus" },
  { key: "people", label: "Employees" },
  { key: "access", label: "Logins & roles" },
];
const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.key, a.label]));
export const areaLabel = (key) => AREA_LABEL[key] ?? key;

const TABLE_LABEL = {
  daily_kpi: "Tic sheet",
  daily_service_units: "Tic sheet units",
  payroll_daily: "Daily hours",
  timesheet_entries: "Weekly timesheet",
  timesheet_midas: "Weekly timesheet",
  timesheet_speedee: "Weekly timesheet",
  timesheet_pay: "Bonus / paycheck",
  store_week_sales: "Weekly store sales",
  tech_daily: "Tech Tracker day",
  tech_weekly: "Tech other pay",
  tech_slots: "Tech slot",
  tech_pay_rates: "Tech pay rate",
  employee_pay_rate_history: "Pay rate",
  bonus_monthly_inputs: "Bonus inputs",
  bonus_monthly_targets: "Bonus targets",
  bonus_plans: "Bonus plan",
  bonus_incentive_tiers: "Bonus incentive tier",
  bonus_model_rates: "Bonus model rate",
  bonus_model_splits: "Bonus model split",
  bonus_policy: "Bonus policy",
  market_bonus_brackets: "Market bonus bracket",
  employees: "Employee",
  profiles: "Login",
};
export const tableLabel = (t) => TABLE_LABEL[t] ?? t;

// Only where the column name reads badly; everything else is humanized.
const FIELD_LABEL = {
  ro_count: "Cars",
  sales_adjustments: "Adjustments",
  adjustments_note: "Adjustment reason",
  zero_dollar_tickets: "$0 tickets",
  hours_worked_other: "Hours worked (other store)",
  hours_turned_other: "Hours turned (other store)",
  hours_turned_here: "Hours turned",
  clock_hours_other: "Clock hours (other store)",
  pto_days: "PTO days",
  phone_conversion_pct: "Phone conversion %",
  referral_gp_credit: "Referral GP credit",
  gp_budget: "GP budget",
  last_year_gp: "Last year GP",
  labor_pct_eligible: "Labor % eligible",
  labor_pct_rate: "Labor % rate",
  is_store_manager: "Store manager",
  adp_position_id: "ADP position ID",
  location_id: "Store",
  district_id: "District",
  region_id: "Region",
  employee_id: "Employee",
  transferred_from_id: "Transferred from",
  is_manager_or_sa: "Manager / SA slot",
  full_name: "Name",
  pct: "Percent",
};
export const fieldLabel = (f) =>
  FIELD_LABEL[f] ?? (f.charAt(0).toUpperCase() + f.slice(1)).replace(/_/g, " ");

const MONEY = /^(sales_(?!required$|expectation_flat$)|cost_|declined_sales$|credit_dollars$|amount$|bonus$|incentives$|paycheck_amount$|labor_sales$|actual_|other_pay$|spiffs$|flat_rate$|guarantee_rate$|payout$|gp_budget$|sales_goal$|referral_gp_credit$|last_year_gp$|sales_required$|sales_expectation_flat$|increment_above$)/;

// Columns that say which row, not what it holds -- shown in the record
// description, not as "changes".
const REF = new Set([
  "id", "location_id", "employee_id", "business_date", "work_date", "week_start", "plan_year",
  "month", "effective_date", "rate_type", "tech_slot_id", "timesheet_entry_id", "daily_kpi_id",
  "service_category_id", "slot_index", "kind", "tier_index",
]);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const shortDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${DOW[new Date(y, m - 1, d).getDay()]} ${m}/${d}/${String(y).slice(2)}`;
};

// lookups: { stores: [{id, store_number, name}], districts: [{id,name}], regions: [{id,name}] }
export function formatValue(field, v, lookups = {}) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (field === "location_id") {
    const s = lookups.stores?.find((x) => x.id === v);
    return s ? `#${s.store_number}` : "another store";
  }
  if (field === "district_id") return lookups.districts?.find((x) => x.id === v)?.name ?? "a district";
  if (field === "region_id") return lookups.regions?.find((x) => x.id === v)?.name ?? "a region";
  if (field === "employee_id" || field === "transferred_from_id") return "another employee record";
  if (field === "role") return ROLE_NAMES[v] ?? v;
  if (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && !/(_number|_id)$/.test(field))) {
    const n = Number(v);
    if (MONEY.test(field)) return money(n);
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return shortDate(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const ROLE_NAMES = {
  store: "Store Manager", district: "District Manager", regional: "Regional Manager",
  office: "Office", admin: "Admin", master: "Master",
};
export const roleName = (r) => ROLE_NAMES[r] ?? r ?? "";

// "Thu 10/8/26", "Week of Sun 10/4/26", "Oct 2026", "Hourly from Wed 10/1/26"
export function describeRecord(row) {
  const r = row.row_ref ?? {};
  const bits = [];
  if (r.category) bits.push(r.category);
  if (r.rate_type) bits.push(fieldLabel(r.rate_type));
  if (r.business_date) bits.push(shortDate(r.business_date));
  else if (r.work_date) bits.push(shortDate(r.work_date));
  else if (r.week_start) bits.push(`week of ${shortDate(r.week_start)}`);
  else if (r.plan_year && r.month) bits.push(`${MONTHS[r.month - 1]} ${r.plan_year}`);
  else if (r.plan_year) bits.push(String(r.plan_year));
  if (r.effective_date) bits.push(`from ${shortDate(r.effective_date)}`);
  if (r.slot_index != null && row.table_name === "tech_slots") bits.push(`slot ${r.slot_index}`);
  return bits.join(" · ");
}

export function actionVerb(row) {
  if (row.action === "insert") return row.table_name === "employees" && row.new_values?.transferred_from_id ? "transferred in" : "added";
  if (row.action === "delete") return "deleted";
  return "changed";
}

// The field-level changes, in a stable order.
export function changesOf(row) {
  const out = [];
  if (row.action === "update") {
    for (const f of Object.keys(row.new_values ?? {})) {
      out.push({ field: f, from: row.old_values?.[f] ?? null, to: row.new_values[f] });
    }
  } else {
    const vals = (row.action === "insert" ? row.new_values : row.old_values) ?? {};
    for (const f of Object.keys(vals)) {
      if (REF.has(f) && !(row.table_name === "employees" && f === "location_id")) continue;
      if (row.action === "insert") out.push({ field: f, from: null, to: vals[f] });
      else out.push({ field: f, from: vals[f], to: null });
    }
  }
  return out;
}

export function actorLabel(row) {
  if (row.source === "database") return "Direct database change";
  if (row.source === "service") return "Automated job";
  return row.actor_name || "Unknown user";
}

// Rows from one save (one database transaction) arrive together and share
// a txid -- a transfer touches 3-6 tables. Consecutive rows only, since the
// feed is newest first by id and one transaction's ids are contiguous.
export function groupByTxid(rows) {
  const groups = [];
  for (const r of rows ?? []) {
    const last = groups[groups.length - 1];
    if (last && last.txid === r.txid) last.rows.push(r);
    else groups.push({ txid: r.txid, rows: [r] });
  }
  for (const g of groups) {
    g.isTransfer = g.rows.some((r) => r.table_name === "employees" && r.action === "insert" && r.new_values?.transferred_from_id);
  }
  return groups;
}

// "Oct 9, 2:14 PM" in Eastern time -- every store is Eastern.
export const whenLabel = (ts) =>
  new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });

export function auditCsv(rows, lookups = {}) {
  const head = ["When (ET)", "Who", "Role", "Store", "Area", "Record", "Employee / login", "Detail", "Action", "Field", "From", "To"];
  const lines = [head.join(",")];
  for (const r of rows ?? []) {
    const base = [
      whenLabel(r.at), actorLabel(r), roleName(r.actor_role), r.store_number ? `#${r.store_number}` : "",
      areaLabel(r.area), tableLabel(r.table_name), r.subject_name ?? "", describeRecord(r), actionVerb(r),
    ];
    const ch = changesOf(r);
    if (!ch.length) lines.push([...base, "", "", ""].map(csvEsc).join(","));
    for (const c of ch) {
      lines.push([...base, fieldLabel(c.field), formatValue(c.field, c.from, lookups), formatValue(c.field, c.to, lookups)].map(csvEsc).join(","));
    }
  }
  return lines.join("\n");
}
