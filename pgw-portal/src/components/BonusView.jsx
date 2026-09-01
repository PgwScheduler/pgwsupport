import React, { useState } from "react";
import { ChevronLeft, ChevronRight, Trophy, AlertTriangle, Info, Lock, TrendingUp } from "lucide-react";
import { useBonusTracker } from "../hooks/useBonusTracker.js";
import { SectionHeader, Card, PrimaryBtn, GhostBtn, Empty, inputCls } from "./ui.jsx";
import { money, pct, numOrDash } from "../lib/format.js";

const pad2 = (n) => String(n).padStart(2, "0");
const monthLabel = (y, m) => new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

const MODEL_BLURB = {
  A: "Model A — team pool, split three ways",
  B: "Model B — store manager and assistant, measured against last year",
  C: "Model C — business operator",
  D: "Model D — store manager, flat rate",
};

// A line that did not pay says WHY. "short" = the measure did not reach a
// rung; "locked" = a gross-profit gate is not met; "unfilled" = nobody has
// entered the number yet, which is never the same thing as zero.
const STATUS_STYLE = {
  short: "text-content-muted",
  locked: "text-content-muted",
  unfilled: "text-warning",
  capped: "text-content-secondary",
};
const STATUS_LABEL = { short: "not reached", locked: "locked", unfilled: "not entered", capped: "capped" };

function Tile({ label, value, sub, tone }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface-page p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-content-muted">{label}</p>
      <p className={"pgw-display mt-1 text-lg font-bold " + (tone ?? "text-content-primary")}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-content-muted">{sub}</p>}
    </div>
  );
}

function TierBadge({ name }) {
  const cls = {
    gold: "border-warning-border bg-warning-tint text-warning",
    silver: "border-hairline-strong bg-surface-overlay text-content-secondary",
    bronze: "border-hairline-strong bg-surface-overlay text-content-secondary",
    none: "border-hairline bg-surface-page text-content-muted",
  }[name] ?? "border-hairline bg-surface-page text-content-muted";
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>
      {name === "none" ? "No tier reached" : name}
    </span>
  );
}

