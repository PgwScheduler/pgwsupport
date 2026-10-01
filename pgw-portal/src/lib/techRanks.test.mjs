// Offline checks for Tech Ranks (migration 74).
// Run: node src/lib/techRanks.test.mjs
// The fixture is the September 2026 workbook ("Tech ranks sept 2026.xlsx",
// Sheet2): the report must reproduce its top 20 and its market counts.
import { STORE_NAMES, buildTechRanks, compareTechs, medalFor, periodLabels, proficiency } from "./techRanks.js";
import { buildTechRanksWorkbook } from "./techRanksWorkbook.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`);
};

// The workbook's five division columns: name, hrs turned, hrs worked.
const WB = {
  "Columbia East": [["Joe Ludack",231,207],["Chris Jones",150,175],["Joshua Lee",150,196],["Jarrell Steward",137,197],["Robbie Herrington",132,191],["Solomon Boney",131,207],["Bradley Jones",121,195],["Cliff Jones",118,164],["Rod Campos",105,198],["James Felder",97,188]],
  "Columbia West": [["Ron Hendriks",279,160],["Jeremy Miles",255,187],["Dave Merritt",230,186],["Joseph Platt",199,194],["Mike Tucker",199,210],["Heith Thomas",159,165],["Shane Stinnard",152,159],["Cecil Phillips",149,212],["Spenze Kitchens",141,182],["Ray Currin",136,184]],
  "Florida": [["Michael Ferrell",133,192],["John Kirkland",128,198],["Dustin Kelley",124,173],["Ryan Carlson",112,200],["Josh Rivera",109,215],["Garrison Perkins",101,201],["Joel Lapitsky",96,198],["Wyatt Kutch",93,197],["Aleksander Robertson",93,195],["Dylan Jaiser",88,197]],
  "North": [["James Angelo",140,200],["Kevin Lepage",129,192],["Carlos Rodriguez",124,189],["Kevin Jackson",120,187],["Michael Brooke",113,177],["Mohamed Konteh",113,196],["William Quick",101,160],["Dennis Mcgregor",101,287],["Austin Wilson",96,219],["Rodney Jones",90,181]],
  "Charleston": [["Josh Hughes",202,215],["Santo Albanese",185,192],["John Demers",174,185],["Collin Enos",170,168],["Richard Doyle",168,199],["Noah Van Horn",146,218],["Preston Palmer",99,154],["Lance Chabotte",99,173],["Lucas Pruner",95,159],["Jacob Jensen",95,122]],
};
// Feed them in Charleston-first to prove the order comes from the code.
const names = ["Charleston", "North", "Florida", "Columbia West", "Columbia East"];
const raw = {
  divisions: names.map((n) => ({ district_id: "d-" + n, name: n, stores: [{ store_number: n, name: n + " store", has_data: n !== "Florida" }] })),
  techs: names.flatMap((n) => WB[n].map(([name, t, w], i) => ({
    employee_id: `${n}-${i}`, name, district_id: "d-" + n, store_number: n, store_name: n, store_count: 1, hours_turned: t, hours_worked: w,
  }))),
};
const r = buildTechRanks(raw);

eq("division order + workbook headings", r.divisions.map((d) => d.label),
  ["Columbia - East Division", "Columbia - West Division", "Florida", "PGW North", "Charleston"]);
eq("Columbia East top 10 = workbook column B", r.divisions[0].top.map((t) => t.name), WB["Columbia East"].map((x) => x[0]));
eq("Columbia West top 10 = workbook column H", r.divisions[1].top.map((t) => t.name), WB["Columbia West"].map((x) => x[0]));
eq("North top 10 = workbook column T", r.divisions[3].top.map((t) => t.name), WB["North"].map((x) => x[0]));
// The workbook was sorted by hand and breaks two ties the other way:
// Florida's 93 hours (Kutch 47% above Robertson 48%) and Charleston's 95
// (Pruner 60% above Jensen 78%). The portal always gives a tie to the
// higher proficiency, so those two pairs swap and nothing else moves.
const swap = (list, a, b) => { const l = list.map((x) => x[0]); const i = l.indexOf(a), j = l.indexOf(b); [l[i], l[j]] = [l[j], l[i]]; return l; };
eq("Charleston top 10 = column Z, Jensen over Pruner", r.divisions[4].top.map((t) => t.name), swap(WB["Charleston"], "Lucas Pruner", "Jacob Jensen"));
eq("Florida top 10 = column N, Robertson over Kutch", r.divisions[2].top.map((t) => t.name), swap(WB["Florida"], "Wyatt Kutch", "Aleksander Robertson"));

