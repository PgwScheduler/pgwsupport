import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

// Announcements (migration 86). One provider holds the CURRENT feed so
// the banner and the Announcements screen agree on what is unread, and
// opening one anywhere clears it everywhere. Everything goes through
// definer functions; the tables have no direct read or write path.

const AnnouncementsContext = createContext(null);
const REFRESH_MS = 5 * 60 * 1000;

export function AnnouncementsProvider({ children }) {
  const [current, setCurrent] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc("my_announcements", { p_include_past: false });
    if (e) { setError(e.message); return; }
    setError(null);
    setCurrent(data ?? []);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  // Opening = read (user decision). Recorded once per login; the first
  // time is kept. Updates the local list straight away.
  const markRead = useCallback(async (id) => {
    const { data, error: e } = await supabase.rpc("announcement_mark_read", { p_id: id });
    if (e) return { error: e.message };
    setCurrent((list) => list.map((a) => (a.id === id && !a.read_at ? { ...a, read_at: data } : a)));
    return { error: null };
  }, []);

  const value = useMemo(() => ({
    current, error, reload: load, markRead,
    unread: current.filter((a) => !a.read_at),
  }), [current, error, load, markRead]);

  return React.createElement(AnnouncementsContext.Provider, { value }, children);
}

export function useAnnouncementFeed() {
  const ctx = useContext(AnnouncementsContext);
  if (!ctx) throw new Error("useAnnouncementFeed needs <AnnouncementsProvider>");
  return ctx;
}

// The history list (current + expired + archived), for the screen.
export function useAnnouncementHistory() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: e } = await supabase.rpc("my_announcements", { p_include_past: true });
    setError(e ? e.message : null);
    setRows(data ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  return { rows, loading, error, reload: load };
}

const rpc = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args);
  return error ? { error: error.message } : { data, error: null };
};

export const announcementApi = {
  post: (a) => rpc("announcement_post", {
    p_title: a.title, p_body: a.body, p_priority: a.priority, p_location_ids: a.locationIds,
    p_audience_label: a.audienceLabel, p_training_id: a.trainingId || null,
    p_expires_at: a.expiresAt || null, p_email: !!a.email,
  }),
  update: (id, a) => rpc("announcement_update", {
    p_id: id, p_title: a.title, p_body: a.body, p_priority: a.priority,
    p_training_id: a.trainingId || null, p_expires_at: a.expiresAt || null,
  }),
  archive: (id, archived = true) => rpc("announcement_archive", { p_id: id, p_archived: archived }),
  receipts: (id) => rpc("announcement_receipts", { p_id: id }),
  canPost: () => rpc("announcement_can_post", {}),
  // Edge Function; a non-2xx reply puts the server's message on error.context.
  email: async (id) => {
    const { data, error } = await supabase.functions.invoke("announcement-email", { body: { announcement_id: id } });
    if (!error) return { data, error: null };
    let msg = error.message;
    try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep msg */ }
    return { error: msg };
  },
  // Which of these stores have a Directory email (for the "also email"
  // count). Reads only rows the caller may already see.
  storesWithEmail: async (ids) => {
    if (!ids.length) return new Set();
    const { data } = await supabase.from("locations").select("id, store_email").in("id", ids);
    return new Set((data ?? []).filter((r) => (r.store_email ?? "").trim()).map((r) => r.id));
  },
  trainingFiles: async () => {
    const { data, error } = await supabase.from("training").select("id, title").eq("item_type", "file").order("title");
    return error ? { error: error.message, data: [] } : { data: data ?? [], error: null };
  },
  openTraining: async (trainingId) => {
    const { data: row, error } = await supabase.from("training").select("storage_path").eq("id", trainingId).maybeSingle();
    if (error || !row?.storage_path) return { error: error?.message ?? "That training file is no longer there." };
    const { data, error: e2 } = await supabase.storage.from("training").createSignedUrl(row.storage_path, 60);
    if (e2) return { error: e2.message };
    window.open(data.signedUrl, "_blank");
    return { error: null };
  },
};
