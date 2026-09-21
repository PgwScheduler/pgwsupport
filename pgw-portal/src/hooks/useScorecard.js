import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { settingsFrom } from "../lib/scorecard.js";
import { addDays, asDate, iso } from "../lib/weekUtils.js";

// Matt's reports, Phase 1: everything the three reports read, for one
// report date. The numbers themselves are computed in lib/scorecard.js.
//
// WHERE EACH NUMBER COMES FROM
//   daily cars, sales, GP, declined work, tire / alignment / battery
//     units  -> report_build(), grouped by store: the same definitions
//               every other report uses, scoped by can_access_location
//               and with the sandbox excluded, both in the database.
//   days open, GP and sales budget -> bonus_monthly_targets
//   2025 sales, cars, tires        -> prior_year_actuals
//   market, row order, name, fill  -> markets + store_report_profile
//   weekly goal, tire goals, bronze floor -> store_report_config_for()
//   bands, tier %, payouts          -> report_settings
//   market bonus brackets           -> market_bonus_brackets
//                                      (admin/master only: everyone
//                                      else gets no rows, so no bonus)
//
// The calendar: "elapsed" is open days (Mon–Sat, not a holiday) from the
// 1st to the report date -- Matt's G2, which he types by hand. The pay
// week for Report 2's weekly figures is Monday–Saturday, as in his sheet.
const Y_MEASURES = ["ro_count", "gross_sales", "gross_profit", "total_potential",
  "cat_units_kpi_su_tires", "cat_units_kpi_su_wheel_alignments"];
const MTD_MEASURES = ["ro_count", "gross_sales", "gross_profit", "cat_units_kpi_su_tires", "cat_units_kpi_su_battery"];

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const mondayOf = (d) => { const dow = asDate(d).getDay(); return addDays(d, dow === 0 ? -6 : 1 - dow); };

async function byStore(from, to, measures) {
  const { data, error } = await supabase.rpc("report_build", {
    p_from: from, p_to: to, p_group_by: "store", p_measures: measures,
  });
  if (error) throw error;
  // Grouped by store, report_build puts the store's id in bucket_key
  // (store_id is only filled when a time grouping is split by store).
  const out = {};
  for (const r of data ?? []) {
    const id = r.store_id ?? r.bucket_key;
    if (!r.is_total && id) out[id] = r.measures ?? {};
  }
  return out;
}

