import React, { useEffect, useState } from "react";
import { PackageSearch } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
import { usePartsReconAccess, usePartsReconMonths } from "../../hooks/usePartsRecon.js";
import { Empty, SectionHeader } from "../ui.jsx";
import { ItemsPanel } from "./ItemsPanel.jsx";
import { TasksPanel } from "./TasksPanel.jsx";
import { TrackerPanel } from "./TrackerPanel.jsx";
import { DeductionPanel } from "./DeductionPanel.jsx";
import { ImportPanel } from "./ImportPanel.jsx";
import { Notice, Pill, Segmented, selectSm } from "./shared.jsx";

// Parts Recon (migration 90). The Python recon run stays where it is; this
// is everything after it: store replies, AP review, the AP to-do list and
// the live tracker. Who sees what is decided in SQL (see the migration).

export function PartsReconView() {
  const { profile, role } = useAuth();
  const access = usePartsReconAccess();
  const months = usePartsReconMonths();
  const [month, setMonth] = useState(null);
  const [tab, setTab] = useState("items");
  const isAp = !!access.data?.is_ap;
  const isStore = role === "store";

  useEffect(() => {
    if (!month && months.data?.length) setMonth(months.data[0].month);
  }, [months.data, month]);

  const monthRow = months.data?.find((m) => m.month === month) ?? null;
  const tabs = [
    ["items", isStore ? "Our items" : "Store items"],
    ...(isAp ? [["tasks", "AP to-do"]] : []),
    ...(!isStore ? [["tracker", "Tracker"]] : []),
    ...(isAp ? [["deductions", "Deductions"]] : []),
    ...(isAp ? [["import", "Import & month"]] : []),
  ];
  const current = tabs.some(([k]) => k === tab) ? tab : "items";

  // Only the first load blanks the page; a reload after a reply keeps the panels mounted.
  if ((access.loading && !access.data) || (months.loading && !months.data)) return <p className="text-sm text-content-muted">Loading…</p>;
  if (access.error || months.error) return <Notice tone="error">{access.error || months.error}</Notice>;

  const header = (
    <SectionHeader
      title="Parts Recon"
      subtitle={isStore ? "Vendor charges that don't match your ROs, and what we need from you" : "Monthly parts reconciliation: store replies, AP review and the tracker"}
      action={months.data?.length > 0 && (
        <div className="flex items-center gap-2">
          {monthRow && (monthRow.closed_at ? <Pill tone="muted">Closed</Pill>
            : monthRow.released_at ? <Pill tone="good">Open for replies</Pill> : <Pill tone="warn">Not released</Pill>)}
          <select className={selectSm} value={month ?? ""} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            {months.data.map((m) => <option key={m.month} value={m.month}>{m.label}</option>)}
          </select>
        </div>
      )}
    />
  );

  if (!months.data?.length) {
    return (
      <div>
        {header}
        {isAp
          ? <ImportPanel month={null} monthRow={null} managesTeam={!!access.data?.manages_team}
              onImported={(m) => { setMonth(m); months.reload(); }} onChanged={months.reload} />
          : <Empty icon={PackageSearch} title="No parts recon yet" hint="When AP releases a month, your items show up here." />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      {tabs.length > 1 && <Segmented options={tabs} value={current} onChange={setTab} />}
      {current === "items" && (
        <ItemsPanel key={month + (isStore ? profile?.location_id : "")} month={month} monthRow={monthRow} isAp={isAp}
          isStore={isStore} storeLocationId={profile?.location_id} onChanged={months.reload}
          canCredit={!isAp && !!access.data?.can_answer} />
      )}
      {current === "tasks" && isAp && <TasksPanel key={month} month={month} />}
      {current === "tracker" && <TrackerPanel key={month} month={month} />}
      {current === "deductions" && isAp && <DeductionPanel key={month} month={month} monthRow={monthRow} />}
      {current === "import" && isAp && (
        <ImportPanel month={month} monthRow={monthRow} managesTeam={!!access.data?.manages_team}
          onImported={(m) => { setMonth(m); months.reload(); }} onChanged={months.reload} />
      )}
    </div>
  );
}
