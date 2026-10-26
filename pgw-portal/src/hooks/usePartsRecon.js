import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { chunk } from "../lib/partsRecon.js";

// Parts Recon (migration 90). Every read and write is a definer function
// that applies the rules (AP team / store / DM-RM / office); the tables
// have no direct path.

const rpc = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args);
  return error ? { data: null, error: error.message } : { data, error: null };
};

// The API returns at most 1,000 rows a request (Supabase max-rows), and a
// month has more items and AP to-do lines than that. Lists are read in
// pages ordered by columns that make the order total, so a page boundary
// can't skip or repeat a row; the screens sort for display themselves.
const PAGE = 1000;
async function rpcAll(fn, args, order) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.rpc(fn, args);
    for (const col of order) q = q.order(col);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) return { data: null, error: error.message };
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return { data: out, error: null };
  }
}

function useRpc(fn, args, enabled = true, order = null) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const key = JSON.stringify(args ?? {});
  const orderKey = order ? order.join(",") : "";
  const load = useCallback(async () => {
    if (!enabled) { setData(null); setLoading(false); return; }
    setLoading(true);
    const r = orderKey ? await rpcAll(fn, JSON.parse(key), orderKey.split(",")) : await rpc(fn, JSON.parse(key));
    setError(r.error);
    setData(r.data);
    setLoading(false);
  }, [fn, key, enabled, orderKey]);
  useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}

const byTask = (a, b) => a.recon_store.localeCompare(b.recon_store) || String(a.vendor ?? "").localeCompare(String(b.vendor ?? ""))
  || a.kind.localeCompare(b.kind) || String(a.txn_date ?? "9").localeCompare(String(b.txn_date ?? "9"))
  || String(a.invoice ?? "").localeCompare(String(b.invoice ?? ""));

export const usePartsReconAccess = () => useRpc("parts_recon_access", {});
export const usePartsReconMonths = () => useRpc("parts_recon_months", {});
export const usePartsReconItems = (month, location) =>
  useRpc("parts_recon_items", { p_month: month, p_location: location ?? null }, !!month, ["id"]);
export const usePartsReconNotes = (month, location) =>
  useRpc("parts_recon_store_notes", { p_month: month, p_location: location ?? null }, !!month,
    ["recon_store", "vendor", "ro", "part", "description", "cost", "ordered_on"]);
export const usePartsReconTracker = (month, enabled = true) =>
  useRpc("parts_recon_tracker", { p_month: month }, !!month && enabled, ["sort", "key"]);
export function usePartsReconTasks(month, enabled) {
  const r = useRpc("parts_recon_tasks", { p_month: month }, !!month && enabled, ["id"]);
  const sorted = useMemo(() => (r.data ? [...r.data].sort(byTask) : r.data), [r.data]);
  return { ...r, data: sorted };
}
export const usePartsReconOtherCredits = (month, enabled) => useRpc("parts_recon_other_credits", { p_month: month }, !!month && enabled);
export const usePartsReconTeam = (enabled) => useRpc("parts_recon_team", {}, enabled);

const BUCKET = "parts-recon";
const safeName = (n) => String(n ?? "file").replace(/[^\w.\- ]+/g, "_").slice(-120);

