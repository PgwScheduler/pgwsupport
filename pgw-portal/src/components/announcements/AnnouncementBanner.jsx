import React, { useState } from "react";
import { Megaphone, AlertTriangle, X, GraduationCap } from "lucide-react";
import { useAnnouncementFeed, announcementApi } from "../../hooks/useAnnouncements.js";
import { whenLabel } from "../../lib/announcements.js";
import { Card, GhostBtn } from "../ui.jsx";

// The full announcement. Opening it is what counts as read (migration 86,
// user decision), so the parent marks it read when this opens.
export function AnnouncementDetail({ a, onClose }) {
  const [err, setErr] = useState(null);
  const important = a.priority === "important";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <Card className="max-h-[85vh] w-full max-w-xl overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className={"text-xs font-semibold uppercase tracking-wide " + (important ? "text-danger" : "text-content-muted")}>
              {important ? "Important announcement" : "Announcement"}
            </p>
            <h3 className="pgw-display mt-0.5 text-lg font-bold text-content-primary">{a.title}</h3>
            <p className="mt-0.5 text-xs text-content-muted">
              {a.created_by_name ? `${a.created_by_name} · ` : ""}{whenLabel(a.created_at)}
              {a.edited_at ? " · edited" : ""}{a.audience_label ? ` · to ${a.audience_label}` : ""}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-content-primary">{a.body}</div>
        {a.training_id && (
          <div className="mt-4">
            <GhostBtn onClick={async () => setErr((await announcementApi.openTraining(a.training_id)).error)}>
              <GraduationCap className="h-4 w-4" /> Open training: {a.training_title ?? "file"}
            </GhostBtn>
          </div>
        )}
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
        <div className="mt-5 flex justify-end">
          <GhostBtn onClick={onClose}>Close</GhostBtn>
        </div>
      </Card>
    </div>
  );
}

// Above every screen while anything current is unread. Important ones
// come first (the feed is ordered unread -> important -> newest).
export function AnnouncementBanner({ onShowAll }) {
  const { unread, markRead } = useAnnouncementFeed();
  const [open, setOpen] = useState(null);
  if (!unread.length && !open) return null;

  const first = unread[0];
  const important = unread.some((a) => a.priority === "important");
  const show = (a) => { setOpen(a); markRead(a.id); };

  return (
    <>
      {first && (
        <div className={"flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-2 text-sm "
          + (important ? "border-danger-border bg-danger-tint" : "border-hairline bg-accent-tint")}>
          {important ? <AlertTriangle className="h-4 w-4 shrink-0 text-danger" /> : <Megaphone className="h-4 w-4 shrink-0 text-accent-text" />}
          <button type="button" onClick={() => show(first)} className="min-w-0 flex-1 truncate text-left font-medium text-content-primary hover:underline">
            {first.priority === "important" ? "Important: " : ""}{first.title}
            <span className="ml-2 font-normal text-content-secondary">— tap to read</span>
          </button>
          {unread.length > 1 && (
            <button type="button" onClick={onShowAll} className="shrink-0 text-xs font-medium text-content-secondary hover:text-content-primary">
              +{unread.length - 1} more unread
            </button>
          )}
        </div>
      )}
      {open && <AnnouncementDetail a={open} onClose={() => setOpen(null)} />}
    </>
  );
}
