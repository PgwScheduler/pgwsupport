import React, { useMemo, useState } from "react";
import { AlertTriangle, FileSpreadsheet, Info } from "lucide-react";
import { useTechRanks } from "../../hooks/useTechRanks.js";
import { DateRangeControl } from "../DateRangeControl.jsx";
import { Card, GhostBtn } from "../ui.jsx";
import {
  COMPANY_TOP, DIVISION_TOP, TITLE_FILL, buildTechRanks, medalFor, periodLabels,
} from "../../lib/techRanks.js";

// =====================================================================
// Tech Ranks (migration 74) — the "Tech ranks" workbook for any range:
// each division's top 10 and the company top 20 by hours turned, ranks
// 1-3 in gold, silver and bronze. Every number comes from lib/techRanks.js.
// =====================================================================

const hrs = (v) => (v === null || v === undefined ? "" : Math.round(v).toLocaleString());
const pct = (v) => (v === null || v === undefined ? "" : `${Math.round(v * 100)}%`);

const medalStyle = (rank) => {
  const m = medalFor(rank);
  return m ? { backgroundColor: `#${m.fill}`, color: `#${m.font}`, fontWeight: 600 } : undefined;
};

function TechRow({ t, rank, market }) {
  const st = t ? medalStyle(t.rank) : undefined;
  return (
    <tr style={st} className={st ? "" : "hover:bg-surface-overlay"} title={t && medalFor(t.rank) ? medalFor(t.rank).label : undefined}>
      <td className="px-2 py-1 text-left tabular-nums">{rank}</td>
      <td className="whitespace-nowrap px-2 py-1 text-center" title={t?.storeCount > 1 ? `Worked at ${t.storeCount} stores; ranked under ${t.storeName}` : t?.storeName}>
        {t ? t.name : <span className={st ? "" : "text-content-muted"}>·</span>}
      </td>
      {market && <td className="whitespace-nowrap px-2 py-1 text-center">{t?.division}</td>}
      <td className="px-2 py-1 text-center tabular-nums">{t ? hrs(t.hoursTurned) : ""}</td>
      <td className="px-2 py-1 text-center tabular-nums">{t ? hrs(t.hoursWorked) : ""}</td>
      <td className="px-2 py-1 text-center tabular-nums">{t ? pct(t.proficiency) : ""}</td>
    </tr>
  );
}

function Head({ market }) {
  return (
    <thead className="bg-surface-overlay text-[11px] text-content-secondary">
      <tr>
        <th className="px-2 py-1.5 text-left font-medium">Rank</th>
        <th className="px-2 py-1.5 font-medium">Name</th>
        {market && <th className="px-2 py-1.5 font-medium">Market</th>}
        <th className="whitespace-nowrap px-2 py-1.5 font-medium">Hrs Turned</th>
        <th className="whitespace-nowrap px-2 py-1.5 font-medium">Hrs Worked</th>
        <th className="px-2 py-1.5 font-medium">Proficiency</th>
      </tr>
    </thead>
  );
}

function DivisionCard({ d }) {
  return (
    <Card className="flex min-w-0 flex-col overflow-hidden">
      <h3 className="px-3 pb-2 pt-3 text-center text-sm font-bold text-content-primary underline underline-offset-2">{d.label}</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs text-content-primary">
          <Head />
          <tbody className="divide-y divide-hairline">
            {Array.from({ length: DIVISION_TOP }, (_, i) => <TechRow key={i} t={d.top[i]} rank={i + 1} />)}
          </tbody>
        </table>
      </div>
      <ul className="mt-auto border-t border-hairline px-3 py-2 text-[11px] text-content-muted">
        {d.stores.map((s) => (
          <li key={s.store_number} className="flex items-center gap-1.5">
            <span className={"inline-block h-1.5 w-1.5 rounded-full " + (s.has_data ? "bg-success" : "bg-hairline-strong")}
              title={s.has_data ? "Has tech hours in this range" : "No tech hours entered in this range"} />
            {s.name}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function TechRanksView() {
  const r = useTechRanks();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  const report = useMemo(() => (r.raw ? buildTechRanks(r.raw) : null), [r.raw]);
  const period = r.from && r.to ? periodLabels(r.from, r.to) : null;

  const doExport = async () => {
    setExporting(true); setExportError(null);
    try {
      const { downloadTechRanksWorkbook } = await import("../../lib/techRanksWorkbook.js");
      await downloadTechRanksWorkbook(report, { from: r.from, to: r.to });
    } catch (e) {
      setExportError(e.message ?? String(e));
    }
    setExporting(false);
  };

  return (
    <div className="space-y-4">
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeControl align="left" />
          <div className="ml-auto">
            <GhostBtn onClick={doExport} disabled={!report || exporting}>
              <FileSpreadsheet className="h-4 w-4" /> {exporting ? "Building…" : "Export to Excel"}
            </GhostBtn>
          </div>
        </div>
      </Card>

      {r.error && (
        <p className="flex items-center gap-2 rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">
          <AlertTriangle className="h-4 w-4" /> {r.error}
        </p>
      )}
      {exportError && <p className="rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{exportError}</p>}

      {report && !r.loading && (
        <p className={"flex items-start gap-2 rounded-md border px-3 py-2 text-xs " +
          (report.storesWithData < report.storeCount ? "border-warning-border bg-warning-tint text-warning" : "border-hairline bg-surface-overlay text-content-secondary")}>
          <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            <strong>{report.storesWithData} of {report.storeCount} Midas stores</strong> have tech hours for {period?.long}.
            {report.storesWithData < report.storeCount && " Stores without any are marked with a grey dot under their division."}
            {" "}Ranked by hours turned; a tie goes to the higher proficiency. Managers are not ranked. A tech who worked at more than one store is ranked once, under the store where they worked the most hours.
          </span>
        </p>
      )}

      {r.loading && <p className="text-sm text-content-secondary">Loading…</p>}

      {report && !r.loading && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            {report.divisions.map((d) => <DivisionCard key={d.id} d={d} />)}
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <Card className="min-w-0 overflow-hidden">
              <div className="px-3 py-2 text-center" style={{ backgroundColor: `#${TITLE_FILL}` }}>
                <h3 className="text-lg font-bold tracking-wide text-white">TOP {COMPANY_TOP} PGW TECHS - {period?.title}</h3>
              </div>
              {/* The workbook's #5B6573 is unreadable on the dark portal;
                  the Excel export keeps it. */}
              <p className="py-1.5 text-center text-xs font-bold italic text-content-muted">Ranked by Hrs Turned</p>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs text-content-primary">
                  <Head market />
                  <tbody className="divide-y divide-hairline">
                    {report.top.length === 0
                      ? <tr><td colSpan={6} className="px-3 py-6 text-center text-content-muted">No tech hours in this range.</td></tr>
                      : report.top.map((t) => <TechRow key={t.id} t={t} rank={t.rank} market />)}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <table className="text-xs text-content-primary">
                <thead className="bg-surface-overlay text-[11px] text-content-secondary">
                  <tr>
                    <th className="border border-hairline px-3 py-1.5 font-semibold">Market</th>
                    <th className="whitespace-nowrap border border-hairline px-3 py-1.5 font-semibold">
                      Techs in {period?.short ? `${period.short} ` : ""}Top {COMPANY_TOP}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.counts.map((m) => (
                    <tr key={m.label}>
                      <td className="whitespace-nowrap border border-hairline px-3 py-1 text-center">{m.label}</td>
                      <td className="border border-hairline px-3 py-1 text-center tabular-nums">{m.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
