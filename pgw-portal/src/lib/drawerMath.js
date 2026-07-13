import { DENOMS, countTotal, num } from "./denoms.js";

export function blankEntry() {
  return {
    business_date: new Date().toISOString().slice(0, 10),
    open_counts: {},
    close_counts: {},
    cash: "", checks: "", bread: "", synchrony: "", cards: "", american_first: "",
    koalifi: "", snap: "", advance_pay: "", prior_advance: "", sales_tax: "",
    overage_why: "", shortage_why: "",
    poa_cards: [{ id: 1, customer: "", invoice: "", amount: "" }],
    poa_checks: [{ id: 1, invoice: "", account: "", amount: "" }],
    fleet: [{ id: 1, invoice: "", account: "", amount: "", auth: "" }],
    payouts: [{ id: 1, vendor: "", ro: "", description: "", amount: "" }],
  };
}

/* Mirrors the original deposit-sheet formulas exactly — see CLAUDE.md. */
export function computeTotals(entry, float) {
  const openTotal = countTotal(entry.open_counts);
  const closeTotal = countTotal(entry.close_counts);
  const netDailyCash = closeTotal - float;
  const cashToDeposit = Math.max(netDailyCash, 0);

  const sum = (rows) => (rows || []).reduce((a, r) => a + num(r.amount), 0);
  const poaCardsTotal = sum(entry.poa_cards);
  const poaChecksTotal = sum(entry.poa_checks);
  const fleetTotal = sum(entry.fleet);
  const pettyTotal = sum(entry.payouts);

  const cash = num(entry.cash), checks = num(entry.checks), bread = num(entry.bread),
    synchrony = num(entry.synchrony), cards = num(entry.cards), amFirst = num(entry.american_first),
    koalifi = num(entry.koalifi), snap = num(entry.snap),
    advance = num(entry.advance_pay), prior = num(entry.prior_advance);

  const cashChecksTotal = cash + checks;
  const advanceMinusPrior = advance - prior;
  const diff = cashToDeposit - cash; // + = over, − = short
  const overage = Math.max(diff, 0);
  const shortage = Math.min(diff, 0);
  const totalSales = fleetTotal + snap + koalifi + amFirst + cards + synchrony + bread + cashChecksTotal - advance + prior - poaCardsTotal;
  const homeOffice = cashToDeposit + checks + bread + synchrony + cards + amFirst + koalifi + snap - pettyTotal;
  const cardsMinusPOA = cards - poaCardsTotal;
  const storeDeposit = cashToDeposit + checks - pettyTotal;

  return {
    openTotal, closeTotal, float, netDailyCash, cashToDeposit,
    cashChecksTotal, advanceMinusPrior, diff, overage, shortage,
    poaCardsTotal, poaChecksTotal, fleetTotal, pettyTotal,
    totalSales, homeOffice, cardsMinusPOA, storeDeposit,
  };
}

function sanitizeCounts(counts) {
  const out = {};
  for (const [k] of DENOMS) {
    const v = num(counts?.[k]);
    if (v) out[k] = v;
  }
  return out;
}

function sanitizeRows(rows, keys) {
  return (rows || [])
    .map((r) => {
      const clean = {};
      for (const k of keys) clean[k] = k === "amount" ? num(r[k]) : String(r[k] ?? "").trim();
      return clean;
    })
    .filter((r) => keys.some((k) => (k === "amount" ? r[k] !== 0 : r[k] !== "")));
}

/* Coerces the typed-in form state to clean, storable values. */
export function sanitizeEntryForSave(entry) {
  return {
    business_date: entry.business_date,
    open_counts: sanitizeCounts(entry.open_counts),
    close_counts: sanitizeCounts(entry.close_counts),
    cash: num(entry.cash), checks: num(entry.checks), bread: num(entry.bread),
    synchrony: num(entry.synchrony), cards: num(entry.cards), american_first: num(entry.american_first),
    koalifi: num(entry.koalifi), snap: num(entry.snap), advance_pay: num(entry.advance_pay),
    prior_advance: num(entry.prior_advance), sales_tax: num(entry.sales_tax),
    overage_why: entry.overage_why?.trim() || null,
    shortage_why: entry.shortage_why?.trim() || null,
    poa_cards: sanitizeRows(entry.poa_cards, ["customer", "invoice", "amount"]),
    poa_checks: sanitizeRows(entry.poa_checks, ["invoice", "account", "amount"]),
    fleet: sanitizeRows(entry.fleet, ["invoice", "account", "amount", "auth"]),
    payouts: sanitizeRows(entry.payouts, ["vendor", "ro", "description", "amount"]),
  };
}
