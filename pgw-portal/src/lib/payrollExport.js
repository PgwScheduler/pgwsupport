// Role-aware payroll export. A store export contains NO pay data; a
// master/admin export includes rates, paychecks and payroll dollars.
// The caller passes `privileged` — the same flag that gates the UI and,
// more importantly, whether pay data was ever fetched at all.
import { csvEsc, downloadFile } from "./csv.js";
import { money, pct, numOrDash } from "./format.js";
import { computeStoreRow, computePayRow, POSITIONS } from "./payrollMath.js";

const posLabel = (p) => POSITIONS.find(([k]) => k === p)?.[1] ?? p;
const d2 = (n) => (n == null ? "—" : Number(n).toFixed(2));

const STORE_HEAD = [
  "Position", "Employee", "PTO Days", "Clock Hrs Other", "Clock Hrs Here", "Total Hours",
  "Turned Other", "Turned Here", "Total Turned", "Productivity",
  "Actual Sales", "Sales Required", "% of Goal", "Work Orders", "ARO", "FLAT",
];
const PAY_HEAD = [
  "Hourly Rate", "Flat Rate", "Hourly Earned", "OT Earned", "Total Hourly",
  "Total Flat", "Bonus", "Incentives", "Paycheck",
];

function storeCells(row) {
  const c = computeStoreRow(row.entry);
  const e = row.entry;
  return [
    posLabel(row.employee.position), row.employee.full_name || "",
    e.pto_days ?? 0, e.clock_hours_other ?? 0, e.clock_hours ?? 0, c.totalHours,
    e.hrs_turned_other ?? 0, e.hrs_turned_here ?? 0, c.totalTurned,
    c.productivity == null ? "—" : c.productivity.toFixed(2),
    e.actual_sales ?? 0, e.sales_required ?? "", pct(c.pctOfGoal), e.work_orders ?? 0,
    c.aro == null ? "—" : c.aro.toFixed(2), row.flatFlag ? "FLAT" : "",
  ];
}

function payCells(row) {
  const p = computePayRow(row.entry, row.rate, row.pay);
  if (p.manager) {
    return ["x", "x", "x", "x", "x", "x", d2(p.bonus), d2(p.incentives), money(p.paycheck)];
  }
  return [
    d2(p.hourlyRate), d2(p.flatRate), money(p.hourlyEarned), money(p.otEarned),
    money(p.totalHourly), money(p.totalFlat), d2(p.bonus), d2(p.incentives), money(p.paycheck),
  ];
}

export function exportPayrollCSV(store, week, rows, privileged, summary) {
  const head = ["Store #", "Store", "Week of", ...STORE_HEAD, ...(privileged ? PAY_HEAD : [])];
  const body = rows.map((r) => [
    store.store_number, store.name, week, ...storeCells(r), ...(privileged ? payCells(r) : []),
  ]);

  const lines = [head, ...body];
  lines.push([]);
  // Payroll summary — percentages for everyone, dollars only when privileged.
  if (summary) {
    if (privileged) lines.push(["", "", "Payroll $", money(summary.payrollDollars ?? 0)]);
    lines.push(["", "", "Actual Sales", money(summary.actualSales ?? summary.actual_sales ?? 0)]);
    lines.push(["", "", "Total Payroll %", pct(summary.totalPct ?? summary.total_payroll_pct), "(target ≤ 26%)"]);
    lines.push(["", "", "CST %", pct(summary.cstPct ?? summary.cst_payroll_pct), "(target ≤ 10%)"]);
    lines.push(["", "", "VST %", pct(summary.vstPct ?? summary.vst_payroll_pct), "(target ≤ 16%)"]);
  }

  const csv = lines.map((r) => r.map(csvEsc).join(",")).join("\n");
  downloadFile(`PGW_${store.store_number}_payroll_week_${week}.csv`, csv, "text/csv;charset=utf-8;");
}

export function printPayroll(store, week, rows, privileged, summary) {
  const th = [...STORE_HEAD, ...(privileged ? PAY_HEAD : [])]
    .map((h) => `<th>${h}</th>`).join("");
  const body = rows.map((r) => {
    const cells = [...storeCells(r), ...(privileged ? payCells(r) : [])];
    return `<tr>${cells.map((c) => `<td>${c === "" ? "" : c}</td>`).join("")}</tr>`;
  }).join("");

  const s = summary || {};
  const totalPct = s.totalPct ?? s.total_payroll_pct;
  const cstPct = s.cstPct ?? s.cst_payroll_pct;
  const vstPct = s.vstPct ?? s.vst_payroll_pct;
  const over = (r, t) => (r != null && r > t) ? ' class="over"' : "";
  const summaryHtml = summary ? `
    <table class="sum">
      ${privileged ? `<tr><td>Payroll $</td><td>${money(s.payrollDollars ?? 0)}</td></tr>` : ""}
      <tr><td>Actual Sales</td><td>${money(s.actualSales ?? s.actual_sales ?? 0)}</td></tr>
      <tr${over(totalPct, 0.26)}><td>Total Payroll %</td><td>${pct(totalPct)} <span>(≤ 26%)</span></td></tr>
      <tr${over(cstPct, 0.10)}><td>CST %</td><td>${pct(cstPct)} <span>(≤ 10%)</span></td></tr>
      <tr${over(vstPct, 0.16)}><td>VST %</td><td>${pct(vstPct)} <span>(≤ 16%)</span></td></tr>
    </table>` : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PGW Payroll ${store.store_number} ${week}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;font-size:11px}
      h1{font-size:17px;margin:0}
      .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:14px}
      .meta{text-align:right;font-size:11px;color:#444}
      table{width:100%;border-collapse:collapse;margin-bottom:14px}
      td,th{border:1px solid #bbb;padding:4px 5px;text-align:right;white-space:nowrap}
      th{background:#eee;font-size:10px;text-align:right}
      td:nth-child(1),td:nth-child(2),th:nth-child(1),th:nth-child(2){text-align:left}
      .sum{width:auto} .sum td{text-align:left} .sum td:nth-child(2){text-align:right;font-weight:bold}
      .sum span{color:#666;font-weight:normal}
      .over td{background:#fde2e1;color:#a11}
      @media print{body{margin:10mm}}
    </style></head><body>
      <div class="head">
        <div><h1>Weekly Payroll</h1><div>#${store.store_number} · ${store.name}</div></div>
        <div class="meta"><div><strong>Week of:</strong> ${week}</div><div>${privileged ? "Master / Admin copy" : "Store copy — no pay data"}</div></div>
      </div>
      <table><tr>${th}</tr>${body || `<tr><td colspan="${STORE_HEAD.length + (privileged ? PAY_HEAD.length : 0)}">No employees</td></tr>`}</table>
      ${summaryHtml}
    </body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
