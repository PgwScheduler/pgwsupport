import React, { useEffect, useMemo, useState } from "react";
import { Megaphone, Plus, AlertTriangle, Users, Pencil, Archive, ArchiveRestore, Mail, GraduationCap } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
import { useAnnouncementFeed, useAnnouncementHistory, announcementApi } from "../../hooks/useAnnouncements.js";
import { audienceLabel, receiptTotals, canPostAnnouncements, whenLabel } from "../../lib/announcements.js";
import { StoreMultiSelect } from "../reports/StoreMultiSelect.jsx";
import { AnnouncementDetail } from "./AnnouncementBanner.jsx";
import { Card, Empty, Field, GhostBtn, PrimaryBtn, SectionHeader, inputCls } from "../ui.jsx";

// Announcements (migration 86): the bulletin board. Everyone sees what
// was sent to their stores; master/admin/office post to any store, DMs
// and RMs to their own. Opening one counts as read.

function Notice({ tone = "info", children }) {
  const cls = tone === "error" ? "border-danger-border bg-danger-tint text-danger"
    : tone === "ok" ? "border-success-border bg-success-tint text-success"
    : "border-hairline bg-surface-page text-content-secondary";
  return <div className={"rounded-md border px-3 py-2 text-sm " + cls}>{children}</div>;
}

// Local date input value -> end of that day, as an ISO timestamp.
const endOfDayIso = (d) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);
const dateInput = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function useTrainingFiles(enabled) {
  const [files, setFiles] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    announcementApi.trainingFiles().then((r) => setFiles(r.data));
  }, [enabled]);
  return files;
}

