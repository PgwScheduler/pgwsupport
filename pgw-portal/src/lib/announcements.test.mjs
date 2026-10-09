// Offline checks for announcement wording (migration 86).
// Run: node src/lib/announcements.test.mjs
import { audienceLabel, receiptTotals, canPostAnnouncements, whenLabel } from "./announcements.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

const col = { id: "rC", name: "Columbia" }, chs = { id: "rH", name: "Charleston" };
const east = { id: "dE", name: "Columbia East", region: col }, west = { id: "dW", name: "Columbia West", region: col };
const chd = { id: "dC", name: "Charleston", region: chs };
const S = (id, n, district) => ({ id, store_number: n, district });
const stores = [S("a", "3303", east), S("b", "3305", east), S("c", "3229", west), S("d", "3029", chd), S("e", "3009", chd),
  { id: "sb", store_number: "9999", district: east, is_sandbox: true }];

eq("everything, master", audienceLabel(["a", "b", "c", "d", "e"], stores, "master"), "All stores");
eq("sandbox not needed for 'all'", audienceLabel(["a", "b", "c", "d", "e"], stores, "office"), "All stores");
eq("a whole region", audienceLabel(["a", "b", "c"], stores, "master"), "Columbia region");
eq("region + a district", audienceLabel(["a", "b", "c", "d", "e"].slice(0, 3).concat(["d", "e"]), stores, "regional"), "Charleston region · Columbia region");
eq("a whole district", audienceLabel(["a", "b"], stores, "master"), "Columbia East district");
eq("district + single store", audienceLabel(["a", "b", "d"], stores, "master"), "Columbia East district · #3029");
eq("singles sorted", audienceLabel(["d", "a"], stores, "master"), "#3029, #3303");
eq("DM never gets a region label", audienceLabel(["a", "b"], [stores[0], stores[1]], "district"), "Columbia East district");
eq("RM with its own list: region", audienceLabel(["a", "b", "c"], stores.slice(0, 3), "regional"), "Columbia region");
eq("nothing", audienceLabel([], stores, "master"), "");
const many = Array.from({ length: 9 }, (_, i) => S("x" + i, String(4000 + i), { id: "d" + i, name: "D" + i, region: { id: "r" + i, name: "R" + i } }));
// each store alone in its own district: one store = whole district, so names come out as districts
eq("many singles truncated", audienceLabel(many.slice(0, 2).map((s) => s.id), many.concat([S("y", "5000", many[0].district)]), "district"), "D1 district · #4000");

eq("receipt totals", receiptTotals([
  { location_id: "a", logins: 2, read_count: 1 },
  { location_id: "b", logins: 1, read_count: 0 },
  { location_id: "c", logins: 0, read_count: 0 },
  { location_id: null, logins: null, read_count: 3 },
]), { stores: 3, storesRead: 1, storesNoLogin: 1, logins: 3, loginsRead: 1 });

eq("posters", ["master", "admin", "office", "district", "regional", "store", undefined].map(canPostAnnouncements),
  [true, true, true, true, true, false, false]);
eq("when blank", whenLabel(null), "");
eq("when bad", whenLabel("nope"), "");

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
