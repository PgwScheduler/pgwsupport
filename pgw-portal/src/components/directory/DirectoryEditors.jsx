import React, { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Card, Field, GhostBtn, PrimaryBtn, inputCls } from "../ui.jsx";
import {
  DAYS, DEFAULT_SCOPE, ROLE_CATEGORIES, SCOPE_TYPES, formToHours, hoursFormErrors, hoursToForm,
} from "../../lib/directory.js";

// Admin-only editors. Hiding them from everyone else is tidiness; the
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
export function StoreEditModal({ store, onSave, onClose }) {
  const [f, setF] = useState({
    address_line1: store.address_line1 ?? "",
    address_line2: store.address_line2 ?? "",
    city: store.city ?? "",
    state: store.state ?? "",
    postal_code: store.postal_code ?? "",
    main_phone: store.main_phone ?? "",
    hours_note: store.hours_note ?? "",
  });
  // "Not entered" is its own state, distinct from "closed every day".
  const [hoursEntered, setHoursEntered] = useState(store.hours != null);
  const [hours, setHours] = useState(() => hoursToForm(store.hours));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [tried, setTried] = useState(false);

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const setDay = (day, patch) => setHours((h) => ({ ...h, [day]: { ...h[day], ...patch } }));
  const copyMonday = () => setHours((h) => ({ ...h, tue: { ...h.mon }, wed: { ...h.mon }, thu: { ...h.mon }, fri: { ...h.mon } }));

  const dayErrors = hoursEntered ? hoursFormErrors(hours) : {};
  const fieldErrors = {
    state: f.state.trim() && !/^[A-Za-z]{2}$/.test(f.state.trim()) ? "Two-letter state code" : null,
    postal_code: f.postal_code.trim() && !/^\d{5}(-\d{4})?$/.test(f.postal_code.trim()) ? "ZIP as 12345 or 12345-6789" : null,
  };
  const invalid = Object.keys(dayErrors).length > 0 || Object.values(fieldErrors).some(Boolean);

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    if (invalid) return;
    setSaving(true);
    setError(null);
    const { error } = await onSave({ ...f, hours: hoursEntered ? formToHours(hours) : null });
    setSaving(false);
    if (error) setError(error.message);
    else onClose();
  };

  return (
    <Modal title={`Edit #${store.store_number} · ${store.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
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
          {tried && (fieldErrors.state || fieldErrors.postal_code) && (
            <p className="text-xs text-danger sm:col-span-6">{[fieldErrors.state, fieldErrors.postal_code].filter(Boolean).join(" · ")}</p>
          )}
          <div className="sm:col-span-6">
            <Field label="Main phone">
              <input className={inputCls} value={f.main_phone} onChange={set("main_phone")} type="tel" />
            </Field>
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-content-secondary">Weekly hours</span>
            <label className="inline-flex items-center gap-2 text-sm text-content-primary">
              <input type="checkbox" className="accent-accent" checked={hoursEntered} onChange={(e) => setHoursEntered(e.target.checked)} />
              Hours entered
            </label>
          </div>
          {hoursEntered ? (
            <div className="space-y-1.5 rounded-lg border border-hairline p-3">
              {DAYS.map(([key, label]) => {
                const d = hours[key];
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2">
                    <span className="w-10 text-sm text-content-secondary">{label}</span>
                    <label className="inline-flex w-20 items-center gap-1.5 text-sm text-content-primary">
                      <input type="checkbox" className="accent-accent" checked={d.open} onChange={(e) => setDay(key, { open: e.target.checked })} />
                      Open
                    </label>
                    {d.open ? (
                      <>
                        <input type="time" className={inputCls + " !w-32"} value={d.from} onChange={(e) => setDay(key, { from: e.target.value })} aria-label={`${label} open`} />
                        <span className="text-content-muted">–</span>
                        <input type="time" className={inputCls + " !w-32"} value={d.to} onChange={(e) => setDay(key, { to: e.target.value })} aria-label={`${label} close`} />
                      </>
                    ) : (
                      <span className="text-sm text-content-muted">Closed</span>
                    )}
                    {tried && dayErrors[key] && <span className="text-xs text-danger">{dayErrors[key]}</span>}
                  </div>
                );
              })}
              <button type="button" onClick={copyMonday} className="mt-1 text-xs font-medium text-accent-text hover:underline">
                Copy Monday to Tue–Fri
              </button>
            </div>
          ) : (
            <p className="text-sm text-content-muted">Not entered — the store card says so rather than showing it closed.</p>
          )}
        </div>

        <Field label="Hours note">
          <input className={inputCls} value={f.hours_note} onChange={set("hours_note")} placeholder="e.g. Closed Sundays, seasonal hours" />
        </Field>

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

export function ContactEditModal({ contact, coverage, stores, districts, regions, onSave, onClose }) {
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
      <form onSubmit={submit} className="space-y-4">
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
