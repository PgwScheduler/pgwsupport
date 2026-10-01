// =====================================================================
// Tech Ranks (migration 74) — the "Tech ranks" workbook, for any range.
//
// tech_ranks() returns raw per-technician totals; everything the report
// shows is decided here, so the screen and the Excel export rank the
// same numbers the same way:
//
//   * each division's top 10 and the company top 20, ranked by hours
//     turned (flag hours); a tie goes to the higher proficiency, then
//     to the name. The hand-sorted workbook mostly does the same (Chris
//     Jones 86% over Joshua Lee 77% at 150 hours, Joseph Platt over Mike
//     Tucker at 199) but not always; the portal is consistent.
//   * proficiency = hours turned / hours worked, blank (never 0% and
//     never infinite) when nothing was worked
//   * ranks 1-3 are gold, silver and bronze
//   * divisions in the workbook's order and under its headings; a
//     district the workbook never knew falls in after them under its
//     own name rather than disappearing
// =====================================================================

export const DIVISION_TOP = 10;
export const COMPANY_TOP = 20;

// The workbook's own fills (Sheet2 A3 / A4 / A5).
export const MEDALS = {
  1: { fill: "FFD700", font: "1F1F1F", label: "Gold" },
  2: { fill: "C0C0C0", font: "1F1F1F", label: "Silver" },
  3: { fill: "CD7F32", font: "1F1F1F", label: "Bronze" },
};
export const TITLE_FILL = "17365D";   // the Top 20 banner (I22)
export const SUBTITLE_FONT = "5B6573"; // "Ranked by Hrs Turned" (I23)

// Portal district name -> the workbook's heading, in its column order.
export const DIVISIONS = [
  ["Columbia East", "Columbia - East Division"],
  ["Columbia West", "Columbia - West Division"],
  ["Florida", "Florida"],
  ["North", "PGW North"],
  ["Charleston", "Charleston"],
];

export const medalFor = (rank) => MEDALS[rank] ?? null;

export function proficiency(turned, worked) {
  return worked > 0 ? turned / worked : null;
}

// Highest hours turned first; ties to proficiency, then name.
export function compareTechs(a, b) {
  if (b.hoursTurned !== a.hoursTurned) return b.hoursTurned - a.hoursTurned;
  const pa = a.proficiency ?? -1, pb = b.proficiency ?? -1;
  if (pb !== pa) return pb - pa;
  return a.name.localeCompare(b.name);
}

const ranked = (list, n) => [...list].sort(compareTechs).slice(0, n).map((t, i) => ({ ...t, rank: i + 1 }));

export function buildTechRanks(raw) {
  const order = new Map(DIVISIONS.map(([name], i) => [name, i]));
  const heading = new Map(DIVISIONS);

  const divisions = [...(raw?.divisions ?? [])]
    .sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99) || a.name.localeCompare(b.name))
    .map((d) => ({ id: d.district_id, name: d.name, label: heading.get(d.name) ?? d.name, stores: d.stores ?? [] }));
  const labelOf = Object.fromEntries(divisions.map((d) => [d.id, d.label]));

  const techs = (raw?.techs ?? []).map((t) => {
    const hoursTurned = Number(t.hours_turned) || 0, hoursWorked = Number(t.hours_worked) || 0;
    return {
      id: t.employee_id, name: (t.name ?? "").trim() || "(no name)",
      divisionId: t.district_id, division: labelOf[t.district_id] ?? "",
      storeNumber: t.store_number, storeName: t.store_name, storeCount: t.store_count ?? 1,
      hoursTurned, hoursWorked, proficiency: proficiency(hoursTurned, hoursWorked),
    };
  });

  for (const d of divisions) d.top = ranked(techs.filter((t) => t.divisionId === d.id), DIVISION_TOP);
  const top = ranked(techs, COMPANY_TOP);

  // "Techs in Sept Top 20": every division listed, most first (the
  // workbook lists Florida with 0 rather than dropping it).
  const counts = divisions
    .map((d) => ({ label: d.label, count: top.filter((t) => t.divisionId === d.id).length }))
    .sort((a, b) => b.count - a.count);

  const stores = divisions.flatMap((d) => d.stores);
  return {
    divisions, top, counts, techCount: techs.length,
    storeCount: stores.length, storesWithData: stores.filter((s) => s.has_data).length,
  };
}

// "SEPTEMBER" for a whole calendar month, as the workbook titles it;
// otherwise the range itself.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtDay = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
};
export function periodLabels(from, to) {
  const [y, m] = from.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const wholeMonth = from.endsWith("-01") && to === `${from.slice(0, 7)}-${String(last).padStart(2, "0")}`;
  if (wholeMonth) {
    return { title: MONTHS[m - 1].toUpperCase(), short: MONTHS[m - 1].slice(0, 3) === "Sep" ? "Sept" : MONTHS[m - 1].slice(0, 3), long: `${MONTHS[m - 1]} ${y}` };
  }
  const long = from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
  return { title: long.toUpperCase(), short: null, long };
}
