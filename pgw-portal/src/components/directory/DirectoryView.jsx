import React, { useEffect, useMemo, useState } from "react";
import { BookUser, Search, Store, UserPlus, Users, Wrench } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
import { useDirectory } from "../../hooks/useDirectory.js";
import {
  ROLE_CATEGORIES, buildDirectoryIndex, groupStores, matchesPerson, matchesStore, sortContacts,
} from "../../lib/directory.js";
import { ConfirmDialog } from "../ConfirmDialog.jsx";
import { Empty, GhostBtn, PrimaryBtn, SectionHeader, inputCls } from "../ui.jsx";
import { PersonCard, StoreCard } from "./DirectoryCards.jsx";
import { ContactEditModal, ServiceTypesModal, StoreEditModal, StorePhonesModal } from "./DirectoryEditors.jsx";

// Company Directory. Unlike every other screen this one is NOT scoped to
// the header store or to the user's location scope: every signed-in
// user sees every store and every active contact (migration 55). It is
// therefore not keyed to currentStore in App.jsx either.

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-full border px-3 py-1 text-xs font-medium " +
        (active
          ? "border-accent bg-accent-tint text-accent-text"
          : "border-hairline-strong bg-surface-overlay text-content-secondary hover:bg-hairline-strong")
      }
    >
      {children}
    </button>
  );
}

function Tab({ active, onClick, icon: Icon, label, count }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium " +
        (active ? "border-accent text-content-primary" : "border-transparent text-content-secondary hover:text-content-primary")
      }
    >
      <Icon className="h-4 w-4" /> {label}
      <span className="text-xs text-content-muted">{count}</span>
    </button>
  );
}

