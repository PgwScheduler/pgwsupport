// Offline checks for the Company Directory logic.
// Run: node src/lib/directory.test.mjs
import {
  formatTime, hoursRows, telHref, mailHref, storeShortName, formatAddress, groupStores, sortContacts,
  buildDirectoryIndex, matchesStore, matchesPerson, hoursToForm, formToHours, hoursFormErrors,
} from "./directory.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

// --- times and hours --------------------------------------------------
eq("7:30 AM", formatTime("07:30"), "7:30 AM");
eq("6 PM", formatTime("18:00"), "6 PM");
eq("noon", formatTime("12:00"), "12 PM");
eq("midnight", formatTime("00:15"), "12:15 AM");

eq("never entered is null, not closed", hoursRows(null), null);
const day = { open: "07:30", close: "18:00" };
eq("weekdays collapse", hoursRows({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: { open: "08:00", close: "16:00" }, sun: null }), [
  { label: "Mon–Fri", text: "7:30 AM – 6 PM" },
  { label: "Sat", text: "8 AM – 4 PM" },
  { label: "Sun", text: "Closed" },
]);
eq("non-adjacent equal days do not merge", hoursRows({ mon: day, tue: null, wed: day, thu: null, fri: null, sat: null, sun: null }), [
  { label: "Mon", text: "7:30 AM – 6 PM" },
  { label: "Tue", text: "Closed" },
  { label: "Wed", text: "7:30 AM – 6 PM" },
  { label: "Thu–Sun", text: "Closed" },
]);

// --- links ------------------------------------------------------------
eq("dotted phone", telHref("689.399.3918"), "tel:+16893993918");
eq("formatted phone", telHref("(803) 555-0100"), "tel:+18035550100");
eq("leading 1", telHref("1-803-555-0100"), "tel:+18035550100");
eq("extension dropped", telHref("803-555-0100 x12"), "tel:+18035550100");
eq("ext. dropped", telHref("803-555-0100 ext. 4"), "tel:+18035550100");
eq("no digits", telHref("TBD"), null);
eq("empty", telHref(null), null);
eq("mailto", mailHref("a@pgwus.com"), "mailto:a@pgwus.com");

// --- names and addresses ---------------------------------------------
eq("strip Midas", storeShortName("Midas Two Notch"), "Two Notch");
eq("strip Speedee", storeShortName("Speedee Summerville"), "Summerville");
eq("no brand prefix", storeShortName("Value Service"), "Value Service");
eq("address lines", formatAddress({ address_line1: "2701 Millwood Ave", address_line2: null, city: "Columbia", state: "SC", postal_code: "29206" }),
  ["2701 Millwood Ave", "Columbia, SC 29206"]);
eq("address partial", formatAddress({ address_line1: null, city: "Columbia", state: null, postal_code: null }), ["Columbia"]);

// --- grouping ---------------------------------------------------------
const S = (n, name, r, rn, d, dn, city = "Columbia") => ({ location_id: "s" + n, store_number: String(n), name, region_id: r, region_name: rn, district_id: d, district_name: dn, city });
const stores = [
  S(3935, "Midas Two Notch", "rC", "Columbia", "dE", "Columbia East"),
  S(3303, "Midas Millwood Ave", "rC", "Columbia", "dE", "Columbia East"),
  S(3229, "Midas Harbison", "rC", "Columbia", "dW", "Columbia West"),
  S(2320, "Midas Semoran", "rF", "Florida & North", "dF", "Florida", "Orlando"),
  S(9999, "Midas Nowhere", null, null, null, null),
];
const g = groupStores(stores);
eq("regions sorted, unassigned last", g.map((r) => r.regionName), ["Columbia", "Florida & North", "Unassigned"]);
eq("districts sorted by name", g[0].districts.map((d) => d.districtName), ["Columbia East", "Columbia West"]);
eq("stores by number", g[0].districts[0].stores.map((s) => s.store_number), ["3303", "3935"]);

