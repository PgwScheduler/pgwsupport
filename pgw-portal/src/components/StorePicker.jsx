import React from "react";
import { MapPin } from "lucide-react";
import { T } from "./ui.jsx";

export function StorePicker({ stores, value, onChange, disabled }) {
  if (disabled) {
    const s = stores.find((s) => s.id === value) ?? stores[0];
    if (!s) return null;
    return (
      <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm">
        <MapPin className="h-4 w-4" style={{ color: T.accent }} />
        <span className="font-medium text-slate-100">
          #{s.store_number} · {s.name}
        </span>
      </div>
    );
  }

  return (
    <div className="relative">
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-md border border-slate-700 bg-slate-800 py-2 pl-9 pr-8 text-sm font-medium text-slate-100 outline-none focus:border-slate-500"
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            #{s.store_number} — {s.name}
          </option>
        ))}
      </select>
      <MapPin className="pointer-events-none absolute left-3 top-2.5 h-4 w-4" style={{ color: T.accent }} />
    </div>
  );
}
