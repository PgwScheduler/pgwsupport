import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { DEFAULT_PRESET, rangeFor, today } from "../lib/dateRange.js";

// The selected range follows the user between screens: someone reviewing
// last month on the Dashboard should not have to re-pick it on Payroll.
//
// It lives in sessionStorage, not localStorage, because the task asks for
// exactly that lifetime — persist within a session, reset to month to
// date on a new one. sessionStorage is per-tab and dies with the tab,
// which is the definition of "a session" here. localStorage would carry
// a stale range across days and quietly answer a different question than
// the one the user thinks they asked.
//
// Every accessor is wrapped: a private window, cleared site data, or a
// browser set to block storage makes these throw rather than return null.
const KEY = "pgw.dateRange";

const read = () => {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v?.preset) return null;
    if (v.preset === "custom" && !(v.from && v.to)) return null;
    return v;
  } catch {
    return null;
  }
};

const write = (v) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable — the range still works, it just won't persist */
  }
};

const DateRangeContext = createContext(null);

export function DateRangeProvider({ children }) {
  const [state, setState] = useState(() => {
    const saved = read();
    if (saved) return saved;
    const r = rangeFor(DEFAULT_PRESET);
    return { preset: DEFAULT_PRESET, ...r };
  });

  // A preset is re-resolved against today whenever it is chosen, so a
  // session left open overnight does not keep yesterday's "today".
  const setPreset = useCallback((preset) => {
    const next =
      preset === "custom"
        ? { preset, from: state.from, to: state.to }
        : { preset, ...rangeFor(preset) };
    setState(next);
    write(next);
  }, [state.from, state.to]);

  const setCustom = useCallback((from, to) => {
    // Tolerate a backwards pick rather than refusing it — the user
    // clicked two dates and meant the span between them.
    const [a, b] = from <= to ? [from, to] : [to, from];
    const next = { preset: "custom", from: a, to: b };
    setState(next);
    write(next);
  }, []);

  const value = useMemo(
    () => ({ ...state, today: today(), setPreset, setCustom }),
    [state, setPreset, setCustom]
  );

  return <DateRangeContext.Provider value={value}>{children}</DateRangeContext.Provider>;
}

export function useDateRange() {
  const ctx = useContext(DateRangeContext);
  if (!ctx) throw new Error("useDateRange must be used inside a DateRangeProvider");
  return ctx;
}