eq("top 20 = workbook J25:J44", r.top.map((t) => t.name), [
  "Ron Hendriks","Jeremy Miles","Joe Ludack","Dave Merritt","Josh Hughes","Joseph Platt","Mike Tucker","Santo Albanese","John Demers","Collin Enos",
  "Richard Doyle","Heith Thomas","Shane Stinnard","Chris Jones","Joshua Lee","Cecil Phillips","Noah Van Horn","Spenze Kitchens","James Angelo","Jarrell Steward"]);
eq("top 20 markets = workbook K25", r.top.slice(0, 3).map((t) => t.division), ["Columbia - West Division", "Columbia - West Division", "Columbia - East Division"]);
eq("Techs in Top 20 = workbook P25:Q29", r.counts.map((c) => [c.label, c.count]),
  [["Columbia - West Division", 9], ["Charleston", 6], ["Columbia - East Division", 4], ["PGW North", 1], ["Florida", 0]]);
eq("proficiency N25 = 1.74375", r.top[0].proficiency, 1.74375);
eq("store coverage", [r.storeCount, r.storesWithData], [5, 4]);

eq("no hours worked -> blank proficiency", proficiency(10, 0), null);
eq("blank proficiency ranks below a real one on a tie",
  [{ name: "A", hoursTurned: 5, proficiency: null }, { name: "B", hoursTurned: 5, proficiency: 0.1 }].sort(compareTechs).map((t) => t.name), ["B", "A"]);
eq("medals", [1, 2, 3, 4].map((n) => medalFor(n)?.fill ?? null), ["FFD700", "C0C0C0", "CD7F32", null]);

// Store lists: the workbook's names, in its order, whatever order and
// names tech_ranks() sends; an unlisted store follows under its own name.
const named = buildTechRanks({
  divisions: [{ district_id: "c", name: "Charleston", stores: [
    { store_number: "3938", name: "Wesmark", has_data: true }, { store_number: "9999", name: "Acme", has_data: false },
    { store_number: "3287", name: "MP Midas", has_data: true }, { store_number: "3302", name: "Sam Ritt", has_data: true },
  ] }],
  techs: [{ employee_id: "x", name: "X", district_id: "c", store_number: "3938", store_name: "Wesmark", hours_turned: 1, hours_worked: 1 }],
});
eq("store names + order from the workbook", named.divisions[0].stores.map((s) => s.name), ["Sam Ritt", "Mt Pleasant", "Sumter", "Acme"]);
eq("has_data survives the rename", named.divisions[0].stores.map((s) => s.has_data), [true, true, true, false]);
eq("a tech's store uses the workbook name too", named.top[0].storeName, "Sumter");
eq("all 34 workbook stores mapped once", [STORE_NAMES.length, new Set(STORE_NAMES.map((s) => s[0])).size], [34, 34]);

const unknown = buildTechRanks({ divisions: [{ district_id: "x", name: "Gulf", stores: [] }, { district_id: "y", name: "Florida", stores: [] }], techs: [] });
eq("an unknown district follows the known ones, under its own name", unknown.divisions.map((d) => d.label), ["Florida", "Gulf"]);
eq("empty input", [buildTechRanks(null).top.length, buildTechRanks(null).divisions.length], [0, 0]);

