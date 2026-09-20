// Company Directory: the pure logic behind the Stores and People tabs.
// No React and no Supabase here, so every rule below is testable offline
// (see directory.test.mjs).
//
// Store manager and DM are DERIVED from coverage rows, never stored on
// the store: a store's manager is an active `store_manager` contact with
// an active store-scope row for that store; its DM is an active
// `district_manager` contact with an active district-scope row for the
// store's district.

export const ROLE_CATEGORIES = [
  { key: "regional_director", label: "Regional director", plural: "Regional directors" },
  { key: "district_manager", label: "District manager", plural: "District managers" },
  { key: "store_manager", label: "Store manager", plural: "Store managers" },
  { key: "office", label: "Office", plural: "Office" },
];
const ROLE_RANK = Object.fromEntries(ROLE_CATEGORIES.map((r, i) => [r.key, i]));
export const roleLabel = (key) => ROLE_CATEGORIES.find((r) => r.key === key)?.label ?? key;

export const SCOPE_TYPES = [
  { key: "store", label: "Store" },
  { key: "district", label: "District" },
  { key: "region", label: "Region" },
  { key: "company", label: "All stores" },
];

// The scope a new contact's first coverage row starts at, by category.
export const DEFAULT_SCOPE = {
  store_manager: "store",
  district_manager: "district",
  regional_director: "region",
  office: "company",
};

export const BRAND_LABEL = { midas: "Midas", speedee: "SpeeDee" };

