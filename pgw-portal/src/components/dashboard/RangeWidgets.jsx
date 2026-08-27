import React from "react";
import { AlertTriangle, TrendingUp } from "lucide-react";
import { money, pct } from "../../lib/format.js";
import { rangeLabel } from "../../lib/dateRange.js";
import { Card } from "../ui.jsx";

// The five range-driven dashboard widgets.
//
// Every widget states the window it covers. A number without its window
// is unreadable — "$41,800" means nothing until you know whether that is
// a week, a month or a quarter.

const num1 = (n) => (n == null ? "—" : (Math.round(Number(n) * 10) / 10).toLocaleString());

function Widget({ label, value, sub, tone, children, from, to }) {
  const toneCls =
    tone === "pos" ? "text-success" : tone === "neg" ? "text-danger" : "text-content-primary";
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-content-secondary">{label}</p>
      <p className={"pgw-display mt-1 text-2xl font-bold " + toneCls}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-content-muted">{sub}</p>}
      {children}
      <p className="mt-2 border-t border-hairline pt-1.5 text-[11px] text-content-muted">
        {rangeLabel(from, to)}
      </p>
    </Card>
  );
}

// Credit apps: the two kicker thresholds and, below the floor, the
// penalty exposure. The penalty is FLAGGED, never applied — the same
// treatment the bonus tracker gives it, and for the same reason: it can
// be waived three different ways (Gold gross profit, the daily car goal,
// or 40% phone conversion), so showing it as a deduction would state a
// loss the store may not take.
const KICKER_1 = 50;
const KICKER_2 = 100;
const PENALTY_FLOOR = 35;
const PENALTY_PER_APP = 75;

function CreditApps({ apps, from, to }) {
  const n = Number(apps ?? 0);
  const next = n < KICKER_1 ? KICKER_1 : n < KICKER_2 ? KICKER_2 : null;
  const shortfall = Math.max(0, PENALTY_FLOOR - n);
  const towards = next ? Math.min(1, n / next) : 1;

  return (
    <Widget
      label="Credit apps"
      value={num1(n)}
      sub={
        next
          ? `${next - n} more to the ${next}-app kicker`
          : `past the ${KICKER_2}-app kicker`
      }
      from={from}
      to={to}
    >
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-overlay">
        <div
          className="h-full rounded-full"
          style={{ width: `${towards * 100}%`, backgroundColor: "var(--accent)" }}
        />
      </div>
      <p className="mt-1 text-[11px] text-content-muted">
        Kickers at {KICKER_1} and {KICKER_2}
      </p>
      {shortfall > 0 && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md border border-warning-border bg-warning-tint px-2 py-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {shortfall} below the floor of {PENALTY_FLOOR} — exposure{" "}
            <span className="font-semibold">{money(shortfall * PENALTY_PER_APP)}</span>, shown, not
            deducted. Waived by Gold gross profit, the daily car goal, or 40% phone conversion.
          </span>
        </p>
      )}
    </Widget>
  );
}

export function RangeWidgets({ metrics, payroll, from, to }) {
  const m = metrics ?? {};
  const p = payroll ?? {};

  const gp = m.gross_profit == null ? null : Number(m.gross_profit);
  const gpPct = m.gross_profit_pct == null ? null : Number(m.gross_profit_pct);
  const ptsRatio = p.payroll_to_sales == null ? null : Number(p.payroll_to_sales);
  const hasWindow = !!p.window_end;
  // The whole range predates daily payroll entry, so payroll_to_sales_range
  // clamped its start past the range's own end. Not missing data — a
  // figure that cannot exist for those days, because hours before the
  // cutover are one weekly total per person and cannot be split by day.
  const preCutover = !hasWindow && p.window_start && to && p.window_start > to;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Widget
        label="Sales"
        value={m.gross_sales == null ? "—" : money(m.gross_sales)}
        sub={m.ro_count ? `${num1(m.ro_count)} repair orders` : null}
        from={from}
        to={to}
      />

      <Widget
        label="Gross profit"
        value={gp == null ? "—" : money(gp)}
        sub={gpPct == null ? null : `${pct(gpPct)} of sales`}
        from={from}
        to={to}
      >
        {/* Stated explicitly because the old figure did NOT subtract it,
            and the two are easy to confuse at a glance. */}
        {m.labor_cost != null && (
          <p className="mt-1 text-[11px] text-content-muted">
            after {money(m.labor_cost)} technician labour
          </p>
        )}
      </Widget>

      <Widget
        label="Tires per day"
        value={num1(m.tires_per_day)}
        sub={
          m.days_with_data
            ? `${num1(m.tire_units)} tires over ${m.days_with_data} day${m.days_with_data === 1 ? "" : "s"} with data`
            : "no days with data yet"
        }
        from={from}
        to={to}
      />

      <CreditApps apps={m.credit_apps} from={from} to={to} />

      {/* The window shown must never be the clamped start paired with the
          requested end — for a range entirely before the daily-entry
          cutover that reads backwards ("Aug 30 – Jul 31"). With no
          measurable window, show the range that was actually asked for
          and say why there is no figure. */}
      <Widget
        label="Payroll to sales"
        value={ptsRatio == null ? "—" : pct(ptsRatio)}
        sub={
          p.wages_total != null
            ? `${money(p.wages_total)} wages ÷ ${money(p.gross_sales)} sales`
            : preCutover
              ? `daily payroll entry starts ${rangeLabel(p.window_start, p.window_start)}`
              : "needs hours and a tic sheet"
        }
        tone=""
        from={hasWindow ? p.window_start : from}
        to={hasWindow ? p.window_end : to}
      >
        {p.window_end && (p.hours_thru !== p.sales_thru) && (
          <p className="mt-1 text-[11px] text-content-muted">
            Measured to the last day both sides have.
          </p>
        )}
        {p.techs_included === false && (
          <p className="mt-1 text-[11px] text-content-muted">Technicians excluded by policy.</p>
        )}
      </Widget>

      {m.store_count > 1 && (
        <Card className="flex items-center gap-2 p-4 text-xs text-content-secondary">
          <TrendingUp className="h-4 w-4 shrink-0 text-content-muted" />
          <span>
            Aggregated across the <span className="font-semibold text-content-primary">{m.store_count}</span>{" "}
            stores you can see. Use the store selector above to narrow to one.
          </span>
        </Card>
      )}
    </div>
  );
}