eq("whole month -> SEPTEMBER / Sept", periodLabels("2026-09-01", "2026-09-30"), { title: "SEPTEMBER", short: "Sept", long: "September 2026" });
eq("whole month Feb leap-safe", periodLabels("2028-02-01", "2028-02-29").title, "FEBRUARY");
eq("a partial range is spelled out", periodLabels("2026-09-01", "2026-09-15"), { title: "SEP 1, 2026 – SEP 15, 2026", short: null, long: "Sep 1, 2026 – Sep 15, 2026" });

// The Excel export, in the workbook's cells.
const wb = buildTechRanksWorkbook(r, { from: "2026-09-01", to: "2026-09-30" });
const ws = wb.getWorksheet("Tech Ranks");
eq("B1 heading", ws.getCell("B1").value, "Columbia - East Division");
eq("H1 heading", ws.getCell("H1").value, "Columbia - West Division");
eq("Z1 heading", ws.getCell("Z1").value, "Charleston");
eq("row 2 headers", ["B2", "C2", "D2", "E2"].map((a) => ws.getCell(a).value), ["Name", "Hrs Turned", "Hrs Worked", "Proficiency"]);
eq("B3 / C3 / D3", ["B3", "C3", "D3"].map((a) => ws.getCell(a).value), ["Joe Ludack", 231, 207]);
eq("E3 is a live formula", ws.getCell("E3").value.formula, 'IF(D3>0,C3/D3,"")');
eq("A3 gold, A4 silver, A5 bronze, A6 plain", ["A3", "A4", "A5", "A6"].map((a) => ws.getCell(a).fill?.fgColor?.argb ?? null),
  ["FFFFD700", "FFC0C0C0", "FFCD7F32", null]);
eq("proficiency 0%", ws.getCell("E3").numFmt, "0%");
eq("store list under each division", [ws.getCell("A14").value, ws.getCell("Y14").value], ["Columbia East store", "Charleston store"]);
const titleRow = [...Array(40).keys()].map((i) => i + 1).find((n) => ws.getCell(`I${n}`).value === "TOP 20 PGW TECHS - SEPTEMBER");
eq("Top 20 banner directly under the store lists (one store each -> row 15)", titleRow, 15);
const eight = buildTechRanks({ ...raw, divisions: raw.divisions.map((d) => ({ ...d, stores: Array.from({ length: 8 }, (_, k) => ({ store_number: d.name + k, name: "S" + k })) })) });
eq("eight stores -> banner on row 22, as in the workbook",
  buildTechRanksWorkbook(eight, { from: "2026-09-01", to: "2026-09-30" }).getWorksheet("Tech Ranks").getCell("I22").value, "TOP 20 PGW TECHS - SEPTEMBER");
eq("banner navy fill + white bold 16", [ws.getCell(`I${titleRow}`).fill.fgColor.argb, ws.getCell(`I${titleRow}`).font.color.argb, ws.getCell(`I${titleRow}`).font.size],
  ["FF17365D", "FFFFFFFF", 16]);
eq("subtitle", ws.getCell(`I${titleRow + 1}`).value, "Ranked by Hrs Turned");
eq("top 20 header row", ["I", "J", "K", "L", "M", "N", "P", "Q"].map((c) => ws.getCell(`${c}${titleRow + 2}`).value),
  ["Rank", "Name", "Market", "Hrs Turned", "Hrs Worked", "Proficiency", "Market", "Techs in Sept Top 20"]);
eq("top 20 first row", ["I", "J", "K", "L", "M"].map((c) => ws.getCell(`${c}${titleRow + 3}`).value), [1, "Ron Hendriks", "Columbia - West Division", 279, 160]);
eq("top 20 last row", ws.getCell(`J${titleRow + 22}`).value, "Jarrell Steward");
eq("market count first", [ws.getCell(`P${titleRow + 3}`).value, ws.getCell(`Q${titleRow + 3}`).value], ["Columbia - West Division", 9]);

const partial = buildTechRanksWorkbook(r, { from: "2026-09-01", to: "2026-09-15" }).getWorksheet("Tech Ranks");
eq("partial range count header", partial.getCell(`Q${titleRow + 2}`).value, "Techs in Top 20");

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
