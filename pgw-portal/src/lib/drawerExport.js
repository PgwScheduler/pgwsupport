import { DENOMS } from "./denoms.js";
import { computeTotals } from "./drawerMath.js";
import { csvEsc, downloadFile } from "./csv.js";
import { buildCloseoutRows } from "./closeoutRows.js";

const m2 = (v) => (Number(v) || 0).toFixed(2);

/* Single-store deposit sheet -> CSV. Uses the shared row model so it stays
   byte-for-byte in step with the per-store sheets in the multi-store workbook. */
export function exportCloseoutCSV(record, store) {
  const csv = buildCloseoutRows(record, store)
    .map((r) => r.cells.map(csvEsc).join(","))
    .join("\n");
  downloadFile(`PGW_${store.store_number}_closeout_${record.business_date}.csv`, csv, "text/csv;charset=utf-8;");
}

/* Every saved closeout for this store, one row each — for the office */
export function exportSummaryCSV(rows, store) {
  const head = ["Store #", "Store", "Date", "Entered by", "Opening Cash", "Closing Cash", "Drawer Fund",
    "Cash to Deposit", "Cash (summary)", "Over/Short", "Checks", "Credit Cards", "Bread", "Synchrony",
    "American First", "Koalifi", "Snap", "Fleet Invoices", "POA Cards", "Petty Cash", "Sales Tax",
    "Total Sales", "Total for Home Office", "Store Deposit to Bank", "Explanation"];
  const body = rows.map((r) => {
    const t = computeTotals(r, store.drawer_float);
    return [store.store_number, store.name, r.business_date, r.submitted_by_name || "",
      t.openTotal, t.closeTotal, t.float, t.cashToDeposit, Number(r.cash) || 0, t.diff, Number(r.checks) || 0,
      Number(r.cards) || 0, Number(r.bread) || 0, Number(r.synchrony) || 0, Number(r.american_first) || 0,
      Number(r.koalifi) || 0, Number(r.snap) || 0, t.fleetTotal, t.poaCardsTotal, t.pettyTotal,
      Number(r.sales_tax) || 0, t.totalSales, t.homeOffice, t.storeDeposit,
      (r.shortage_why || r.overage_why || "")];
  });
  const csv = [head, ...body].map((r) => r.map(csvEsc).join(",")).join("\n");
  downloadFile(`PGW_${store.store_number}_closeouts_summary.csv`, csv, "text/csv;charset=utf-8;");
}

