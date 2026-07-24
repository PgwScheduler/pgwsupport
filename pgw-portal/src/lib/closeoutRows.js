import { DENOMS } from "./denoms.js";
import { computeTotals } from "./drawerMath.js";

// Shared layout logic — the single source of truth for BOTH the per-store CSV
// and the per-store sheets in the multi-store workbook, so they can never drift.
// Each row is { style, cells, fmts } where cells and fmts are both exactly WIDTH
// wide (padded with ""). Amounts are carried as real numbers (not pre-formatted
// strings) so Excel can treat them as numbers; the CSV stringifies them naturally
// (200, not 200.00). `fmts` tags each cell so the xlsx renderer can apply the
// right number format ("money" -> currency, "qty" -> integer count, "text" ->
// invoice/reference kept as text) — the CSV path ignores it entirely.
// All business math comes from computeTotals() — this file never re-derives it.

const WIDTH = 5;

// Per-cell format tokens consumed by closeoutWorkbook.js. "" = general/label.
const MONEY = "money";
const QTY = "qty";
const TEXT = "text";

export const round2 = (v) =>
  Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

const pad = (cells) => {
  const a = cells.slice(0, WIDTH);
  while (a.length < WIDTH) a.push("");
  return a;
};

// business_date is stored as ISO yyyy-mm-dd -> M/D/YYYY (matches the sample file)
const formatDate = (val) => {
  if (!val) return "";
  const [y, m, d] = String(val).slice(0, 10).split("-").map(Number);
  return `${m}/${d}/${y}`;
};

// created_at is an ISO timestamp -> "7/17/2026, 2:24:28 PM". Locale-pinned to
// en-US so the output is stable regardless of where the build/browser runs.
const formatTimestamp = (val) =>
  val ? new Date(val).toLocaleString("en-US") : "";

// The 21 named Daily Sales Summary rows, in order. [label, key-in-summaryVals].
const SUMMARY_ROWS = [
  ["CASH", "cash"],
  ["TOTAL Customer CHECKS", "customerChecks"],
  ["CASH, CHECKS TOTAL", "cashChecksTotal"],
  ["Midas CC Totals (Bread)", "midasCC"],
  ["Sync Car Care Totals (Synchrony)", "syncCarCare"],
  ["Visa, Disc, Amex, Debit, MC", "cardsVisaDiscAmexDebitMC"],
  ["American First Totals", "americanFirst"],
  ["Koalifi Totals", "koalifi"],
  ["Snap Totals", "snap"],
  ["Advance Pay", "advancePay"],
  ["Prior Advance Pay", "priorAdvancePay"],
  ["Advance Minus Prior Advanced", "advanceMinusPrior"],
  ["Cash Overage", "cashOverage"],
  ["Cash Shortage", "cashShortage"],
  ["Charges / Fleet invoices", "fleetInvoicesTotal"],
  ["POA's (Visa, Disc, Amex, Debit)", "poaCards"],
  ["SALES TAX", "salesTax"],
  ["TOTAL SALES", "totalSales"],
  ["TOTAL for Home Office", "totalForHomeOffice"],
  ["Credit Cards minus Credit Card POAs", "cardsMinusPoa"],
  ["Store Deposit to Bank", "storeDepositToBank"],
];

