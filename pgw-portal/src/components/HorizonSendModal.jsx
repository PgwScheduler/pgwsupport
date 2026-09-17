import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Send, X, XCircle } from "lucide-react";
import { Card, GhostBtn, PrimaryBtn } from "./ui.jsx";
import { money } from "../lib/format.js";

// Review-then-send for one store-month. The numbers shown are the exact
// fields that will be posted (read back from the Edge Function's own
// build), and Send carries their fingerprint, so what Horizon receives is
// what was on this screen. A store manager never sees technician pay.

const monthName = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};
const dayName = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const when = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const hrs = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const TOTALS = [
  ["kpi_ro", "ROs", "count"],
  ["kpi_sales_labor", "Labor sales", "money"],
  ["kpi_sales_parts", "Parts sales", "money"],
  ["kpi_sales_tires", "Tire sales", "money"],
  ["kpi_sales_discounts", "Discounts", "money"],
  ["kpi_cost_labor", "Labor cost", "money"],
  ["kpi_cost_parts", "Parts cost", "money"],
  ["kpi_cost_tires", "Tire cost", "money"],
];

function Banner({ tone, icon: Icon, children }) {
  const cls = {
    success: "border-success-border bg-success-tint text-success",
    warning: "border-warning-border bg-warning-tint text-warning",
    danger: "border-danger-border bg-danger-tint text-danger",
  }[tone];
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${cls}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function LastUploadLine({ last }) {
  if (!last) return <p className="text-xs text-content-muted">Not sent from the portal yet.</p>;
  return (
    <p className="text-xs text-content-muted">
      Last sent {when(last.sent_at)} by {last.sent_by} for {monthName(last.month.slice(0, 7))} —{" "}
      <span className={last.accepted ? "text-success" : "text-danger"}>
        {last.accepted ? "accepted" : "not accepted"}
      </span>
      {last.horizon_reply ? `: ${last.horizon_reply.trim()}` : ""}
    </p>
  );
}

// Migration 48: Adjustments changed on a month Horizon already accepted.
// Warning yellow, never the brand orange.
export function ResendBanner({ resend }) {
  if (!resend?.needs_resend) return null;
  const who = resend.changed_by ?? "an administrator";
  const first = when(resend.since);
  const latest = resend.last_changed_at ? when(resend.last_changed_at) : first;
  return (
    <Banner tone="warning" icon={AlertTriangle}>
      <p className="font-medium">Adjustments were changed after this month was sent. Re-send required.</p>
      <p className="text-xs">
        Changed by {who} · {first === latest ? first : `first ${first}, latest ${latest}`}
      </p>
    </Banner>
  );
}

export function HorizonSendModal({ store, monthYm, upload, onClose }) {
  const [phase, setPhase] = useState("loading"); // loading | review | refused | sending | done
  const [review, setReview] = useState(null);
  const [result, setResult] = useState(null);

  const loadPreview = async () => {
    setPhase("loading");
    setResult(null);
    const r = await upload.preview();
    setReview(r);
    setPhase(r.ok ? "review" : "refused");
  };

  // Every preview is an audited attempt, so build it once per open even
  // when React's development mode runs effects twice.
  const loadedFor = useRef(null);
  useEffect(() => {
    const key = `${store.id}|${monthYm}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.id, monthYm]);

  const doSend = async () => {
    setPhase("sending");
    const r = await upload.send(review.fields_sha256);
    setResult(r);
    setPhase("done");
  };

  const busy = phase === "loading" || phase === "sending";
  const slots = (review?.slots ?? []).filter(
    (s) => s.name || s.hours_worked || s.hours_sold || s.labor_sales || s.compensation
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Send to Horizon">
      <Card className="flex max-h-[90vh] w-full max-w-2xl flex-col p-0">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-5 py-4">
          <div>
            <h3 className="pgw-display text-base font-bold text-content-primary">Send {monthName(monthYm)} to Horizon</h3>
            <p className="text-sm text-content-secondary">
              {store.store_number ? `#${store.store_number} · ` : ""}{store.name}
              {review?.shop_number ? ` · Horizon shop ${review.shop_number}` : ""}
            </p>
            <div className="mt-1"><LastUploadLine last={upload.lastUpload} /></div>
          </div>
          <button onClick={onClose} disabled={phase === "sending"} className="rounded p-1 text-content-muted hover:text-content-primary" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {phase === "loading" && <p className="text-sm text-content-muted">Building your numbers…</p>}

          {phase === "refused" && (
            <Banner tone="danger" icon={XCircle}>{review?.error ?? "This store cannot send to Horizon right now."}</Banner>
          )}

          {review?.ok && phase !== "loading" && (
            <>
              <p className="text-sm text-content-secondary">
                {review.days_sent > 0
                  ? <>This sends <strong className="text-content-primary">{dayName(`${monthYm}-01`)} – {dayName(review.last_day_sent)}</strong> ({review.days_sent} {review.days_sent === 1 ? "day" : "days"}). Horizon replaces those days with the numbers below, so a day you have corrected is simply sent again.</>
                  : <>There are no days to send for this month yet.</>}
              </p>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {TOTALS.map(([k, label, kind]) => (
                  <div key={k} className="rounded-md border border-hairline bg-surface-page px-3 py-2">
                    <span className="block text-[11px] font-medium uppercase tracking-wide text-content-muted">{label}</span>
                    <span className="text-sm font-semibold tabular-nums text-content-primary">
                      {kind === "money" ? money(review.totals?.[k]) : (review.totals?.[k] ?? 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>

              <div>
                <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-content-secondary">Technicians by Horizon slot</h4>
                {slots.length === 0 ? (
                  <p className="text-sm text-content-muted">No technician numbers this month.</p>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-hairline">
                    <table className="w-full text-sm">
                      <thead className="bg-surface-overlay text-[11px] uppercase tracking-wide text-content-muted">
                        <tr>
                          <th className="px-2 py-1.5 text-left">Slot</th>
                          <th className="px-2 py-1.5 text-left">Name</th>
                          <th className="px-2 py-1.5 text-right">Hours worked</th>
                          <th className="px-2 py-1.5 text-right">Hours sold</th>
                          <th className="px-2 py-1.5 text-right">Labor sales</th>
                          {!review.pay_hidden && <th className="px-2 py-1.5 text-right">Pay</th>}
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {slots.map((s) => (
                          <tr key={s.slot} className="border-t border-hairline">
                            <td className="px-2 py-1.5 text-content-muted">{s.slot}</td>
                            <td className="px-2 py-1.5 text-content-primary">{s.name || <span className="text-content-muted">—</span>}</td>
                            <td className="px-2 py-1.5 text-right">{hrs(s.hours_worked)}</td>
                            <td className="px-2 py-1.5 text-right">{hrs(s.hours_sold)}</td>
                            <td className="px-2 py-1.5 text-right">{money(s.labor_sales)}</td>
                            {!review.pay_hidden && <td className="px-2 py-1.5 text-right">{money(s.compensation)}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {review.pay_hidden && (
                  <p className="mt-1 text-[11px] text-content-muted">Each technician's pay is sent to Horizon but not shown here.</p>
                )}
              </div>

              {review.warnings?.length > 0 && (
                <Banner tone="warning" icon={AlertTriangle}>
                  <p className="font-medium">Check before sending</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-content-secondary">
                    {review.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                </Banner>
              )}

              {!review.send_enabled && phase === "review" && (
                <Banner tone="warning" icon={AlertTriangle}>{review.send_disabled_reason}</Banner>
              )}
            </>
          )}

          {phase === "sending" && <p className="text-sm text-content-muted">Sending to Horizon…</p>}

          {phase === "done" && result && (
            result.ok && result.horizon_accepted ? (
              <Banner tone="success" icon={CheckCircle2}>
                <p className="font-medium">Horizon accepted the upload.</p>
                {result.horizon_reply && <p className="mt-0.5 text-content-secondary">{result.horizon_reply.trim()}</p>}
              </Banner>
            ) : (
              <Banner tone="danger" icon={XCircle}>
                <p className="font-medium">{result.sent_to_horizon ? "Horizon did not accept the upload." : "Nothing was sent."}</p>
                <p className="mt-0.5 text-content-secondary">{(result.horizon_reply || result.error || "").trim()}</p>
              </Banner>
            )
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          {phase === "done" ? (
            <>
              {!(result?.ok && result?.horizon_accepted) && <GhostBtn onClick={loadPreview}>Review again</GhostBtn>}
              <PrimaryBtn onClick={onClose}>Close</PrimaryBtn>
            </>
          ) : (
            <>
              <GhostBtn onClick={onClose} disabled={phase === "sending"}>Cancel</GhostBtn>
              <PrimaryBtn
                onClick={doSend}
                disabled={busy || phase !== "review" || !review?.send_enabled || !(review?.days_sent > 0)}
              >
                <Send className="h-4 w-4" />
                {phase === "sending" ? "Sending…" : "Send to Horizon"}
              </PrimaryBtn>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
