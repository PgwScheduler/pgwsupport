// Parts Recon (migration 90): the monthly parts reconciliation after the
// Python scripts have run. Wording and small rules shared by the screens.
// The boundary is in SQL -- who sees, replies and reviews -- so nothing
// here decides access; it only labels and adds up what came back.

// Item status. Left to deduct follows the Response Tracker workbook's
// formula (and parts_recon_left() in SQL): credit received or explained
// = 0, partial credit = amount minus credit, anything else = the amount.
export const STATUS = {
  open: { label: "Open", tone: "warn", hint: "Waiting on the store" },
  answered: { label: "Store replied", tone: "info", hint: "Waiting on AP's review" },
  credit_received: { label: "Credit received", tone: "good" },
  partial_credit: { label: "Partial credit", tone: "warn" },
  explained: { label: "Explained - no deduction", tone: "good" },
  deduct: { label: "Deduct from store", tone: "bad" },
};
export const REVIEW_STATUSES = ["credit_received", "partial_credit", "explained", "deduct", "open"];
export const statusLabel = (s) => STATUS[s]?.label ?? s ?? "";

export const leftToDeduct = (status, amount, credit) => {
  const a = Number(amount) || 0;
  if (status === "credit_received" || status === "explained") return 0;
  if (status === "partial_credit") return Math.max(a - (Number(credit) || 0), 0);
  return a;
};

// What the store did, picked when replying.
export const STORE_ACTIONS = [
  ["returned", "Returned the part - credit #"],
  ["core_returned", "Returned the core - core credit #"],
  ["other_vendor", "Part came from a different vendor"],
  ["entered_in_ap", "Entered it in RO Writer AP"],
  ["explained", "Explanation (no return)"],
  ["other", "Other"],
];
// Without the "- credit #" prompt, for showing a reply that has the credit # next to it.
export const storeActionLabel = (a) => (STORE_ACTIONS.find(([k]) => k === a)?.[1] ?? a ?? "").replace(/ - (core )?credit #$/, "");

export const KIND_LABEL = {
  ro_cost: "RO cost doesn't match the vendor invoice",
  divvy: "Divvy card charge not entered in RO Writer AP",
  arm: "SpeeDee ARM store (RO level, no store email)",
  other: "Other bill",   // entered by AP, not on a vendor statement (migration 92)
};

// The scripts' vendor names, shown the way the Response Tracker showed them.
const VENDOR_DISPLAY = { Napa: "NAPA", "O'Reilly's": "O'Reilly", "Advance & Carquest": "Advance / Carquest" };
export const vendorLabel = (v) => VENDOR_DISPLAY[v] ?? v ?? "";

export const AP_TASK_KIND = {
  bill_not_in_ap: "Bill not keyed in AP",
  credit_not_in_ap: "Credit not keyed in AP",
  amount_diff: "AP amount differs",
  wrong_supplier: "Wrong supplier in AP",
  sales_tax: "Sales tax on invoice",
  ap_not_on_statement: "In AP, not on statement",
  unassigned: "Unassigned charge",
  warranty_addback: "Warranty tire - add back",
  ro_not_on_parts_detail: "RO not on Parts Detail",
  no_ro_on_statement: "No RO # on statement",
};

// "2026-09-01" -> "Sept 2026", matching the recon's own file names.
export function monthShort(month) {
  const [y, m] = String(month ?? "").split("-").map(Number);
  if (!y || !m) return "";
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} ${y}`;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Totals for a list of items (what the caller can see).
export function itemTotals(items) {
  const t = { items: 0, open: 0, answered: 0, done: 0, amount: 0, credited: 0, left: 0 };
  for (const i of items ?? []) {
    t.items++;
    if (i.status === "open") t.open++;
    else if (i.status === "answered") t.answered++;
    else t.done++;
    const left = leftToDeduct(i.status, i.amount, i.credit_amt);
    t.amount += Number(i.amount) || 0;
    t.left += left;
    t.credited += (Number(i.amount) || 0) - left;
  }
  t.amount = round2(t.amount); t.left = round2(t.left); t.credited = round2(t.credited);
  return t;
}

// Store -> vendor -> items, stores and vendors in name order, biggest first inside.
export function groupItems(items) {
  const stores = new Map();
  for (const i of items ?? []) {
    if (!stores.has(i.recon_store)) stores.set(i.recon_store, new Map());
    const vendors = stores.get(i.recon_store);
    if (!vendors.has(i.vendor)) vendors.set(i.vendor, []);
    vendors.get(i.vendor).push(i);
  }
  return [...stores.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([store, vendors]) => ({
    store,
    vendors: [...vendors.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([vendor, list]) => ({
      vendor,
      items: [...list].sort((x, y) => (Number(y.amount) || 0) - (Number(x.amount) || 0)),
      totals: itemTotals(list),
    })),
    totals: itemTotals([...vendors.values()].flat()),
  }));
}

// Filter used by the list: "all", "open" (needs the store), "answered"
// (needs AP), "done" (reviewed).
export function matchesFilter(item, filter) {
  if (filter === "open") return item.status === "open" || item.status === "partial_credit" || item.status === "deduct";
  if (filter === "answered") return item.status === "answered";
  if (filter === "done") return !["open", "answered"].includes(item.status);
  return true;
}

export function matchesSearch(item, text) {
  const s = String(text ?? "").trim().toLowerCase();
  if (!s) return true;
  return [item.ro, item.invoices, item.vendor, vendorLabel(item.vendor), item.recon_store, item.store_number, item.why]
    .some((v) => String(v ?? "").toLowerCase().includes(s));
}

// Split rows into chunks for the import RPCs (one request each).
export function chunk(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
