import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";

const PRIVILEGED = ["admin", "master"];

// Horizon slot occupancy for one store.
//
// THIS IS NOT tech_slots. Horizon TMG addresses exactly 20 technician
// slots per shop and the upload writes into those numbered slots, so the
// portal must not invent its own numbering. tech_slots is the 9-row
// Excel entry grid and is freely reassignable; these 20 are an external
// address space with an allocation rule. The two must never be joined —
// both relate to employees, and nothing else.
//
// WHY A TERMINATED TECHNICIAN STILL HOLDING A SLOT IS SURFACED HERE.
// Release is deliberately not wired to employees.active. Holding a slot
// after termination is the SAFE state: the technician's history stays
// attributable in Horizon and it costs nothing until the store needs a
// 21st slot. Releasing is destructive and effectively irreversible —
// under the rehire rule the slot does not come back, the technician goes
// to the end of the queue, and slot ordering is permanently altered. So
// an accidental `active` flip must not free a slot.
//
// The cost of that choice is that a slot can sit held and forgotten.
// This hook is the compensating control: it makes the held slots visible
// so forgetting costs visibility rather than data.
export function useHorizonSlots(locationId) {
  const { role } = useAuth();
  const privileged = PRIVILEGED.includes(role);

  const [held, setHeld] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!locationId) { setHeld([]); return; }
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("horizon_slots_held_by_inactive")
      .select("location_id, slot_number, employee_id, full_name, position")
      .eq("location_id", locationId)
      .order("slot_number");
    if (err) setError(err.message);
    else setHeld(data ?? []);
    setLoading(false);
  }, [locationId]);

  useEffect(() => { load(); }, [load]);

  // Release is the one write, and it is always explicit. The RPC
  // re-checks role and location access itself; this is not the guard.
  const release = useCallback(
    async (technicianId) => {
      const { error: err } = await supabase.rpc("release_horizon_slot", {
        p_location_id: locationId,
        p_technician_id: technicianId,
      });
      if (err) { setError(err.message); return false; }
      await load();
      return true;
    },
    [locationId, load],
  );

  return { held, loading, error, privileged, reload: load, release };
}
