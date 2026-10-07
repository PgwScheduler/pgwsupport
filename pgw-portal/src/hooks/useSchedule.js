import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { monthGrid } from "../lib/scheduleMath.js";
import { isOfficeRole } from "../lib/officeRole.js";

// Loads one store's shifts for the visible month grid plus the store's active
// roster, and exposes add/update/delete. Reads only id + full_name off the
// roster — never pay rates or any pay field. RLS (can_access_location) does all
// scoping; we never filter by role or hardcode a store list here.
const SHIFT_SELECT =
  "id, location_id, employee_id, shift_date, start_time, end_time, notes, shift_type_id, employee:employee_id ( id, full_name )";
// No embed: it would join employees, which the office role cannot read.
const OFFICE_SHIFT_SELECT = "id, location_id, employee_id, shift_date, start_time, end_time, notes, shift_type_id";

export function useSchedule(store, year, month) {
  const { user, role } = useAuth();
  const locationId = store?.id ?? null;
  // Replace mode clears a whole month, so it is admin/master only — the one
  // action here that destroys existing work in bulk. Editing shifts (and
  // Fill-empty duplication) stays open to anyone can_access_location lets
  // in, which is the district/regional edit right migration 17 established.
  const canReplace = role === "admin" || role === "master";
  // Office (migration 78): read-only, and names come from schedule_people().
  const office = isOfficeRole(role);

  const [shifts, setShifts] = useState([]);
  const [roster, setRoster] = useState([]);
  const [shiftTypes, setShiftTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  const rangeStart = grid[0][0];
  const rangeEnd = grid[grid.length - 1][6];

  const load = useCallback(async () => {
    if (!locationId) return;
    setLoading(true);
    setError(null);
    const [shiftRes, rosterRes, typeRes] = await Promise.all([
      supabase
        .from("employee_schedules")
        .select(office ? OFFICE_SHIFT_SELECT : SHIFT_SELECT)
        .eq("location_id", locationId)
        .gte("shift_date", rangeStart)
        .lte("shift_date", rangeEnd)
        .order("shift_date")
        .order("start_time"),
      office
        // An office login cannot read employees (migration 78); this
        // returns just the calendar's columns, active people plus anyone
        // holding a shift in the range.
        ? supabase.rpc("schedule_people", { p_location_id: locationId, p_from: rangeStart, p_to: rangeEnd })
        : supabase
          .from("employees")
          // Birthday + anniversary fields feed the calendar (migration 67).
          .select("id, full_name, birth_month, birth_day, hire_date, rehire_date")
          .eq("location_id", locationId)
          .eq("active", true)
          .order("full_name"),
      // Company-wide catalog: readable by everyone, so no location filter.
      supabase
        .from("shift_types")
        .select("id, name, abbreviation, color_token, export_argb, counts_toward_hours, is_copyable, sort_order")
        .eq("active", true)
        .order("sort_order"),
    ]);
    const people = rosterRes.error ? [] : rosterRes.data ?? [];
    if (shiftRes.error) setError(shiftRes.error.message);
    else if (office) {
      // The embedded employee comes from schedule_people() instead.
      const byId = Object.fromEntries(people.map((p) => [p.id, { id: p.id, full_name: p.full_name }]));
      setShifts((shiftRes.data ?? []).map((s) => ({ ...s, employee: byId[s.employee_id] ?? null })));
    } else setShifts(shiftRes.data ?? []);
    if (!rosterRes.error) setRoster(office ? people.filter((p) => p.active) : people);
    if (!typeRes.error) setShiftTypes(typeRes.data ?? []);
    setLoading(false);
  }, [locationId, rangeStart, rangeEnd, office]);

  useEffect(() => {
    load();
  }, [load]);

  const addShift = useCallback(
    async ({ employee_id, shift_date, start_time, end_time, notes, shift_type_id }) => {
      const { error: err } = await supabase.from("employee_schedules").insert({
        location_id: locationId,
        employee_id,
        shift_date,
        start_time,
        end_time,
        notes: notes?.trim() || null,
        shift_type_id: shift_type_id || null,
        created_by: user?.id ?? null,
      });
      if (!err) await load();
      return { error: err };
    },
    [locationId, user?.id, load]
  );

  const updateShift = useCallback(
    async (id, { employee_id, shift_date, start_time, end_time, notes, shift_type_id }) => {
      const { error: err } = await supabase
        .from("employee_schedules")
        .update({
          employee_id,
          shift_date,
          start_time,
          end_time,
          notes: notes?.trim() || null,
          shift_type_id: shift_type_id || null,
          updated_by: user?.id ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (!err) await load();
      return { error: err };
    },
    [user?.id, load]
  );

  const deleteShift = useCallback(
    async (id) => {
      const { error: err } = await supabase.from("employee_schedules").delete().eq("id", id);
      if (!err) await load();
      return { error: err };
    },
    [load]
  );

  // Duplicate a month. Both calls hit the same RPC, which reads one plan
  // function for preview and commit alike — so the summary the user
  // confirms cannot drift from what actually runs. Nothing writes until
  // commit is called; the whole copy is a single transaction server-side.
  const previewCopy = useCallback(
    async (sourceMonthIso, targetMonthIso, mode) => {
      const { data, error: err } = await supabase.rpc("schedule_copy_month", {
        p_location_id: locationId,
        p_source_month: sourceMonthIso,
        p_target_month: targetMonthIso,
        p_mode: mode,
        p_commit: false,
      });
      return { data, error: err };
    },
    [locationId]
  );

  const commitCopy = useCallback(
    async (sourceMonthIso, targetMonthIso, mode) => {
      const { data, error: err } = await supabase.rpc("schedule_copy_month", {
        p_location_id: locationId,
        p_source_month: sourceMonthIso,
        p_target_month: targetMonthIso,
        p_mode: mode,
        p_commit: true,
      });
      if (!err) await load();
      return { data, error: err };
    },
    [locationId, load]
  );

  // Shifts grouped by date for O(1) day-cell lookup, each list start-time sorted.
  const byDate = useMemo(() => {
    const map = {};
    for (const s of shifts) (map[s.shift_date] ??= []).push(s);
    for (const k in map) map[k].sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
    return map;
  }, [shifts]);

  const typesById = useMemo(() => {
    const m = {};
    for (const t of shiftTypes) m[t.id] = t;
    return m;
  }, [shiftTypes]);

  return {
    grid, byDate, roster, loading, error, reload: load,
    addShift, updateShift, deleteShift,
    shiftTypes, typesById, canReplace, readOnly: office,
    previewCopy, commitCopy,
  };
}
