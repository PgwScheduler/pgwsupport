import React, { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CheckCircle2, CircleDashed, Save, Send, ListChecks } from "lucide-react";
import { useDailyKpi, SUMMARY_FIELDS } from "../hooks/useDailyKpi.js";
import { SectionHeader, Card, PrimaryBtn, GhostBtn, Empty, inputCls, T } from "./ui.jsx";

// --- date helpers (timezone-naive local dates; never UTC) -------------------
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shiftDate(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function prettyDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}
function prettyStamp(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// 0 / null render as blank so the sheet is fast to scan and key through.
const numToStr = (n) => (n == null || Number(n) === 0 ? "" : String(n));

function NumField({ label, value, onChange, kind, disabled }) {
  return (
    <label className="block">
      <span className="mb-1 block truncate text-xs font-medium text-content-secondary" title={label}>
        {label}
      </span>
      <input
        type="number"
        inputMode={kind === "int" ? "numeric" : "decimal"}
        step={kind === "int" ? "1" : "0.01"}
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="0"
        className={inputCls}
      />
    </label>
  );
}

export function TicSheetView({ store }) {
  const [businessDate, setBusinessDate] = useState(todayLocal());
  const { categories, kpi, units, submittedAt, loading, error, save } = useDailyKpi(store, businessDate);

  const [unitsState, setUnitsState] = useState({}); // { [catId]: string }
  const [summaryState, setSummaryState] = useState({}); // { [key]: string }
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [justSaved, setJustSaved] = useState(false);

  const today = todayLocal();
  const atToday = businessDate >= today;

  // Resync local inputs whenever the loaded record changes (date change, save).
  // Does NOT fire on keystrokes, so typing is never clobbered.
  useEffect(() => {
    const s = {};
    for (const f of SUMMARY_FIELDS) s[f.key] = numToStr(kpi?.[f.key]);
    setSummaryState(s);
    const u = {};
    for (const c of categories) u[c.id] = numToStr(units[c.id]);
    setUnitsState(u);
    setDirty(false);
  }, [kpi, units, categories]);

  const markEdited = () => {
    if (!dirty) setDirty(true);
    if (justSaved) setJustSaved(false);
  };

  const setUnit = (catId, v) => {
    setUnitsState((p) => ({ ...p, [catId]: v }));
    markEdited();
  };
  const setSummary = (key, v) => {
    setSummaryState((p) => ({ ...p, [key]: v }));
    markEdited();
  };

  const parse = (kind, v) => {
    const n = Number(v);
    if (v === "" || v == null || !Number.isFinite(n)) return 0;
    return kind === "int" ? Math.trunc(n) : n;
  };

  const doSave = async (submit) => {
    setSaving(true);
    setSaveError(null);
    const summary = {};
    for (const f of SUMMARY_FIELDS) summary[f.key] = parse(f.kind, summaryState[f.key]);
    const unitCounts = {};
    for (const c of categories) unitCounts[c.id] = parse("int", unitsState[c.id]);
    const { error: err } = await save({ summary, unitCounts, submit });
    setSaving(false);
    if (err) setSaveError(err.message);
    else setJustSaved(true);
  };

  const changeDate = (iso) => {
    if (!iso || iso > today) return;
    setBusinessDate(iso);
  };

  const statusPill = useMemo(() => {
    if (submittedAt) {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-overlay px-2.5 py-1 text-xs font-medium" style={{ color: T.accent }}>
          <CheckCircle2 className="h-3.5 w-3.5" /> Submitted {prettyStamp(submittedAt)}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-overlay px-2.5 py-1 text-xs font-medium text-content-muted">
        <CircleDashed className="h-3.5 w-3.5" /> Not submitted
      </span>
    );
  }, [submittedAt]);

  return (
    <div className="pb-24">
      <SectionHeader
        title="Daily Tic Sheet"
        subtitle={`#${store.store_number} · ${store.name}`}
        action={
          <div className="flex items-center gap-2">
            <GhostBtn onClick={() => changeDate(shiftDate(businessDate, -1))} aria-label="Previous day">
              <ChevronLeft className="h-4 w-4" />
            </GhostBtn>
            <input
              type="date"
              value={businessDate}
              max={today}
              onChange={(e) => changeDate(e.target.value)}
              className="rounded-md border border-hairline-strong bg-surface-overlay px-2 py-1.5 text-sm text-content-primary outline-none focus:border-hairline-strong"
            />
            <GhostBtn onClick={() => changeDate(shiftDate(businessDate, 1))} disabled={atToday} aria-label="Next day">
              <ChevronRight className="h-4 w-4" />
            </GhostBtn>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-content-primary">{prettyDate(businessDate)}</span>
        {statusPill}
        {loading && <span className="text-xs text-content-muted">Loading…</span>}
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {/* Service units — the bulk of the sheet */}
      <Card className="mb-4 p-5">
        <div className="mb-4 flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-content-muted" />
          <h3 className="pgw-display text-sm font-bold text-content-primary">Service Units</h3>
          {categories.length > 0 && (
            <span className="text-xs text-content-muted">{categories.length} categories</span>
          )}
        </div>

        {categories.length === 0 ? (
          <Empty
            icon={ListChecks}
            title="No service categories for this store"
            hint={
              store.brand === "speedee"
                ? "SpeeDee categories haven't been set up yet — that's expected for now."
                : "No active categories are configured for this brand."
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {categories.map((c) => (
              <NumField
                key={c.id}
                label={c.display_name}
                kind="int"
                value={unitsState[c.id] ?? ""}
                onChange={(v) => setUnit(c.id, v)}
                disabled={saving}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Day summary */}
      <Card className="p-5">
        <h3 className="pgw-display mb-4 text-sm font-bold text-content-primary">Day Summary</h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          {SUMMARY_FIELDS.map((f) => (
            <NumField
              key={f.key}
              label={f.kind === "money" ? `${f.label} ($)` : f.label}
              kind={f.kind}
              value={summaryState[f.key] ?? ""}
              onChange={(v) => setSummary(f.key, v)}
              disabled={saving}
            />
          ))}
        </div>
      </Card>

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-hairline bg-surface-card px-5 py-3 md:pl-60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-content-muted">
            {saveError ? (
              <span className="text-danger">{saveError}</span>
            ) : saving ? (
              "Saving…"
            ) : justSaved ? (
              "All changes saved"
            ) : dirty ? (
              "Unsaved changes"
            ) : (
              ""
            )}
          </div>
          <div className="flex items-center gap-2">
            <GhostBtn onClick={() => doSave(false)} disabled={saving}>
              <Save className="h-4 w-4" /> Save
            </GhostBtn>
            <PrimaryBtn onClick={() => doSave(true)} disabled={saving}>
              <Send className="h-4 w-4" /> {submittedAt ? "Re-submit" : "Submit"}
            </PrimaryBtn>
          </div>
        </div>
      </div>
    </div>
  );
}
