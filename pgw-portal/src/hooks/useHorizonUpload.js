import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";

// Roles the horizon-upload Edge Function accepts (migrations 46-47). A
// manager only ever reaches the stores they manage; the function and the
// database both enforce that, this list only decides whether the button
// is shown.
export const HORIZON_UPLOAD_ROLES = ["store", "district", "regional", "admin", "master"];

// supabase.functions.invoke puts a non-2xx reply on error.context (a
// Response). Read the function's own { error } message from it; fall
// back to the transport error for a network failure.
async function readFunctionError(error) {
  try {
    const body = await error.context.json();
    return { status: error.context.status, ...body };
  } catch {
    return { status: null, error: error?.message ?? "Could not reach the upload service." };
  }
}

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke("horizon-upload", { body });
  if (error) return { ok: false, ...(await readFunctionError(error)) };
  return { ok: true, status: 200, ...data };
}

// One store-month's Horizon upload: review first, then send exactly what
// was reviewed. `send` passes the reviewed fingerprint; the function
// rebuilds the numbers and refuses if anything changed in between.
export function useHorizonUpload(locationId, monthYm) {
  const { role } = useAuth();
  const canUse = HORIZON_UPLOAD_ROLES.includes(role);

  const [lastUpload, setLastUpload] = useState(null);

  const loadLast = useCallback(async () => {
    if (!locationId || !canUse) { setLastUpload(null); return; }
    const { data, error } = await supabase.rpc("horizon_last_upload", { p_location_id: locationId });
    setLastUpload(error ? null : data?.[0] ?? null);
  }, [locationId, canUse]);

  useEffect(() => { loadLast(); }, [loadLast]);

  const preview = useCallback(
    () => invoke({ location_id: locationId, month: monthYm, mode: "preview" }),
    [locationId, monthYm]
  );

  const send = useCallback(async (fingerprint) => {
    const r = await invoke({ location_id: locationId, month: monthYm, mode: "send", confirm_sha256: fingerprint });
    loadLast();
    return r;
  }, [locationId, monthYm, loadLast]);

  return { canUse, role, lastUpload, reloadLast: loadLast, preview, send };
}
