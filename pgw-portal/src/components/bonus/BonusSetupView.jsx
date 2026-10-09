import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, AlertTriangle, Copy, Plus, Trash2, Lock } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
import { revenueStores } from "../../lib/homeOffice.js";
import { money } from "../../lib/format.js";
import {
  MODEL_DEFAULT_RULES, MONTHS, TIER_KINDS, thresholdsFor, parsePastedColumn,
  pctToInput, inputToPct, groupProblems,
} from "../../lib/bonusSetup.js";
import { useBonusYears, useBonusYearOverview, useBonusRates, useStorePlan } from "../../hooks/useBonusSetup.js";
import { Card, GhostBtn, PrimaryBtn, SectionHeader } from "../ui.jsx";
import { ConfirmDialog } from "../ConfirmDialog.jsx";

// Bonus plan setup (migration 85), admin and master. A year is a DRAFT
// until a master publishes it; only drafts are edited here, and nobody
// below admin can see a draft. Published years are shown read-only.

const cell = "w-full rounded border border-hairline-strong bg-surface-input px-1.5 py-1 text-right text-sm text-content-primary outline-none focus:border-accent disabled:border-transparent disabled:bg-transparent";
const th = "px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-content-muted";
const numStr = (v) => (v === null || v === undefined ? "" : String(v));
const toNumOrNull = (s) => {
  if (s === "" || s === null || s === undefined) return null;
  const n = Number(String(s).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

function StatusBadge({ status }) {
  return status === "published" ? (
    <span className="rounded-full border border-success-border bg-success-tint px-2 py-0.5 text-xs font-medium text-success">Published</span>
  ) : (
    <span className="rounded-full border border-warning-border bg-warning-tint px-2 py-0.5 text-xs font-medium text-warning">Draft — hidden from stores and DMs</span>
  );
}

function Notice({ tone = "info", children }) {
  const cls = tone === "error" ? "border-danger-border bg-danger-tint text-danger"
    : tone === "ok" ? "border-success-border bg-success-tint text-success"
    : "border-hairline bg-surface-page text-content-secondary";
  return <div className={"rounded-md border px-3 py-2 text-sm " + cls}>{children}</div>;
}

// ---------------------------------------------------------------------
// Company rates for the year
// ---------------------------------------------------------------------
function RatesPanel({ year, editable }) {
  const { rates, splits, policy, loading, error, saveRates, saveSplits, savePolicy } = useBonusRates(year);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft({}); setMsg(null); }, [year]);

  if (loading) return <p className="p-4 text-sm text-content-muted">Loading rates…</p>;
  const k = (...p) => p.join("|");
  const val = (key, fallback) => (key in draft ? draft[key] : fallback);
  const set = (key, v) => setDraft((d) => ({ ...d, [key]: v }));
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setBusy(true); setMsg(null);
    const rateRows = rates.filter((r) => k("r", r.model, r.tier, r.role) in draft)
      .map((r) => ({ ...r, patch: { pct: inputToPct(draft[k("r", r.model, r.tier, r.role)]) } }));
    const splitRows = splits.filter((s) => k("s", s.model, s.role) in draft)
      .map((s) => ({ ...s, patch: { share: inputToPct(draft[k("s", s.model, s.role)]) } }));
    const polRows = policy.filter((p) => k("p", p.key) in draft)
      .map((p) => ({ ...p, patch: { value: toNumOrNull(draft[k("p", p.key)]) } }));
    const bad = [...rateRows.map((r) => r.patch.pct), ...splitRows.map((s) => s.patch.share), ...polRows.map((p) => p.patch.value)]
      .some((v) => v === null || Number.isNaN(v));
    if (bad) { setBusy(false); setMsg({ tone: "error", text: "Every rate needs a number." }); return; }
    const res = (await saveRates(rateRows)).error ?? (await saveSplits(splitRows)).error ?? (await savePolicy(polRows)).error;
    setBusy(false);
    if (res) setMsg({ tone: "error", text: res });
    else { setDraft({}); setMsg({ tone: "ok", text: `${year} rates saved. ${year - 1} is unchanged.` }); }
  };

  const pctInput = (key, stored) => (
    <input className={cell + " w-24"} disabled={!editable} value={val(key, pctToInput(stored))} onChange={(e) => set(key, e.target.value)} />
  );

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      <p className="text-sm text-content-secondary">
        These apply to every store on the model, for {year} only. {editable ? "Percentages are entered as percent (7 = 7%)." : ""}
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-x-auto p-3">
          <h4 className="mb-2 text-sm font-bold text-content-primary">Model rates (% of GP)</h4>
          <table className="w-full text-sm">
            <thead><tr><th className={th}>Model</th><th className={th}>Tier</th><th className={th}>Paid to</th><th className={th}>%</th></tr></thead>
            <tbody className="divide-y divide-hairline">
              {rates.map((r) => (
                <tr key={k(r.model, r.tier, r.role)}>
                  <td className="px-2 py-1">{r.model}</td><td className="px-2 py-1 capitalize">{r.tier}</td>
                  <td className="px-2 py-1">{r.role}</td><td className="px-2 py-1">{pctInput(k("r", r.model, r.tier, r.role), r.pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card className="overflow-x-auto p-3">
          <h4 className="mb-2 text-sm font-bold text-content-primary">Model A pool split (%)</h4>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-hairline">
              {splits.map((s) => (
                <tr key={k(s.model, s.role)}>
                  <td className="px-2 py-1">{s.role}</td><td className="px-2 py-1">{pctInput(k("s", s.model, s.role), s.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card className="overflow-x-auto p-3">
          <h4 className="mb-2 text-sm font-bold text-content-primary">Policy values</h4>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-hairline">
              {policy.map((p) => (
                <tr key={p.key}>
                  <td className="px-2 py-1 text-xs text-content-secondary">{p.note || p.key}</td>
                  <td className="px-2 py-1">
                    <input className={cell + " w-24"} disabled={!editable} value={val(k("p", p.key), numStr(p.value))}
                      onChange={(e) => set(k("p", p.key), e.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {editable && (
        <div className="flex justify-end gap-2">
          <GhostBtn onClick={() => setDraft({})} disabled={!dirty || busy}>Undo changes</GhostBtn>
          <PrimaryBtn onClick={save} disabled={!dirty || busy}>{busy ? "Saving…" : "Save rates"}</PrimaryBtn>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// One store's plan
// ---------------------------------------------------------------------
function StorePlanEditor({ store, year, editable, problems, onSaved }) {
  const { plan, targets, tiers, loading, error, save } = useStorePlan(store.id, year);
  const [p, setP] = useState(null);
  const [rows, setRows] = useState([]);
  const [tierRows, setTierRows] = useState([]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setP(plan);
    setRows(targets.map((t) => ({ ...t })));
    setTierRows(tiers.map((t) => ({ ...t })));
    setMsg(null);
  }, [plan, targets, tiers]);

  const dirty = useMemo(() => JSON.stringify([p, rows, tierRows]) !== JSON.stringify([plan, targets, tiers]),
    [p, rows, tierRows, plan, targets, tiers]);

  if (loading) return <Card className="p-5"><p className="text-sm text-content-muted">Loading #{store.store_number}…</p></Card>;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!plan || !p) return <Card className="p-5"><p className="text-sm text-content-muted">#{store.store_number} has no bonus plan for {year}.</p></Card>;

  const isB = p.threshold_basis === "last_year";
  const setRow = (i, field, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [field]: v } : r)));

  // Paste a column from a spreadsheet: fills down from the month pasted into.
  const onPaste = (i, field) => (e) => {
    const text = e.clipboardData.getData("text");
    if (!text.includes("\n")) return;
    e.preventDefault();
    const vals = parsePastedColumn(text);
    if (vals.some((v) => Number.isNaN(v))) { setMsg({ tone: "error", text: "That paste has something that isn't a number." }); return; }
    setRows((rs) => rs.map((r, j) => (j >= i && j - i < vals.length ? { ...r, [field]: vals[j - i] } : r)));
    setMsg({ tone: "info", text: `Pasted ${Math.min(vals.length, rows.length - i)} months into ${field.replace(/_/g, " ")}. Not saved yet.` });
  };

  const changeModel = (model) => {
    setP((cur) => ({ ...cur, model, ...MODEL_DEFAULT_RULES[model] }));
    setMsg({ tone: "info", text: `Model ${model}: thresholds reset to the model's standard rule. Check them before saving.` });
  };

  const doSave = async () => {
    const numericFields = ["days_open", "daily_car_goal", "sales_goal", "gp_budget", "last_year_gp"];
    const cleanRows = rows.map((r) => {
      const o = { ...r };
      for (const f of numericFields) o[f] = toNumOrNull(r[f]);
      return o;
    });
    const badRow = cleanRows.find((r) => numericFields.some((f) => Number.isNaN(r[f])));
    if (badRow) { setMsg({ tone: "error", text: `${MONTHS[badRow.month - 1]} has something that isn't a number.` }); return; }
    const cleanTiers = tierRows.map((t) => ({ ...t, threshold: toNumOrNull(t.threshold), payout: toNumOrNull(t.payout), increment_above: toNumOrNull(t.increment_above) }));
    if (cleanTiers.some((t) => t.threshold === null || t.payout === null || [t.threshold, t.payout, t.increment_above].some(Number.isNaN))) {
      setMsg({ tone: "error", text: "Every incentive tier needs a number for 'at' and 'pays'." }); return;
    }
    setBusy(true); setMsg(null);
    const r = await save({ plan: p, targets: cleanRows, tiers: cleanTiers });
    setBusy(false);
    if (r.error) setMsg({ tone: "error", text: r.error });
    else { setMsg({ tone: "ok", text: `#${store.store_number} saved; thresholds recalculated.` }); onSaved?.(); }
  };

  const ruleInput = (field, label) => (
    <label className="flex items-center gap-1.5 text-xs text-content-secondary">
      {label}
      <input className={cell + " w-20"} disabled={!editable} value={pctToInput(p[field])}
        onChange={(e) => setP((cur) => ({ ...cur, [field]: inputToPct(e.target.value) }))} />%
    </label>
  );

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="pgw-display text-base font-bold text-content-primary">#{store.store_number} · {store.name}</h3>
        <label className="flex items-center gap-2 text-sm text-content-secondary">
          Model
          <select disabled={!editable} value={p.model} onChange={(e) => changeModel(e.target.value)}
            className="rounded-md border border-hairline-strong bg-surface-overlay px-2 py-1 text-sm text-content-primary">
            {["A", "B", "C", "D"].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>

      {editable && problems?.length > 0 && (
        <Notice tone="error">
          {problems.length} thing{problems.length === 1 ? "" : "s"} to fix before publishing:{" "}
          {problems.slice(0, 6).map((x) => `${x.month ? MONTHS[x.month - 1] + " " : ""}${x.problem}`).join("; ")}
          {problems.length > 6 ? "; …" : ""}
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md bg-surface-page px-3 py-2">
        <span className="text-xs font-semibold text-content-primary">
          Thresholds = {isB ? "last year's GP ×" : "GP budget ×"}
        </span>
        {ruleInput("gold_pct", "Gold")}
        {ruleInput("silver_pct", "Silver")}
        {!isB && ruleInput("bronze_pct", "Bronze")}
        {isB && (
          <label className="flex items-center gap-1.5 text-xs text-content-secondary">
            never below $
            <input className={cell + " w-24"} disabled={!editable} value={numStr(p.threshold_floor)}
              onChange={(e) => setP((cur) => ({ ...cur, threshold_floor: toNumOrNull(e.target.value) }))} />
          </label>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr>
              <th className={th}>Month</th><th className={th}>Days open</th>
              {!isB && <th className={th}>Cars/day goal</th>}
              <th className={th}>Sales goal</th><th className={th}>GP budget</th>
              {isB && <th className={th}>Last year GP</th>}
              <th className={th}>Gold</th><th className={th}>Silver</th>{!isB && <th className={th}>Bronze</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r, i) => {
              const t = thresholdsFor(p, r);
              const input = (field, w = "w-28") => (
                <input className={cell + " " + w} disabled={!editable} value={numStr(r[field])}
                  onChange={(e) => setRow(i, field, e.target.value)} onPaste={editable ? onPaste(i, field) : undefined} />
              );
              return (
                <tr key={r.id}>
                  <td className="px-2 py-1 font-medium text-content-primary">{MONTHS[r.month - 1]}</td>
                  <td className="px-2 py-1">{input("days_open", "w-14")}</td>
                  {!isB && <td className="px-2 py-1">{input("daily_car_goal", "w-20")}</td>}
                  <td className="px-2 py-1">{input("sales_goal")}</td>
                  <td className="px-2 py-1">{input("gp_budget")}</td>
                  {isB && <td className="px-2 py-1">{input("last_year_gp")}</td>}
                  <td className="px-2 py-1 text-right tabular-nums text-content-secondary">{t.gold === null ? "—" : money(t.gold)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-content-secondary">{t.silver === null ? "—" : money(t.silver)}</td>
                  {!isB && <td className="px-2 py-1 text-right tabular-nums text-content-secondary">{t.bronze === null ? "—" : money(t.bronze)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
        {editable && (
          <p className="mt-1 text-xs text-content-muted">
            Tip: copy a column of 12 numbers from BDC's sheet and paste into January's cell — it fills down.
            {isB ? " Last year GP fills from the tic sheet with “Fill last-year GP”; a month that wasn't fully entered stays blank." : ""}
          </p>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-sm font-bold text-content-primary">Incentive scales</h4>
        <div className="grid gap-3 md:grid-cols-3">
          {TIER_KINDS.map(({ kind, label }) => {
            const list = tierRows.map((t, i) => ({ t, i })).filter((x) => x.t.kind === kind);
            if (!list.length && !editable) return null;
            return (
              <div key={kind} className="rounded-md border border-hairline p-2">
                <p className="mb-1 text-xs font-semibold text-content-secondary">{label}</p>
                <table className="w-full text-sm">
                  <thead><tr><th className={th}>At</th><th className={th}>Pays</th><th className={th}>+ per unit above</th><th /></tr></thead>
                  <tbody>
                    {list.map(({ t, i }) => (
                      <tr key={t.id ?? "new" + i}>
                        {["threshold", "payout", "increment_above"].map((f) => (
                          <td key={f} className="px-1 py-0.5">
                            <input className={cell} disabled={!editable} value={numStr(t[f])}
                              onChange={(e) => setTierRows((ts) => ts.map((x, j) => (j === i ? { ...x, [f]: e.target.value } : x)))} />
                          </td>
                        ))}
                        <td className="px-1">
                          {editable && (
                            <button type="button" aria-label="Remove tier" className="rounded p-1 text-content-muted hover:text-danger"
                              onClick={() => setTierRows((ts) => ts.filter((_, j) => j !== i))}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!list.length && <p className="px-1 text-xs text-content-muted">None</p>}
                {editable && (
                  <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-content-secondary hover:text-content-primary"
                    onClick={() => setTierRows((ts) => [...ts, { kind, threshold: "", payout: "", increment_above: null }])}>
                    <Plus className="h-3.5 w-3.5" /> Add tier
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {editable && (
        <div className="flex justify-end gap-2">
          <GhostBtn onClick={() => { setP(plan); setRows(targets.map((t) => ({ ...t }))); setTierRows(tiers.map((t) => ({ ...t }))); setMsg(null); }}
            disabled={!dirty || busy}>Undo changes</GhostBtn>
          <PrimaryBtn onClick={doSave} disabled={!dirty || busy}>{busy ? "Saving…" : `Save #${store.store_number}`}</PrimaryBtn>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------
export function BonusSetupView({ onBack }) {
  const { role, stores: allStores } = useAuth();
  const isMaster = role === "master";
  const canEditStores = role === "master" || role === "admin";
  const stores = revenueStores(allStores);
  const { years, loading, error, rollover, publish, discard, fillLastYear } = useBonusYears();
  const [year, setYear] = useState(null);
  const [tab, setTab] = useState("stores");
  const [storeId, setStoreId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'rollover' | 'publish' | 'discard'

  // Land on the newest draft, else the newest year.
  useEffect(() => {
    if (!years.length || (year && years.some((y) => y.plan_year === year))) return;
    const draft = [...years].reverse().find((y) => y.status === "draft");
    setYear((draft ?? years[years.length - 1]).plan_year);
  }, [years, year]);

  const current = years.find((y) => y.plan_year === year);
  const isDraft = current?.status === "draft";
  const latest = years.length ? years[years.length - 1].plan_year : null;
  const overview = useBonusYearOverview(year);
  const grouped = groupProblems(overview.problems);
  const modelOf = Object.fromEntries(overview.plans.map((p) => [p.location_id, p.model]));
  const planStores = stores.filter((s) => modelOf[s.id]);
  const selected = planStores.find((s) => s.id === storeId) ?? planStores[0];

  const act = async (fn, okText) => {
    setBusy(true); setMsg(null);
    const r = await fn();
    setBusy(false); setConfirm(null);
    if (r.error) { setMsg({ tone: "error", text: r.error }); return r; }
    if (okText) setMsg({ tone: "ok", text: typeof okText === "function" ? okText(r.data) : okText });
    overview.reload();
    return r;
  };

  const doRollover = () => act(async () => {
    const r = await rollover(latest, latest + 1);
    if (!r.error) setYear(latest + 1);
    return r;
  }, (d) => `${d.plan_year} created from ${d.copied_from}: ${d.plans} store plans, ${d.targets} months, ${d.tiers} incentive tiers, ${d.rates} rates. `
    + `Last-year GP filled for ${d.last_year_gp_filled} Model B months; ${d.last_year_gp_missing?.length ?? 0} still blank (month not finished or not fully entered).`
    + (d.holidays_in_year ? "" : ` No ${d.plan_year} holidays are on file, so days open counts every Mon–Sat — add the holidays and re-check.`));

  const doPublish = () => act(() => publish(year), (d) => (d.published ? `${year} is published. Stores and DMs can see it.`
    : `Not published — ${d.problems.length} thing${d.problems.length === 1 ? "" : "s"} still to fix (listed per store).`));

  const doFill = () => act(() => fillLastYear(year), (d) => `Last-year GP filled for ${d.filled} more months; ${d.still_missing.length} still blank.`);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Bonus plan setup"
        subtitle="Start next year from this year's plans, edit the draft, then publish."
        action={<GhostBtn onClick={onBack}><ArrowLeft className="h-4 w-4" /> Bonus Tracker</GhostBtn>}
      />
      {error && <Notice tone="error">{error}</Notice>}

      <Card className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {loading ? <span className="text-sm text-content-muted">Loading…</span> : years.map((y) => (
            <button key={y.plan_year} type="button" onClick={() => { setYear(y.plan_year); setMsg(null); }}
              className={"rounded-md px-3 py-1.5 text-sm font-semibold " + (y.plan_year === year ? "bg-accent text-on-accent" : "bg-surface-overlay text-content-primary hover:bg-hairline-strong")}>
              {y.plan_year}{y.status === "draft" ? " (draft)" : ""}
            </button>
          ))}
        </div>
        {current && <StatusBadge status={current.status} />}
        <div className="ml-auto flex flex-wrap gap-2">
          {isMaster && latest && !years.some((y) => y.plan_year === latest + 1) && (
            <PrimaryBtn onClick={() => setConfirm("rollover")} disabled={busy}><Copy className="h-4 w-4" /> Start {latest + 1} from {latest}</PrimaryBtn>
          )}
          {isDraft && canEditStores && <GhostBtn onClick={doFill} disabled={busy}>Fill last-year GP</GhostBtn>}
          {isDraft && isMaster && <PrimaryBtn onClick={() => setConfirm("publish")} disabled={busy}><CheckCircle2 className="h-4 w-4" /> Publish {year}</PrimaryBtn>}
          {isDraft && isMaster && <GhostBtn onClick={() => setConfirm("discard")} disabled={busy}><Trash2 className="h-4 w-4" /> Discard draft</GhostBtn>}
        </div>
      </Card>

      {confirm === "rollover" && (
        <Card className="space-y-3 border-accent p-4">
          <p className="text-sm text-content-primary">
            Create <strong>{latest + 1}</strong> as a draft copy of {latest}: every store's model, incentive scales and goals,
            and the company rates. Days open are recounted for {latest + 1}; gold/silver/bronze are recalculated from each
            store's own percentages; Model B's last-year GP comes from {latest}'s tic sheet where the month was fully entered.
            Nobody below admin sees it until you publish. {latest} is not changed.
          </p>
          <div className="flex justify-end gap-2">
            <GhostBtn onClick={() => setConfirm(null)} disabled={busy}>Cancel</GhostBtn>
            <PrimaryBtn onClick={doRollover} disabled={busy}>{busy ? "Copying…" : `Create ${latest + 1} draft`}</PrimaryBtn>
          </div>
        </Card>
      )}
      {confirm === "publish" && (
        <Card className="space-y-3 border-accent p-4">
          <p className="text-sm text-content-primary">
            Publish <strong>{year}</strong>? Store managers and DMs will see these plans, and they can no longer be edited here.
            {grouped.general.length + Object.keys(grouped.byStore).length > 0 ? " There are still problems listed — publishing will refuse until they're fixed." : ""}
          </p>
          <div className="flex justify-end gap-2">
            <GhostBtn onClick={() => setConfirm(null)} disabled={busy}>Cancel</GhostBtn>
            <PrimaryBtn onClick={doPublish} disabled={busy}>{busy ? "Checking…" : `Publish ${year}`}</PrimaryBtn>
          </div>
        </Card>
      )}
      {confirm === "discard" && (
        <ConfirmDialog
          title={`Discard the ${year} draft?`}
          message={`Every ${year} store plan, goal, incentive scale and rate is deleted. ${year - 1} is not touched. You can start ${year} again afterwards.`}
          confirmLabel={`Discard ${year}`} busyLabel="Discarding…" busy={busy}
          onConfirm={() => act(async () => { const r = await discard(year); if (!r.error) setYear(null); return r; }, `${year} draft discarded.`)}
          onClose={() => setConfirm(null)}
        />
      )}

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!isDraft && current && (
        <Notice><Lock className="mr-1 inline h-3.5 w-3.5" /> {year} is published, so it is shown read-only. Changes to a published year are not made from this screen.</Notice>
      )}
      {isDraft && grouped.general.length > 0 && <Notice tone="error">{grouped.general.join("; ")}</Notice>}

      {year && (
        <>
          <div className="flex gap-1 border-b border-hairline">
            {[["stores", "Stores"], ["rates", "Company rates"]].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTab(k)}
                className={"-mb-px border-b-2 px-3 py-2 text-sm font-medium " + (tab === k ? "border-accent text-content-primary" : "border-transparent text-content-secondary hover:text-content-primary")}>
                {label}
              </button>
            ))}
          </div>

          {tab === "rates" ? (
            <RatesPanel year={year} editable={isDraft && isMaster} />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
              <Card className="max-h-[70vh] overflow-y-auto p-2">
                {overview.loading ? <p className="p-2 text-sm text-content-muted">Loading…</p> : planStores.map((s) => {
                  const n = grouped.byStore[s.id]?.length ?? 0;
                  return (
                    <button key={s.id} type="button" onClick={() => setStoreId(s.id)}
                      className={"flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm " + (selected?.id === s.id ? "bg-surface-overlay text-content-primary" : "text-content-secondary hover:bg-surface-overlay")}>
                      <span className="truncate"><span className="font-semibold">#{s.store_number}</span> {s.name}</span>
                      <span className="flex shrink-0 items-center gap-1 text-xs">
                        {isDraft && n > 0 && <span className="flex items-center gap-0.5 text-danger"><AlertTriangle className="h-3 w-3" />{n}</span>}
                        <span className="rounded bg-surface-page px-1.5 py-0.5 text-content-muted">{modelOf[s.id]}</span>
                      </span>
                    </button>
                  );
                })}
              </Card>
              {selected && (
                <StorePlanEditor key={selected.id + year} store={selected} year={year}
                  editable={isDraft && canEditStores} problems={grouped.byStore[selected.id]} onSaved={overview.reload} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