// Title / body / priority / training / expiry -- shared by new and edit.
function MessageFields({ v, set, trainingFiles }) {
  return (
    <div className="space-y-3">
      <Field label="Title">
        <input className={inputCls} maxLength={200} value={v.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label="Message">
        <textarea className={inputCls + " min-h-[140px]"} maxLength={10000} value={v.body} onChange={(e) => set({ body: e.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Priority">
          <select className={inputCls} value={v.priority} onChange={(e) => set({ priority: e.target.value })}>
            <option value="normal">Normal</option>
            <option value="important">Important (red banner)</option>
          </select>
        </Field>
        <Field label="Training link (optional)">
          <select className={inputCls} value={v.trainingId ?? ""} onChange={(e) => set({ trainingId: e.target.value || null })}>
            <option value="">None</option>
            {trainingFiles.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
          </select>
        </Field>
        <Field label="Stop showing after (optional)">
          <input type="date" className={inputCls} value={v.expiresDate ?? ""} onChange={(e) => set({ expiresDate: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}

function Composer({ stores, role, onDone, onCancel }) {
  const trainingFiles = useTrainingFiles(true);
  const [v, setV] = useState({ title: "", body: "", priority: "normal", trainingId: null, expiresDate: "", email: false });
  const [ids, setIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (p) => setV((cur) => ({ ...cur, ...p }));
  const label = audienceLabel(ids, stores, role);
  const [emailIds, setEmailIds] = useState(new Set());
  useEffect(() => { announcementApi.storesWithEmail(stores.map((s) => s.id)).then(setEmailIds); }, [stores]);
  const withEmail = ids.filter((id) => emailIds.has(id)).length;

  const post = async () => {
    if (!v.title.trim()) { setMsg({ tone: "error", text: "Give it a title." }); return; }
    if (!ids.length) { setMsg({ tone: "error", text: "Pick at least one store." }); return; }
    setBusy(true); setMsg(null);
    const r = await announcementApi.post({ ...v, locationIds: ids, audienceLabel: label, expiresAt: endOfDayIso(v.expiresDate) });
    if (r.error) { setBusy(false); setMsg({ tone: "error", text: r.error }); return; }
    let text = `Posted to ${label || `${ids.length} stores`}.`;
    if (v.email) {
      const e = await announcementApi.email(r.data);
      text += e.error ? ` The email didn't go out: ${e.error}` : ` Emailed ${e.data.sent} store${e.data.sent === 1 ? "" : "s"}`
        + (e.data.no_email?.length ? `; ${e.data.no_email.length} have no store email in the Directory` : "")
        + (e.data.failed?.length ? `; ${e.data.failed.length} failed` : "") + ".";
    }
    setBusy(false);
    onDone(text);
  };

  return (
    <Card className="space-y-4 p-4">
      <h3 className="pgw-display text-base font-bold text-content-primary">New announcement</h3>
      <MessageFields v={v} set={set} trainingFiles={trainingFiles} />
      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-content-secondary">
          Send to {label ? <span className="normal-case text-content-primary">— {label}</span> : ""}
        </p>
        <div className="h-72 overflow-hidden rounded-md border border-hairline">
          <StoreMultiSelect stores={stores} selected={ids} onChange={setIds} />
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm text-content-secondary">
        <input type="checkbox" className="mt-1" checked={v.email} onChange={(e) => set({ email: e.target.checked })} />
        <span>
          Also email it to each store's Directory email.
          {ids.length > 0 && <span className="text-content-muted"> {withEmail} of {ids.length} picked stores have one.</span>}
        </span>
      </label>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="flex justify-end gap-2">
        <GhostBtn onClick={onCancel} disabled={busy}>Cancel</GhostBtn>
        <PrimaryBtn onClick={post} disabled={busy}>{busy ? (v.email ? "Posting and emailing…" : "Posting…") : "Post"}</PrimaryBtn>
      </div>
    </Card>
  );
}

function Receipts({ id }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    announcementApi.receipts(id).then((r) => (r.error ? setErr(r.error) : setRows(r.data)));
  }, [id]);
  if (err) return <Notice tone="error">{err}</Notice>;
  if (!rows) return <p className="text-sm text-content-muted">Loading receipts…</p>;
  const t = receiptTotals(rows);
  const stores = rows.filter((r) => r.location_id).sort((a, b) => (a.read_count > 0) - (b.read_count > 0) || (Number(a.store_number) - Number(b.store_number)));
  const mgr = rows.find((r) => !r.location_id);
  const names = (list) => list.map((x) => `${x.name} (${whenLabel(x.read_at)})`).join(", ");
  return (
    <div className="space-y-2">
      <p className="text-sm text-content-primary">
        Opened at <strong>{t.storesRead} of {t.stores}</strong> stores · {t.loginsRead} of {t.logins} store logins
        {t.storesNoLogin > 0 && <span className="text-warning"> · {t.storesNoLogin} store{t.storesNoLogin === 1 ? " has" : "s have"} no store login</span>}
      </p>
      <div className="max-h-80 overflow-y-auto rounded-md border border-hairline">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-hairline">
            {stores.map((r) => (
              <tr key={r.location_id}>
                <td className="whitespace-nowrap px-2 py-1.5 font-medium text-content-primary">#{r.store_number} {r.store_name}</td>
                <td className={"whitespace-nowrap px-2 py-1.5 " + (r.read_count > 0 ? "text-success" : r.logins ? "text-danger" : "text-content-muted")}>
                  {r.logins ? `${r.read_count} of ${r.logins}` : "no login"}
                </td>
                <td className="px-2 py-1.5 text-xs text-content-secondary">{names(r.readers)}</td>
              </tr>
            ))}
            {mgr && mgr.read_count > 0 && (
              <tr>
                <td className="px-2 py-1.5 font-medium text-content-primary">Managers / home office</td>
                <td className="px-2 py-1.5 text-content-secondary">{mgr.read_count}</td>
                <td className="px-2 py-1.5 text-xs text-content-secondary">{names(mgr.readers)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Editor({ a, onDone, onCancel }) {
  const trainingFiles = useTrainingFiles(true);
  const [v, setV] = useState({ title: a.title, body: a.body, priority: a.priority, trainingId: a.training_id, expiresDate: dateInput(a.expires_at) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true);
    const r = await announcementApi.update(a.id, { ...v, expiresAt: endOfDayIso(v.expiresDate) });
    setBusy(false);
    if (r.error) setErr(r.error); else onDone("Saved. Anyone who already opened it stays counted as read.");
  };
  return (
    <div className="space-y-3">
      <MessageFields v={v} set={(p) => setV((c) => ({ ...c, ...p }))} trainingFiles={trainingFiles} />
      {err && <Notice tone="error">{err}</Notice>}
      <div className="flex justify-end gap-2">
        <GhostBtn onClick={onCancel} disabled={busy}>Cancel</GhostBtn>
        <PrimaryBtn onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</PrimaryBtn>
      </div>
    </div>
  );
}

function Row({ a, onOpen, onChanged }) {
  const [panel, setPanel] = useState(null); // 'receipts' | 'edit'
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const important = a.priority === "important";
  // Confirmations go to the page, not this card: archiving moves the card
  // into the collapsed past list, which would hide its own message.
  const done = (text) => { setPanel(null); setMsg(null); onChanged(text); };
  const sentNone = a.emailed_at && !(a.email_result?.sent > 0);

  return (
    <Card className={"p-4 " + (!a.is_current ? "opacity-75" : "")}>
      <div className="flex flex-wrap items-start gap-3">
        <span className={"mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full " + (a.read_at ? "bg-transparent" : important ? "bg-danger" : "bg-accent")}
          title={a.read_at ? `Opened ${whenLabel(a.read_at)}` : "Not opened yet"} />
        <button type="button" onClick={() => onOpen(a)} className="min-w-0 flex-1 text-left">
          <p className="flex flex-wrap items-center gap-2">
            <span className={"font-semibold text-content-primary " + (!a.read_at ? "" : "font-medium")}>{a.title}</span>
            {important && <span className="flex items-center gap-1 rounded-full border border-danger-border bg-danger-tint px-2 py-0.5 text-xs text-danger"><AlertTriangle className="h-3 w-3" />Important</span>}
            {a.training_id && <span className="flex items-center gap-1 text-xs text-content-muted"><GraduationCap className="h-3 w-3" />{a.training_title}</span>}
            {a.archived_at && <span className="text-xs text-content-muted">Archived</span>}
            {!a.archived_at && !a.is_current && <span className="text-xs text-content-muted">Expired</span>}
          </p>
          <p className="mt-0.5 line-clamp-2 text-sm text-content-secondary">{a.body}</p>
          <p className="mt-1 text-xs text-content-muted">
            {a.created_by_name ? `${a.created_by_name} · ` : ""}{whenLabel(a.created_at)}{a.edited_at ? " · edited" : ""}
            {a.audience_label ? ` · to ${a.audience_label}` : ` · ${a.store_count} stores`}
            {a.expires_at ? ` · until ${new Date(a.expires_at).toLocaleDateString()}` : ""}
            {a.can_manage && a.emailed_at ? ` · emailed ${whenLabel(a.emailed_at)}${a.email_result ? ` (${a.email_result.sent ?? 0} sent)` : ""}` : ""}
          </p>
        </button>
        {a.can_manage && (
          <div className="flex flex-wrap gap-1.5">
            <GhostBtn onClick={() => setPanel(panel === "receipts" ? null : "receipts")}><Users className="h-4 w-4" /> Who opened it</GhostBtn>
            {!a.archived_at && <GhostBtn onClick={() => setPanel(panel === "edit" ? null : "edit")}><Pencil className="h-4 w-4" /> Edit</GhostBtn>}
            {!a.archived_at && (!a.emailed_at || sentNone) && (
              <GhostBtn disabled={busy} onClick={async () => {
                setBusy(true);
                const e = await announcementApi.email(a.id);
                setBusy(false);
                if (e.error) setMsg({ tone: "error", text: e.error });
                else done(`Emailed ${e.data.sent} store${e.data.sent === 1 ? "" : "s"}${e.data.no_email?.length ? `; ${e.data.no_email.length} have no store email` : ""}.`);
              }}><Mail className="h-4 w-4" /> {sentNone ? "Retry email" : "Email stores"}</GhostBtn>
            )}
            <GhostBtn disabled={busy} onClick={async () => {
              setBusy(true);
              const r = await announcementApi.archive(a.id, !a.archived_at);
              setBusy(false);
              if (r.error) setMsg({ tone: "error", text: r.error }); else done(a.archived_at ? "Restored." : "Archived — it no longer shows to stores.");
            }}>
              {a.archived_at ? <><ArchiveRestore className="h-4 w-4" /> Restore</> : <><Archive className="h-4 w-4" /> Archive</>}
            </GhostBtn>
          </div>
        )}
      </div>
      {msg && <div className="mt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {panel === "receipts" && <div className="mt-3"><Receipts id={a.id} /></div>}
      {panel === "edit" && <div className="mt-3"><Editor a={a} onDone={done} onCancel={() => setPanel(null)} /></div>}
    </Card>
  );
}

export function AnnouncementsView() {
  const { role, stores: allStores } = useAuth();
  const { markRead, reload: reloadFeed } = useAnnouncementFeed();
  const { rows, loading, error, reload } = useAnnouncementHistory();
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState(null);
  const [msg, setMsg] = useState(null);
  const [showPast, setShowPast] = useState(false);
  const stores = useMemo(() => (allStores ?? []).filter((s) => !s.is_sandbox), [allStores]);
  const canPost = canPostAnnouncements(role);

  const refresh = (text) => { reload(); reloadFeed(); if (typeof text === "string") setMsg(text); };
  const openOne = async (a) => {
    setOpen(a);
    if (!a.read_at) { await markRead(a.id); reload(); }
  };
  const current = rows.filter((a) => a.is_current);
  const past = rows.filter((a) => !a.is_current);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Announcements"
        subtitle="From the home office and your managers. Opening one marks it read."
        action={canPost && !composing && <PrimaryBtn onClick={() => { setComposing(true); setMsg(null); }}><Plus className="h-4 w-4" /> New announcement</PrimaryBtn>}
      />
      {error && <Notice tone="error">{error}</Notice>}
      {msg && <Notice tone="ok">{msg}</Notice>}
      {composing && (
        <Composer stores={stores} role={role} onCancel={() => setComposing(false)}
          onDone={(text) => { setComposing(false); setMsg(text); refresh(); }} />
      )}

      {loading ? (
        <p className="px-1 py-6 text-center text-sm text-content-muted">Loading…</p>
      ) : !current.length && !past.length ? (
        <Empty icon={Megaphone} title="No announcements yet" hint={canPost ? "Post one with “New announcement”." : "Anything sent to your store will show here and as a banner."} />
      ) : (
        <>
          {current.length === 0 && <p className="text-sm text-content-muted">Nothing current.</p>}
          {current.map((a) => <Row key={a.id} a={a} onOpen={openOne} onChanged={refresh} />)}
          {past.length > 0 && (
            <button type="button" onClick={() => setShowPast((s) => !s)} className="text-sm font-medium text-content-secondary hover:text-content-primary">
              {showPast ? "Hide" : "Show"} {past.length} past announcement{past.length === 1 ? "" : "s"} (expired or archived)
            </button>
          )}
          {showPast && past.map((a) => <Row key={a.id} a={a} onOpen={openOne} onChanged={refresh} />)}
        </>
      )}
      {open && <AnnouncementDetail a={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
