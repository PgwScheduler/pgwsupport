// =====================================================================
// Parts Recon — Deduction Report (read-only, for the month-end GP audit).
//
// Nothing new is defined here. Every figure is one the database already
// returns:
//   * an item's deduction  = left_to_deduct from parts_recon_items(), i.e.
//     parts_recon_left(status, amount, credit_amt): 0 when credit_received
//     or explained, amount - credit for partial_credit, else the amount
//   * a Tracker line with NO items (e.g. Agero Towing keyed onto the
//     tracker by hand) = its left_to_deduct from parts_recon_tracker(),
//     which for such a line is the tracker's own amount. They are listed
//     as their own kind so a store's total equals the Tracker's (user,
//     2026-10-26).
//   * a store's deduction  = the sum of both; the month's = all stores.
//
// Each store row also carries the Tracker's left to deduct for the same
// store and the difference, so a mismatch shows instead of hiding.
// Sandbox and Home Office are not stores here; every other location is
// listed, $0 or not.
// =====================================================================

export const DEDUCTION_KIND = {
  ro_cost: "RO cost",
  divvy: "Divvy",
  arm: "ARM",
  other: "Other bill",
  tracker: "Tracker line (no items)",
};

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// items:   parts_recon_items() rows for the month (AP sees every store)
// tracker: parts_recon_tracker() rows for the month
// locations: [{ id, store_number, name, is_sandbox, is_home_office }]
export function buildDeductionReport({ items, tracker, locations }) {
  const stores = new Map();
  const keyOf = (locationId, reconStore) => locationId ?? `name:${reconStore}`;
  const store = (locationId, reconStore, storeNumber) => {
    const k = keyOf(locationId, reconStore);
    if (!stores.has(k)) {
      stores.set(k, { key: k, locationId: locationId ?? null, storeNumber: storeNumber ?? null, name: reconStore ?? null,
        left: 0, trackerLeft: 0, lines: [] });
    }
    const s = stores.get(k);
    if (!s.name && reconStore) s.name = reconStore;
    if (!s.storeNumber && storeNumber) s.storeNumber = storeNumber;
    return s;
  };

  const locById = new Map((locations ?? []).map((l) => [l.id, l]));
  const excluded = (id) => { const l = locById.get(id); return !!l && (l.is_sandbox || l.is_home_office); };

  // Every store, $0 or not.
  for (const l of locations ?? []) {
    if (l.is_sandbox || l.is_home_office) continue;
    store(l.id, null, l.store_number);
  }

  for (const i of items ?? []) {
    if (excluded(i.location_id)) continue;
    const s = store(i.location_id, i.recon_store, i.store_number ?? locById.get(i.location_id)?.store_number);
    const left = Number(i.left_to_deduct) || 0;
    s.left += left;
    if (left > 0) {
      s.lines.push({
        kind: i.kind, kindLabel: DEDUCTION_KIND[i.kind] ?? i.kind, vendor: i.vendor, ro: i.ro ?? null,
        invoices: i.invoices ?? null, status: i.status, amount: Number(i.amount) || 0,
        credit: i.credit_amt === null || i.credit_amt === undefined ? null : Number(i.credit_amt), left,
      });
    }
  }

  for (const t of tracker ?? []) {
    if (excluded(t.location_id)) continue;
    const s = store(t.location_id, t.recon_store, locById.get(t.location_id)?.store_number);
    const left = Number(t.left_to_deduct) || 0;
    s.trackerLeft += left;
    // A line with items is already counted through its items.
    if (!t.items) {
      s.left += left;
      if (left > 0) {
        s.lines.push({
          kind: "tracker", kindLabel: DEDUCTION_KIND.tracker, vendor: t.vendor, ro: null, invoices: null,
          status: t.status || null, amount: Number(t.script_amount) || 0, credit: null, left,
        });
      }
    }
  }

  const rows = [...stores.values()].map((s) => {
    const loc = s.locationId ? locById.get(s.locationId) : null;
    const lines = s.lines.sort((a, b) => b.left - a.left || String(a.vendor).localeCompare(String(b.vendor)) || String(a.ro ?? "").localeCompare(String(b.ro ?? "")));
    return {
      key: s.key, locationId: s.locationId, storeNumber: s.storeNumber ?? null,
      name: s.name ?? loc?.name ?? "", mapped: !!s.locationId,
      left: r2(s.left), trackerLeft: r2(s.trackerLeft), diff: r2(s.left - s.trackerLeft),
      count: lines.length, lines,
    };
  }).sort((a, b) => (Number(a.storeNumber) || 99999) - (Number(b.storeNumber) || 99999) || a.name.localeCompare(b.name));

  const total = r2(rows.reduce((a, r) => a + r.left, 0));
  const trackerTotal = r2(rows.reduce((a, r) => a + r.trackerLeft, 0));
  return {
    stores: rows, total, trackerTotal, diff: r2(total - trackerTotal),
    mismatches: rows.filter((r) => r.diff !== 0).length,
    lineCount: rows.reduce((a, r) => a + r.count, 0),
  };
}