// record: a cash_drawer_closeouts row (jsonb line-item arrays inline,
//         optional submitted_by_name attached by the caller).
// store:  { store_number, name, drawer_float }.
export function buildCloseoutRows(record, store) {
  const e = record;
  const t = computeTotals(record, store.drawer_float);
  const rows = [];
  const push = (style, cells, fmts = []) =>
    rows.push({ style, cells: pad(cells), fmts: pad(fmts) });
  const blank = () => rows.push({ style: "blank", cells: pad([]), fmts: pad([]) });

  push("title", ["PGW Cash Drawer Closeout"]);
  push("meta", ["Store", `#${store.store_number} ${store.name}`]);
  push("meta", ["Date", formatDate(e.business_date)]);
  push("meta", ["Entered by", e.submitted_by_name || ""]);
  push("meta", ["Saved at", formatTimestamp(e.created_at)]);
  blank();

  push("sectionTitle", ["DRAWER CASH COUNT"]);
  push("columnHeader", ["Currency", "Opening Qty", "Opening Amount", "Closing Qty", "Closing Amount"]);
  DENOMS.forEach(([k, label, dn]) => {
    const oq = Number(e.open_counts?.[k]) || 0;
    const cq = Number(e.close_counts?.[k]) || 0;
    // Unused denominations stay blank (not 0) so the grid reads like the print
    // sheet; the qty/money tokens still span all 5 columns so the renderer keeps
    // the full-width table border.
    push("normal",
      [label, oq || "", oq ? round2(oq * dn) : "", cq || "", cq ? round2(cq * dn) : ""],
      ["", QTY, MONEY, QTY, MONEY]);
  });
  push("total", ["Total Cash", "", round2(t.openTotal), "", round2(t.closeTotal)],
    ["", "", MONEY, "", MONEY]);
  blank();

  push("sectionTitle", ["CASH TO DEPOSIT"]);
  push("normal", ["Closing Cash Balance", round2(t.closeTotal)], ["", MONEY]);
  push("normal", ["Subtract Drawer Fund Amount", round2(-t.float)], ["", MONEY]);
  push("normal", ["Net Daily Cash Activity", round2(t.netDailyCash)], ["", MONEY]);
  push("total", ["Total Cash to Deposit", round2(t.cashToDeposit)], ["", MONEY]);
  blank();

  push("sectionTitle", ["DAILY SALES SUMMARY"]);
  const summaryVals = {
    cash: e.cash,
    customerChecks: e.checks,
    cashChecksTotal: t.cashChecksTotal,
    midasCC: e.bread,
    syncCarCare: e.synchrony,
    cardsVisaDiscAmexDebitMC: e.cards,
    americanFirst: e.american_first,
    koalifi: e.koalifi,
    snap: e.snap,
    advancePay: e.advance_pay,
    priorAdvancePay: e.prior_advance,
    advanceMinusPrior: t.advanceMinusPrior,
    cashOverage: t.overage,   // >= 0
    cashShortage: t.shortage, // <= 0
    fleetInvoicesTotal: t.fleetTotal,
    poaCards: t.poaCardsTotal,
    salesTax: e.sales_tax,
    totalSales: t.totalSales,
    totalForHomeOffice: t.homeOffice,
    cardsMinusPoa: t.cardsMinusPOA,
    storeDepositToBank: t.storeDeposit,
  };
  for (const [label, key] of SUMMARY_ROWS) push("normal", [label, round2(summaryVals[key] ?? 0)], ["", MONEY]);
  blank();

  // Variable-length line-item tables. The Total lands in the "amount" column
  // (cleanup: the old export misplaced the Fleet total under the Auth # column).
  // Column format token: money -> currency, text -> invoice/reference kept as
  // text (leading zeros survive), otherwise general.
  const fmtFor = (c) => (c.money ? MONEY : c.text ? TEXT : "");
  const lineTable = (title, cols, items, total, trailingBlank = true) => {
    push("sectionTitle", [title]);
    push("columnHeader", cols.map((c) => c.label));
    for (const r of items || []) {
      push("normal",
        cols.map((c) => (c.money ? round2(r[c.key]) : (r[c.key] ?? ""))),
        cols.map(fmtFor));
    }
    push("total",
      cols.map((c, i) => (i === 0 ? "Total" : c.money ? round2(total) : "")),
      cols.map((c, i) => (i === 0 ? "" : fmtFor(c))));
    if (trailingBlank) blank();
  };

  lineTable("POA - CREDIT CARDS",
    [{ key: "customer", label: "Customer" }, { key: "invoice", label: "Invoice", text: true }, { key: "amount", label: "Amount", money: true }],
    e.poa_cards, t.poaCardsTotal);
  lineTable("POA - CHECKS OR CASH & VENDOR REBATES",
    [{ key: "invoice", label: "Invoice #", text: true }, { key: "account", label: "Account or Vendor" }, { key: "amount", label: "Amount", money: true }],
    e.poa_checks, t.poaChecksTotal);
  lineTable("FLEET / CHARGE INVOICES",
    [{ key: "invoice", label: "Invoice #", text: true }, { key: "account", label: "Account" }, { key: "amount", label: "Amount", money: true }, { key: "auth", label: "Auth #", text: true }],
    e.fleet, t.fleetTotal);
  lineTable("CASH PAYOUTS RECAP",
    [{ key: "vendor", label: "Vendor" }, { key: "ro", label: "RO/PO #", text: true }, { key: "description", label: "Description" }, { key: "amount", label: "Amount", money: true }],
    e.payouts, t.pettyTotal, false);

  return rows;
}