/* Printable sheet -> opens the print dialog (choose "Save as PDF") */
export function printCloseout(record, store) {
  const e = record;
  const t = computeTotals(record, store.drawer_float);
  const m = (v) => (v < 0 ? "-$" : "$") + Math.abs(Number(v) || 0).toFixed(2);
  const cntRows = DENOMS.map(([k, label, dn]) => {
    const oq = Number(e.open_counts?.[k]) || 0, cq = Number(e.close_counts?.[k]) || 0;
    return `<tr><td>${label}</td><td class="c">${oq || ""}</td><td class="r">${oq ? m(oq * dn) : ""}</td>
     <td class="c">${cq || ""}</td><td class="r">${cq ? m(cq * dn) : ""}</td></tr>`;
  }).join("");
  const tblHTML = (title, cols, rows, total) => {
    const filled = (rows || []).filter((r) => cols.some((c) => String(r[c.key] ?? "").trim() !== ""));
    return `<h3>${title}</h3><table class="grid"><tr>${cols.map((c) => `<th>${c.label}</th>`).join("")}</tr>
      ${filled.length ? filled.map((r) => `<tr>${cols.map((c) => `<td class="${c.money ? "r" : ""}">${c.money ? m(r[c.key]) : (r[c.key] ?? "")}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${cols.length}" class="muted">No entries</td></tr>`}
      <tr class="tot"><td colspan="${cols.length - 1}">Total</td><td class="r">${m(total)}</td></tr></table>`;
  };
  const sumRow = (l, v, strong) => `<tr class="${strong ? "strong" : ""}"><td>${l}</td><td class="r">${m(v)}</td></tr>`;
  const savedAt = record.created_at ? new Date(record.created_at).toLocaleString() : "—";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PGW Closeout ${store.store_number} ${record.business_date}</title>
  <style>
    *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:28px;font-size:12px}
    h1{font-size:18px;margin:0} h2{font-size:13px;margin:18px 0 6px;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #111;padding-bottom:3px}
    h3{font-size:12px;margin:12px 0 4px}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:8px}
    .meta{text-align:right;font-size:11px;color:#444}
    table{width:100%;border-collapse:collapse;margin-bottom:6px}
    td,th{padding:3px 6px;border:1px solid #bbb} th{background:#eee;text-align:left;font-size:11px}
    .r{text-align:right} .c{text-align:center} .muted{color:#888;text-align:center}
    .strong td{font-weight:bold;background:#f4f4f4}
    .tot td{font-weight:bold;background:#f4f4f4}
    .two{display:flex;gap:14px} .two>div{flex:1}
    .box{border:2px solid #111;padding:6px 10px;margin:8px 0;display:flex;justify-content:space-between;font-weight:bold;font-size:14px}
    .note{font-size:11px;color:#444;margin:4px 0}
    @media print{body{margin:12mm}}
  </style></head><body>
  <div class="head">
    <div><h1>Cash Drawer Closeout</h1><div>#${store.store_number} · ${store.name}</div></div>
    <div class="meta"><div><strong>Date:</strong> ${record.business_date}</div>
      <div>Entered by: ${record.submitted_by_name || "—"}</div><div>Saved: ${savedAt}</div></div>
  </div>

  <h2>Drawer Cash Count</h2>
  <div class="note">This drawer keeps a ${m(t.float)} cash fund at all times.</div>
  <table class="grid">
    <tr><th>Currency</th><th class="c">Opening Qty</th><th class="r">Opening Amt</th><th class="c">Closing Qty</th><th class="r">Closing Amt</th></tr>
    ${cntRows}
    <tr class="tot"><td>Total Cash</td><td></td><td class="r">${m(t.openTotal)}</td><td></td><td class="r">${m(t.closeTotal)}</td></tr>
  </table>

  <table>
    ${sumRow("Closing Cash Balance", t.closeTotal)}
    ${sumRow("Subtract Drawer Fund Amount", -t.float)}
    ${sumRow("Net Daily Cash Activity", t.netDailyCash)}
  </table>
  <div class="box"><span>TOTAL CASH TO DEPOSIT</span><span>${m(t.cashToDeposit)}</span></div>
  <div class="note">Put this amount in your deposit envelope. Deposits are to be made DAILY.</div>

  <h2>Daily Sales Summary</h2>
  <div class="two">
    <div><table>
      ${sumRow("CASH", Number(e.cash) || 0)}
      ${sumRow("TOTAL Customer CHECKS", Number(e.checks) || 0)}
      ${sumRow("CASH, CHECKS TOTAL", t.cashChecksTotal, true)}
      ${sumRow("Midas CC Totals (Bread)", Number(e.bread) || 0)}
      ${sumRow("Sync Car Care (Synchrony)", Number(e.synchrony) || 0)}
      ${sumRow("Visa, Disc, Amex, Debit, MC", Number(e.cards) || 0)}
      ${sumRow("American First Totals", Number(e.american_first) || 0)}
      ${sumRow("Koalifi Totals", Number(e.koalifi) || 0)}
      ${sumRow("Snap Totals", Number(e.snap) || 0)}
      ${sumRow("Advance Pay", Number(e.advance_pay) || 0)}
      ${sumRow("Prior Advance Pay", Number(e.prior_advance) || 0)}
      ${sumRow("Advance Minus Prior Advanced", t.advanceMinusPrior)}
      ${sumRow("SALES TAX", Number(e.sales_tax) || 0)}
    </table></div>
    <div><table>
      ${sumRow("Cash Overage", t.overage)}
      ${sumRow("Cash Shortage", t.shortage)}
      ${sumRow("Charges / Fleet invoices", t.fleetTotal)}
      ${sumRow("POA's (Visa, Disc, Amex, Debit)", t.poaCardsTotal)}
      ${sumRow("TOTAL SALES", t.totalSales, true)}
      ${sumRow("TOTAL for Home Office", t.homeOffice, true)}
      ${sumRow("Credit Cards minus CC POAs", t.cardsMinusPOA)}
      ${sumRow("Store Deposit to Bank", t.storeDeposit, true)}
    </table>
    ${e.overage_why ? `<div class="note"><strong>Overage:</strong> ${e.overage_why}</div>` : ""}
    ${e.shortage_why ? `<div class="note"><strong>Shortage:</strong> ${e.shortage_why}</div>` : ""}
    </div>
  </div>

  <h2>Invoices, POAs &amp; Payouts</h2>
  ${tblHTML("POA — Credit Cards", [{ key: "customer", label: "Customer" }, { key: "invoice", label: "Invoice" }, { key: "amount", label: "Amount", money: true }], e.poa_cards, t.poaCardsTotal)}
  ${tblHTML("POA — Checks or Cash & Vendor Rebates", [{ key: "invoice", label: "Invoice #" }, { key: "account", label: "Account or Vendor" }, { key: "amount", label: "Amount", money: true }], e.poa_checks, t.poaChecksTotal)}
  ${tblHTML("Fleet / Charge Invoices", [{ key: "invoice", label: "Invoice #" }, { key: "account", label: "Account" }, { key: "amount", label: "Amount", money: true }, { key: "auth", label: "Auth #" }], e.fleet, t.fleetTotal)}
  ${tblHTML("Cash Payouts Recap", [{ key: "vendor", label: "Vendor" }, { key: "ro", label: "RO/PO #" }, { key: "description", label: "Description" }, { key: "amount", label: "Amount", money: true }], e.payouts, t.pettyTotal)}
  <div class="note">Receipts must accompany this form in your daily paperwork. All purchases go through Shari before using anything from the cash drawer.</div>
  </body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
