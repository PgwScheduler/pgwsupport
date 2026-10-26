// Parts Recon — Mass Credit Import (migration 91): one vendor credit
// invoice applied to every item it covers, as a bulk store reply.
// The screen checks with these rules; parts_recon_credit_batch_submit()
// checks every one again inside its transaction.

// What a credit invoice is for (a subset of the reply's "What you did").
export const CREDIT_ACTIONS = [
  ["returned", "Returned the parts"],
  ["core_returned", "Returned the cores"],
  ["other", "Other"],
];

const cents = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const exactCents = (v) => {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  return s !== "" && /^\d+(\.\d{1,2})?$/.test(s);
};

// header: { locationId, vendor, creditNo, total }
// lines:  [{ id, ro, left_to_deduct, amount }]  (amount as typed)
// -> { errors: [..], lineErrors: { [id]: msg }, sum, total, remaining }
export function validateCredit(header, lines) {
  const errors = [], lineErrors = {};
  if (!header.locationId) errors.push("Pick the store.");
  if (!header.vendor) errors.push("Pick the vendor.");
  if (!String(header.creditNo ?? "").trim()) errors.push("Enter the credit #.");
  const total = cents(header.total);
  if (!exactCents(header.total) || !total || total <= 0) errors.push("Enter the credit total in dollars and cents.");
  if (!lines.length) errors.push("Add at least one item.");

  const seen = new Set();
  let sum = 0;
  for (const l of lines) {
    if (seen.has(l.id)) { lineErrors[l.id] = "This item is on the credit twice."; continue; }
    seen.add(l.id);
    const amt = cents(l.amount);
    const left = cents(l.left_to_deduct) ?? 0;
    if (!exactCents(l.amount) || !amt || amt <= 0) lineErrors[l.id] = "Enter a credit above $0.";
    else if (amt > left) lineErrors[l.id] = `More than the $${(left / 100).toFixed(2)} left to deduct.`;
    sum += amt ?? 0;
  }
  if (Object.keys(lineErrors).length) errors.push("Fix the lines marked below.");
  if (total && lines.length && sum !== total) {
    errors.push(`The lines add up to $${(sum / 100).toFixed(2)}, not the credit total of $${(total / 100).toFixed(2)}.`);
  }
  return { errors, lineErrors, sum: sum / 100, total: total === null ? null : total / 100, remaining: total === null ? null : (total - sum) / 100 };
}

// The submit payload's lines.
export const creditLinesPayload = (lines) => lines.map((l) => ({ item_id: l.id, amount: cents(l.amount) / 100 }));
