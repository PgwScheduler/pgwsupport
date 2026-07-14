import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { authOnlyClient } from "../lib/authOnlyClient.js";
import { generateTempPassword } from "../lib/tempPassword.js";

const PROFILE_SELECT = `
  id, email, full_name, role, location_id, district_id, region_id,
  location:location_id ( id, name, store_number ),
  district:district_id ( id, name ),
  region:region_id ( id, name )
`;

export function useUserManagement() {
  const [users, setUsers] = useState([]);
  const [regions, setRegions] = useState([]);
  const [districts, setDistricts] = useState([]);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [usersRes, regionsRes, districtsRes, storesRes] = await Promise.all([
      supabase.from("profiles").select(PROFILE_SELECT).order("email"),
      supabase.from("regions").select("id, name").order("name"),
      supabase.from("districts").select("id, name, region_id").order("name"),
      supabase.from("locations").select("id, name, store_number, district_id").order("store_number"),
    ]);
    const firstError = usersRes.error || regionsRes.error || districtsRes.error || storesRes.error;
    if (firstError) setError(firstError.message);
    else setError(null);
    setUsers(usersRes.data ?? []);
    setRegions(regionsRes.data ?? []);
    setDistricts(districtsRes.data ?? []);
    setStores(storesRes.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /* Sets exactly one of location_id/district_id/region_id based on role,
     clearing the other two — a user's scope should never be ambiguous. */
  const scopeFieldsFor = (role, scopeId) => ({
    location_id: role === "store" ? scopeId : null,
    district_id: role === "district" ? scopeId : null,
    region_id: role === "regional" ? scopeId : null,
  });

  const updateAssignment = useCallback(async (id, role, scopeId) => {
    const patch = { role, ...scopeFieldsFor(role, scopeId) };
    const { data, error } = await supabase.from("profiles").update(patch).eq("id", id).select(PROFILE_SELECT).single();
    if (error) {
      setError(error.message);
      return { error };
    }
    setUsers((prev) => prev.map((u) => (u.id === id ? data : u)));
    return { data };
  }, []);

  const createUser = useCallback(async ({ email, full_name, role, scopeId }) => {
    const tempPassword = generateTempPassword();
    const { data: signUpData, error: signUpError } = await authOnlyClient.auth.signUp({
      email,
      password: tempPassword,
      options: { data: { full_name } },
    });
    if (signUpError) {
      setError(signUpError.message);
      return { error: signUpError };
    }
    const newUserId = signUpData.user?.id;
    if (!newUserId) {
      const err = new Error("Sign-up didn't return a user id.");
      setError(err.message);
      return { error: err };
    }

    const patch = { full_name, role, ...scopeFieldsFor(role, scopeId) };
    const { data: profileData, error: profileError } = await supabase
      .from("profiles")
      .update(patch)
      .eq("id", newUserId)
      .select(PROFILE_SELECT)
      .single();
    if (profileError) {
      setError(profileError.message);
      return { error: profileError, tempPassword };
    }

    setUsers((prev) => [...prev, profileData].sort((a, b) => (a.email || "").localeCompare(b.email || "")));
    return { data: profileData, tempPassword };
  }, []);

  return { users, regions, districts, stores, loading, error, updateAssignment, createUser, refetch: fetchAll };
}
