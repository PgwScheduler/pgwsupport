import React, { useMemo } from "react";
import { Check, Minus } from "lucide-react";
import { storeTree, storeLabel } from "../../lib/reportSpec.js";

// The store picker. Every store in it is one the signed-in user can
// already reach — `stores` comes from AuthProvider, which reads
// locations under can_access_location(). A district manager therefore
// sees their district and nothing else, without this component knowing
// what a district manager is.
//
// The select-all shortcuts are per region and per district because that
// is how the people using this talk about their stores. They act on the
// stores PRESENT IN THIS LIST, so "all in region" for a district manager
// selects their district — the shortcut cannot reach past the scope.

function Box({ state, onClick, children, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={"flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-surface-overlay " + className}
    >
      <span
        className={
          "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border " +
          (state === "none" ? "border-hairline-strong bg-surface-input" : "border-transparent")
        }
        style={state === "none" ? {} : { backgroundColor: "var(--accent)", color: "var(--on-accent)" }}
      >
        {state === "all" && <Check className="h-3 w-3" />}
        {state === "some" && <Minus className="h-3 w-3" />}
      </span>
      {children}
    </button>
  );
}

const stateOf = (ids, selected) => {
  const n = ids.filter((id) => selected.includes(id)).length;
  return n === 0 ? "none" : n === ids.length ? "all" : "some";
};

export function StoreMultiSelect({ stores, selected, onChange }) {
  const tree = useMemo(() => storeTree(stores), [stores]);
  const allIds = useMemo(() => stores.map((s) => s.id), [stores]);

  const setMany = (ids, on) => {
    const set = new Set(selected);
    for (const id of ids) (on ? set.add(id) : set.delete(id));
    onChange([...set]);
  };
  const toggleGroup = (ids) => setMany(ids, stateOf(ids, selected) !== "all");

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-content-muted">
          {selected.length} of {stores.length} selected
        </span>
        <div className="flex gap-2 text-xs">
          <button type="button" onClick={() => onChange(allIds)} className="text-accent-text hover:underline">
            All
          </button>
          <span className="text-content-muted">·</span>
          <button type="button" onClick={() => onChange([])} className="text-content-muted hover:underline">
            None
          </button>
        </div>
      </div>

      <div className="max-h-72 min-h-0 overflow-auto rounded-md border border-hairline bg-surface-page p-1.5">
        {tree.map((region) => {
          const regionIds = region.districts.flatMap((d) => d.stores.map((s) => s.id));
          return (
            <div key={region.id ?? "~none"} className="mb-1.5 last:mb-0">
              <Box
                state={stateOf(regionIds, selected)}
                onClick={() => toggleGroup(regionIds)}
                className="text-[11px] font-semibold uppercase tracking-wide text-content-secondary"
              >
                {region.name}
                <span className="ml-auto text-[10px] font-normal normal-case text-content-muted">
                  region · {regionIds.length}
                </span>
              </Box>

              {region.districts.map((district) => {
                const districtIds = district.stores.map((s) => s.id);
                return (
                  <div key={district.id ?? "~none"} className="ml-3">
                    <Box
                      state={stateOf(districtIds, selected)}
                      onClick={() => toggleGroup(districtIds)}
                      className="text-xs font-medium text-content-secondary"
                    >
                      {district.name}
                      <span className="ml-auto text-[10px] font-normal text-content-muted">
                        district · {districtIds.length}
                      </span>
                    </Box>

                    {district.stores.map((s) => (
                      <div key={s.id} className="ml-3">
                        <Box
                          state={selected.includes(s.id) ? "all" : "none"}
                          onClick={() => setMany([s.id], !selected.includes(s.id))}
                          className="text-xs text-content-primary"
                        >
                          {storeLabel(s)}
                        </Box>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
