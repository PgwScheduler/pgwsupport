import React, { useEffect, useState } from "react";
import { Check, Copy, ShieldOff, UserPlus, X } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
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
  return <span className="text-sm text-content-muted">All 36 stores</span>;
}

const selectCls =
  "w-full rounded-md border border-hairline-strong bg-surface-overlay px-2.5 py-1.5 text-sm text-content-primary outline-none focus:border-hairline-strong";

function UserRow({ user, regions, districts, stores, isSelf, onSave, onRevoke }) {
  const [role, setRole] = useState(user.role || "store");
  const [scopeId, setScopeId] = useState(scopeIdOf(user));
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);

  // Resync local edit state whenever the server value changes underneath us
  // (after a successful save, a revoke, or someone else's edit refetching).
  const serverScopeId = scopeIdOf(user);
  useEffect(() => {
    setRole(user.role || "store");
    setScopeId(serverScopeId);
  }, [user.role, serverScopeId]);

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

  const revoke = async () => {
    if (!window.confirm(`Revoke access for ${user.email}? They'll immediately lose access everywhere. You can reassign a role later to restore it.`)) return;
    setRevoking(true);
    await onRevoke(user.id);
    setRevoking(false);
  };

  return (
    <tr className="border-b border-hairline last:border-0">
      <td className="px-4 py-3">
        <p className="text-sm font-medium text-content-primary">{user.full_name || "—"}</p>
        <p className="text-xs text-content-muted">{user.email}</p>
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
        <div className="flex items-center justify-end gap-2">
          <GhostBtn onClick={save} disabled={!canSave || saving}>
            <Check className="h-4 w-4" /> {saving ? "Saving…" : "Save"}
          </GhostBtn>
          {!isSelf && user.role && (
            <GhostBtn onClick={revoke} disabled={revoking} className="text-danger hover:text-danger" title="Revoke access">
              <ShieldOff className="h-4 w-4" /> {revoking ? "…" : "Revoke"}
            </GhostBtn>
          )}
        </div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <Card className="w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="pgw-display text-base font-bold text-content-primary">Add a user</h3>
          <button onClick={onClose} className="rounded-md p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary">
            <X className="h-5 w-5" />
          </button>
        </div>

        {result ? (
          <div className="space-y-3">
            <p className="text-sm text-content-secondary">
              Account created for <span className="font-medium text-content-primary">{email}</span>. Share this temporary
              password with them — it won't be shown again.
            </p>
            <div className="flex items-center gap-2 rounded-md border border-hairline-strong bg-surface-overlay px-3 py-2">
              <code className="flex-1 text-sm text-content-primary">{result.tempPassword}</code>
              <button
                onClick={() => navigator.clipboard.writeText(result.tempPassword)}
                className="text-content-secondary hover:text-content-primary"
                title="Copy"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-content-muted">
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
            {error && <p className="text-sm text-danger">{error}</p>}
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
  const { user: currentUser } = useAuth();
  const { users, regions, districts, stores, loading, error, updateAssignment, createUser, revokeAccess } = useUserManagement();
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
        <p className="mb-3 rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>
      )}

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-overlay text-left text-xs uppercase tracking-wide text-content-secondary">
            <tr>
              <th className="px-4 py-2.5">User</th>
              <th className="px-3 py-2.5">Role</th>
              <th className="px-3 py-2.5">Scope</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                regions={regions}
                districts={districts}
                stores={stores}
                isSelf={u.id === currentUser?.id}
                onSave={updateAssignment}
                onRevoke={revokeAccess}
              />
            ))}
            {!loading && users.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-content-muted">No users yet.</td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-content-muted">Loading…</td>
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