// A dialable tel: href. Anything after an "x"/"ext" is an extension and
// is dropped (a phone cannot dial it reliably); ten digits get +1.
export function telHref(phone) {
  if (!phone) return null;
  const main = String(phone).split(/\s*(?:x|ext\.?|extension)\s*\d/i)[0];
  const digits = main.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`;
  return `tel:${digits}`;
}

export const mailHref = (email) => (email ? `mailto:${email}` : null);

// Numbers are stored as the source holds them -- BDC's seed supplies ten
// digits with no punctuation -- and are formatted here, once, for every
// screen. Anything that is not a plain 10- or 11-digit number is shown
// exactly as entered rather than mangled into a shape it is not.
export function formatPhone(phone) {
  if (!phone) return "";
  const s = String(phone).trim();
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s;
}

// "Midas Two Notch" -> "Two Notch". The brand is shown as a badge, so
// the plain-language coverage line reads "Store 3935 Two Notch".
export function storeShortName(name) {
  return String(name ?? "").replace(/^(midas|spee\s?dee)\s+/i, "").trim() || String(name ?? "");
}

export function formatAddress(s) {
  const cityLine = [s.city, [s.state, s.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [s.address_line1, s.address_line2, cityLine].filter(Boolean);
}

const numCompare = (a, b) => {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
};

// Region -> district -> stores, each level sorted; stores by number.
// A store with no district lands in an "Unassigned" group at the end.
export function groupStores(stores) {
  const regions = new Map();
  for (const s of stores) {
    const rKey = s.region_id ?? "~none";
    if (!regions.has(rKey)) regions.set(rKey, { regionId: s.region_id, regionName: s.region_name ?? "Unassigned", districts: new Map() });
    const r = regions.get(rKey);
    const dKey = s.district_id ?? "~none";
    if (!r.districts.has(dKey)) r.districts.set(dKey, { districtId: s.district_id, districtName: s.district_name ?? "Unassigned", stores: [] });
    r.districts.get(dKey).stores.push(s);
  }
  return [...regions.values()]
    .sort((a, b) => (a.regionId == null) - (b.regionId == null) || a.regionName.localeCompare(b.regionName))
    .map((r) => ({
      regionId: r.regionId,
      regionName: r.regionName,
      districts: [...r.districts.values()]
        .sort((a, b) => (a.districtId == null) - (b.districtId == null) || a.districtName.localeCompare(b.districtName))
        .map((d) => ({ ...d, stores: [...d.stores].sort((a, b) => numCompare(a.store_number, b.store_number)) })),
    }));
}

export function sortContacts(list) {
  return [...list].sort(
    (a, b) =>
      (ROLE_RANK[a.role_category] ?? 99) - (ROLE_RANK[b.role_category] ?? 99) ||
      (a.sort_order == null) - (b.sort_order == null) ||
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      a.display_name.localeCompare(b.display_name)
  );
}

// Everything the two tabs need to cross-reference, built once per load.
// Only ACTIVE contacts and ACTIVE coverage count toward assignments.
export function buildDirectoryIndex({ stores, contacts, coverage, districts, regions }) {
  const storesById = new Map(stores.map((s) => [s.location_id, s]));
  const districtsById = new Map(districts.map((d) => [d.id, d]));
  const regionsById = new Map(regions.map((r) => [r.id, r]));
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  const coverageByContact = new Map();
  const storeManagersByStore = new Map();
  const dmsByDistrict = new Map();
  const push = (map, key, v) => {
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(v)) map.get(key).push(v);
  };

  for (const cv of coverage) {
    if (cv.active === false) continue;
    push(coverageByContact, cv.contact_id, cv);
    const c = contactsById.get(cv.contact_id);
    if (!c || !c.active) continue;
    if (cv.scope_type === "store" && c.role_category === "store_manager") push(storeManagersByStore, cv.location_id, c);
    if (cv.scope_type === "district" && c.role_category === "district_manager") push(dmsByDistrict, cv.district_id, c);
  }
  for (const m of [storeManagersByStore, dmsByDistrict]) {
    for (const [k, v] of m) m.set(k, sortContacts(v));
  }

  const regionOfDistrict = (id) => districtsById.get(id)?.region_id ?? null;

  // The regions a contact's coverage touches; "*" = company-wide, which
  // matches every region filter.
  const regionsForContact = (contactId) => {
    const out = new Set();
    for (const cv of coverageByContact.get(contactId) ?? []) {
      if (cv.scope_type === "company") out.add("*");
      else if (cv.scope_type === "region") out.add(cv.region_id);
      else if (cv.scope_type === "district") out.add(regionOfDistrict(cv.district_id));
      else if (cv.scope_type === "store") out.add(storesById.get(cv.location_id)?.region_id ?? null);
    }
    out.delete(null);
    return out;
  };

  // Plain-language coverage, one item per row. Store items carry the id
  // so the People tab can link back to the store card.
  const coverageItems = (contactId) =>
    (coverageByContact.get(contactId) ?? [])
      .map((cv) => {
        if (cv.scope_type === "company") return { key: cv.id, rank: 0, text: "All stores" };
        if (cv.scope_type === "region") return { key: cv.id, rank: 1, text: `${regionsById.get(cv.region_id)?.name ?? "Unknown"} region` };
        if (cv.scope_type === "district") return { key: cv.id, rank: 2, text: `${districtsById.get(cv.district_id)?.name ?? "Unknown"} district` };
        const s = storesById.get(cv.location_id);
        if (!s) return { key: cv.id, rank: 3, text: "Unlisted store" };
        return { key: cv.id, rank: 3, text: `Store ${s.store_number} ${storeShortName(s.name)}`, storeId: s.location_id, sortNum: s.store_number };
      })
      .sort((a, b) => a.rank - b.rank || numCompare(a.sortNum, b.sortNum) || a.text.localeCompare(b.text));

  return { storesById, districtsById, regionsById, coverageByContact, storeManagersByStore, dmsByDistrict, regionsForContact, coverageItems };
}

// Search: every whitespace-separated term must appear somewhere in the
// record's haystack, case-insensitively. An empty query matches all.
const terms = (q) => String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
const hit = (hay, q) => {
  const t = terms(q);
  if (!t.length) return true;
  const h = hay.filter(Boolean).join(" ").toLowerCase();
  return t.every((x) => h.includes(x));
};

// Services are searchable too: "alignments" finds every store that
// offers them, which is the question the list is usually opened for.
export const matchesStore = (s, q) =>
  hit([s.store_number, `#${s.store_number}`, s.name, s.city, s.store_email, ...(s.services ?? []).map((x) => x.label)], q);

// Coverage text is searchable too, so "Columbia East" finds its DM and
// "3935" finds the store's manager.
export const matchesPerson = (c, coverageText, q) => hit([c.display_name, c.title, ...coverageText], q);
