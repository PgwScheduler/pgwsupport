import React, { useState } from "react";
import { Database, X } from "lucide-react";
import { supabase } from "../../lib/supabaseClient.js";
import { Card, GhostBtn, PrimaryBtn } from "../ui.jsx";

// =====================================================================
// The prior-year import path.
//
// BDC will send a spreadsheet, so this takes a PASTE — headers and all —
// rather than asking anyone to produce JSON or match a uuid. Stores are
// identified by STORE NUMBER, which is what a spreadsheet from the
// business actually contains.
//
// Parsing happens here and the upsert happens in
// prior_year_actuals_import(), which re-checks the role, resolves store
// numbers itself and REPORTS the ones it did not recognise instead of
// failing the whole file on one typo. A blank cell means "not supplied"
// and leaves the stored value alone, so a sales-only file can be
// followed by a cars-only file without erasing the first.
// =====================================================================

const HEADER_ALIASES = {
  store: "store_number", store_number: "store_number", store_no: "store_number", "store #": "store_number",
  number: "store_number", year: "year", month: "month",
  sales: "sales", "total sales": "sales",
  gp: "gross_profit", gross_profit: "gross_profit", "gross profit": "gross_profit",
  cars: "cars", ro: "cars", ros: "cars", "repair orders": "cars", "car count": "cars",
};

const clean = (s) => String(s ?? "").trim().replace(/^"|"$/g, "");
const money = (s) => {
  const v = clean(s).replace(/[$,]/g, "");
  return v === "" ? null : v;
};

// Split a pasted table. Tab-separated is what a spreadsheet paste gives;
// comma-separated is what a saved CSV gives. Both are accepted because
// the person doing this should not have to know which they have.
export function parsePriorYear(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { rows: [], errors: ["Nothing pasted."] };
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].split(delim).map((h) => HEADER_ALIASES[clean(h).toLowerCase()] ?? null);

  if (!header.includes("store_number")) {
    return { rows: [], errors: ["No store number column found. Expected a header row including 'Store'."] };
  }
  if (!header.includes("year") || !header.includes("month")) {
    return { rows: [], errors: ["A Year and a Month column are required — prior-year actuals are monthly."] };
  }

  const rows = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delim);
    const row = {};
    header.forEach((key, j) => { if (key) row[key] = clean(cells[j]); });
    if (!row.store_number) continue;
    const year = parseInt(row.year, 10);
    const month = parseInt(row.month, 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      errors.push(`Line ${i + 1}: year or month is not a number (${row.year}/${row.month}).`);
      continue;
    }
    rows.push({
      store_number: row.store_number,
      year, month,
      sales: money(row.sales),
      gross_profit: money(row.gross_profit),
      cars: clean(row.cars) === "" ? null : clean(row.cars).replace(/,/g, ""),
    });
  }
  return { rows, errors };
}

export function PriorYearImportModal({ onClose }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const { rows, errors } = parsePriorYear(text);
    if (!rows.length) {
      setError(errors[0] ?? "Nothing to import.");
      setBusy(false);
      return;
    }
    const { data, error: err } = await supabase.rpc("prior_year_actuals_import", { p_rows: rows });
    if (err) setError(err.message);
    else {
      const r = Array.isArray(data) ? data[0] : data;
      setResult({ ...r, parseErrors: errors, sent: rows.length });
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4" onClick={onClose}>
      <div className="mt-12 w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3">
            <div>
              <h3 className="pgw-display text-base font-bold text-content-primary">Import prior-year actuals</h3>
              <p className="text-xs text-content-muted">Sales, gross profit and car count — by store, by month.</p>
            </div>
            <button onClick={onClose} className="rounded-md p-1.5 text-content-secondary hover:bg-surface-overlay hover:text-content-primary">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="space-y-3 p-5">
            <p className="text-xs text-content-secondary">
              Paste straight from the spreadsheet, header row included. Columns recognised:{" "}
              <code className="text-content-primary">Store</code>, <code className="text-content-primary">Year</code>,{" "}
              <code className="text-content-primary">Month</code>, <code className="text-content-primary">Sales</code>,{" "}
              <code className="text-content-primary">Gross Profit</code>, <code className="text-content-primary">Cars</code>.
              Dollar signs and commas are fine. A blank cell leaves whatever is already stored untouched.
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              spellCheck={false}
              placeholder={"Store\tYear\tMonth\tSales\tGross Profit\tCars\n3303\t2025\t7\t$183,634\t$96,120\t402"}
              className="w-full rounded-md border border-hairline-strong bg-surface-input px-3 py-2 font-mono text-xs text-content-primary outline-none focus:border-accent"
            />

            {error && <p className="rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}

            {result && (
              <div className="space-y-2 rounded-md border border-success-border bg-success-tint px-3 py-2 text-sm text-success">
                <p>Imported {result.imported} of {result.sent} row{result.sent === 1 ? "" : "s"}.</p>
                {result.unknown_stores?.length > 0 && (
                  <p className="text-warning">
                    Skipped — no store with these numbers: {result.unknown_stores.join(", ")}
                  </p>
                )}
                {result.parseErrors?.length > 0 && (
                  <ul className="list-disc pl-4 text-warning">
                    {result.parseErrors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <GhostBtn onClick={onClose}>Close</GhostBtn>
              <PrimaryBtn onClick={run} disabled={busy || !text.trim()}>
                <Database className="h-4 w-4" /> {busy ? "Importing…" : "Import"}
              </PrimaryBtn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
