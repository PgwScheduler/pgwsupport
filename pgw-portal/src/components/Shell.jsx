import React, { useState } from "react";
import {
  LogOut, LayoutDashboard, GraduationCap, Banknote, Clock, CalendarDays, FileText,
  ChevronRight, Eye, ShieldCheck, Building2, Users, KeyRound,
} from "lucide-react";
import { useAuth } from "../context/AuthProvider.jsx";
import { LogoMark, T } from "./ui.jsx";
import { StorePicker } from "./StorePicker.jsx";
import { ChangePasswordModal } from "./ChangePasswordModal.jsx";

const NAV = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "training", label: "Training", icon: GraduationCap },
  { key: "drawer", label: "Cash Drawer", icon: Banknote },
  { key: "hours", label: "Employee Hours", icon: Clock },
  { key: "schedule", label: "Employee Schedule", icon: CalendarDays },
  { key: "documents", label: "Documents", icon: FileText },
];

const MASTER_NAV = [{ key: "users", label: "Users", icon: Users }];

export const ROLE_LABELS = {
  store: "Store Manager",
  district: "District Manager",
  regional: "Regional Manager",
  admin: "Admin",
  master: "Master",
};

function scopeLabel(profile, storeCount) {
  switch (profile?.role) {
    case "store":
      return profile.location?.name ?? "Your store";
    case "district":
      return profile.district?.name ?? "Your district";
    case "regional":
      return profile.region?.name ?? "Your region";
    case "admin":
      return `All ${storeCount} stores`;
    case "master":
      return `All ${storeCount} stores + controls`;
    default:
      return "—";
  }
}

export function Shell({ view, setView, children }) {
  const { profile, role, stores, currentStore, selectedStoreId, setSelectedStoreId, signOut } = useAuth();
  const [showChangePassword, setShowChangePassword] = useState(false);

  return (
    <div className="pgw-root flex min-h-screen bg-surface-page text-content-primary">
      {/* Sidebar */}
      <aside className="hidden w-60 flex-shrink-0 flex-col justify-between border-r border-hairline bg-surface-card p-4 md:flex">
        <div>
          <div className="mb-6 px-1">
            <LogoMark />
            <p className="mt-1.5 text-[11px] uppercase tracking-widest text-content-muted">Operations Portal</p>
          </div>
          <nav className="space-y-1">
            {[...NAV, ...(role === "master" ? MASTER_NAV : [])].map((n) => {
              const active = view === n.key;
              return (
                <button
                  key={n.key}
                  onClick={() => setView(n.key)}
                  style={active ? { backgroundColor: T.accent, color: T.accentText } : {}}
                  className={"flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium " + (active ? "" : "text-content-secondary hover:bg-surface-overlay")}
                >
                  <n.icon className="h-4 w-4" /> {n.label}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="rounded-lg border border-hairline bg-surface-page p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-content-muted">
            <Eye className="h-3 w-3" /> You can see
          </p>
          <p className="pgw-display mt-1 text-sm font-bold text-content-primary">{scopeLabel(profile, stores.length)}</p>
          <p className="mt-0.5 text-xs text-content-muted">
            {stores.length} store{stores.length === 1 ? "" : "s"}
          </p>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline bg-surface-card px-5 py-3">
          <StorePicker stores={stores} value={selectedStoreId} onChange={setSelectedStoreId} disabled={role === "store"} />
          <div className="flex items-center gap-3">
            <div className="hidden flex-col items-end sm:flex">
              <span className="text-sm font-medium text-content-primary">{profile?.full_name || "—"}</span>
              <span className="text-xs text-content-muted">{ROLE_LABELS[role] ?? role}</span>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-overlay text-xs font-bold text-content-primary">
              {role === "master" ? <ShieldCheck className="h-4 w-4" style={{ color: T.accent }} /> : "PG"}
            </div>
            <button
              onClick={() => setShowChangePassword(true)}
              className="text-content-muted hover:text-content-primary"
              title="Change password"
            >
              <KeyRound className="h-4 w-4" />
            </button>
            <button onClick={signOut} className="text-content-muted hover:text-content-primary" title="Sign out">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}

        {currentStore && (
          <div className="flex items-center gap-1.5 border-b border-hairline bg-surface-card px-5 py-2 text-xs text-content-muted">
            <Building2 className="h-3.5 w-3.5" />
            <span>{currentStore.district?.region?.name ?? "—"}</span>
            <ChevronRight className="h-3 w-3" />
            <span>{currentStore.district?.name ?? "—"}</span>
            <ChevronRight className="h-3 w-3" />
            <span className="font-medium text-content-secondary">
              #{currentStore.store_number} · {currentStore.name}
            </span>
          </div>
        )}

        <main className="flex-1 overflow-auto p-5">{children}</main>
      </div>
    </div>
  );
}
