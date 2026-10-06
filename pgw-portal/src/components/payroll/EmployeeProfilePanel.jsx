import React, { useEffect, useState } from "react";
import { ArrowRightLeft, Lock, Trash2, Wrench, X } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
import { useEmployeeProfile } from "../../hooks/useEmployeeProfile.js";
import { usePayrollConfig } from "../../hooks/usePayrollConfig.js";
import { money } from "../../lib/format.js";
import { LEGACY_DATE, RATE_TYPES, firstPayWeek, ratesOn, rowOn, weeksAlreadyStarted } from "../../lib/payRates.js";
import { positionsForBrand, canBeSalaried } from "../../lib/payrollMath.js";
import { addDays, asDate, iso, shiftWeek, thisWeekStart, weekEndOf, weekStartOf } from "../../lib/weekUtils.js";
import { Field, GhostBtn, PrimaryBtn, inputCls } from "../ui.jsx";

// Employee profile (migration 56), opened by clicking a name on Payroll
// or the Tech Tracker. Details are editable by anyone who can see the
// store; the Pay section renders only for admin/master, and the data
// behind it is never fetched for anyone else (useEmployeeProfile).

const fmtDate = (d) =>
  d ? asDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
const fmtShort = (d) => asDate(d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const todayIso = () => iso(new Date());
const typeLabel = (k) => RATE_TYPES.find((t) => t.key === k)?.label ?? k;
// "#3303" in a sentence; a store with no number (the sandbox) by name.
const storeRef = (l) => (l?.store_number ? `#${l.store_number}` : l?.name ?? "the other store");
const SOURCE_LABEL = { manual: "Profile", tech_tracker: "Tech Tracker", legacy: "Original rate" };

function Section({ title, children, right }) {
  return (
    <section className="border-t border-hairline pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-content-secondary">{title}</h4>
        {right}
      </div>
      {children}
    </section>
  );
}

function Msg({ kind, children }) {
  if (!children) return null;
  const cls = kind === "error"
    ? "border-danger-border bg-danger-tint text-danger"
    : kind === "warn" ? "border-warning-border bg-warning-tint text-warning" : "border-success-border bg-success-tint text-success";
  return <p className={"rounded-md border px-3 py-2 text-sm " + cls}>{children}</p>;
}

export function EmployeeProfilePanel({ employeeId, onClose, onChanged, onNavigate }) {
  // A transfer (migration 76) links two rows. The panel follows the link
  // itself, so the page that opened it needn't know.
  const [viewId, setViewId] = useState(employeeId);
  const [notice, setNotice] = useState(null);
  useEffect(() => { setViewId(employeeId); setNotice(null); }, [employeeId]);
  const open = (id) => { setNotice(null); setViewId(id); };
  const p = useEmployeeProfile(viewId);
  const { role, stores } = useAuth();
  // Pay waits for the cutover: it decides which weekday a pay week starts
  // on, and so which week a change first applies to.
  const { cutover } = usePayrollConfig();
  const e = p.employee;

  useEffect(() => {
    const onKey = (ev) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changed = async (fn) => {
    const r = await fn();
    if (!r.error) onChanged?.();
    return r;
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-scrim" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-hairline bg-surface-card p-5"
        onClick={(ev) => ev.stopPropagation()}
        aria-label="Employee profile"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-widest text-content-muted">Employee profile</p>
            <h3 className="pgw-display truncate text-lg font-bold text-content-primary">{e?.full_name || (p.loading ? "Loading…" : "—")}</h3>
            {e && (
              <p className="text-sm text-content-secondary">
                #{e.location?.store_number} · {e.location?.name} · <StatusText e={e} />
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-content-secondary hover:bg-surface-overlay hover:text-content-primary" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {p.error && <Msg kind="error">{p.error}</Msg>}
        {notice && <div className="mb-4"><Msg kind="ok">{notice}</Msg></div>}
        {e && (
          <div className="space-y-5">
            <Details e={e} privileged={p.privileged} onSave={(patch) => changed(() => p.saveDetails(patch))} />
            <Employment key={e.id} e={e} privileged={p.privileged} transferredTo={p.transferredTo} onOpen={open}
              canTransfer={["admin", "master", "district", "regional"].includes(role)}
              transferForm={(close) => (
                <TransferForm e={e} privileged={p.privileged} stores={stores} history={p.history} techRates={p.techRates}
                  cutover={cutover} onCancel={close}
                  onTransfer={async (args) => {
                    const r = await changed(() => p.transfer(args));
                    if (!r.error && r.id) {
                      const to = stores.find((s) => s.id === args.toLocationId);
                      open(r.id);
                      setNotice(`Transferred. This is ${e.full_name}'s record at ${storeRef(to)}; their record at ${storeRef(e.location)} ended ${fmtDate(addDays(args.transferDate, -1))}.`);
                    }
                    return r;
                  }} />
              )}
              onEnd={(d) => changed(() => p.endEmployment(d))} onReactivate={() => changed(p.reactivate)} />
            {p.privileged && !cutover ? (
              <Section title="Pay"><p className="text-sm text-content-muted">Loading…</p></Section>
            ) : p.privileged ? (
              <Pay e={e} history={p.history} techRates={p.techRates} cutover={cutover} onNavigate={onNavigate}
                onSave={(t, d, a) => changed(() => p.saveRate(t, d, a))} onRemove={(row) => changed(() => p.removeRate(row))} />
            ) : (
              <Section title="Pay">
                <p className="inline-flex items-center gap-1.5 text-sm text-content-muted">
                  <Lock className="h-3.5 w-3.5" /> Pay rates are managed by the office.
                </p>
              </Section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function StatusText({ e }) {
  if (e.termination_date) return <span>Ended {fmtDate(e.termination_date)}</span>;
  if (!e.active) return <span>Removed (no end date recorded)</span>;
  return <span>Active</span>;
}

// ---------------------------------------------------------------------
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb 29 allowed

function Details({ e, privileged, onSave }) {
  const initial = () => ({
    full_name: e.full_name ?? "",
    position: e.position ?? "",
    hire_date: e.hire_date ?? "",
    rehire_date: e.rehire_date ?? "",
    birth_month: e.birth_month ? String(e.birth_month) : "",
    birth_day: e.birth_day ? String(e.birth_day) : "",
    employee_number: e.employee_number ?? "",
    adp_position_id: e.adp_position_id ?? "",
    is_store_manager: !!e.is_store_manager,
  });
  const [f, setF] = useState(initial);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setF(initial()), [e]); // eslint-disable-line react-hooks/exhaustive-deps

  const positions = positionsForBrand(e.location?.brand, e.location?.is_home_office);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial());
  const set = (k) => (ev) => setF((x) => ({ ...x, [k]: ev.target.type === "checkbox" ? ev.target.checked : ev.target.value }));

  const submit = async (ev) => {
    ev.preventDefault();
    if (!f.full_name.trim()) return setMsg({ kind: "error", text: "Name is required." });
    if (f.hire_date && e.termination_date && f.hire_date > e.termination_date)
      return setMsg({ kind: "error", text: "Hire date is after the last day worked." });
    if (f.rehire_date && f.hire_date && f.rehire_date < f.hire_date)
      return setMsg({ kind: "error", text: "Rehire date is before the original hire date." });
    // Migration 72: three letters/digits then six digits, e.g. MWT000084.
    const pid = f.adp_position_id.trim().toUpperCase();
    if (pid && !/^[A-Z0-9]{3}[0-9]{6}$/.test(pid))
      return setMsg({ kind: "error", text: "ADP Position ID looks like MWT000084: three letters or digits, then six digits." });
    if (!f.birth_month !== !f.birth_day)
      return setMsg({ kind: "error", text: "Pick both the birthday month and day, or neither." });
    if (f.birth_month && Number(f.birth_day) > DAYS_IN_MONTH[Number(f.birth_month) - 1])
      return setMsg({ kind: "error", text: "That birthday isn't a real date." });
    setSaving(true);
    const patch = {
      full_name: f.full_name.trim(),
      position: f.position || null,
      hire_date: f.hire_date || null,
      rehire_date: f.rehire_date || null,
      birth_month: f.birth_month ? Number(f.birth_month) : null,
      birth_day: f.birth_day ? Number(f.birth_day) : null,
      employee_number: f.employee_number.trim() || null,
      adp_position_id: pid || null,
    };
    // Only admin/master see the salaried switch on the grid; same here.
    if (privileged) patch.is_store_manager = canBeSalaried(f.position) && f.is_store_manager;
    const { error } = await onSave(patch);
    setSaving(false);
    setMsg(error ? { kind: "error", text: error.message } : { kind: "ok", text: "Saved." });
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input className={inputCls} value={f.full_name} onChange={set("full_name")} />
        </Field>
        <Field label="Position">
          <select className={inputCls} value={f.position} onChange={set("position")}>
            {/* Migration 73: blank until the position is confirmed. */}
            {!f.position && <option value="">— Not set —</option>}
            {positions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Hire date">
          <input type="date" className={inputCls} value={f.hire_date} onChange={set("hire_date")} />
        </Field>
        <Field label="Rehire date">
          <input type="date" className={inputCls} value={f.rehire_date} onChange={set("rehire_date")} />
        </Field>
        {/* Month and day only -- the portal never stores a birth year. */}
        <Field label="Birthday">
          <div className="flex gap-2">
            <select className={inputCls} value={f.birth_month} onChange={set("birth_month")} aria-label="Birthday month">
              <option value="">Month</option>
              {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
            </select>
            <select className={inputCls} value={f.birth_day} onChange={set("birth_day")} aria-label="Birthday day">
              <option value="">Day</option>
              {Array.from({ length: f.birth_month ? DAYS_IN_MONTH[Number(f.birth_month) - 1] : 31 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>{i + 1}</option>
              ))}
            </select>
          </div>
        </Field>
        <Field label="Employee / ADP ID">
          <input className={inputCls} value={f.employee_number} onChange={set("employee_number")} placeholder="Optional" />
        </Field>
        {/* Migration 72: the key roster loads match on, so a spelling
            difference can never create a second row for the same person. */}
        <Field label="ADP Position ID">
          <input className={inputCls + " uppercase"} value={f.adp_position_id} onChange={set("adp_position_id")}
            placeholder="e.g. MWT000084" maxLength={9} autoCapitalize="characters" spellCheck={false} />
        </Field>
      </div>
      {privileged && canBeSalaried(f.position) && (
        <label className="inline-flex items-center gap-2 text-sm text-content-primary">
          <input type="checkbox" className="accent-accent" checked={f.is_store_manager} onChange={set("is_store_manager")} />
          {f.position === "office"
            ? "Salaried — paid the weekly salary instead of hourly"
            : "Store manager (salaried) — paid the weekly salary, left out of payroll-to-sales"}
        </label>
      )}
      <p className="text-xs text-content-muted">
        The hire date keeps a new person off pay weeks before they started. Weeks where they have hours always show them.
        Birthdays and work anniversaries (from the rehire date when there is one) show on the Employee Schedule.
      </p>
      {msg && <Msg kind={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</Msg>}
      <div className="flex justify-end">
        <PrimaryBtn type="submit" disabled={!dirty || saving}>{saving ? "Saving…" : "Save details"}</PrimaryBtn>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------
function Employment({ e, privileged, transferredTo, canTransfer, transferForm, onOpen, onEnd, onReactivate }) {
  const [open, setOpen] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [lastDay, setLastDay] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ended = !e.active || !!e.termination_date;

  const confirmEnd = async () => {
    if (!lastDay) return setErr("Enter the last day worked.");
    if (lastDay > todayIso()) return setErr("The last day can't be in the future. End their employment once they've left.");
    if (e.hire_date && lastDay < e.hire_date) return setErr("The last day is before the hire date.");
    setBusy(true);
    const { error } = await onEnd(lastDay);
    setBusy(false);
    if (error) setErr(error.message);
    else { setOpen(false); setErr(null); }
  };

  return (
    <Section title="Employment">
      {e.transfer_date && (
        <p className="mb-3 text-sm text-content-secondary">
          At this store since {fmtDate(e.transfer_date)}, transferred from{" "}
          {e.transferred_from ? (
            <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => onOpen(e.transferred_from.id)}>
              {storeRef(e.transferred_from.location)}{e.transferred_from.location?.store_number ? ` · ${e.transferred_from.location.name}` : ""}
            </button>
          ) : "another store"}.
        </p>
      )}
      {!ended && !open && !transferring && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-content-primary">
            Active{e.hire_date ? ` since ${fmtDate(e.hire_date)}` : ""}.
          </p>
          <div className="flex flex-wrap gap-2">
            {canTransfer && (
              <GhostBtn type="button" onClick={() => setTransferring(true)} className="py-1.5">
                <ArrowRightLeft className="h-4 w-4" /> Transfer to another store
              </GhostBtn>
            )}
            <button type="button" onClick={() => setOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-danger-border px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger-tint">
              <Trash2 className="h-4 w-4" /> End employment
            </button>
          </div>
        </div>
      )}
      {!ended && transferring && transferForm(() => setTransferring(false))}
      {!ended && open && (
        <div className="space-y-3 rounded-lg border border-danger-border bg-danger-tint p-3">
          <Field label="Last day worked">
            <input type="date" className={inputCls} value={lastDay} max={todayIso()} min={e.hire_date ?? undefined}
              onChange={(ev) => setLastDay(ev.target.value)} />
          </Field>
          <p className="text-xs text-content-secondary">
            They stay on every pay week up to and including that day, so hours already worked are still paid and still count.
            They drop off the grid, the schedule and the Tech Tracker's pickers from then on.
          </p>
          {err && <Msg kind="error">{err}</Msg>}
          <div className="flex justify-end gap-2">
            <GhostBtn type="button" onClick={() => { setOpen(false); setErr(null); }} disabled={busy}>Cancel</GhostBtn>
            <button type="button" onClick={confirmEnd} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-danger px-3.5 py-2 text-sm font-semibold text-content-primary hover:bg-danger-hover disabled:text-content-disabled">
              {busy ? "Ending…" : "End employment"}
            </button>
          </div>
        </div>
      )}
      {ended && transferredTo && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-content-primary">
            Transferred to {storeRef(transferredTo.location)}{transferredTo.location?.store_number ? ` · ${transferredTo.location.name}` : ""} on {fmtDate(transferredTo.transfer_date)}.
            {e.termination_date && ` Last day here: ${fmtDate(e.termination_date)}.`}
          </p>
          <GhostBtn type="button" onClick={() => onOpen(transferredTo.id)}>
            Open {storeRef(transferredTo.location)} record
          </GhostBtn>
        </div>
      )}
      {ended && !transferredTo && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-content-primary">
            {e.termination_date ? `Last day worked: ${fmtDate(e.termination_date)}.` : "Removed from the roster before end dates were recorded."}
          </p>
          {privileged ? (
            <GhostBtn type="button" onClick={async () => { const { error } = await onReactivate(); if (error) setErr(error.message); }}>
              Reactivate
            </GhostBtn>
          ) : (
            <span className="text-xs text-content-muted">An administrator can reactivate them.</span>
          )}
          {err && <Msg kind="error">{err}</Msg>}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------
// Transfer (migration 76): ends this record the day before and starts a
// linked one at the new store, in one database call. District and
// regional managers see only their own stores in the picker (locations
// are RLS-scoped); new pay and the store-manager flag are admin/master.
const RATE_FIELDS = {
  hourly: { label: "Hourly", unit: "per hour" },
  flat: { label: "Flat", unit: "per turned hour" },
  guarantee: { label: "Guarantee", unit: "per hour" },
  salary: { label: "Salary", unit: "per week" },
};

function TransferForm({ e, privileged, stores, history, techRates, cutover, onCancel, onTransfer }) {
  const tomorrow = addDays(todayIso(), 1);
  const startedHere = [e.hire_date, e.transfer_date].filter(Boolean).sort().pop() ?? null;
  const options = stores.filter((s) => s.id !== e.location_id && (privileged || !s.is_home_office));
  const [toId, setToId] = useState("");
  const [date, setDate] = useState(todayIso());
  const [position, setPosition] = useState(e.position ?? "");
  const [isGm, setIsGm] = useState(privileged && !!e.is_store_manager);
  const [rates, setRates] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const to = options.find((s) => s.id === toId) ?? null;
  const positions = to ? positionsForBrand(to.brand, to.is_home_office) : [];
  // Keep the position when the new store has it; otherwise make them pick.
  useEffect(() => {
    if (to) setPosition((p) => (positions.some(([k]) => k === p) ? p : positions.some(([k]) => k === e.position) ? e.position : ""));
  }, [toId]); // eslint-disable-line react-hooks/exhaustive-deps

  const salaried = canBeSalaried(position) && isGm;
  const isTech = position === "tech";
  const rateKeys = salaried ? ["salary"] : isTech ? ["hourly", "flat", "guarantee"] : ["hourly", "flat"];
  const carried = date ? ratesOn(history, date) : null;
  const carriedTech = techRates.find((t) => t.effective_date <= date) ?? null;
  const carriedOf = (k) => k === "hourly" ? carried?.hourly_rate : k === "flat" ? carried?.flat_rate_per_hour
    : k === "salary" ? carried?.manager_salary : carriedTech ? Number(carriedTech.guarantee_rate) : 0;
  const changing = rateKeys.filter((k) => (rates[k] ?? "") !== "");
  const midWeek = cutover && date && weekStartOf(date, cutover) !== date;
  const first = cutover && date ? firstPayWeek(date, cutover) : null;

  const submit = async () => {
    if (!to) return setErr("Pick the store they're moving to.");
    if (!date) return setErr("Enter their first day at the new store.");
    if (date > tomorrow) return setErr("The transfer date can't be in the future. Transfer them once they've moved.");
    if (startedHere && date <= startedHere) return setErr(`The first day at the new store must be after they started here (${fmtDate(startedHere)}).`);
    if (!position) return setErr(`Pick their position at ${storeRef(to)}.`);
    const out = {};
    for (const k of changing) {
      const n = Number(rates[k]);
      if (!Number.isFinite(n) || n < 0) return setErr(`Enter a ${RATE_FIELDS[k].label.toLowerCase()} rate of 0 or more, or leave it blank to carry it over.`);
      out[k] = Math.round(n * 100) / 100;
    }
    setBusy(true);
    setErr(null);
    const { error } = await onTransfer({ toLocationId: to.id, transferDate: date, position, isStoreManager: privileged && salaried, rates: out });
    setBusy(false);
    if (error) setErr(error.message);
  };

  return (
    <div className="space-y-3 rounded-lg border border-hairline-strong bg-surface-page p-3">
      <p className="text-sm font-medium text-content-primary">Transfer {e.full_name} to another store</p>
      {options.length === 0 ? (
        <p className="text-sm text-content-muted">There is no other store in your area to transfer them to.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="To store">
            <select className={inputCls} value={toId} onChange={(ev) => setToId(ev.target.value)}>
              <option value="">— Pick a store —</option>
              {options.map((s) => <option key={s.id} value={s.id}>#{s.store_number} · {s.name}</option>)}
            </select>
          </Field>
          <Field label="First day at the new store">
            <input type="date" className={inputCls} value={date} max={tomorrow}
              min={startedHere ? addDays(startedHere, 1) : undefined} onChange={(ev) => setDate(ev.target.value)} />
          </Field>
          <Field label="Position there">
            <select className={inputCls} value={position} onChange={(ev) => setPosition(ev.target.value)} disabled={!to}>
              {!position && <option value="">{to ? "— Pick —" : "Pick a store first"}</option>}
              {positions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
      )}
      {privileged && to && canBeSalaried(position) && (
        <label className="inline-flex items-center gap-2 text-sm text-content-primary">
          <input type="checkbox" className="accent-accent" checked={isGm} onChange={(ev) => setIsGm(ev.target.checked)} />
          {position === "office" ? "Salaried at the new location" : `Store manager (salaried) at ${storeRef(to)}`}
        </label>
      )}

      {privileged && to && position && (
        <div className="space-y-2 rounded-md border border-hairline p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-content-secondary">Pay at the new store</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {rateKeys.map((k) => (
              <Field key={k} label={`${RATE_FIELDS[k].label} · ${RATE_FIELDS[k].unit}`}>
                <input className={inputCls} inputMode="decimal" value={rates[k] ?? ""}
                  onChange={(ev) => setRates((r) => ({ ...r, [k]: ev.target.value }))}
                  placeholder={`${money(Number(carriedOf(k) ?? 0))} (same)`} />
              </Field>
            ))}
          </div>
          <p className="text-xs text-content-muted">
            Leave a rate blank to carry it over unchanged.
            {changing.length > 0 && first && ` New rates are first paid in the week of ${fmtShort(first)} – ${fmtShort(weekEndOf(first, cutover))}.`}
          </p>
        </div>
      )}

      {to && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-content-secondary">
          <li>Their record at {storeRef(e.location)} ends on {date ? fmtDate(addDays(date, -1)) : "the day before"}. Weeks already worked there stay exactly as they are.</li>
          <li>A new record starts at {storeRef(to)} on {date ? fmtDate(date) : "that day"}, with the same name, hire date, birthday and ADP IDs{privileged ? ", and their pay rates unless you change them above" : " and the same pay rates"}.</li>
          <li>Their Tech Tracker slot at {storeRef(e.location)} is freed. Their shifts there from that day on become open shifts; time off is removed.</li>
          <li>A Horizon slot at {storeRef(e.location)} is not released automatically. An administrator releases it and assigns one at {storeRef(to)}.</li>
          {!privileged && e.is_store_manager && (
            <li>They're salaried here. At {storeRef(to)} they start on their hourly rates until an administrator marks them salaried.</li>
          )}
        </ul>
      )}
      {to && midWeek && e.is_store_manager && (
        <Msg kind="warn">
          {fmtDate(date)} is mid-week. {storeRef(e.location)} still pays a salaried manager the full weekly salary for that week,
          on top of what {storeRef(to)} pays them for the same week.
          Pick the first day of a pay week ({fmtDate(firstPayWeek(date, cutover))}) to avoid that.
        </Msg>
      )}
      {err && <Msg kind="error">{err}</Msg>}
      <div className="flex justify-end gap-2">
        <GhostBtn type="button" onClick={onCancel} disabled={busy}>Cancel</GhostBtn>
        <PrimaryBtn type="button" onClick={submit} disabled={busy || !to}>
          <ArrowRightLeft className="h-4 w-4" /> {busy ? "Transferring…" : "Transfer"}
        </PrimaryBtn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
function Pay({ e, history, techRates, cutover, onSave, onRemove, onNavigate }) {
  const isTech = e.position === "tech";
  const isSalaried = canBeSalaried(e.position) && e.is_store_manager;
  const weekStart = thisWeekStart(cutover);
  const [type, setType] = useState(isSalaried ? "salary" : "hourly");
  const [amount, setAmount] = useState("");
  // Default: a first rate starts this week; a change to an existing rate
  // starts next week, so the ordinary raise never re-prices a week in
  // progress unless someone chooses to.
  const [date, setDate] = useState(() =>
    history.some((h) => h.effective_date <= weekStart) ? shiftWeek(weekStart, 1, cutover) : weekStart);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // The types this person is actually paid on, per payrollMath: a
  // salaried store manager is paid the salary only; everyone else the
  // greater of hourly(+OT) and flat x turned hours.
  const shownTypes = isSalaried ? ["salary"] : ["hourly", "flat"];
  const first = date ? firstPayWeek(date, cutover) : null;
  // Only a warning when it REPLACES a rate someone was already being paid
  // for those weeks -- a new hire's first rate re-prices nothing.
  const hadRate = history.some((h) => h.rate_type === type && h.effective_date <= weekStart);
  const started = date && hadRate ? weeksAlreadyStarted(date, cutover) : 0;
  const currentTech = techRates.find((t) => t.effective_date <= todayIso()) ?? null;
  const upcoming = history.filter((h) => h.effective_date > weekStart);

  const submit = async (ev) => {
    ev.preventDefault();
    const n = Number(amount);
    if (amount === "" || !Number.isFinite(n) || n < 0) return setMsg({ kind: "error", text: "Enter an amount of 0 or more." });
    if (!date) return setMsg({ kind: "error", text: "Pick the date the rate takes effect." });
    setBusy(true);
    const { error } = await onSave(type, date, Math.round(n * 100) / 100);
    setBusy(false);
    if (error) setMsg({ kind: "error", text: error.message });
    else { setMsg({ kind: "ok", text: "Pay change saved." }); setAmount(""); }
  };

  return (
    <Section title="Pay" right={<span className="inline-flex items-center gap-1 text-[11px] text-content-muted"><Lock className="h-3 w-3" /> admin / master only</span>}>
      {/* In force this week */}
      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        {shownTypes.map((k) => {
          const row = rowOn(history, k, weekStart);
          const t = RATE_TYPES.find((x) => x.key === k);
          return (
            <div key={k} className="rounded-lg border border-hairline bg-surface-page p-3">
              <p className="text-xs text-content-secondary">{t.label} <span className="text-content-muted">· {t.unit}</span></p>
              <p className="pgw-display text-lg font-bold text-content-primary">{row ? money(Number(row.amount)) : "—"}</p>
              <p className="text-xs text-content-muted">
                {!row ? "Not set" : row.effective_date === LEGACY_DATE ? "Rate on file before history began" : `Since ${fmtDate(row.effective_date)}`}
                {row?.source === "tech_tracker" ? " · Tech Tracker" : ""}
              </p>
            </div>
          );
        })}
        {isTech && (
          <div className="rounded-lg border border-hairline bg-surface-page p-3">
            <p className="text-xs text-content-secondary">Guarantee <span className="text-content-muted">· per hour</span></p>
            <p className="pgw-display text-lg font-bold text-content-primary">{currentTech ? money(Number(currentTech.guarantee_rate)) : "—"}</p>
            <p className="text-xs text-content-muted">{currentTech ? `Since ${fmtDate(currentTech.effective_date)} · Tech Tracker` : "Not set"}</p>
          </div>
        )}
      </div>
      <p className="mb-4 text-xs text-content-muted">
        Shown for the current pay week ({fmtShort(weekStart)} – {fmtShort(weekEndOf(weekStart, cutover))}).
        {upcoming.length > 0 && ` ${upcoming.length} change${upcoming.length === 1 ? " is" : "s are"} scheduled for later weeks.`}
      </p>

      {isTech && (
        <p className="mb-4 flex flex-wrap items-center gap-1.5 rounded-md border border-hairline bg-surface-page px-3 py-2 text-xs text-content-secondary">
          <Wrench className="h-3.5 w-3.5" /> A technician's flat and guarantee rates are set in the Tech Tracker.
          {onNavigate && (
            <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => onNavigate("techtracker")}>
              Open Tech Tracker
            </button>
          )}
        </p>
      )}

      {/* Change pay */}
      <form onSubmit={submit} className="space-y-3 rounded-lg border border-hairline p-3">
        <p className="text-sm font-medium text-content-primary">Change pay</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Type">
            <select className={inputCls} value={type} onChange={(ev) => setType(ev.target.value)}>
              {RATE_TYPES.map((t) => (
                <option key={t.key} value={t.key} disabled={isTech && t.key === "flat"}>
                  {t.label}{isTech && t.key === "flat" ? " (Tech Tracker)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Amount ${RATE_TYPES.find((t) => t.key === type)?.unit ?? ""}`}>
            <input className={inputCls} value={amount} onChange={(ev) => setAmount(ev.target.value)} inputMode="decimal" placeholder="0.00" />
          </Field>
          <Field label="Takes effect">
            <input type="date" className={inputCls} value={date} onChange={(ev) => setDate(ev.target.value)} />
          </Field>
        </div>
        {first && (
          <p className="text-xs text-content-secondary">
            First paid in the week of <span className="font-medium text-content-primary">{fmtShort(first)} – {fmtShort(weekEndOf(first, cutover))}</span>.
            {first !== date && " A change dated mid-week starts with the next pay week, because overtime is worked out on the whole week."}
          </p>
        )}
        {started > 0 && (
          <Msg kind="warn">
            This re-prices {started} pay week{started === 1 ? "" : "s"} that {started === 1 ? "has" : "have"} already started, including the current one.
            Only do this to correct a rate that was wrong.
          </Msg>
        )}
        {msg && <Msg kind={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</Msg>}
        <div className="flex justify-end">
          <PrimaryBtn type="submit" disabled={busy}>{busy ? "Saving…" : "Save change"}</PrimaryBtn>
        </div>
      </form>

      {/* History */}
      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-secondary">Rate history</p>
        {history.length === 0 ? (
          <p className="text-sm text-content-muted">No rates on file yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-content-muted">
                <th className="py-1 font-medium">Takes effect</th>
                <th className="py-1 font-medium">Type</th>
                <th className="py-1 text-right font-medium">Amount</th>
                <th className="py-1 pl-3 font-medium">From</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {history.map((h) => (
                <tr key={h.rate_type + h.effective_date}>
                  <td className="py-1.5 text-content-primary">
                    {h.effective_date === LEGACY_DATE ? "On file" : fmtDate(h.effective_date)}
                    {h.effective_date > weekStart && <span className="ml-1.5 rounded border border-hairline-strong px-1 text-[10px] uppercase text-content-secondary">Scheduled</span>}
                  </td>
                  <td className="py-1.5 text-content-secondary">{typeLabel(h.rate_type)}</td>
                  <td className="py-1.5 text-right font-medium text-content-primary">{money(Number(h.amount))}</td>
                  <td className="py-1.5 pl-3 text-content-muted">{SOURCE_LABEL[h.source] ?? h.source}</td>
                  <td className="py-1.5 text-right">
                    {h.source === "manual" && (
                      <RemoveRate onRemove={() => onRemove(h)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Section>
  );
}

function RemoveRate({ onRemove }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm)
    return (
      <button type="button" onClick={() => setConfirm(true)} className="text-content-muted hover:text-danger" title="Withdraw this change">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    );
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <button type="button" className="font-medium text-danger hover:underline" onClick={onRemove}>Withdraw</button>
      <button type="button" className="text-content-muted hover:underline" onClick={() => setConfirm(false)}>Keep</button>
    </span>
  );
}