// --- index: derived managers, coverage text, regions ------------------
const districts = [{ id: "dE", name: "Columbia East", region_id: "rC" }, { id: "dW", name: "Columbia West", region_id: "rC" }, { id: "dF", name: "Florida", region_id: "rF" }];
const regions = [{ id: "rC", name: "Columbia" }, { id: "rF", name: "Florida & North" }];
const contacts = [
  { id: "sm", display_name: "Sam Store", title: "Store Manager", role_category: "store_manager", active: true, sort_order: null },
  { id: "dm", display_name: "Dana DM", title: "District Manager", role_category: "district_manager", active: true, sort_order: null },
  { id: "old", display_name: "Old DM", title: "District Manager", role_category: "district_manager", active: false, sort_order: null },
  { id: "of", display_name: "Olive Office", title: "Payroll", role_category: "office", active: true, sort_order: 1 },
  { id: "rd", display_name: "Rex Regional", title: "Regional Director", role_category: "regional_director", active: true, sort_order: null },
];
const coverage = [
  { id: "c1", contact_id: "sm", scope_type: "store", location_id: "s3935" },
  { id: "c2", contact_id: "dm", scope_type: "district", district_id: "dE" },
  { id: "c3", contact_id: "old", scope_type: "district", district_id: "dE" },
  { id: "c4", contact_id: "of", scope_type: "company" },
  { id: "c5", contact_id: "rd", scope_type: "region", region_id: "rF" },
  { id: "c6", contact_id: "dm", scope_type: "store", location_id: "s3303" },
  { id: "c7", contact_id: "sm", scope_type: "store", location_id: "s3229", active: false },
];
const ix = buildDirectoryIndex({ stores, contacts, coverage, districts, regions });
eq("store manager derived", (ix.storeManagersByStore.get("s3935") ?? []).map((c) => c.id), ["sm"]);
eq("inactive coverage row ignored", ix.storeManagersByStore.get("s3229"), undefined);
eq("a DM with store coverage is not the store manager", ix.storeManagersByStore.get("s3303"), undefined);
eq("DM derived; inactive DM excluded", (ix.dmsByDistrict.get("dE") ?? []).map((c) => c.id), ["dm"]);
eq("no DM for Columbia West", ix.dmsByDistrict.get("dW"), undefined);
eq("coverage text", ix.coverageItems("dm").map((i) => i.text), ["Columbia East district", "Store 3303 Millwood Ave"]);
eq("store coverage links", ix.coverageItems("dm")[1].storeId, "s3303");
eq("company text", ix.coverageItems("of").map((i) => i.text), ["All stores"]);
eq("region text", ix.coverageItems("rd").map((i) => i.text), ["Florida & North region"]);
eq("regions via district", [...ix.regionsForContact("dm")], ["rC"]);
eq("regions via region", [...ix.regionsForContact("rd")], ["rF"]);
eq("company = everywhere", [...ix.regionsForContact("of")], ["*"]);
eq("sort: category, then sort_order, then name",
  sortContacts(contacts.filter((c) => c.active)).map((c) => c.id), ["rd", "dm", "sm", "of"]);

// --- search -----------------------------------------------------------
eq("by number", matchesStore(stores[0], "3935"), true);
eq("by #number", matchesStore(stores[0], "#3935"), true);
eq("by name, any case", matchesStore(stores[0], "two NOTCH"), true);
eq("by city", matchesStore(stores[3], "orlando"), true);
eq("all terms must match", matchesStore(stores[0], "notch orlando"), false);
eq("empty matches", matchesStore(stores[0], "  "), true);
eq("person by name", matchesPerson(contacts[1], [], "dana"), true);
eq("person by title", matchesPerson(contacts[1], [], "district manager"), true);
eq("person by coverage", matchesPerson(contacts[1], ix.coverageItems("dm").map((i) => i.text), "columbia east"), true);
eq("person miss", matchesPerson(contacts[1], [], "payroll"), false);

// --- hours form round trip -------------------------------------------
const h = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: null, sun: null };
eq("round trip", formToHours(hoursToForm(h)), h);
eq("null hours -> all closed form", hoursToForm(null).mon, { open: false, from: "", to: "" });
const f = hoursToForm(h);
f.sat = { open: true, from: "", to: "" };
f.sun = { open: true, from: "16:00", to: "08:00" };
eq("form errors", hoursFormErrors(f), { sat: "Enter both times", sun: "Close must be after open" });
eq("valid form", hoursFormErrors(hoursToForm(h)), {});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
