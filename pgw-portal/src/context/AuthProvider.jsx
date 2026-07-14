import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

const AuthContext = createContext(null);

const PROFILE_SELECT = `
  id, full_name, role,
  location_id, district_id, region_id,
  location:location_id ( id, name, store_number ),
  district:district_id ( id, name ),
  region:region_id ( id, name )
`;

const STORE_SELECT = `
  id, name, address, store_number, drawer_float, brand, district_id,
  district:district_id ( id, name, region_id, region:region_id ( id, name ) )
`;

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = not checked yet, null = signed out
  const [profile, setProfile] = useState(null);
  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [recoveryMode, setRecoveryMode] = useState(false);

  const loadProfileAndStores = useCallback(async (userId) => {
    setLoadingProfile(true);
    const [{ data: profileRow, error: profileError }, { data: storeRows, error: storeError }] = await Promise.all([
      supabase.from("profiles").select(PROFILE_SELECT).eq("id", userId).single(),
      supabase.from("locations").select(STORE_SELECT).order("store_number"),
    ]);

    if (profileError) {
      setAuthError(profileError.message);
      setProfile(null);
    } else {
      setProfile(profileRow);
    }

    if (!storeError && storeRows) {
      setStores(storeRows);
      setSelectedStoreId((current) => {
        if (current && storeRows.some((s) => s.id === current)) return current;
        if (profileRow?.location_id && storeRows.some((s) => s.id === profileRow.location_id)) {
          return profileRow.location_id;
        }
        return storeRows[0]?.id ?? null;
      });
    } else {
      setStores([]);
      setSelectedStoreId(null);
    }

    setLoadingProfile(false);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));

    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === "PASSWORD_RECOVERY") setRecoveryMode(true);
      setSession(newSession);
      if (!newSession) {
        setProfile(null);
        setStores([]);
        setSelectedStoreId(null);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session?.user?.id) {
      loadProfileAndStores(session.user.id);
    }
  }, [session?.user?.id, loadProfileAndStores]);

  const signIn = useCallback(async (email, password) => {
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setAuthError(error.message);
    return { error };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const requestPasswordReset = useCallback(async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    return { error };
  }, []);

  const updatePassword = useCallback(async (password) => {
    const { error } = await supabase.auth.updateUser({ password });
    return { error };
  }, []);

  const clearRecoveryMode = useCallback(() => setRecoveryMode(false), []);

  const currentStore = useMemo(
    () => stores.find((s) => s.id === selectedStoreId) ?? null,
    [stores, selectedStoreId]
  );

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    role: profile?.role ?? null,
    stores,
    currentStore,
    selectedStoreId,
    setSelectedStoreId,
    loadingSession: session === undefined,
    loadingProfile,
    authError,
    recoveryMode,
    signIn,
    signOut,
    requestPasswordReset,
    updatePassword,
    clearRecoveryMode,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
