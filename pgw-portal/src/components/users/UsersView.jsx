import React, { useState } from "react";
import { Check, Copy, UserPlus, X } from "lucide-react";
import { useUserManagement } from "../../hooks/useUserManagement.js";
import { ROLE_LABELS } from "../Shell.jsx";
import { Card, Field, GhostBtn, PrimaryBtn, SectionHeader, inputCls } from "../ui.jsx";

const ROLE_OPTIONS = ["store", "district", "regional", "admin", "master"];

function scopeIdOf(user) {
  return user.location_id || user.district_id || user.region_id || "";
}

function ScopeSelect({ role, value, onChange, regions, districts, stores }) {
  if (role === "store") {
    return (
      <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a store…</option>
        {stores.map((s) => (
          <option key={s.id} value={s.id}>#{s.store_number} — {s.name}</option>
        ))}
      </select>
    );
  }
  if (role === "district") {
    return (
      <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a district…</option>
        {districts.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>
    );
  }
  if (role === "regional") {
    return (
      <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a region…</option>
        {regions.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </select>
    );
  }
  return <span className="text-sm text-slate-500">All 36 stores</span>;
}

const selectCls =
  "w-full rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-slate-500";

function UserRow({ user, regions, districts, stores, onSave }) {
  const [role, setRole] = useState(user.role || "store");
  const [scopeId, setScopeId] = useState(scopeIdOf(user));
  const [saving, setSaving] = useState(false);

  const needsScope = role === "store" || role === "district" || role === "regional";
  const dirty = role !== (user.role || "") || scopeId !== scopeIdOf(user);
  const canSave = dirty && (!needsScope || scopeId);

  const onRoleChange = (r) => {
    setRole(r);
    setScopeId(""); // switching roles always clears the old scope — never silently keep a mismatched one
  };

  const save = async () => {
    setSaving(true);
    await onSave(user.id, role, needsScope ? scopeId : null);
    setSaving(false);
  };

  return (
    <tr className="border-b border-slate-800 last:border-0">
      <td className="px-4 py-3">
        <p className="text-sm font-medium text-white">{user.full_name || "—"}</p>
        <p className="text-xs text-slate-500">{user.email}</p>
      </td>
      <td className="px-3 py-3">
        <select className={selectCls} value={role} onChange={(e) => onRoleChange(e.target.value)}>
          {ROLE_OPTIONS.map((r) => (
            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-3">
        <ScopeSelect role={role} value={scopeId} onChange={setScopeId} regions={regions} districts={districts} stores={stores} />
      </td>
      <td className="px-3 py-3 text-right">
        <GhostBtn onClick={save} disabled={!canSave || saving}>
          <Check className="h-4 w-4" /> {saving ? "Saving…" : "Save"}
        </GhostBtn>
      </td>
    </tr>
  );
}

function InviteModal({ regions, districts, stores, onCreate, onClose }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("store");
  const [scopeId, setScopeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { tempPassword }

  const needsScope = role === "store" || role === "district" || role === "regional";
  const canSubmit = email.trim() && fullName.trim() && (!needsScope || scopeId);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const { error, tempPassword } = await onCreate({
      email: email.trim(),
      full_name: fullName.trim(),
      role,
      scopeId: needsScope ? scopeId : null,
    });
    setSubmitting(false);
    if (error) setError(error.message);
    else setResult({ tempPassword });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="pgw-display text-base font-bold text-white">Add a user</h3>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {result ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              Account created for <span className="font-medium text-white">{email}</span>. Share this temporary
              password with them — it won't be shown again.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-2">
              <code className="flex-1 text-sm text-white">{result.tempPassword}</code>
              <button
                onClick={() => navigator.clipboard.writeText(result.tempPassword)}
                className="text-slate-400 hover:text-white"
                title="Copy"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500">
              If email confirmations are turned on for this Supabase project, they'll also need to confirm their
              email before signing in.
            </p>
            <PrimaryBtn onClick={onClose} className="w-full justify-center">Done</PrimaryBtn>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Email">
              <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@pgwus.com" />
            </Field>
            <Field label="Full name">
              <input className={inputCls} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jane Smith" />
            </Field>
            <Field label="Role">
              <select className={selectCls} value={role} onChange={(e) => { setRole(e.target.value); setScopeId(""); }}>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </Field>
            {needsScope && (
              <Field label={role === "store" ? "Store" : role === "district" ? "District" : "Region"}>
                <ScopeSelect role={role} value={scopeId} onChange={setScopeId} regions={regions} districts={districts} stores={stores} />
              </Field>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}
            <PrimaryBtn onClick={submit} disabled={!canSubmit || submitting} className="w-full justify-center">
              {submitting ? "Creating…" : "Create login"}
            </PrimaryBtn>
          </div>
        )}
      </Card>
    </div>
  );
}

export function UsersView() {
  const { users, regions, districts, stores, loading, error, updateAssignment, createUser } = useUserManagement();
  const [inviting, setInviting] = useState(false);

  return (
    <div>
      <SectionHeader
        title="Users"
        subtitle="Every login, its role, and what it can see"
        action={
          <PrimaryBtn onClick={() => setInviting(true)}>
            <UserPlus className="h-4 w-4" /> Add user
          </PrimaryBtn>
        }
      />

      {error && (
        <p className="mb-3 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/60 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-2.5">User</th>
              <th className="px-3 py-2.5">Role</th>
              <th className="px-3 py-2.5">Scope</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRow key={u.id} user={u} regions={regions} districts={districts} stores={stores} onSave={updateAssignment} />
            ))}
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-500">No users yet.</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-500">Loading…</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {inviting && (
        <InviteModal
          regions={regions}
          districts={districts}
          stores={stores}
          onCreate={createUser}
          onClose={() => setInviting(false)}
        />
      )}
    </div>
  );
}
