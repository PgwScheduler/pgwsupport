// Announcements (migration 86). Who may post, who sees what and what
// counts as read are decided in SQL; these helpers only word things.

// Who sees the "New announcement" button. The database refuses anyone
// else (announcement_can_post), so this is tidiness, not security.
export const ANNOUNCEMENT_POSTER_ROLES = new Set(["master", "admin", "office", "district", "regional"]);
export const canPostAnnouncements = (role) => ANNOUNCEMENT_POSTER_ROLES.has(role);

// A short description of who an announcement went to, saved with it.
// Whole regions first (not for a district manager, whose list is only
// part of a region), then whole districts, then single stores.
export function audienceLabel(selectedIds, stores, role) {
  const sel = new Set(selectedIds);
  const list = (stores ?? []).filter((s) => !s.is_sandbox);
  if (!sel.size) return "";
  const picked = list.filter((s) => sel.has(s.id));
  if (["master", "admin", "office"].includes(role) && picked.length === list.length) return "All stores";

  const parts = [];
  const left = new Set(picked.map((s) => s.id));
  const groupBy = (keyOf) => {
    const m = new Map();
    for (const s of list) {
      const k = keyOf(s);
      if (!k) continue;
      if (!m.has(k.id)) m.set(k.id, { name: k.name, ids: [] });
      m.get(k.id).ids.push(s.id);
    }
    return [...m.values()];
  };
  const takeWhole = (groups, suffix) => {
    for (const g of groups.sort((a, b) => a.name.localeCompare(b.name))) {
      if (g.ids.length && g.ids.every((id) => left.has(id))) {
        parts.push(`${g.name} ${suffix}`);
        g.ids.forEach((id) => left.delete(id));
      }
    }
  };
  if (role !== "district") takeWhole(groupBy((s) => s.district?.region), "region");
  takeWhole(groupBy((s) => s.district), "district");

  const singles = picked.filter((s) => left.has(s.id))
    .sort((a, b) => (Number(a.store_number) || 0) - (Number(b.store_number) || 0))
    .map((s) => `#${s.store_number}`);
  if (singles.length > 6) parts.push(`${singles.slice(0, 6).join(", ")} +${singles.length - 6} more`);
  else if (singles.length) parts.push(singles.join(", "));
  return parts.join(" · ").slice(0, 200);
}

// announcement_receipts rows -> totals for the header line.
export function receiptTotals(rows) {
  const stores = (rows ?? []).filter((r) => r.location_id);
  const withLogin = stores.filter((r) => (r.logins ?? 0) > 0);
  return {
    stores: stores.length,
    storesRead: stores.filter((r) => (r.read_count ?? 0) > 0).length,
    storesNoLogin: stores.length - withLogin.length,
    logins: stores.reduce((a, r) => a + (r.logins ?? 0), 0),
    loginsRead: stores.reduce((a, r) => a + (r.read_count ?? 0), 0),
  };
}

// "Oct 9, 2:15 PM" in the viewer's own time.
export function whenLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
