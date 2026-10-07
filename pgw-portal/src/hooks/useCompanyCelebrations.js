import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

// Every store's birthdays and anniversaries (migration 79), for the
// Employee Schedule's "all stores" toggle. company_celebrations() decides
// who may call it (Home Office logins, office, admin, master) and returns
// only name, birthday month/day, hire/rehire date and store. Loaded once,
// when first switched on: the list does not depend on the month shown.
export function useCompanyCelebrations(enabled) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled || people) return;
    let live = true;
    (async () => {
      const { data, error: err } = await supabase.rpc("company_celebrations");
      if (!live) return;
      setError(err ? err.message : null);
      setPeople(err ? [] : data ?? []);
    })();
    return () => { live = false; };
  }, [enabled, people]);

  return { people: people ?? [], loading: enabled && people == null, error };
}