export function useScorecard() {
  const [reportDate, setReportDate] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Default report date: the last open business day before today.
  useEffect(() => {
    let live = true;
    supabase.rpc("report_default_date", { p_today: iso(new Date()) }).then(({ data: d, error: e }) => {
      if (!live) return;
      if (e) setError(e.message);
      else setReportDate(d);
    });
    return () => { live = false; };
  }, []);

  const load = useCallback(async (d) => {
    if (!d) return;
    setLoading(true);
    setError(null);
    try {
      const year = Number(d.slice(0, 4)), month = Number(d.slice(5, 7));
      const mStart = monthStart(d);
      const mon = mondayOf(d);
      const sat = addDays(mon, 5);
      const [locRes, profRes, mktRes, cfgRes, setRes, brRes, tgRes, pyRes,
             elapsedRes, wkDoneRes, wkLeftRes, pyDaysRes] = await Promise.all([
        supabase.from("locations").select("id, store_number, name, brand, state, is_sandbox"),
        supabase.from("store_report_profile").select("location_id, market_id, report_sort_order, report_display_name, name_fill_override"),
        supabase.from("markets").select("id, code, name, sort_order, display_color, display_font_color").order("sort_order"),
        supabase.rpc("store_report_config_for", { p_year: year, p_month: month }),
        supabase.from("report_settings").select("key, value"),
        supabase.from("market_bonus_brackets").select("min_pct_to_budget, payout_pct, improvement_share"),
        supabase.from("bonus_monthly_targets").select("location_id, days_open, gp_budget, sales_goal").eq("plan_year", year).eq("month", month),
        supabase.from("prior_year_actuals").select("location_id, sales, cars, tires").eq("year", year - 1).eq("month", month),
        supabase.rpc("open_days_between", { d_from: mStart, d_to: d }),
        supabase.rpc("open_days_between", { d_from: mon, d_to: d }),
        supabase.rpc("open_days_between", { d_from: addDays(d, 1), d_to: sat }),
        supabase.rpc("derived_days_open", { p_year: year - 1, p_month: month }),
      ]);
      const firstErr = [locRes, profRes, mktRes, cfgRes, setRes, brRes, tgRes, pyRes, elapsedRes, wkDoneRes, wkLeftRes, pyDaysRes]
        .find((r) => r.error)?.error;
      if (firstErr) throw firstErr;

      const [yest, mtd, wtdByDay] = await Promise.all([
        byStore(d, d, Y_MEASURES),
        byStore(mStart, d, MTD_MEASURES),
        supabase.rpc("report_build", { p_from: mon, p_to: d, p_group_by: "day", p_measures: ["ro_count", "gross_sales"], p_split_by_store: true })
          .then(({ data: rows, error: e }) => { if (e) throw e; return rows ?? []; }),
      ]);

      // Week to date per store: sales, and how many days were entered
      // (Matt's weekly projection averages ENTERED days).
      const week = {};
      for (const r of wtdByDay) {
        if (r.is_total || !r.store_id) continue;
        const w = (week[r.store_id] ||= { sales: 0, enteredDays: 0 });
        const cars = num(r.measures?.ro_count) ?? 0;
        if (cars > 0) { w.enteredDays += 1; w.sales += num(r.measures?.gross_sales) ?? 0; }
      }

      const prof = Object.fromEntries((profRes.data ?? []).map((p) => [p.location_id, p]));
      const mkts = Object.fromEntries((mktRes.data ?? []).map((m) => [m.id, m]));
      const cfg = Object.fromEntries((cfgRes.data ?? []).map((c) => [c.location_id, c]));
      const tg = Object.fromEntries((tgRes.data ?? []).map((t) => [t.location_id, t]));
      const py = Object.fromEntries((pyRes.data ?? []).map((p) => [p.location_id, p]));

      const facts = (locRes.data ?? [])
        .filter((l) => !l.is_sandbox && prof[l.id])
        .map((l) => {
          const p = prof[l.id], m = mkts[p.market_id], c = cfg[l.id] ?? {}, t = tg[l.id] ?? {}, y = yest[l.id] ?? {}, x = mtd[l.id] ?? {};
          const entered = (num(y.ro_count) ?? 0) > 0;
          return {
            id: l.id, storeNumber: l.store_number, name: p.report_display_name, brand: l.brand, state: l.state,
            marketId: p.market_id, sort: p.report_sort_order,
            fill: p.name_fill_override ?? m?.display_color, font: m?.display_font_color,
            daysOpen: num(t.days_open), gpBudget: num(t.gp_budget), salesBudget: num(t.sales_goal),
            bronzePct: num(c.bronze_floor_pct), weeklyGoal: num(c.weekly_sales_goal),
            tireGoal: num(c.tire_goal_per_day), tirePayoutMin: num(c.tire_payout_min),
            // A category with nothing sold has no unit row at all, so on a
            // day the store DID enter, a missing count is 0, not blank.
            yest: entered ? {
              cars: num(y.ro_count), sales: num(y.gross_sales), gp: num(y.gross_profit), potential: num(y.total_potential),
              tires: num(y.cat_units_kpi_su_tires) ?? 0, align: num(y.cat_units_kpi_su_wheel_alignments) ?? 0,
            } : null,
            mtd: (num(x.ro_count) ?? 0) > 0 ? {
              cars: num(x.ro_count), sales: num(x.gross_sales), gp: num(x.gross_profit),
              tires: num(x.cat_units_kpi_su_tires) ?? 0, battery: num(x.cat_units_kpi_su_battery),
            } : { cars: null, sales: null, gp: null, tires: null, battery: null },
            week: week[l.id] ?? { sales: 0, enteredDays: 0 },
            py: { sales: num(py[l.id]?.sales), cars: num(py[l.id]?.cars), tires: num(py[l.id]?.tires), daysOpen: num(pyDaysRes.data) },
          };
        });

      const daysOpen = facts.map((f) => f.daysOpen).find((v) => v !== null) ?? null;
      setData({
        reportDate: d, facts,
        markets: mktRes.data ?? [],
        ctx: {
          elapsed: num(elapsedRes.data), daysOpen,
          daysElapsedInWeek: num(wkDoneRes.data), daysLeftInWeek: num(wkLeftRes.data),
          settings: settingsFrom(setRes.data ?? []),
          brackets: (brRes.data ?? []).length ? brRes.data : null,
        },
        enteredCount: facts.filter((f) => f.yest).length,
      });
    } catch (e) {
      setError(e.message ?? String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (reportDate) load(reportDate); }, [reportDate, load]);

  return { reportDate, setReportDate, data, loading, error, reload: () => load(reportDate) };
}