export function DirectoryView() {
  const { role, stores: myStores } = useAuth();
  const isAdmin = role === "admin" || role === "master";
  // District managers and up may change phone numbers on the stores they
  // can see (migration 66); the RPC enforces the same scope.
  const phoneEditable = useMemo(
    () => (role === "district" || role === "regional" ? new Set(myStores.map((x) => x.id)) : null),
    [role, myStores]
  );
  const dir = useDirectory();
  const { stores, contacts, coverage, districts, regions, serviceTypes } = dir;

  const [tab, setTab] = useState("stores");
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState("all");
  const [category, setCategory] = useState("all");
  const [showInactive, setShowInactive] = useState(false);
  const [jump, setJump] = useState(null); // "store-<id>" | "person-<id>"
  const [flash, setFlash] = useState(null);
  const [editingStore, setEditingStore] = useState(null);
  const [editingPhones, setEditingPhones] = useState(null);
  const [editingContact, setEditingContact] = useState(null); // contact, or "new"
  const [editingServices, setEditingServices] = useState(false);
  const [toggling, setToggling] = useState(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [pageError, setPageError] = useState(null);

  const index = useMemo(
    () => buildDirectoryIndex({ stores, contacts, coverage, districts, regions }),
    [stores, contacts, coverage, districts, regions]
  );

  // Region chips list only regions that have a directory store.
  const regionChips = useMemo(() => {
    const ids = new Set(stores.map((s) => s.region_id).filter(Boolean));
    return regions.filter((r) => ids.has(r.id));
  }, [stores, regions]);

  const visibleStores = useMemo(
    () => stores.filter((s) => (region === "all" || s.region_id === region) && matchesStore(s, query)),
    [stores, region, query]
  );
  const groups = useMemo(() => groupStores(visibleStores), [visibleStores]);

  // Admins receive inactive rows too (RLS lets them, so they can
  // reactivate); everyone else only ever receives active ones.
  const activeContacts = useMemo(() => contacts.filter((c) => c.active), [contacts]);
  const inactiveCount = contacts.length - activeContacts.length;
  const visiblePeople = useMemo(() => {
    const pool = isAdmin && showInactive ? contacts : activeContacts;
    return sortContacts(
      pool.filter((c) => {
        if (category !== "all" && c.role_category !== category) return false;
        if (region !== "all") {
          const rs = index.regionsForContact(c.id);
          if (!rs.has("*") && !rs.has(region)) return false;
        }
        return matchesPerson(c, index.coverageItems(c.id).map((i) => i.text), query);
      })
    );
  }, [contacts, activeContacts, isAdmin, showInactive, category, region, query, index]);

  // Cross-links: clear the filters that could hide the target, switch
  // tab, then scroll to it once it has rendered.
  const jumpTo = (kind, id) => {
    setQuery("");
    setRegion("all");
    if (kind === "person") setCategory("all");
    setTab(kind === "store" ? "stores" : "people");
    setJump(`${kind}-${id}`);
  };
  useEffect(() => {
    if (!jump) return;
    const el = document.getElementById("dir-" + jump);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus({ preventScroll: true });
      setFlash(jump);
    }
    setJump(null);
  }, [jump, tab, visibleStores, visiblePeople]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  const confirmToggle = async () => {
    setToggleBusy(true);
    const { error } = await dir.setContactActive(toggling.id, !toggling.active);
    setToggleBusy(false);
    setToggling(null);
    setPageError(error ? error.message : null);
  };
  const toggleNow = async (c) => {
    // Reactivating is not destructive, so it needs no confirmation.
    if (!c.active) {
      const { error } = await dir.setContactActive(c.id, true);
      setPageError(error ? error.message : null);
    } else {
      setToggling(c);
    }
  };

  if (dir.loading) return <p className="text-sm text-content-secondary">Loading directory…</p>;
  if (dir.error) return <Empty icon={BookUser} title="The directory could not be loaded" hint={dir.error} />;

  const searchPlaceholder = tab === "stores" ? "Search store number, name or city" : "Search name, title or coverage";

  return (
    <div className="mx-auto max-w-7xl">
      <SectionHeader
        title="Directory"
        subtitle="Every store and who to call, company-wide."
        action={
          isAdmin ? (
            tab === "people" ? (
              <PrimaryBtn onClick={() => setEditingContact("new")}>
                <UserPlus className="h-4 w-4" /> Add contact
              </PrimaryBtn>
            ) : (
              <GhostBtn onClick={() => setEditingServices(true)}>
                <Wrench className="h-4 w-4" /> Service types
              </GhostBtn>
            )
          ) : null
        }
      />

      <div role="tablist" className="mb-4 flex gap-1 border-b border-hairline">
        <Tab active={tab === "stores"} onClick={() => setTab("stores")} icon={Store} label="Stores" count={stores.length} />
        <Tab active={tab === "people"} onClick={() => setTab("people")} icon={Users} label="People" count={activeContacts.length} />
      </div>

      <div className="mb-3 relative">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-content-muted" />
        <input
          type="search"
          className={inputCls + " pl-9"}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the directory"
        />
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Chip active={region === "all"} onClick={() => setRegion("all")}>
          All regions
        </Chip>
        {regionChips.map((r) => (
          <Chip key={r.id} active={region === r.id} onClick={() => setRegion(r.id)}>
            {r.name}
          </Chip>
        ))}
      </div>
      {tab === "people" && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Chip active={category === "all"} onClick={() => setCategory("all")}>
            Everyone
          </Chip>
          {ROLE_CATEGORIES.map((c) => (
            <Chip key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
              {c.plural}
            </Chip>
          ))}
          {isAdmin && inactiveCount > 0 && (
            <label className="ml-auto inline-flex items-center gap-2 text-xs text-content-secondary">
              <input type="checkbox" className="accent-accent" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show deactivated ({inactiveCount})
            </label>
          )}
        </div>
      )}

      {pageError && (
        <p className="mb-3 rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{pageError}</p>
      )}

      <div className="mt-4">
        {tab === "stores" &&
          (groups.length === 0 ? (
            <Empty icon={Store} title="No stores match" hint="Try a different search or region." />
          ) : (
            <div className="space-y-8">
              {groups.map((g) => (
                <section key={g.regionId ?? "none"}>
                  <h3 className="pgw-display mb-3 text-base font-bold text-content-primary">{g.regionName}</h3>
                  <div className="space-y-5">
                    {g.districts.map((d) => (
                      <div key={d.districtId ?? "none"}>
                        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-content-secondary">
                          {d.districtName} <span className="text-content-muted">· {d.stores.length}</span>
                        </h4>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {d.stores.map((s) => (
                            <StoreCard
                              key={s.location_id}
                              store={s}
                              managers={index.storeManagersByStore.get(s.location_id)}
                              dms={index.dmsByDistrict.get(s.district_id)}
                              onJumpPerson={(id) => jumpTo("person", id)}
                              onEdit={
                                isAdmin ? () => setEditingStore(s)
                                : phoneEditable?.has(s.location_id) ? () => setEditingPhones(s)
                                : null
                              }
                              flash={flash === "store-" + s.location_id}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ))}

        {tab === "people" &&
          (visiblePeople.length === 0 ? (
            <Empty
              icon={Users}
              title={contacts.length === 0 ? "No contacts yet" : "No one matches"}
              hint={contacts.length === 0 ? (isAdmin ? "Add the first contact with the button above." : "Contacts will appear here once an admin adds them.") : "Try a different search, region or category."}
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {visiblePeople.map((c) => (
                <PersonCard
                  key={c.id}
                  contact={c}
                  coverage={index.coverageItems(c.id)}
                  photoUrl={dir.photoUrls[c.id]}
                  onJumpStore={(id) => jumpTo("store", id)}
                  onEdit={isAdmin ? () => setEditingContact(c) : null}
                  onToggleActive={isAdmin ? () => toggleNow(c) : null}
                  flash={flash === "person-" + c.id}
                />
              ))}
            </div>
          ))}
      </div>

      {editingStore && (
        <StoreEditModal
          store={editingStore}
          serviceTypes={serviceTypes.filter((t) => t.active)}
          onSave={async (f, serviceIds) => {
            const r = await dir.updateStore(editingStore.location_id, f);
            if (r.error) return r;
            return dir.setStoreServices(editingStore.location_id, serviceIds);
          }}
          onClose={() => setEditingStore(null)}
        />
      )}
      {editingPhones && (
        <StorePhonesModal
          store={editingPhones}
          onSave={(f) => dir.updateStorePhones(editingPhones.location_id, f)}
          onClose={() => setEditingPhones(null)}
        />
      )}
      {editingServices && (
        <ServiceTypesModal
          serviceTypes={serviceTypes}
          onAdd={dir.addServiceType}
          onUpdate={dir.updateServiceType}
          onClose={() => setEditingServices(false)}
        />
      )}
      {editingContact && (
        <ContactEditModal
          contact={editingContact === "new" ? null : editingContact}
          coverage={editingContact === "new" ? [] : index.coverageByContact.get(editingContact.id) ?? []}
          stores={stores}
          districts={districts}
          regions={regions}
          onSave={(f, cov) => dir.saveContact(editingContact === "new" ? null : editingContact.id, f, cov)}
          photoUrl={editingContact === "new" ? null : dir.photoUrls[editingContact.id]}
          onUploadPhoto={(file) => dir.uploadPhoto(editingContact, file)}
          onRemovePhoto={() => dir.removePhoto(editingContact)}
          onClose={() => setEditingContact(null)}
        />
      )}
      {toggling && (
        <ConfirmDialog
          title={`Deactivate ${toggling.display_name}?`}
          message="They disappear from the directory for everyone. Their coverage is kept, so reactivating them later restores them exactly as they were."
          confirmLabel="Deactivate"
          busyLabel="Deactivating…"
          busy={toggleBusy}
          onConfirm={confirmToggle}
          onClose={() => setToggling(null)}
        />
      )}
    </div>
  );
}