function FlagList({ flags }) {
  const [open, setOpen] = useState(false);
  if (!flags.length) return null;
  const warn = flags.filter((f) => f.severity === "warn").length;
  return (
    <Card className="mb-4 p-0">
      <button onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-surface-overlay">
        <AlertTriangle className="h-4 w-4 text-warning" />
        <span className="text-sm font-semibold text-content-primary">
          {flags.length} open question{flags.length === 1 ? "" : "s"} on this plan
        </span>
        <span className="text-xs text-content-muted">
          {warn} awaiting a decision from BDC · built to the handout
        </span>
        <ChevronRight className={"ml-auto h-4 w-4 text-content-muted transition-transform " + (open ? "rotate-90" : "")} />
      </button>
      {open && (
        <div className="border-t border-hairline px-5 py-3">
          <ul className="space-y-3">
            {flags.map((f) => (
              <li key={f.code} className="flex gap-2">
                {f.severity === "warn"
                  ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-content-muted" />}
                <div>
                  <p className="text-xs font-semibold text-content-primary">{f.summary}</p>
                  <p className="mt-0.5 text-xs text-content-muted">{f.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// The three figures no system produces. Blank means blank — the screen
// never shows an un-entered number as a zero result.
//
// The review count is the store's own to report, so anyone with access to
// the store may enter it. Phone conversion and the Model D referral GP
// credit stay admin-only: the referral credit adds straight into the
// gross profit the bonus is calculated on, so a store that could type its
// own number could inflate its own payout. Enforced in the database by
// migration 27, not just here.
function InputsPanel({ model, inputs, canEdit, onSave, onClose }) {
  const [vals, setVals] = useState({
    google_reviews: inputs?.google_reviews ?? "",
    phone_conversion_pct: inputs?.phone_conversion_pct == null ? "" : String(inputs.phone_conversion_pct * 100),
    referral_gp_credit: inputs?.referral_gp_credit ?? "",
  });
  const [busy, setBusy] = useState(false);
  const blank = (v) => v === "" || v == null;

  const save = async () => {
    setBusy(true);
    const patch = {
      google_reviews: blank(vals.google_reviews) ? null : Math.max(0, Math.trunc(Number(vals.google_reviews))),
    };
    // Send the admin-only columns only when an admin is editing them, so a
    // store's save never trips the column guard on an untouched value.
    if (canEdit) {
      patch.phone_conversion_pct = blank(vals.phone_conversion_pct) ? null : Math.max(0, Number(vals.phone_conversion_pct)) / 100;
      patch.referral_gp_credit = blank(vals.referral_gp_credit) ? 0 : Number(vals.referral_gp_credit);
    }
    await onSave(patch);
    setBusy(false);
    onClose();
  };

  const set = (k) => (e) => setVals((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Card className="mb-4 p-5">
      <h3 className="pgw-display mb-1 text-sm font-bold text-content-primary">Monthly inputs</h3>
      <p className="mb-4 text-xs text-content-muted">
        Nothing tracks these yet. Leave a field empty and it stays unfilled rather than counting as zero.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-content-secondary">
            Five-star Google reviews
          </span>
          <input type="number" min="0" step="1" className={inputCls} placeholder="not entered"
            value={vals.google_reviews} onChange={set("google_reviews")} />
          <span className="mt-1 block text-[11px] text-content-muted">
            Counted by the store — enter the month's total.
          </span>
        </label>
        {model === "A" && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-content-secondary">
              Phone conversion (%)
            </span>
            <input type="number" min="0" step="0.1" className={inputCls}
              placeholder={canEdit ? "not entered" : "admin only"}
              value={vals.phone_conversion_pct} onChange={set("phone_conversion_pct")} disabled={!canEdit} />
            {/* Stated at the point of entry, because the figure looks like
                a performance measure and is not one. It only ever REMOVES
                the credit-app penalty; it is never itself a deduction. */}
            <span className="mt-1 block text-[11px] text-content-muted">
              40% or above waives the credit app penalty. It never creates one.
              {!canEdit && " Set by an admin."}
            </span>
          </label>
        )}
        {model === "D" && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-content-secondary">
              Midas referral GP credit ($)
            </span>
            <input type="number" step="0.01" className={inputCls}
              placeholder={canEdit ? "0.00" : "admin only"}
              value={vals.referral_gp_credit} onChange={set("referral_gp_credit")} disabled={!canEdit} />
            <span className="mt-1 block text-[11px] text-content-muted">
              {canEdit
                ? "Bonus math only — never reaches the tic sheet or the Horizon upload."
                : "Set by an admin — it adds into the gross profit this bonus is calculated on."}
            </span>
          </label>
        )}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        {!canEdit && (
          <p className="mr-auto text-xs text-content-muted">
            You can log the review count; the other figures are set by an admin.
          </p>
        )}
        <GhostBtn onClick={onClose} disabled={busy}>Close</GhostBtn>
        <PrimaryBtn onClick={save} disabled={busy}>Save</PrimaryBtn>
      </div>
    </Card>
  );
}

export function BonusView({ store }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [showInputs, setShowInputs] = useState(false);

  const { loading, error, plan, target, inputs, flags, result, actual, canEdit, saveInputs } =
    useBonusTracker(store, year, month);

  const curYm = now.getFullYear() * 12 + now.getMonth();
  const shiftMonth = (d) => {
    let m = month + d, y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    if (y * 12 + (m - 1) > curYm) return;
    setYear(y); setMonth(m);
  };

  return (
    <div>
      <SectionHeader
        title="Bonus Tracker"
        subtitle={`#${store.store_number} · ${store.name}${plan ? " · " + MODEL_BLURB[plan] : ""}`}
        action={
          <div className="flex items-center gap-2">
            <GhostBtn onClick={() => shiftMonth(-1)} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></GhostBtn>
            <input type="month" value={`${year}-${pad2(month)}`} max={`${now.getFullYear()}-${pad2(now.getMonth() + 1)}`}
              onChange={(e) => { const [y, m] = e.target.value.split("-").map(Number);
                if (y && m && y * 12 + (m - 1) <= curYm) { setYear(y); setMonth(m); } }}
              className="rounded-md border border-hairline-strong bg-surface-overlay px-2 py-1.5 text-sm text-content-primary outline-none" />
            <GhostBtn onClick={() => shiftMonth(1)} disabled={year * 12 + (month - 1) >= curYm} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </GhostBtn>
          </div>
        }
      />

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {/* Estimate disclaimer — on every screen, every month. */}
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-tint px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p className="text-xs text-content-secondary">
          <span className="font-semibold text-content-primary">This is a tracking estimate, not a payroll figure.</span>{" "}
          Everything below projects month-end from the days entered so far and moves as the month goes on.
          Payroll is calculated separately and governs what is actually paid.
        </p>
      </div>

      <FlagList flags={flags} />

      {loading && !result ? (
        <Card className="p-8"><p className="text-sm text-content-muted">Loading {monthLabel(year, month)}…</p></Card>
      ) : !plan ? (
        <Empty icon={Trophy} title="No bonus plan on file for this store"
          hint={`Nothing is set up for ${year}. Plans are seeded per store per plan year.`} />
      ) : !target ? (
        <Empty icon={Trophy} title={`No targets for ${monthLabel(year, month)}`}
          hint="This store has a plan but no monthly targets for the month selected." />
      ) : (
        <>
          {/* attainment */}
          <Card className="mb-4 p-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <TrendingUp className="h-4 w-4 text-content-muted" />
              <h3 className="pgw-display text-sm font-bold text-content-primary">
                {monthLabel(year, month)} attainment
              </h3>
              <TierBadge name={result.tier.name} />
              <span className="ml-auto text-xs text-content-muted">
                {result.daysElapsed} of {result.daysOpen} days entered
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile label="Projected month-end GP" value={result.ready ? money(result.projectedGp) : "—"}
                sub={result.ready ? "What the bonus is measured on" : "No days entered yet"} />
              <Tile label="Gross profit, month to date" value={money(result.mtdGp)}
                sub={result.daysElapsed >= result.daysOpen ? "Month complete — the two agree" : "Actual so far"} />
              <Tile label="GP budget" value={money(target.gp_budget)}
                sub={plan === "B" ? `Last year ${target.last_year_gp == null ? "—" : money(target.last_year_gp)}` : "Month target"} />
              <Tile
                label={result.tier.next ? `Gap to ${result.tier.next.name}` : "Top tier reached"}
                value={result.tier.next ? money(result.tier.next.gap) : "—"}
                tone={result.tier.next ? "text-warning" : "text-success"}
                sub={result.tier.next ? money(result.tier.next.threshold) + " needed" : "Nothing above this rung"} />
            </div>
            {plan === "D" && result.referralCredit > 0 && (
              <p className="mt-3 text-xs text-content-muted">
                Includes {money(result.referralCredit)} of Midas referral GP credit, applied to bonus math only.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-content-muted">
              <span>Tires {numOrDash(result.tirePerDay, 2)}/day</span>
              <span>Cars {numOrDash(result.carsPerDay, 2)}/day
                {target.daily_car_goal != null && ` · goal ${Number(target.daily_car_goal).toFixed(1)}`}</span>
              <span>Credit apps {result.creditApps}</span>
              <button onClick={() => setShowInputs((v) => !v)} className="ml-auto underline decoration-dotted hover:text-content-primary">
                {showInputs ? "Hide" : "Edit"} monthly inputs
                {result.unfilled.length > 0 && <span className="ml-1 text-warning">({result.unfilled.length} unfilled)</span>}
              </button>
            </div>
          </Card>

          {showInputs && (
            <InputsPanel model={plan} inputs={inputs} canEdit={canEdit}
              onSave={saveInputs} onClose={() => setShowInputs(false)} />
          )}

          {/* the pool, line by line */}
          <Card className="mb-4 p-0">
            <div className="border-b border-hairline px-5 py-3">
              <h3 className="pgw-display text-sm font-bold text-content-primary">
                {plan === "A" ? "Bonus pool" : "Bonus"}
              </h3>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {result.lines.map((l) => (
                  <tr key={l.key} className="border-b border-hairline">
                    <td className="px-5 py-2.5">
                      <span className="text-content-primary">{l.label}</span>
                      {l.note && <span className="ml-2 text-xs text-content-muted">{l.note}</span>}
                    </td>
                    <td className="w-40 px-5 py-2.5 text-right">
                      {l.status && l.amount === 0 ? (
                        <span className={"text-xs " + (STATUS_STYLE[l.status] ?? "text-content-muted")}>
                          {STATUS_LABEL[l.status] ?? l.status}
                        </span>
                      ) : (
                        <span className="font-semibold text-content-primary">{money(l.amount)}</span>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="bg-surface-overlay">
                  <td className="px-5 py-3 font-semibold text-content-primary">
                    {plan === "A" ? "Total pool" : "Total"}
                  </td>
                  <td className="px-5 py-3 text-right pgw-display text-base font-bold text-content-primary">
                    {money(result.pool)}
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>

          {/* penalty — calculated, shown, never deducted */}
          {result.penalty && result.penalty.amount > 0 && (
            <Card className="mb-4 border-warning-border p-5">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-content-primary">
                    Credit app penalty {money(result.penalty.amount)}
                    <span className="ml-2 text-xs font-normal uppercase tracking-wide text-warning">
                      {result.penalty.waived ? "waived" : result.penalty.provisional ? "provisional" : "not applied"}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-content-muted">{result.penalty.note}</p>
                  {result.penalty.waived ? (
                    <p className="mt-1 text-xs text-success">Waived — {result.penalty.waiverReasons.join(", ")}.</p>
                  ) : result.penalty.provisional ? (
                    // Two of the three waivers are computable and neither was
                    // met; the third has no data source. We cannot say whether
                    // this is owed, so we do not say it is. Marking it
                    // provisional keeps the exposure visible without asserting
                    // a penalty the store may already have waived.
                    <p className="mt-1 text-xs text-content-muted">
                      <span className="font-semibold text-warning">Provisional — not confirmed.</span>{" "}
                      Checked and not met: {result.penalty.waiversChecked.join(" and ")}. The third waiver,{" "}
                      <span className="font-semibold text-content-primary">{result.penalty.pendingWaiver}</span>, has
                      no data source yet, so whether this penalty is owed cannot be determined. It is not deducted
                      from the figures above and must not be treated as final. Phone conversion is a way{" "}
                      <span className="font-semibold text-content-primary">out</span> of this penalty, never a cause
                      of it — 40% or above removes it entirely.
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-content-muted">
                      Not deducted from the figures above — shown so the exposure is visible, never applied.
                      It is waived by <span className="font-semibold text-content-primary">any one</span> of three
                      things: Gold gross profit, hitting the daily car goal, or 40% phone conversion.
                      Phone conversion is one of the ways OUT of this penalty, not a cause of it — a high
                      conversion rate removes the penalty and can never create one.
                      If it were applied the total would be{" "}
                      <span className="font-semibold text-content-primary">{money(result.poolIfPenaltyApplied)}</span>.
                    </p>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* who gets paid */}
          <Card className="p-0">
            <div className="border-b border-hairline px-5 py-3">
              <h3 className="pgw-display text-sm font-bold text-content-primary">Estimated payout</h3>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {result.payouts.map((p) => (
                  <tr key={p.role} className="border-b border-hairline last:border-0">
                    <td className="px-5 py-3 text-content-primary">
                      {p.role}
                      {p.share != null && <span className="ml-2 text-xs text-content-muted">{pct(p.share, 0)}</span>}
                    </td>
                    <td className="w-40 px-5 py-3 text-right pgw-display font-bold text-content-primary">
                      {money(p.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {plan === "C" && (
              <p className="border-t border-hairline px-5 py-2.5 text-xs text-content-muted">
                Distribution of the Google incentive is at the store manager's discretion — tracked as a total, not split.
              </p>
            )}
            {plan === "B" && (
              <p className="border-t border-hairline px-5 py-2.5 text-xs text-content-muted">
                <Lock className="mr-1 inline h-3 w-3" />
                The 6% GP improvement bonus is assumed to go to the store manager — the handout does not name a recipient.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
