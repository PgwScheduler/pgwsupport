import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { monthGrid } from "../lib/scheduleMath.js";

// Loads one store's shifts for the visible month grid plus the store's active
// roster, and exposes add/update/delete. Reads only id + full_name off the
// roster — never pay rates or any pay field. RLS (can_access_location) does all
// scoping; we never filter by role or hardcode a store list here.
const SHIFT_SELECT =
  "id, location_id, employee_id, shift_date, start_time, end_time, notes, shift_type_id, employee:employee_id ( id, full_name )";

export function useSchedule(store, year, month) {
  const { user, role } = useAuth();
  const locationId = store?.id ?? null;
  // Replace mode clears a whole month, so it is admin/master only — the one
  // action here that destroys existing work in bulk. Editing shifts (and
  // Fill-empty duplication) stays open to anyone can_access_location lets
  // in, which is the district/regional edit right migration 17 established.
  const canReplace = role === "admin" || role === "master";

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
        .select(SHIFT_SELECT)
        .eq("location_id", locationId)
        .gte("shift_date", rangeStart)
        .lte("shift_date", rangeEnd)
        .order("shift_date")
        .order("start_time"),
      supabase
        .from("employees")
        .select("id, full_name")
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
    if (shiftRes.error) setError(shiftRes.error.message);
    else setShifts(shiftRes.data ?? []);
    if (!rosterRes.error) setRoster(rosterRes.data ?? []);
    if (!typeRes.error) setShiftTypes(typeRes.data ?? []);
    setLoading(false);
  }, [locationId, rangeStart, rangeEnd]);

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
    shiftTypes, typesById, canReplace,
    previewCopy, commitCopy,
  };
}
