import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { weeksTouching, isWholeCalendarMonth } from "../lib/dateRange.js";
import {
  weekStartOf, rateForDate,
  computeTechWeek, computeTechMonth, computeTechSummaryStore,
} from "../lib/techPayMath.js";

const PRIVILEGED = ["admin", "master"];
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};


// Technician Tracker data for one store + one month.
//   - tech_slots / tech_daily are store-visible (hours/flag/labor).
//   - tech_weekly (other_pay) and tech_pay_rates are MASTER/ADMIN only, so
//     they are fetched only when privileged; a store user never receives a
//     rate or a pay figure. Per-technician pay is derived client-side from
//     the rates (techPayMath). Store-level labor cost + the daily allocation
//     come from the SECURITY DEFINER RPCs, which a store MAY call.
// Driven by the shared date range, not a month.
//
// THE PAY ENGINE ALWAYS SEES WHOLE WEEKS. `weeks` covers every Sunday–
// Saturday week the range touches, and each is fetched and computed in
// full whatever the range's own edges are, so a range that cuts a week
// in half cannot produce half-week overtime — the week is evaluated at
// its true 40-hour threshold and the screen simply shows part of it,
// labelled partial.
export function useTechTracker(locationId, from, to) {
  const { role } = useAuth();
  const privileged = PRIVILEGED.includes(role);

  // NOT a fixed five blocks. monthWeekStarts() always returned exactly
  // five, which silently drops the tail of a 31-day month beginning on a
  // Saturday: August 2026 starts Saturday the 1st, so its five blocks
  // ended on the 29th and the 30th and 31st fell off the screen. That is
  // the same defect the tic sheet fixed in migration 25, and it matters
  // more now — the 30th is the payroll daily-entry cutover.
  const weeks = useMemo(() => weeksTouching(from, to), [from, to]);
  const weekStarts = useMemo(() => weeks.map((w) => w.weekStart), [weeks]);
  const rangeStart = weekStarts[0];
  const rangeEnd = addDays(weekStarts[weekStarts.length - 1], 7); // exclusive
  const isMonth = useMemo(() => isWholeCalendarMonth(from, to), [from, to]);

  const [slots, setSlots] = useState([]);
  const [employees, setEmployees] = useState([]); // active roster (for assignment / rates)
  const [daily, setDaily] = useState([]);     // tech_daily rows in range
  const [weekly, setWeekly] = useState([]);   // tech_weekly rows (privileged)
  const [rates, setRates] = useState([]);     // tech_pay_rates rows (privileged)
  const [storeMonth, setStoreMonth] = useState(null); // tech_store_month RPC
  const [monthGroupon, setMonthGroupon] = useState(0); // daily_kpi groupon (store ELR)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);

    const [slotRes, empRes, dayRes, monthRes, kpiRes] = await Promise.all([
      supabase.from("tech_slots")
        .select("*, employee:employees(id, full_name, position)")
        .eq("location_id", locationId).order("slot_index"),
      supabase.from("employees").select("id, full_name, position")
        .eq("location_id", locationId).eq("active", true).order("full_name"),
      supabase.from("tech_daily").select("*")
        .eq("location_id", locationId).gte("work_date", rangeStart).lt("work_date", rangeEnd),
      supabase.rpc("tech_store_range", { loc: locationId, d_from: from, d_to: to }),
      supabase.from("daily_kpi").select("sales_groupon")
        .eq("location_id", locationId).gte("business_date", from).lte("business_date", to),
    ]);

    if (slotRes.error) { setError(slotRes.error.message); setLoading(false); return; }
    setError(null);
    setSlots(slotRes.data ?? []);
    setEmployees(empRes.data ?? []);
    setDaily(dayRes.data ?? []);
    setStoreMonth(Array.isArray(monthRes.data) ? monthRes.data[0] ?? null : monthRes.data ?? null);
    setMonthGroupon((kpiRes.data ?? []).reduce((a, r) => a + Number(r.sales_groupon || 0), 0));

    if (privileged) {
      const slotIds = (slotRes.data ?? []).map((s) => s.id);
      const empIds = (slotRes.data ?? []).map((s) => s.employee_id).filter(Boolean);
      const [wkRes, rateRes] = await Promise.all([
        slotIds.length ? supabase.from("tech_weekly").select("*").in("tech_slot_id", slotIds) : Promise.resolve({ data: [] }),
        empIds.length ? supabase.from("tech_pay_rates").select("*").in("employee_id", empIds) : Promise.resolve({ data: [] }),
      ]);
      setWeekly(wkRes.data ?? []);
      setRates(rateRes.data ?? []);
    } else {
      setWeekly([]);
      setRates([]);
    }
    setLoading(false);
  }, [locationId, rangeStart, rangeEnd, from, to, privileged]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Group the raw rows for fast lookup.
  const dailyBySlot = useMemo(() => {
    const m = {};
    for (const d of daily) (m[d.tech_slot_id] ||= {})[d.work_date] = d;
    return m;
  }, [daily]);
  const otherPayBySlotWeek = useMemo(() => {
    const m = {};
    for (const w of weekly) (m[w.tech_slot_id] ||= {})[w.week_start] = Number(w.other_pay || 0);
    return m;
  }, [weekly]);
  const ratesByEmp = useMemo(() => {
    const m = {};
    for (const r of rates) (m[r.employee_id] ||= []).push(r);
    return m;
  }, [rates]);

  // Per-slot computed view: one block per WHOLE week the range touches,
  // plus range totals. Pay figures are present only when privileged
  // (rates loaded); otherwise store-visible metrics only.
  //
  // Each week is computed over all seven of its days even when the range
  // covers only part of it, because overtime and the guarantee-versus-
  // commission choice are properties of the whole week. `partial` marks
  // those weeks so the UI can label their totals rather than let them
  // read as if they belonged wholly to the range.
  const slotViews = useMemo(() => {
    return slots.map((slot) => {
      const empRates = slot.employee_id ? ratesByEmp[slot.employee_id] ?? [] : [];
      const rangeDays = [];
      const slotWeeks = weeks.map((w) => {
        const days = [];
        for (let i = 0; i < 7; i++) {
          const iso = addDays(w.weekStart, i);
          const row = dailyBySlot[slot.id]?.[iso] ?? { hours_worked: 0, flag_hours: 0, labor_sales: 0 };
          const inRange = iso >= from && iso <= to;
          days.push({ iso, inRange, ...row });
          // Store-visible metrics describe the RANGE, so they take only
          // the days asked for; the pay engine above takes all seven.
          if (inRange) rangeDays.push(row);
        }
        const rate = privileged ? rateForDate(empRates, w.weekStart) : null;
        const otherPay = otherPayBySlotWeek[slot.id]?.[w.weekStart] ?? 0;
        return {
          weekStart: w.weekStart,
          weekEnd: w.weekEnd,
          partial: w.partial,
          ...computeTechWeek(days, rate, otherPay),
          rate,
        };
      });
      const store = computeTechSummaryStore(rangeDays);
      const month = privileged ? computeTechMonth(slotWeeks) : null;
      return {
        slot,
        weeks: slotWeeks,
        store,
        month,
        anyPartial: slotWeeks.some((w) => w.partial),
        hasRate: privileged && empRates.length > 0,
      };
    });
  }, [slots, dailyBySlot, otherPayBySlotWeek, ratesByEmp, weeks, from, to, privileged]);

  // Days with hours typed against a slot that had nobody in it, so no pay
  // rate resolves and they cost zero. Two shapes count:
  //
  //   * the slot holds someone NOW but the day predates the assignment —
  //     hours entered for a new tech before an admin moved the slot
  //   * the slot is entirely empty (no employee, no label) and somebody
  //     typed into it anyway
  //
  // A PLACEHOLDER slot (a label and no employee, e.g. 'MANAGER OR SA') is
  // deliberately unstaffed. Its days are meant to carry no pay, so they are
  // not flagged — otherwise every store would show a permanent warning it
  // can never clear. Scope is the month on screen, which is the range the
  // hook already holds; an older month is only visible by going to it.
  const unattributed = useMemo(() => {
    const bySlot = new Map();
    for (const d of daily) {
      if (d.employee_id) continue;
      if (!Number(d.hours_worked) && !Number(d.flag_hours) && !Number(d.labor_sales)) continue;
      if (d.work_date < from || d.work_date > to) continue;
      const slot = slots.find((s) => s.id === d.tech_slot_id);
      if (!slot) continue;
      const isPlaceholder = !slot.employee_id && !!slot.label;
      if (isPlaceholder) continue;
      if (!bySlot.has(slot.id)) {
        bySlot.set(slot.id, {
          slotId: slot.id,
          slotIndex: slot.slot_index,
          slotName: slot.employee?.full_name ?? slot.label ?? `Slot ${slot.slot_index}`,
          assignedNow: !!slot.employee_id,
          dates: [],
        });
      }
      bySlot.get(slot.id).dates.push(d.work_date);
    }
    return [...bySlot.values()]
      .map((g) => ({ ...g, dates: g.dates.sort() }))
      .sort((a, b) => a.slotIndex - b.slotIndex);
  }, [daily, slots, from, to]);

  // Store-level ELR is groupon-blended (Summary R22); other store metrics
  // come from the RPC (labor cost, avg cost/sold hr, shop proficiency).
  const storeSummary = useMemo(() => {
    const laborSales = Number(storeMonth?.labor_sales || 0);
    const flag = Number(storeMonth?.flag_hours || 0);
    return {
      laborSales,
      laborCost: storeMonth ? Number(storeMonth.labor_cost) : null,
      flagHours: flag,
      hoursWorked: Number(storeMonth?.hours_worked || 0),
      avgTechCostPerSoldHr: storeMonth ? Number(storeMonth.avg_tech_cost_per_sold_hr) : null,
      shopProficiency: Number(storeMonth?.shop_proficiency || 0),
      elr: flag === 0 ? 0 : (laborSales + 0.5 * monthGroupon) / flag, // blended
    };
  }, [storeMonth, monthGroupon]);

  // ---- savers ----
  const saveDaily = useCallback(async (slotId, workDate, patch) => {
    const { data, error: e } = await supabase.from("tech_daily")
      .upsert({ location_id: locationId, tech_slot_id: slotId, work_date: workDate,
                updated_at: new Date().toISOString(), ...patch },
              { onConflict: "tech_slot_id,work_date" })
      .select().single();
    if (e) return setError(e.message);
    setDaily((prev) => {
      const i = prev.findIndex((r) => r.tech_slot_id === slotId && r.work_date === workDate);
      return i >= 0 ? prev.map((r, j) => (j === i ? data : r)) : [...prev, data];
    });
  }, [locationId]);

  const saveOtherPay = useCallback(async (slotId, weekStart, value) => {
    const { data, error: e } = await supabase.from("tech_weekly")
      .upsert({ tech_slot_id: slotId, week_start: weekStart,
                other_pay: value === "" ? 0 : Number(value) || 0, updated_at: new Date().toISOString() },
              { onConflict: "tech_slot_id,week_start" })
      .select().single();
    if (e) return setError(e.message);
    setWeekly((prev) => {
      const i = prev.findIndex((r) => r.tech_slot_id === slotId && r.week_start === weekStart);
      return i >= 0 ? prev.map((r, j) => (j === i ? data : r)) : [...prev, data];
    });
  }, []);

  const saveRate = useCallback(async (employeeId, effectiveDate, patch) => {
    const { data, error: e } = await supabase.from("tech_pay_rates")
      .upsert({ employee_id: employeeId, effective_date: effectiveDate,
                updated_at: new Date().toISOString(), ...patch },
              { onConflict: "employee_id,effective_date" })
      .select().single();
    if (e) return setError(e.message);
    setRates((prev) => {
      const i = prev.findIndex((r) => r.employee_id === employeeId && r.effective_date === effectiveDate);
      return i >= 0 ? prev.map((r, j) => (j === i ? data : r)) : [...prev, data];
    });
  }, []);

  // How many already-entered days a reassignment would re-stamp. Shown
  // before the admin confirms, so nothing about history moves unseen.
  const countRowsFrom = useCallback(async (slotId, effectiveDate) => {
    const { count, error: e } = await supabase.from("tech_daily")
      .select("id", { count: "exact", head: true })
      .eq("tech_slot_id", slotId).gte("work_date", effectiveDate);
    return e ? 0 : (count ?? 0);
  }, []);

  // Reassign / clear an OCCUPIED slot. Goes through the RPC so the slot
  // move and the day re-stamp land in one transaction, and so rows before
  // the effective date are provably untouched. Returns rows re-stamped.
  const reassignSlot = useCallback(async (slotId, patch, effectiveDate) => {
    const { data, error: e } = await supabase.rpc("tech_reassign_slot", {
      p_slot_id: slotId,
      p_employee_id: patch.employee_id ?? null,
      p_label: patch.label ?? null,
      p_is_manager_or_sa: patch.is_manager_or_sa ?? null,
      p_effective_date: effectiveDate,
    });
    if (e) { setError(e.message); return { error: e }; }
    await fetchAll();
    return { error: null, restamped: Number(data) || 0 };
  }, [fetchAll]);

  // Assign / clear a slot (employee, label, manager flag).
  // Only reaches the insert branch for a slot row that does not exist yet;
  // an occupied slot goes through reassignSlot so the day rows stay bound
  // to whoever worked them. Returns { error } so callers can tell.
  const saveSlot = useCallback(async (slotIndex, patch) => {
    const existing = slots.find((s) => s.slot_index === slotIndex);
    if (existing) {
      const { data, error: e } = await supabase.from("tech_slots").update(patch).eq("id", existing.id).select("*, employee:employees(id, full_name, position)").single();
      if (e) { setError(e.message); return { error: e }; }
      setSlots((prev) => prev.map((s) => (s.id === data.id ? data : s)));
    } else {
      const { data, error: e } = await supabase.from("tech_slots")
        .insert({ location_id: locationId, slot_index: slotIndex, ...patch })
        .select("*, employee:employees(id, full_name, position)").single();
      if (e) { setError(e.message); return { error: e }; }
      setSlots((prev) => [...prev, data].sort((a, b) => a.slot_index - b.slot_index));
    }
    setError(null);
    return { error: null };
  }, [slots, locationId]);

  return {
    privileged, loading, error,
    weekStarts, weeks, isMonth, from, to, slotViews, storeSummary, unattributed,
    employees, ratesByEmp,
    saveDaily, saveOtherPay, saveRate, saveSlot, reassignSlot, countRowsFrom,
    refetch: fetchAll,
  };
}
