import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

// Company Directory data. Company-wide for every role -- see migration 55.
//
// Deliberately touches ONLY directory sources: directory_stores() (the
// whitelisted SECURITY DEFINER read of locations), directory_contacts,
// directory_contact_coverage, and districts/regions (readable by every
// signed-in user since migration 2). It never reads `locations`,
// `employees` or `employee_pay_rates`, and never selects
// directory_contacts.employee_id -- that link is for admins in SQL only.
//
// Writes go through the three directory RPCs, which re-check the role
// and raise on refusal, so a denied save can never look like success.
const CONTACT_SELECT = "id, display_name, title, role_category, work_phone, work_email, active, sort_order";
const COVERAGE_SELECT = "id, contact_id, scope_type, location_id, district_id, region_id";

export function useDirectory() {
  const [data, setData] = useState({ stores: [], contacts: [], coverage: [], districts: [], regions: [], serviceTypes: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    const [s, c, cv, d, r, st] = await Promise.all([
      supabase.rpc("directory_stores"),
      supabase.from("directory_contacts").select(CONTACT_SELECT),
      supabase.from("directory_contact_coverage").select(COVERAGE_SELECT).eq("active", true),
      supabase.from("districts").select("id, name, region_id"),
      supabase.from("regions").select("id, name").order("name"),
      // RLS hands non-admins the active catalogue only; an admin also
      // sees deactivated types, to bring one back.
      supabase.from("service_types").select("id, code, label, sort_order, active").order("sort_order").order("label"),
    ]);
    const firstError = [s, c, cv, d, r, st].find((x) => x.error)?.error;
    if (firstError) {
      setError(firstError.message);
    } else {
      setData({
        stores: s.data ?? [], contacts: c.data ?? [], coverage: cv.data ?? [],
        districts: d.data ?? [], regions: r.data ?? [], serviceTypes: st.data ?? [],
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateStore = useCallback(
    async (locationId, f) => {
      const { error } = await supabase.rpc("directory_update_store", {
        p_location_id: locationId,
        p_address_line1: f.address_line1,
        p_address_line2: f.address_line2,
        p_city: f.city,
        p_state: f.state,
        p_postal_code: f.postal_code,
        p_main_phone: f.main_phone,
        p_marchex_phone: f.marchex_phone,
        p_store_email: f.store_email,
      });
      if (!error) await load();
      return { error };
    },
    [load]
  );

  const saveContact = useCallback(
    async (id, f, coverage) => {
      const { data: savedId, error } = await supabase.rpc("directory_save_contact", {
        p_id: id ?? null,
        p_display_name: f.display_name,
        p_title: f.title,
        p_role_category: f.role_category,
        p_work_phone: f.work_phone,
        p_work_email: f.work_email,
        p_sort_order: f.sort_order === "" || f.sort_order == null ? null : Number(f.sort_order),
        p_coverage: coverage,
      });
      if (!error) await load();
      return { id: savedId, error };
    },
    [load]
  );

  // One call replaces a store's whole service list, so it is never
  // briefly half-set while someone is reading the card.
  const setStoreServices = useCallback(
    async (locationId, serviceTypeIds) => {
      const { error } = await supabase.rpc("directory_set_store_services", {
        p_location_id: locationId,
        p_service_type_ids: serviceTypeIds,
      });
      if (!error) await load();
      return { error };
    },
    [load]
  );

  // Catalogue upkeep. A code is immutable once created (the database
  // enforces it) and a type is deactivated, never deleted, because
  // stores point at it.
  const addServiceType = useCallback(
    async (code, label, sortOrder) => {
      const { error } = await supabase.from("service_types")
        .insert({ code, label, sort_order: sortOrder ?? 100 });
      if (!error) await load();
      return { error };
    },
    [load]
  );

  const updateServiceType = useCallback(
    async (id, patch) => {
      const { data: rows, error } = await supabase.from("service_types").update(patch).eq("id", id).select();
      const refused = !error && (!rows || rows.length === 0);
      const out = refused ? { message: "That change was not saved (not permitted)." } : error;
      if (!out) await load();
      return { error: out };
    },
    [load]
  );

  const setContactActive = useCallback(
    async (id, active) => {
      const { error } = await supabase.rpc("directory_set_contact_active", { p_id: id, p_active: active });
      if (!error) await load();
      return { error };
    },
    [load]
  );

  return { ...data, loading, error, reload: load, updateStore, saveContact, setContactActive, setStoreServices, addServiceType, updateServiceType };
}
