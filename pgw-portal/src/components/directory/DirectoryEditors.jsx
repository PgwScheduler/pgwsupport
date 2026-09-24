import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Card, Field, GhostBtn, PrimaryBtn, inputCls } from "../ui.jsx";
import { DEFAULT_SCOPE, ROLE_CATEGORIES, SCOPE_TYPES } from "../../lib/directory.js";
import { Avatar } from "./DirectoryCards.jsx";

// Admin-only editors, apart from StorePhonesModal (district and up, on
// their own stores). Hiding them from everyone else is tidiness; the
// directory RPCs re-check the role and RLS is the real boundary.

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4 sm:items-center" onClick={onClose}>
      <Card className="my-4 w-full max-w-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="pgw-display text-base font-bold text-content-primary">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </Card>
    </div>
  );
}

function FormError({ message }) {
  if (!message) return null;
  return <p className="rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{message}</p>;
}

function Footer({ saving, onClose, label = "Save" }) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <GhostBtn type="button" onClick={onClose} disabled={saving}>
        Cancel
      </GhostBtn>
      <PrimaryBtn type="submit" disabled={saving}>
        {saving ? "Saving…" : label}
      </PrimaryBtn>
    </div>
  );
}

// ---------------------------------------------------------------------
// Store: address, phone, hours, hours note
// ---------------------------------------------------------------------
export function StoreEditModal({ store, serviceTypes = [], onSave, onClose }) {
  const [f, setF] = useState({
    address_line1: store.address_line1 ?? "",
    address_line2: store.address_line2 ?? "",
    city: store.city ?? "",
    state: store.state ?? "",
    postal_code: store.postal_code ?? "",
    main_phone: store.main_phone ?? "",
    marchex_phone: store.marchex_phone ?? "",
    store_email: store.store_email ?? "",
  });
  // The card carries services as code + label; the save takes ids.
  const offered = useMemo(() => new Set((store.services ?? []).map((x) => x.code)), [store]);
  const [services, setServices] = useState(() => serviceTypes.filter((t) => offered.has(t.code)).map((t) => t.id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [tried, setTried] = useState(false);

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const fieldErrors = {
    store_email: f.store_email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.store_email.trim())
      ? "That doesn't look like an email address" : null,
    state: f.state.trim() && !/^[A-Za-z]{2}$/.test(f.state.trim()) ? "Two-letter state code" : null,
    postal_code: f.postal_code.trim() && !/^\d{5}(-\d{4})?$/.test(f.postal_code.trim()) ? "ZIP as 12345 or 12345-6789" : null,
  };
  const invalid = Object.values(fieldErrors).some(Boolean);

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (invalid) return;
    setSaving(true);
    setError(null);
    const { error } = await onSave(f, services);
    setSaving(false);
    if (error) setError(error.message);
    else onClose();
  };

  return (
    <Modal title={`Edit #${store.store_number} · ${store.name}`} onClose={onClose}>
      {/* noValidate: the fields carry type="email"/"tel" for the right
          mobile keyboard, but the BROWSER's own validation would block
          submit before React saw it -- leaving the form silently stuck
          with no message. Our inline errors are the ones that speak. */}
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-6">
          <div className="sm:col-span-6">
            <Field label="Address line 1">
              <input className={inputCls} value={f.address_line1} onChange={set("address_line1")} />
            </Field>
          </div>
          <div className="sm:col-span-6">
            <Field label="Address line 2">
              <input className={inputCls} value={f.address_line2} onChange={set("address_line2")} />
            </Field>
          </div>
          <div className="sm:col-span-3">
            <Field label="City">
              <input className={inputCls} value={f.city} onChange={set("city")} />
            </Field>
          </div>
          <div className="sm:col-span-1">
            <Field label="State">
              <input className={inputCls} value={f.state} onChange={set("state")} maxLength={2} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="ZIP">
              <input className={inputCls} value={f.postal_code} onChange={set("postal_code")} inputMode="numeric" />
            </Field>
          </div>
          {tried && (fieldErrors.state || fieldErrors.postal_code || fieldErrors.store_email) && (
            <p className="text-xs text-danger sm:col-span-6">{[fieldErrors.state, fieldErrors.postal_code, fieldErrors.store_email].filter(Boolean).join(" · ")}</p>
          )}
          <div className="sm:col-span-3">
            <Field label="Main phone">
              <input className={inputCls} value={f.main_phone} onChange={set("main_phone")} type="tel" />
            </Field>
          </div>
          <div className="sm:col-span-3">
            <Field label="Marchex tracking number">
              <input className={inputCls} value={f.marchex_phone} onChange={set("marchex_phone")} type="tel" />
            </Field>
          </div>
          <div className="sm:col-span-6">
            <Field label="Store email">
              <input className={inputCls} value={f.store_email} onChange={set("store_email")} type="email" placeholder="The shop's own mailbox" />
            </Field>
          </div>
        </div>

        {serviceTypes.length > 0 && (
          <div>
            <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-content-secondary">Services offered</span>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {serviceTypes.map((t) => (
                <label key={t.id} className="inline-flex items-center gap-2 text-sm text-content-primary">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={services.includes(t.id)}
                    onChange={(e) =>
                      setServices((cur) => (e.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id)))
                    }
                  />
                  {t.label}
                </label>
              ))}
            </div>
          </div>
        )}

        <FormError message={error} />
        <Footer saving={saving} onClose={onClose} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Store phones only: the district-manager edit (migration 66). Address,
