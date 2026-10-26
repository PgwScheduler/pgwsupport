// Offline checks for the Mass Credit Import screen rules.
// Run: node src/lib/partsReconCredit.test.mjs
import { validateCredit, creditLinesPayload } from "./partsReconCredit.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const h = { locationId: "L1", vendor: "Napa", creditNo: "CR-1", total: "130.00" };
const lines = [
  { id: "a", ro: "111", left_to_deduct: 100, amount: "60" },
  { id: "b", ro: "112", left_to_deduct: 30, amount: "30.00" },
  { id: "c", ro: "106", left_to_deduct: 40, amount: "40" },
];

let v = validateCredit(h, lines);
eq("valid credit", v.errors, []);
eq("sum and remaining", [v.sum, v.total, v.remaining], [130, 130, 0]);
eq("payload", creditLinesPayload(lines), [{ item_id: "a", amount: 60 }, { item_id: "b", amount: 30 }, { item_id: "c", amount: 40 }]);

v = validateCredit({ ...h, total: "120" }, lines);
eq("lines must add up", v.errors, ["The lines add up to $130.00, not the credit total of $120.00."]);
eq("remaining shows the gap", v.remaining, -10);

v = validateCredit(h, [{ ...lines[0], amount: "100.01" }, lines[1]]);
eq("over left to deduct", v.lineErrors.a, "More than the $100.00 left to deduct.");

v = validateCredit(h, [{ ...lines[0], amount: "0" }]);
eq("zero refused", v.lineErrors.a, "Enter a credit above $0.");
v = validateCredit(h, [{ ...lines[0], amount: "1.005" }]);
eq("fractions of a cent refused", v.lineErrors.a, "Enter a credit above $0.");

v = validateCredit(h, [lines[0], lines[0]]);
eq("item twice", v.lineErrors.a, "This item is on the credit twice.");

v = validateCredit({ locationId: "", vendor: "", creditNo: " ", total: "" }, []);
eq("header required", v.errors, ["Pick the store.", "Pick the vendor.", "Enter the credit #.", "Enter the credit total in dollars and cents.", "Add at least one item."]);

v = validateCredit({ ...h, total: "$1,234.50" }, [{ id: "a", left_to_deduct: 2000, amount: "1,234.50" }]);
eq("dollar signs and commas accepted", [v.errors, v.sum], [[], 1234.5]);

// Float safety: 0.1 + 0.2 style sums compare in cents.
v = validateCredit({ ...h, total: "0.30" }, [{ id: "a", left_to_deduct: 1, amount: "0.10" }, { id: "b", left_to_deduct: 1, amount: "0.20" }]);
eq("cents, not floats", v.errors, []);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
