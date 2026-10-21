import ExcelJS from "exceljs";
import JSZip from "jszip";
import { monthShort } from "./partsRecon.js";

// =====================================================================
// Reading the recon run's result workbooks (migration 90).
//
// The Python scripts (AP Reconciliations\00 Setup\Monthly Recon Scripts)
// stay exactly as they are. AP uploads what run_all.py wrote to
// 03 Results and this turns it into rows for parts_recon_import_rows():
//
//   RO Cost Breakdown      By RO + Line Detail -> store items (what the
//                          store emails carry), Stock But Ordered -> notes,
//                          Warranty (add back) -> AP to-do
//   Parts Recon Detail     Statement Lines -> Divvy items + AP to-do,
//                          RO Cost Check / AP Not On Statement -> AP to-do,
//                          Summary -> ARM store amounts + the tie-out check
//   filled tracker         MONTHLY LOG -> management's tracker lines
//   Store Response Tracker (optional) statuses already worked in Excel,
//                          and the Other Credits tab
//
// The rules mirror the scripts so the portal shows what the emails and
// the tracker said: emails_data.py for store items, build_packets.py for
// the AP to-do, build_detail.py for the tracker amount (Divvy = bills not
// in AP; everything else = vendor over RO cost).
// =====================================================================

const SET_ASIDE = 25; // build_packets.py SET_ASIDE

// ExcelJS can't open a workbook whose tables Excel has re-saved (the
// Response Tracker and the shared tracker both crash it). Tables are only
// formatting for our purposes, so take them out of the zip first.
export async function loadWorkbook(data) {
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files);
  for (const n of names) if (/^xl\/tables\//.test(n)) zip.remove(n);
  for (const n of names) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(n)) {
      const s = await zip.file(n).async("string");
      zip.file(n, s.replace(/<tableParts[\s\S]*?<\/tableParts>/, "").replace(/<tableParts[^>]*\/>/, ""));
    } else if (/^xl\/worksheets\/_rels\/.*\.rels$/.test(n)) {
      const s = await zip.file(n).async("string");
      zip.file(n, s.replace(/<Relationship[^>]*tables\/[^>]*\/>/g, ""));
    } else if (n === "[Content_Types].xml") {
      const s = await zip.file(n).async("string");
      zip.file(n, s.replace(/<Override[^>]*\/xl\/tables\/[^>]*\/>/g, ""));
    }
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await zip.generateAsync({ type: "uint8array" }));
  return wb;
}

// A cell as a plain value. A formula Excel never calculated has no saved
// result and comes back null -- the checks below say so rather than guess.
export function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isoDate(v);
  if (typeof v === "object") {
    if ("result" in v) return v.result instanceof Date ? isoDate(v.result) : v.result ?? null;
    if ("formula" in v || "sharedFormula" in v) return null;
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return v.text;
    if (v.error) return null;
    return null;
  }
  return v;
}
const isoDate = (d) => (isNaN(d) ? null : d.toISOString().slice(0, 10));

export function sheetRows(ws, fromRow) {
  const out = [];
  if (!ws) return out;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n < fromRow) return;
    const vals = row.values.slice(1).map(cellValue);
    out.push(vals);
  });
  return out;
}

