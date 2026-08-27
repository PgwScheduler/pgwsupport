import React from "react";
import { AlertTriangle, Wrench, Info } from "lucide-react";
import { money, pct } from "../../lib/format.js";
import { Card } from "../ui.jsx";

const dayLabel = (iso) => {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

// Payroll to sales, week to date.
//
//   payroll_to_sales = wages_to_date / gross_sales_to_date
//
// A running figure so a manager can control staffing before the week is
// gone. Aggregate, never individual — but see the note at the bottom of
// this file about what that does and does not hide.
//
// Everything shown here comes from payroll_to_sales_wtd (migration 32),
// which computes both sides over the SAME date window and returns the
// bounds so the card can say which days it covered. It is deliberately
// explicit about that: a part-week wage figure against a full-week sales
// figure produces a number that looks like a crisis and isn't.
export function PayrollToSalesCard({ data, onNavigate, isDaily = true, cutover }) {
  if (!data) return null;

  const {
    window_start, window_end, hours_thru, sales_thru,
    wages_non_tech, wages_tech, wages_total, gross_sales, payroll_to_sales,
    techs_included, week_complete, missing_store_manager, unattributed_days,
  } = data;

  const ratio = payroll_to_sales == null ? null : Number(payroll_to_sales);
  const nothingYet = !window_end;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="pgw-display text-sm font-bold text-content-primary">
          Payroll to sales — week to date
        </h3>
        {!nothingYet && (
          <p className="text-xs text-content-muted">
            {dayLabel(window_start)} – {dayLabel(window_end)}
            {week_complete ? " · full week" : " · so far"}
          </p>
        )}
      </div>

      {nothingYet && !isDaily ? (
        // A week-to-date figure needs hours BY DAY. A pre-cutover week
        // holds one weekly total per person, and a lump sum cannot be
        // apportioned across days — so this is not missing data, it is a
        // figure that cannot exist for those weeks. Say which, rather
        // than implying someone forgot to type something.
        <p className="mt-3 text-sm text-content-muted">
          Week-to-date payroll to sales begins with daily entry on{" "}
          {dayLabel(cutover) ?? "the cutover"}. This week's hours are a single weekly total per
          person, and a weekly total cannot be split across days.
        </p>
      ) : nothingYet ? (
        <p className="mt-3 text-sm text-content-muted">
          Nothing to compare yet this week. The figure needs both sides —{" "}
          {hours_thru ? `hours are in through ${dayLabel(hours_thru)}` : "no hours entered"} and{" "}
          {sales_thru ? `the tic sheet through ${dayLabel(sales_thru)}` : "no tic sheet entered"}.
        </p>
      ) : (
        <>
          <p className="pgw-display mt-1 text-3xl font-bold text-content-primary">
            {ratio == null ? "—" : pct(ratio)}
          </p>

          {/* The components, broken out — BDC asked to see them rather
              than a bare ratio. */}
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-content-muted">Wages</dt>
              <dd className="font-semibold text-content-primary">{money(wages_total)}</dd>
            </div>
            <div>
              <dt className="text-xs text-content-muted">· technicians</dt>
              <dd className="text-content-secondary">
                {techs_included ? money(wages_tech) : "excluded"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-content-muted">· everyone else</dt>
              <dd className="text-content-secondary">{money(wages_non_tech)}</dd>
            </div>
            <div>
              <dt className="text-xs text-content-muted">Gross sales</dt>
              <dd className="font-semibold text-content-primary">{money(gross_sales)}</dd>
            </div>
          </dl>

          {/* Both sides must cover the same days. When one is further
              along than the other, say so rather than quietly truncating. */}
          {hours_thru !== sales_thru && (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-content-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Measured to {dayLabel(window_end)}, the last day both sides have. Hours are entered
                through {dayLabel(hours_thru)} and the tic sheet through {dayLabel(sales_thru)};
                comparing them over different days would misstate the percentage.
              </span>
            </p>
          )}

          {!week_complete && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-content-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Part-week figure. Overtime is earned across the whole week, so it is zero until
                someone passes forty hours — a week heading for overtime reads low until it gets
                there. A technician's pay is the greater of guarantee and commission across the
                week, so it can still flip as flag hours land.
              </span>
            </p>
          )}
        </>
      )}

      {/* Flagged on screen so BDC can confirm the policy, per the brief.
          Excluding technicians is a one-field change in payroll_config —
          include_technicians — with no deploy. */}
      <p className="mt-3 flex items-start gap-1.5 text-xs text-content-muted">
        <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {techs_included
            ? "Technicians are included, at their Tech Tracker pay less bonuses. They are the largest labour cost in the store, so a staffing figure without them would say very little — but this is a policy call, not a fixed rule."
            : "Technicians are excluded by policy. The figure now covers only front-counter labour, which is a small share of the store's real wage bill."}{" "}
          Store managers are salaried and left out entirely. Bonuses and incentives are excluded.
        </span>
      </p>

      {/* The exclusion is only as good as the roster flag behind it. */}
      {missing_store_manager && (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-warning-border bg-warning-tint px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This store has a manager on the roster but none marked as the store manager, so no one
            is being excluded — a salaried manager's pay may be inflating this figure. Set{" "}
            <button
              onClick={() => onNavigate?.("hours")}
              className="font-semibold underline underline-offset-2"
            >
              Store manager (salaried) on the Payroll roster
            </button>
            .
          </span>
        </p>
      )}

      {/* Mirrors the Tech Tracker banner (PR #20): hours typed against a
          slot nobody held resolve to no rate and cost zero, so they are
          missing from the wages above. */}
      {unattributed_days > 0 && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md border border-warning-border bg-warning-tint px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {unattributed_days} day{unattributed_days === 1 ? "" : "s"} this week{" "}
            {unattributed_days === 1 ? "has" : "have"} technician hours against a slot with no
            technician assigned. Those hours resolve to no pay rate, so they are missing from the
            wages above and this percentage reads low. Fix it in the{" "}
            <button
              onClick={() => onNavigate?.("techtracker")}
              className="font-semibold underline underline-offset-2"
            >
              Tech Tracker
            </button>
            .
          </span>
        </p>
      )}
    </Card>
  );
}

// A NOTE ON WHAT THIS DISCLOSES, recorded here so it is not rediscovered
// as a surprise. The figure is aggregate, and store managers are meant to
// see it — that is the entire point of the tool. But gross sales are
// already visible to a store on the tic sheet, so percentage x sales is
// the store's wage bill exactly, and the card shows the wage total
// outright rather than pretending otherwise. At a four-person store,
// combined with hours that are visible by design, a manager can work
// backwards toward individual wages. It does soften the pay-visibility
// wall that migration 14 built. BDC accepted that trade knowingly; it is
// still worth having. Hiding the numerator would have been theatre.
