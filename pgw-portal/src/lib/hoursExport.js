import { DAYS, sumDays } from "./weekUtils.js";
import { csvEsc, downloadFile } from "./csv.js";

export function exportHoursCSV(store, week, rows) {
  const head = ["Store #", "Store", "Week of", "Employee", ...DAYS.map(([, l]) => l), "Total Hours", "Hours Turned", "Notes"];
  const body = rows.map((r) => [
    store.store_number, store.name, week, r.employee_name || "",
    ...DAYS.map(([k]) => r[k] ?? ""),
    sumDays(r), r.hours_turned ?? "", r.notes || "",
  ]);
  const totals = [
    "", "", "", "WEEK TOTAL",
    ...DAYS.map(([k]) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)),
    rows.reduce((a, r) => a + sumDays(r), 0),
    rows.reduce((a, r) => a + (Number(r.hours_turned) || 0), 0),
    "",
  ];
  const csv = [head, ...body, totals].map((r) => r.map(csvEsc).join(",")).join("\n");
  downloadFile(`PGW_${store.store_number}_hours_week_${week}.csv`, csv, "text/csv;charset=utf-8;");
}

export function printHours(store, week, rows) {
  const dayTotal = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const weekTotal = rows.reduce((a, r) => a + sumDays(r), 0);
  const turnedTotal = rows.reduce((a, r) => a + (Number(r.hours_turned) || 0), 0);
  const body = rows.map((r) => `<tr>
      <td>${r.employee_name || ""}</td>
      ${DAYS.map(([k]) => `<td class="c">${r[k] ?? ""}</td>`).join("")}
      <td class="c b">${sumDays(r)}</td>
      <td class="c">${r.hours_turned ?? ""}</td>
      <td>${r.notes || ""}</td>
      <td class="sig"></td>
    </tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PGW Hours ${store.store_number} ${week}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:28px;font-size:12px}
      h1{font-size:18px;margin:0}
      .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:14px}
      .meta{text-align:right;font-size:11px;color:#444}
      table{width:100%;border-collapse:collapse}
      td,th{border:1px solid #bbb;padding:5px 6px}
      th{background:#eee;text-align:left;font-size:11px}
      .c{text-align:center} .b{font-weight:bold}
      .tot td{font-weight:bold;background:#f4f4f4}
      .sig{width:150px}
      .note{font-size:11px;color:#444;margin-top:10px}
      .signline{margin-top:26px;display:flex;gap:40px}
      .signline div{flex:1;border-top:1px solid #111;padding-top:4px;font-size:11px}
      @media print{body{margin:12mm}}
    </style></head><body>
      <div class="head">
        <div><h1>Weekly Employee Hours</h1><div>#${store.store_number} · ${store.name}</div></div>
        <div class="meta"><div><strong>Week of:</strong> ${week}</div><div>Monday – Saturday</div></div>
      </div>
      <table>
        <tr><th>Employee</th>${DAYS.map(([, l]) => `<th class="c">${l}</th>`).join("")}<th class="c">Total</th><th class="c">Hrs Turned</th><th>Notes</th><th>Employee Signature</th></tr>
        ${body || `<tr><td colspan="11" class="c">No hours logged</td></tr>`}
        <tr class="tot"><td>WEEK TOTAL</td>${DAYS.map(([k]) => `<td class="c">${dayTotal(k)}</td>`).join("")}<td class="c">${weekTotal}</td><td class="c">${turnedTotal}</td><td></td><td></td></tr>
      </table>
      <div class="note">Hours submitted for payroll processing.</div>
      <div class="signline"><div>Store Manager signature / date</div><div>Reviewed by / date</div></div>
    </body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
