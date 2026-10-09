import React, { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { useTicEntryStatus } from "../../hooks/useTicEntryStatus.js";
import { shortDayLabel } from "../../lib/ticEntry.js";
import { Card } from "../ui.jsx";

// "Who hasn't entered yesterday's tic sheet" (migration 80), for district
// and regional managers and up. Yesterday = the last working day (Mon-Sat,
// not a holiday), so on Monday it is Saturday.
function DayStrip({ days }) {
  return (
    <div className="flex items-center gap-1" aria-label="Last working days, oldest to newest">
      {days.map((d) => (
        <span
          key={d.date}
          title={`${shortDayLabel(d.date)} — ${d.entered ? "entered" : "not entered"}`}
          className={"h-2.5 w-2.5 rounded-full " + (d.entered ? "bg-success" : "bg-danger")}
        />
      ))}
    </div>
  );
}

function lastEnteredLabel(iso) {
  return iso ? `Last entered ${shortDayLabel(iso)}` : "No entries on record";
}

function StoreRow({ s, showDistrict, onOpenStore }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-content-primary">
          <span className="font-semibold">#{s.store_number}</span> {s.store_name}
        </p>
        <p className="text-xs text-content-muted">
          {showDistrict && s.district_name ? `${s.district_name} · ` : ""}
          {lastEnteredLabel(s.last_entered)}
        </p>
      </div>
      <DayStrip days={s.days} />
      <button
        type="button"
        onClick={() => onOpenStore(s.location_id)}
        className="inline-flex items-center gap-0.5 rounded-md px-2 py-1 text-xs font-medium text-content-secondary hover:bg-surface-overlay hover:text-content-primary"
      >
        Tic sheet <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

export function MissingEntriesCard({ onOpenStore }) {
  const { data, loading, error } = useTicEntryStatus(7);
  const [showAll, setShowAll] = useState(false);

  if (loading) return null;
  if (error) {
    return (
      <p className="rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">
        Tic sheet entry check: {error}
      </p>
    );
  }
  if (!data || data.stores.length === 0) return null;

  const { latestDate, stores, missing, enteredCount } = data;
  const showDistrict = new Set(stores.map((s) => s.district_name)).size > 1;
  const list = showAll ? stores : missing;

  return (
    <Card className="p-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="pgw-display flex items-center gap-2 text-sm font-bold text-content-primary">
          {missing.length ? (
            <AlertTriangle className="h-4 w-4 text-danger" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-success" />
          )}
          Tic sheet entry — {shortDayLabel(latestDate)}
        </h3>
        <span
          className={
            "rounded-full border px-2 py-0.5 text-xs font-medium " +
            (missing.length ? "border-danger-border bg-danger-tint text-danger" : "border-success-border bg-success-tint text-success")
          }
        >
          {enteredCount} of {stores.length} entered
        </span>
      </div>

      {missing.length === 0 && !showAll && (
        <p className="text-sm text-content-secondary">Every store has entered {shortDayLabel(latestDate)}.</p>
      )}
      {missing.length > 0 && !showAll && (
        <p className="text-sm text-content-secondary">
          {missing.length} store{missing.length === 1 ? " has" : "s have"} not entered {shortDayLabel(latestDate)}. Dots show the last {stores[0].days.length} working days, oldest first.
        </p>
      )}

      {list.length > 0 && (
        <ul className="mt-1 divide-y divide-hairline">
          {list.map((s) => (
            <StoreRow key={s.location_id} s={s} showDistrict={showDistrict} onOpenStore={onOpenStore} />
          ))}
        </ul>
      )}

      {stores.length > missing.length && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 text-xs font-medium text-content-secondary hover:text-content-primary"
        >
          {showAll ? "Show only missing" : `Show all ${stores.length} stores`}
        </button>
      )}
    </Card>
  );
}