// Which result file is this?
export function identify(wb) {
  const has = (n) => !!wb.getWorksheet(n);
  if (has("By RO") && has("Line Detail")) return "breakdown";
  if (has("Statement Lines") && has("Summary")) return "detail";
  if (has("MONTHLY LOG")) return "tracker";
  if (has("Items") && has("By Store")) return "responses";
  return null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sept", "oct", "nov", "dec"];
// "September 2026 Parts Reconciliation ..." or "Sept 2026 RO Cost Breakdown" -> "2026-09-01"
export function monthFromTitle(text) {
  const m = String(text ?? "").toLowerCase().match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b\.?\s+(20\d\d)/);
  if (!m) return null;
  let i = MONTHS.indexOf(m[1]);
  if (i < 0) i = SHORT.indexOf(m[1] === "sep" ? "sept" : m[1]);
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, "0")}-01`;
}

const num = (v) => (typeof v === "number" && isFinite(v) ? v : v === null || v === "" || v === undefined ? null : isFinite(Number(v)) ? Number(v) : null);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

// Keys that stay the same from one run to the next, so a re-import keeps
// replies. A repeat of the same charge gets #2, #3.
function keyer() {
  const seen = new Map();
  return (base) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };
}

// ---------------------------------------------------------------------
// RO Cost Breakdown
// ---------------------------------------------------------------------
export function fromBreakdown(sheets) {
  const lineKey = (r) => `${r[0]}|${r[1]}|${r[2]}`;
  const parts = new Map(), lines = new Map();
  for (const r of sheets.lineDetail) {
    if (!r[0]) continue;
    const k = lineKey(r);
    if (r[3] === "RO part - this vendor") {
      if (!parts.has(k)) parts.set(k, []);
      parts.get(k).push({ part: str(r[7]), desc: str(r[8]), cost: num(r[10]), stock: r[9] === "Stock", result: str(r[11]) });
    } else if (r[3] === "Vendor invoice") {
      if (!lines.has(k)) lines.set(k, []);
      lines.get(k).push({ inv: str(r[4]), date: str(r[5]), amt: num(r[10]), result: str(r[11]), note: str(r[12]) });
    }
  }

  const items = [], warnings = [];
  const key = keyer();
  for (const r of sheets.byRo) {
    const [st, v, ro, billed, rocost, , , cause, fix] = r;
    if (!st) continue;
    // emails_data.py: an RO whose only asks are AP's ("AP: ...") isn't a store item.
    const asks = String(fix ?? "").split("; ").filter((f) => f && !f.startsWith("AP:"));
    if (!asks.length) continue;
    const b = num(billed), c = num(rocost), core = num(r[11]) ?? 0;
    if (b === null || c === null) { warnings.push(`By RO ${st} ${v} RO ${ro}: billed or RO cost has no saved value`); continue; }
    const diff = r2(b - c - core);
    let asked = asks.join("; ");
    if (diff < 0) asked = (asked ? asked + "; " : "") + `RO is $${(-diff).toFixed(2)} higher than the bill - no deduction`;
    const k = lineKey(r);
    const invs = [...new Set((lines.get(k) ?? []).map((x) => x.inv).filter(Boolean))].join(", ");
    items.push({
      import_key: key(`ro_cost|${st}|${v}|${ro}`), kind: "ro_cost", recon_store: st, vendor: v, ro: str(ro),
      invoices: invs || null, billed: r2(b), ro_cost: r2(c), core: r2(core),
      amount: diff > 0 ? diff : 0, ro_higher: diff < 0 ? -diff : null,
      asked, why: str(cause), detail: { parts: parts.get(k) ?? [], lines: lines.get(k) ?? [] },
    });
  }

  const notes = sheets.stockOrdered.filter((r) => r[0]).map((r) => ({
    recon_store: r[0], vendor: str(r[1]), ro: str(r[2]), part: str(r[3]), description: str(r[4]), cost: num(r[5]), ordered_on: str(r[6]),
  }));

  const tkey = keyer();
  const tasks = sheets.warranty.filter((r) => r[0]).map((r) => ({
    import_key: tkey(`warranty_addback|${r[0]}|${r[1]}|${r[2]}`), kind: "warranty_addback", recon_store: r[0], vendor: str(r[1]),
    task: "Midas warranty tire - add back by hand (left off the store email and the tracker)",
    invoice: str(r[3]), po: str(r[2]), stmt_amount: num(r[4]), ap_amount: num(r[5]),
    detail: [r[7] && `Tire(s): ${r[7]}`, num(r[6]) !== null && `difference $${r2(r[6]).toFixed(2)}`].filter(Boolean).join("; ") || null,
  }));
  return { items, notes, tasks, warnings };
}

// ---------------------------------------------------------------------
// Parts Recon Detail
// ---------------------------------------------------------------------
// Statement Lines columns
const SL = { store: 0, vendor: 1, date: 2, inv: 3, po: 4, ro: 5, amt: 6, ap: 8, apInv: 9, apAmt: 10, note: 14, src: 15 };

export function fromDetail(sheets) {
  const items = [], tasks = [], warnings = [];
  const ikey = keyer(), tkey = keyer();
  const task = (kind, store, vendor, text, inv, po, date, stmt, ap, detail) => tasks.push({
    import_key: tkey(`${kind}|${store}|${vendor ?? ""}|${inv ?? ""}|${po ?? ""}|${date ?? ""}|${stmt ?? ap ?? ""}`),
    kind, recon_store: store, vendor: str(vendor), task: text, invoice: str(inv), po: str(po), txn_date: date ?? null,
    stmt_amount: stmt === null || stmt === undefined ? null : r2(stmt), ap_amount: ap === null || ap === undefined ? null : r2(ap),
    detail: str(detail),
  });

  const armStores = new Set();
  for (const s of sheets.statementLines) {
    if (s[SL.ap] === "N/A - ARM (no AP report)") armStores.add(s[SL.store]);
  }

  for (const s of sheets.statementLines) {
    const store = s[SL.store], vendor = s[SL.vendor], st = s[SL.ap], amt = num(s[SL.amt]);
    if (!store || amt === null) continue;
    const unassigned = String(store).startsWith("Unassigned");

    // Divvy parts charge not keyed in AP -> on the tracker (build_detail.py: Divvy GP = bills not in AP).
    if (vendor === "Divvy" && st === "NOT IN AP" && !unassigned && amt > 0) {
      items.push({
        import_key: ikey(`divvy|${store}|${s[SL.date] ?? ""}|${s[SL.inv] ?? ""}|${amt}|${s[SL.po] ?? ""}`), kind: "divvy",
        recon_store: store, vendor: "Divvy", ro: str(s[SL.ro]) ?? str(s[SL.po]), invoices: str(s[SL.inv]), txn_date: s[SL.date] ?? null,
        billed: r2(amt), amount: r2(amt),
        asked: "Enter this purchase in RO Writer AP on the correct RO (or send the receipt and RO #).",
        why: [str(s[SL.po]) && `PO / note: ${s[SL.po]}`, str(s[SL.src])].filter(Boolean).join(" - ") || null,
      });
      continue;
    }
    if (unassigned) {
      if (Math.abs(amt) >= SET_ASIDE && st !== "MATCHED" && !String(st ?? "").startsWith("N/A")) {
        task("unassigned", store, vendor, "Couldn't tie this to a store - ask the cardholder / corporate which store and RO",
          s[SL.inv], s[SL.po], s[SL.date], amt, null, s[SL.src]);
      }
      continue;
    }
    if (vendor === "Divvy" || vendor === "Uber") continue;
    const apAmt = num(s[SL.apAmt]);
    if (st === "NOT IN AP" && Math.abs(amt) >= SET_ASIDE) {
      task(amt < 0 ? "credit_not_in_ap" : "bill_not_in_ap", store, vendor,
        amt < 0 ? "Credit not keyed in AP - key the credit" : "Bill not keyed in AP - key the bill",
        s[SL.inv], s[SL.po], s[SL.date], amt, null, s[SL.src]);
    } else if (st === "AMOUNT DIFF" && apAmt !== null && Math.abs(amt - apAmt) >= 1) {
      task("amount_diff", store, vendor,
        "AP amount differs from statement - correct the AP entry" + (/sales tax/i.test(s[SL.note] ?? "") ? " (looks like sales tax)" : ""),
        s[SL.inv], s[SL.po], s[SL.date], amt, apAmt, s[SL.apInv] ? `AP invoice ${s[SL.apInv]}` : null);
    } else if (st === "WRONG SUPPLIER IN AP") {
      task("wrong_supplier", store, vendor, "Keyed under the wrong supplier - move it", s[SL.inv], s[SL.po], s[SL.date], amt, apAmt, s[SL.note]);
    }
  }

  // RO Cost Check: Location, Vendor, RO #, Statement PO(s), # lines, Statement Net, RO Cost, Vendor - RO Cost, Status, What it looks like, Statement Invoices
  for (const c of sheets.roCostCheck) {
    const [store, vendor, ro, pos, , net, , gap, status, looks, invs] = c;
    if (!store) continue;
    if (status === "SALES TAX ON INVOICE (AP)") {
      task("sales_tax", store, vendor, "Vendor charged sales tax on a parts invoice - take up with the vendor", invs, ro, null, num(net), null, looks);
    } else if (status === "RO NOT ON PARTS DETAIL" && (num(gap) ?? 0) >= SET_ASIDE) {
      task("ro_not_on_parts_detail", store, vendor, "RO # on the vendor invoice isn't on this month's Parts Detail - still open, or a different RO?",
        invs, ro ?? pos, null, num(net), null, looks);
    } else if (status === "NO RO # ON STATEMENT" && (num(gap) ?? 0) >= SET_ASIDE) {
      task("no_ro_on_statement", store, vendor, "Vendor charge with no RO # on it - what RO (or stock/shop) was it for?",
        invs, pos || "(blank)", null, num(gap), null, looks);
    }
  }

  // AP Not On Statement: Location, Vendor, AP Supplier Name, AP Date, AP Invoice, AP PO #, AP Amount, Paid?
  for (const r of sheets.apNotOnStatement) {
    const amt = num(r[6]);
    if (!r[0] || amt === null || Math.abs(amt) < SET_ASIDE) continue;
    task("ap_not_on_statement", r[0], r[1], "In AP but not on the vendor statement - confirm before paying (partial bill? duplicate? core not charged?)",
      r[4], r[5], r[3], null, amt, `AP supplier ${r[2] ?? ""}${r[7] ? ` - paid: ${r[7]}` : ""}`);
  }

  // Summary: script amounts per Location x Vendor (the tracker's Amount), and the ARM stores.
  const summary = [];
  let summaryTotal = null;
  const hi = sheets.summary.findIndex((r) => r[0] === "Location");
  const hdr = hi >= 0 ? sheets.summary[hi] : [];
  const col = (name) => hdr.indexOf(name);
  const gpCol = col("GP Amount → tracker"), statusCol = col("Status → tracker"), lineCol = col("Tracker line");
  if (gpCol < 0) warnings.push("Parts Recon Detail: the Summary tab has no 'GP Amount → tracker' column");
  for (const r of sheets.summary.slice(hi + 1)) {
    if (!r[0]) continue;
    if (r[0] === "TOTAL") { summaryTotal = num(r[gpCol]); continue; }
    summary.push({ store: r[0], vendor: r[1], gp: num(r[gpCol]), status: str(r[statusCol]), line: lineCol < 0 ? null : str(r[lineCol]) });
  }
  for (const s of summary) {
    if (!armStores.has(s.store) || s.vendor === "Divvy" || !(s.gp > 0)) continue;
    items.push({
      import_key: ikey(`arm|${s.store}|${s.vendor}`), kind: "arm", recon_store: s.store, vendor: s.vendor,
      amount: r2(s.gp), asked: "Compared at RO level to the ARM outside-purchase cost (no part lines, no store email).",
    });
  }
  return { items, tasks, summary, summaryTotal, warnings, title: sheets.summaryTitle };
}

// ---------------------------------------------------------------------
// Filled tracker (MONTHLY LOG), or the Summary when it isn't uploaded
// ---------------------------------------------------------------------
export function fromTracker(rows, month) {
  const ym = String(month).slice(0, 7);
  const hi = rows.findIndex((r) => r[0] === "Month" && r.includes("Key"));
  if (hi < 0) return { tracker: [], warnings: ["Tracker: no MONTHLY LOG header row found"] };
  const h = rows[hi], c = (n) => h.indexOf(n);
  // A month can appear twice: management's blank template block AND the
  // block the run filled (September has both). One row per key -- the one
  // with something in it -- and lines only management keyed (Agero
  // Towing...) are kept so the export doesn't lose them.
  const byKey = new Map();
  rows.slice(hi + 1).forEach((r) => {
    const key = str(r[c("Key")]);
    if (!key || !key.startsWith(ym + "|")) return;
    const line = {
      key, region: str(r[c("Region")]), recon_store: str(r[c("Location")]), vendor: str(r[c("Vendor")]),
      script_status: str(r[c("Status")]), script_amount: num(r[c("Amount")]), script_notes: str(r[c("Notes")]),
    };
    const filled = (x) => x.script_status !== null || x.script_amount !== null || x.script_notes !== null;
    const prev = byKey.get(key);
    if (!prev || (!filled(prev) && filled(line))) byKey.set(key, { ...line, sort: prev?.sort ?? byKey.size + 1 });
  });
  const tracker = [...byKey.values()].sort((a, b) => a.sort - b.sort);
  return { tracker, warnings: tracker.length ? [] : [`Tracker: no MONTHLY LOG rows for ${ym}`] };
}

export const trackerFromSummary = (summary, month) => {
  const ym = String(month).slice(0, 7);
  return summary.map((s, i) => ({
    key: `${ym}|${s.store}|${s.vendor}`, sort: i + 1, region: null, recon_store: s.store, vendor: s.vendor,
    script_status: s.status, script_amount: s.gp ?? 0, script_notes: null,
  }));
};

// ---------------------------------------------------------------------
// Store Response Tracker (optional): statuses worked in Excel, and the
// Other Credits tab.
// ---------------------------------------------------------------------
const RT_STATUS = {
  "open": "open", "credit received": "credit_received", "partial credit": "partial_credit",
  "explained - no deduction": "explained", "deduct from store": "deduct",
};
const VENDOR_DISPLAY = { Napa: "NAPA", "O'Reilly's": "O'Reilly", "Advance & Carquest": "Advance / Carquest" };

export function fromResponses(itemsRows, creditRows, items) {
  // The workbook shows vendors by display name; find each item by store|vendor|RO.
  const byKey = new Map();
  for (const i of items) {
    if (i.kind !== "ro_cost") continue;
    byKey.set(`${i.recon_store}|${VENDOR_DISPLAY[i.vendor] ?? i.vendor}|${i.ro}`, i.import_key);
  }
  const responses = [], unmatched = [];
  for (const r of itemsRows) {
    if (!r[0] || r[0] === "Store") continue;
    const status = RT_STATUS[String(r[7] ?? "").trim().toLowerCase()];
    if (!status || status === "open") continue;
    const k = byKey.get(`${r[0]}|${r[1]}|${r[2]}`);
    if (!k) { unmatched.push(`${r[0]} ${r[1]} RO ${r[2]}`); continue; }
    responses.push({ import_key: k, status, credit_no: str(r[8]), credit_amt: num(r[9]), answered: str(r[10]), note: str(r[11]) });
  }
  const hi = creditRows.findIndex((r) => r[0] === "Store" && r.includes("Credit #"));
  const credits = hi < 0 ? [] : creditRows.slice(hi + 1).filter((r) => r[0]).map((r) => ({
    recon_store: r[0], vendor: str(r[1]), credit_no: str(r[2]), credit_date: str(r[3]), orig_invoice: str(r[4]), ro: str(r[5]),
    parts: str(r[6]), amount: num(r[7]), for_month: str(r[8]), notes: str(r[9]),
  }));
  return { responses, credits, unmatched };
}

// ---------------------------------------------------------------------
// Putting it together, with the checks AP sees before importing.
// ---------------------------------------------------------------------
export function sheetsOf(wb, kind) {
  const rows = (name, from) => sheetRows(wb.getWorksheet(name), from);
  if (kind === "breakdown") {
    return { byRo: rows("By RO", 5), lineDetail: rows("Line Detail", 5), stockOrdered: rows("Stock But Ordered", 5),
      warranty: rows("Warranty (add back)", 5), title: cellValue(wb.getWorksheet("By RO").getCell("A1").value) };
  }
  if (kind === "detail") {
    return { statementLines: rows("Statement Lines", 2), roCostCheck: rows("RO Cost Check", 2), apNotOnStatement: rows("AP Not On Statement", 2),
      summary: rows("Summary", 1), summaryTitle: cellValue(wb.getWorksheet("Summary").getCell("A1").value) };
  }
  if (kind === "tracker") return { log: rows("MONTHLY LOG", 1) };
  if (kind === "responses") {
    const other = wb.worksheets.find((w) => /other credits/i.test(w.name));
    return { items: rows("Items", 1), credits: other ? sheetRows(other, 1) : [] };
  }
  return null;
}

export function buildImport({ breakdown, detail, tracker, responses }) {
  const errors = [], warnings = [];
  if (!breakdown) errors.push("Add the RO Cost Breakdown workbook.");
  if (!detail) errors.push("Add the Parts Recon Detail workbook.");
  if (errors.length) return { errors, warnings };

  const month = monthFromTitle(detail.summaryTitle) ?? monthFromTitle(breakdown.title);
  if (!month) return { errors: ["Couldn't tell the month from the workbooks' titles."], warnings };
  const bMonth = monthFromTitle(breakdown.title);
  if (bMonth && bMonth !== month) errors.push(`The RO Cost Breakdown is for ${monthShort(bMonth)} but the Parts Recon Detail is for ${monthShort(month)}.`);

  const b = fromBreakdown(breakdown);
  const d = fromDetail(detail);
  warnings.push(...b.warnings, ...d.warnings);
  const items = [...b.items, ...d.items];
  const tasks = [...d.tasks, ...b.tasks];

  let trackerLines;
  if (tracker) {
    const t = fromTracker(tracker.log, month);
    warnings.push(...t.warnings);
    trackerLines = t.tracker;
  }
  if (!trackerLines?.length) {
    trackerLines = trackerFromSummary(d.summary, month);
    warnings.push("No filled tracker uploaded - tracker lines come from the Summary tab (no Region or Notes).");
  }

  // Which tracker row each item rolls up to -- fill_tracker.py: the
  // Summary's "Tracker line" if the tracker has that row for the store,
  // otherwise "Misc." (small vendors, towing, dealers...).
  const lineOf = new Map(d.summary.map((s) => [`${s.store}|${s.vendor}`, s.line]));
  const trackerKeys = new Set(trackerLines.map((t) => `${t.recon_store}|${t.vendor}`));
  for (const i of items) {
    const tl = lineOf.get(`${i.recon_store}|${i.vendor}`) || "Misc.";
    i.tracker_vendor = trackerKeys.has(`${i.recon_store}|${tl}`) ? tl : "Misc.";
  }

  let resp = { responses: [], credits: [], unmatched: [] };
  if (responses) {
    resp = fromResponses(responses.items, responses.credits, items);
    if (resp.unmatched.length) warnings.push(`${resp.unmatched.length} Response Tracker row(s) didn't match an item: ${resp.unmatched.slice(0, 5).join("; ")}${resp.unmatched.length > 5 ? "…" : ""}`);
  }

  // Tie-out: the run's amount per Location x Vendor vs. the items built here.
  const itemSum = new Map();
  for (const i of items) itemSum.set(`${i.recon_store}|${i.vendor}`, r2((itemSum.get(`${i.recon_store}|${i.vendor}`) ?? 0) + i.amount));
  const mismatches = [];
  for (const s of d.summary) {
    if (s.gp === null) continue; // a formula with no saved value
    const got = itemSum.get(`${s.store}|${s.vendor}`) ?? 0;
    if (Math.abs(got - s.gp) > 0.005) mismatches.push({ store: s.store, vendor: s.vendor, script: s.gp, portal: got });
  }
  const byKind = (k) => r2(items.filter((i) => i.kind === k).reduce((a, i) => a + i.amount, 0));
  const check = {
    store_items: b.items.length, store_amount: byKind("ro_cost"), divvy_items: d.items.filter((i) => i.kind === "divvy").length,
    divvy_amount: byKind("divvy"), arm_amount: byKind("arm"), total: r2(items.reduce((a, i) => a + i.amount, 0)),
    summary_total: d.summaryTotal, tracker_total: r2(trackerLines.reduce((a, t) => a + (t.script_amount ?? 0), 0)),
    ap_tasks: tasks.length, notes: b.notes.length, responses: resp.responses.length, mismatches: mismatches.length,
  };
  if (mismatches.length) warnings.push(`${mismatches.length} Location x Vendor amount(s) don't match the Summary tab.`);
  // And against management's tracker: each tracker row vs. the items that
  // roll up to it. A row with no items keeps the amount it was entered with
  // (lines management keyed by hand, e.g. Agero Towing).
  const byLine = new Map();
  for (const i of items) byLine.set(`${i.recon_store}|${i.tracker_vendor}`, r2((byLine.get(`${i.recon_store}|${i.tracker_vendor}`) ?? 0) + i.amount));
  const trackerMismatches = [], keyed = [];
  for (const t of trackerLines) {
    const k = `${t.recon_store}|${t.vendor}`;
    if (!byLine.has(k)) { if ((t.script_amount ?? 0) !== 0) keyed.push(t); continue; }
    if (Math.abs(byLine.get(k) - (t.script_amount ?? 0)) > 0.005) trackerMismatches.push({ store: t.recon_store, vendor: t.vendor, tracker: t.script_amount, portal: byLine.get(k) });
  }
  check.tracker_other = r2(keyed.reduce((a, t) => a + t.script_amount, 0));
  check.tracker_mismatches = trackerMismatches.length;
  if (keyed.length) {
    warnings.push(`The tracker also has ${keyed.length} line(s) the recon didn't produce ($${check.tracker_other.toFixed(2)}, e.g. ${keyed[0].recon_store} ${keyed[0].vendor}). They're kept as entered.`);
  }
  if (trackerMismatches.length) {
    warnings.push(`${trackerMismatches.length} tracker row(s) don't equal their items, e.g. ${trackerMismatches[0].store} ${trackerMismatches[0].vendor}: tracker $${trackerMismatches[0].tracker} vs. $${trackerMismatches[0].portal}.`);
  }
  if (d.summaryTotal !== null && Math.abs(check.total - d.summaryTotal) > 0.005) {
    warnings.push(`Portal total $${check.total.toFixed(2)} vs. Summary total $${d.summaryTotal.toFixed(2)}.`);
  }

  return {
    errors, warnings, month, label: monthShort(month), check, mismatches,
    items, tasks, notes: b.notes, tracker: trackerLines, responses: resp.responses, credits: resp.credits,
  };
}