// email and services stay with the admin editor above.
// ---------------------------------------------------------------------
export function StorePhonesModal({ store, onSave, onClose }) {
  const [f, setF] = useState({
    main_phone: store.main_phone ?? "",
    marchex_phone: store.marchex_phone ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const { error } = await onSave(f);
    setSaving(false);
    if (error) setError(error.message);
    else onClose();
  };

  return (
    <Modal title={`Phone numbers · #${store.store_number} ${store.name}`} onClose={onClose}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Main phone">
            <input className={inputCls} value={f.main_phone} onChange={set("main_phone")} type="tel" />
          </Field>
          <Field label="Marchex tracking number">
            <input className={inputCls} value={f.marchex_phone} onChange={set("marchex_phone")} type="tel" />
          </Field>
        </div>
        <FormError message={error} />
        <Footer saving={saving} onClose={onClose} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------
// Contact: details + coverage. Coverage is the COMPLETE desired set;
// removing a row deactivates it server-side, nothing is deleted.
// ---------------------------------------------------------------------
const refKey = { store: "location_id", district: "district_id", region: "region_id" };

function coverageToRows(coverage) {
  return coverage.map((cv) => ({ scope_type: cv.scope_type, ref: cv[refKey[cv.scope_type]] ?? "" }));
}

export function ContactEditModal({ contact, coverage, stores, districts, regions, photoUrl, onUploadPhoto, onRemovePhoto, onSave, onClose }) {
  const isNew = !contact;
  const [f, setF] = useState({
    display_name: contact?.display_name ?? "",
    title: contact?.title ?? "",
    role_category: contact?.role_category ?? "store_manager",
    work_phone: contact?.work_phone ?? "",
    work_email: contact?.work_email ?? "",
    sort_order: contact?.sort_order ?? "",
  });
  const [rows, setRows] = useState(() => (isNew ? [{ scope_type: "store", ref: "" }] : coverageToRows(coverage)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [tried, setTried] = useState(false);

  const storeOptions = useMemo(
    () => [...stores].sort((a, b) => Number(a.store_number) - Number(b.store_number)),
    [stores]
  );
  const districtOptions = useMemo(() => [...districts].sort((a, b) => a.name.localeCompare(b.name)), [districts]);

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const onRole = (e) => {
    const role = e.target.value;
    setF((p) => ({ ...p, role_category: role }));
    // A single untouched coverage row follows the category's usual scope.
    setRows((r) => (r.length === 1 && !r[0].ref ? [{ scope_type: DEFAULT_SCOPE[role], ref: "" }] : r));
  };
  const setRow = (i, patch) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const problems = [];
  if (!f.display_name.trim()) problems.push("Name is required");
  if (!f.title.trim()) problems.push("Title is required");
  if (f.work_email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.work_email.trim())) problems.push("Work email doesn't look like an email address");
  if (f.sort_order !== "" && !Number.isInteger(Number(f.sort_order))) problems.push("Sort order must be a whole number");
  if (rows.some((r) => r.scope_type !== "company" && !r.ref)) problems.push("Pick a store, district or region for every coverage row");

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (problems.length) return;
    setSaving(true);
    setError(null);
    const payload = rows.map((r) => ({
      scope_type: r.scope_type,
      location_id: r.scope_type === "store" ? r.ref : null,
      district_id: r.scope_type === "district" ? r.ref : null,
      region_id: r.scope_type === "region" ? r.ref : null,
    }));
    const { error } = await onSave(f, payload);
    setSaving(false);
    if (error) setError(error.message);
    else onClose();
  };

  return (
    <Modal title={isNew ? "Add contact" : `Edit ${contact.display_name}`} onClose={onClose}>
      {/* noValidate -- see the note in StoreEditModal. */}
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputCls} value={f.display_name} onChange={set("display_name")} autoFocus={isNew} />
          </Field>
          <Field label="Title">
            <input className={inputCls} value={f.title} onChange={set("title")} placeholder="e.g. District Manager" />
          </Field>
          <Field label="Category">
            <select className={inputCls} value={f.role_category} onChange={onRole}>
              {ROLE_CATEGORIES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sort order (optional)">
            <input className={inputCls} value={f.sort_order} onChange={set("sort_order")} inputMode="numeric" placeholder="Lower lists first" />
          </Field>
          <Field label="Work phone">
            <input className={inputCls} value={f.work_phone} onChange={set("work_phone")} type="tel" />
          </Field>
          <Field label="Work email">
            <input className={inputCls} value={f.work_email} onChange={set("work_email")} type="email" />
          </Field>
        </div>
        <p className="text-xs text-content-muted">Work contact details only — never a personal cell number.</p>

        {/* A photo belongs to a contact that already exists, so it is
            offered once they have been added rather than held in the
            form and uploaded on save. */}
        {isNew ? (
          <p className="text-xs text-content-muted">A photo can be added once this person is saved.</p>
        ) : (
          <PhotoField name={f.display_name} url={photoUrl} onUpload={onUploadPhoto} onRemove={onRemovePhoto} />
        )}

        <div>
          <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-content-secondary">Covers</span>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  className={inputCls + " !w-36 flex-shrink-0"}
                  value={r.scope_type}
                  onChange={(e) => setRow(i, { scope_type: e.target.value, ref: "" })}
                  aria-label="Coverage type"
                >
                  {SCOPE_TYPES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {r.scope_type === "company" ? (
                  <span className="flex-1 text-sm text-content-secondary">Every store</span>
                ) : (
                  <select className={inputCls} value={r.ref} onChange={(e) => setRow(i, { ref: e.target.value })} aria-label="Coverage target">
                    <option value="">Choose…</option>
                    {r.scope_type === "store" &&
                      storeOptions.map((s) => (
                        <option key={s.location_id} value={s.location_id}>
                          #{s.store_number} — {s.name}
                        </option>
                      ))}
                    {r.scope_type === "district" &&
                      districtOptions.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    {r.scope_type === "region" &&
                      regions.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  className="rounded-md p-1.5 text-content-secondary hover:bg-surface-overlay hover:text-content-primary"
                  aria-label="Remove coverage"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setRows((r) => [...r, { scope_type: DEFAULT_SCOPE[f.role_category], ref: "" }])}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline"
          >
            <Plus className="h-3.5 w-3.5" /> Add coverage
          </button>
        </div>

        {tried && problems.length > 0 && <FormError message={problems.join(" · ")} />}
        <FormError message={error} />
        <Footer saving={saving} onClose={onClose} label={isNew ? "Add contact" : "Save"} />
      </form>
    </Modal>
  );
}

// A contact's photo. Uploading replaces whatever was there; removing
// deletes the file, which is why it asks first.
function PhotoField({ name, url, onUpload, onRemove }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef(null);

  const choose = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // choosing the same file twice still fires
    if (!file) return;
    setBusy(true);
    setError(null);
    const { error } = await onUpload(file);
    setBusy(false);
    if (error) setError(error.message);
  };

  const remove = async () => {
    setBusy(true);
    const { error } = await onRemove();
    setBusy(false);
    setConfirming(false);
    if (error) setError(error.message);
  };

  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium uppercase tracking-wide text-content-secondary">Photo</span>
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={name} url={url} size="h-16 w-16" />
        <div className="flex flex-wrap gap-2">
          <GhostBtn type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? "Working…" : url ? "Replace photo" : "Upload photo"}
          </GhostBtn>
          {url && !confirming && (
            <button type="button" onClick={() => setConfirming(true)} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-danger-border px-3 py-2 text-sm font-medium text-danger hover:bg-danger-tint">
              Remove
            </button>
          )}
          {url && confirming && (
            <span className="inline-flex items-center gap-2 text-sm">
              <span className="text-content-secondary">Delete this photo?</span>
              <button type="button" className="font-medium text-danger hover:underline" onClick={remove} disabled={busy}>Delete</button>
              <button type="button" className="text-content-muted hover:underline" onClick={() => setConfirming(false)}>Keep</button>
            </span>
          )}
        </div>
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={choose} />
      </div>
      <p className="text-xs text-content-muted">JPEG, PNG or WebP, up to 5 MB. Saved as soon as it is chosen.</p>
      <FormError message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------
// Service type catalogue. Admins extend it at runtime, which is why the
// directory never hardcodes a service list. A code is the stable key and
// the database refuses to change one; a label is display text and is
// freely editable. Types are deactivated, never deleted, because stores
// point at them.
// ---------------------------------------------------------------------
const toCode = (label) =>
  label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

export function ServiceTypesModal({ serviceTypes, onAdd, onUpdate, onClose }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const code = toCode(label);
  const clash = serviceTypes.some((t) => t.code === code);

  const add = async (e) => {
    e.preventDefault();
    if (!code) return setError("Enter a name.");
    if (clash) return setError("There is already a service type with that name.");
    setBusy(true);
    setError(null);
    const next = Math.max(0, ...serviceTypes.map((t) => t.sort_order ?? 0)) + 10;
    const { error } = await onAdd(code, label.trim(), next);
    setBusy(false);
    if (error) setError(error.message);
    else setLabel("");
  };

  return (
    <Modal title="Service types" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-content-muted">
          These are the services a store card can list. Renaming one changes it everywhere; its code stays as first created,
          so nothing that already points at it breaks. Turning one off hides it from every store without losing which stores offered it.
        </p>

        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {serviceTypes.map((t) => (
            <ServiceTypeRow key={t.id} t={t} onUpdate={onUpdate} />
          ))}
          {serviceTypes.length === 0 && <li className="px-3 py-4 text-sm text-content-muted">No service types yet.</li>}
        </ul>

        <form onSubmit={add} className="space-y-2 rounded-lg border border-hairline p-3">
          <Field label="Add a service type">
            <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Mount & Balance" />
          </Field>
          {code && <p className="text-xs text-content-muted">Code: <span className="text-content-secondary">{code}</span> — fixed once saved.</p>}
          <FormError message={error} />
          <div className="flex justify-end">
            <PrimaryBtn type="submit" disabled={busy || !code}>{busy ? "Adding…" : "Add"}</PrimaryBtn>
          </div>
        </form>

        <div className="flex justify-end">
          <GhostBtn type="button" onClick={onClose}>Done</GhostBtn>
        </div>
      </div>
    </Modal>
  );
}

function ServiceTypeRow({ t, onUpdate }) {
  const [label, setLabel] = useState(t.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setLabel(t.label), [t.label]);

  const save = async (patch) => {
    setBusy(true);
    const { error } = await onUpdate(t.id, patch);
    setBusy(false);
    setError(error ? error.message : null);
  };

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <input
        className={inputCls + " !w-52"}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label.trim() && label !== t.label && save({ label: label.trim() })}
        aria-label={`Name of ${t.label}`}
      />
      <span className="text-xs text-content-muted">{t.code}</span>
      <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-content-secondary">
        <input type="checkbox" className="accent-accent" checked={t.active} disabled={busy} onChange={(e) => save({ active: e.target.checked })} />
        Shown
      </label>
      {error && <span className="w-full text-xs text-danger">{error}</span>}
    </li>
  );
}
