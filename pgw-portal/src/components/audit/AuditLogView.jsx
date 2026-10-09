import React, { useMemo, useState } from "react";
import { ArrowRight, FileDown, History, Repeat, X } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
import { useAuditLog } from "../../hooks/useAuditLog.js";
import { DateRangeControl } from "../DateRangeControl.jsx";
import { Card, Empty, GhostBtn, SectionHeader, T } from "../ui.jsx";
import { downloadFile } from "../../lib/csv.js";
import {
  AREAS, actionVerb, actorLabel, areaLabel, auditCsv, changesOf, describeRecord, fieldLabel, formatValue,
  groupByTxid, roleName, tableLabel, whenLabel,
} from "../../lib/auditLog.js";

// =====================================================================
// Change Log (migration 81) — who changed what, when, for payroll, pay
// rates, the tic sheet, adjustments, bonus inputs, employees and logins.
// Read-only: the log is append-only in the database. What each role sees
// is decided by audit_log's RLS, not by this screen.
// =====================================================================

const selectCls =
  "rounded-md border border-hairline-strong bg-surface-overlay px-2.5 py-2 text-sm text-content-primary outline-none focus:border-hairline-strong";

function Change({ c, lookups, action }) {
  const from = formatValue(c.field, c.from, lookups);
  const to = formatValue(c.field, c.to, lookups);
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
      <span className="text-content-secondary">{fieldLabel(c.field)}:</span>
      {action === "update" && (
        <>
          <span className="text-content-muted line-through decoration-content-muted/60">{from}</span>
          <ArrowRight className="h-3 w-3 self-center text-content-muted" />
        </>
      )}
      <span className="font-medium text-content-primary">{action === "delete" ? from : to}</span>
    </li>
  );
}

function Entry({ row, lookups, onPickEmployee, showStore }) {
  const changes = changesOf(row);
  const record = describeRecord(row);
  return (
    <div className="py-2.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide" style={{ backgroundColor: T.accentSoftBg, color: T.accentSoftText }}>
          {areaLabel(row.area)}
        </span>
        {showStore && row.store_number && <span className="font-medium text-content-primary">#{row.store_number}</span>}
        {tableLabel(row.table_name) !== areaLabel(row.area) && <span className="text-content-primary">{tableLabel(row.table_name)}</span>}
        {record && <span className="text-content-secondary">{record}</span>}
        {row.subject_name && (
          row.employee_id ? (
            <button onClick={() => onPickEmployee(row)} className="text-content-primary underline decoration-dotted underline-offset-2 hover:text-accent" title="Show only this person's history">
              · {row.subject_name}
            </button>
          ) : <span className="text-content-primary">· {row.subject_name}</span>
        )}
        <span className="text-content-muted">{actionVerb(row)}</span>
      </p>
      {changes.length > 0 && <ul className="mt-1 space-y-0.5 pl-1">{changes.map((c) => <Change key={c.field} c={c} lookups={lookups} action={row.action} />)}</ul>}
    </div>
  );
}

function Group({ g, lookups, onPickEmployee }) {
  const first = g.rows[0];
  const stores = new Set(g.rows.map((r) => r.store_number).filter(Boolean));
  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-2">
        <p className="text-sm">
          <span className="font-semibold text-content-primary">{actorLabel(first)}</span>
          {first.actor_role && <span className="text-content-muted"> · {roleName(first.actor_role)}</span>}
          {stores.size === 1 && <span className="text-content-muted"> · #{[...stores][0]}</span>}
          {g.isTransfer && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-content-secondary"><Repeat className="h-3 w-3" /> Transfer</span>
          )}
        </p>
        <p className="text-xs tabular-nums text-content-muted">{whenLabel(first.at)} ET</p>
      </div>
      <div className="divide-y divide-hairline">
        {g.rows.map((r) => <Entry key={r.id} row={r} lookups={lookups} onPickEmployee={onPickEmployee} showStore={stores.size > 1} />)}
      </div>
    </Card>
  );
}

export function AuditLogView() {
  const { stores, role } = useAuth();
  const [locationId, setLocationId] = useState("");
  const [area, setArea] = useState("");
  const [person, setPerson] = useState(null); // { id, name }
  const { from, to, rows, loading, more, error, loadOlder, names } = useAuditLog({ locationId, area, employeeId: person?.id });
  const lookups = useMemo(() => ({ stores, ...names }), [stores, names]);
  const groups = useMemo(() => groupByTxid(rows), [rows]);
  const isLeadership = role === "admin" || role === "master";
  const areas = isLeadership ? AREAS : AREAS.filter((a) => a.key !== "pay_rates" && a.key !== "access");

  const exportCsv = () => downloadFile(`change-log_${from}_${to}.csv`, auditCsv(rows, lookups), "text/csv;charset=utf-8");

  return (
    <div>
      <SectionHeader
        title="Change Log"
        subtitle={isLeadership
          ? "Every change to payroll, pay rates, tic sheets, adjustments, bonus inputs, employees and logins. Nothing here can be edited or deleted."
          : "Every change to payroll, tic sheets, adjustments, bonus inputs and employees at your stores. Nothing here can be edited or deleted."}
        action={<GhostBtn onClick={exportCsv} disabled={!rows.length}><FileDown className="h-4 w-4" /> Export CSV</GhostBtn>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DateRangeControl align="left" />
        <select className={selectCls} value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Store">
          <option value="">All my stores</option>
          {stores.map((s) => <option key={s.id} value={s.id}>#{s.store_number} — {s.name}</option>)}
        </select>
        <select className={selectCls} value={area} onChange={(e) => setArea(e.target.value)} aria-label="Area">
          <option value="">Everything</option>
          {areas.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
        {person && (
          <button onClick={() => setPerson(null)} className="inline-flex items-center gap-1 rounded-full border border-hairline-strong bg-surface-overlay px-3 py-1.5 text-sm text-content-primary hover:bg-hairline-strong" title="Clear the person filter">
            {person.name} <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {error && <Card className="mb-4 px-4 py-3 text-sm text-red-400">{error}</Card>}

      {!loading && !error && rows.length === 0 ? (
        <Empty icon={History} title="No changes in this range" hint="Try a wider date range or clear a filter. Logging started when migration 81 was applied." />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <Group key={g.rows[0].id} g={g} lookups={lookups} onPickEmployee={(r) => setPerson({ id: r.employee_id, name: r.subject_name })} />
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-center">
        {loading ? <p className="text-sm text-content-muted">Loading…</p>
          : more && <GhostBtn onClick={loadOlder}>Load older changes</GhostBtn>}
      </div>
    </div>
  );
}