export const partsReconApi = {
  respond: (id, r) => rpc("parts_recon_respond", {
    p_item: id, p_action: r.action, p_credit_no: r.creditNo || null,
    p_credit_amt: r.creditAmt === "" || r.creditAmt === null || r.creditAmt === undefined ? null : Number(r.creditAmt),
    p_note: r.note || null,
  }),
  review: (id, r) => rpc("parts_recon_review", {
    p_item: id, p_status: r.status, p_credit_no: r.creditNo || null,
    p_credit_amt: r.creditAmt === "" || r.creditAmt === null || r.creditAmt === undefined ? null : Number(r.creditAmt),
    p_credit_date: r.creditDate || null, p_note: r.note || null,
  }),
  setMonth: (month, released, closed) => rpc("parts_recon_set_month", { p_month: month, p_released: released, p_closed: closed }),
  taskDone: (id, done, note) => rpc("parts_recon_task_done", { p_id: id, p_done: done, p_note: note || null }),
  teamSet: (email, on) => rpc("parts_recon_team_set", { p_email: email, p_on: on }),
  saveOtherCredit: (month, c) => rpc("parts_recon_other_credit_save", {
    p_month: month, p_store: c.store, p_vendor: c.vendor || null, p_credit_no: c.creditNo || null,
    p_credit_date: c.creditDate || null, p_orig_invoice: c.origInvoice || null, p_ro: c.ro || null, p_parts: c.parts || null,
    p_amount: c.amount === "" || c.amount === undefined ? null : Number(c.amount), p_for_month: c.forMonth || null, p_notes: c.notes || null,
  }),
  deleteOtherCredit: (id) => rpc("parts_recon_other_credit_delete", { p_id: id }),

  // Credit memo / receipt: upload to <YYYY-MM>/<item>/..., then record it.
  async attach(item, month, file) {
    const path = `${String(month).slice(0, 7)}/${item.id}/${crypto.randomUUID()}-${safeName(file.name)}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, file);
    if (error) return { error: error.message };
    return rpc("parts_recon_file_added", { p_item: item.id, p_path: path, p_name: file.name, p_size: file.size });
  },
  async openFile(path) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 120);
    if (error) return { error: error.message };
    window.open(data.signedUrl, "_blank", "noopener");
    return { error: null };
  },

  // The whole import: begin -> chunks -> responses -> finish. Re-running a
  // month keeps every reply and review (see migration 90's header).
  async runImport(built, files, onProgress) {
    const begin = await rpc("parts_recon_import_begin", { p_month: built.month, p_label: built.label, p_files: files });
    if (begin.error) return begin;
    const batch = begin.data;
    const parts = [
      ["items", built.items, 150], ["tasks", built.tasks, 500], ["notes", built.notes, 1000],
      ["tracker", built.tracker, 500], ["credits", built.credits, 500],
    ];
    const total = parts.reduce((a, [, rows, n]) => a + chunk(rows, n).length, 0) + 2;
    let done = 0;
    for (const [kind, rows, size] of parts) {
      for (const c of chunk(rows, size)) {
        const r = await rpc("parts_recon_import_rows", { p_month: built.month, p_batch: batch, p_kind: kind, p_rows: c });
        if (r.error) return { error: `${kind}: ${r.error}` };
        onProgress?.(++done / total);
      }
    }
    const fin = await rpc("parts_recon_import_finish", { p_month: built.month, p_batch: batch, p_check: built.check });
    if (fin.error) return fin;
    onProgress?.(++done / total);
    let applied = 0;
    if (built.responses.length) {
      const a = await rpc("parts_recon_apply_responses", { p_month: built.month, p_rows: built.responses });
      if (a.error) return { error: `responses: ${a.error}` };
      applied = a.data;
    }
    onProgress?.(1);
    return { data: { ...fin.data, responses_applied: applied }, error: null };
  },
};

// ---------------------------------------------------------------------
// Mass Credit Import (migration 91): one vendor credit across many items.
// ---------------------------------------------------------------------
export const usePartsReconCreditStores = (enabled = true) => useRpc("parts_recon_credit_stores", {}, enabled);
export const usePartsReconCreditVendors = (location) =>
  useRpc("parts_recon_credit_vendors", { p_location: location }, !!location);
export const usePartsReconItemBatches = (month, location) =>
  useRpc("parts_recon_item_batches", { p_month: month, p_location: location ?? null }, !!month);
export const usePartsReconCreditBatchList = (location, enabled = true) =>
  useRpc("parts_recon_credit_batch_list", { p_location: location ?? null }, enabled);

export const creditApi = {
  candidates: (location, vendor, query) =>
    rpc("parts_recon_credit_candidates", { p_location: location, p_vendor: vendor, p_query: query }),
  creditNoUsed: (location, creditNo) =>
    rpc("parts_recon_credit_no_used", { p_location: location, p_credit_no: creditNo }),
  batch: (id) => rpc("parts_recon_credit_batch", { p_batch: id }),

  // The memo goes up first, under the batch's own folder; the submit
  // checks it is there. A failed submit can be retried with the same id
  // and memo (nothing was written).
  async uploadMemo(batchId, file) {
    const path = `batches/${batchId}/${crypto.randomUUID()}-${safeName(file.name)}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, file);
    return error ? { error: error.message } : { data: path, error: null };
  },
  submit: (batchId, h, lines, memo) => rpc("parts_recon_credit_batch_submit", {
    p_batch: batchId, p_location: h.locationId, p_vendor: h.vendor, p_credit_no: h.creditNo.trim(),
    p_credit_date: h.creditDate || null, p_total: Number(String(h.total).replace(/[$,\s]/g, "")),
    p_action: h.action, p_note: h.note || null,
    p_file_path: memo?.path ?? null, p_file_name: memo?.name ?? null, p_file_size: memo?.size ?? null,
    p_lines: lines,
  }),
};

// ---------------------------------------------------------------------
// Other bills (migration 92): AP-entered items not on a vendor statement.
// ---------------------------------------------------------------------
export const usePartsReconOtherBills = () => useRpc("parts_recon_other_bills", {});
export const usePartsReconOtherBillStores = () => useRpc("parts_recon_other_bill_stores", {});

const money = (v) => Number(String(v ?? "").replace(/[$,\s]/g, ""));
export const otherBillApi = {
  create: (b) => rpc("parts_recon_other_bill_create", {
    p_location: b.locationId, p_vendor: b.vendor, p_start: b.month, p_end: b.repeat ? b.endMonth : b.month,
    p_amount: money(b.amount), p_bill_no: b.billNo, p_ro: b.ro || null, p_description: b.description || null,
  }),
  update: (id, b) => rpc("parts_recon_other_bill_update", {
    p_id: id, p_vendor: b.vendor, p_amount: money(b.amount), p_bill_no: b.billNo, p_ro: b.ro || null, p_description: b.description || null,
  }),
  remove: (id) => rpc("parts_recon_other_bill_delete", { p_id: id }),
};
