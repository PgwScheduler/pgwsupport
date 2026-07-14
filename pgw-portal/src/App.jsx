import React, { useState } from "react";
import { LogOut } from "lucide-react";
import { useAuth } from "./context/AuthProvider.jsx";
import { LoginScreen } from "./components/LoginScreen.jsx";
import { SetPasswordScreen } from "./components/SetPasswordScreen.jsx";
import { Shell } from "./components/Shell.jsx";
import { Card, LogoMark } from "./components/ui.jsx";
import { DashboardView } from "./components/DashboardView.jsx";
import { HoursView } from "./components/HoursView.jsx";
import { DrawerView } from "./components/drawer/DrawerView.jsx";
import { DocumentsView } from "./components/DocumentsView.jsx";
import { TrainingView } from "./components/TrainingView.jsx";
import { UsersView } from "./components/users/UsersView.jsx";

function FullScreenMessage({ children }) {
  return (
    <div className="pgw-root flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
      <div className="w-full max-w-sm text-center">{children}</div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <FullScreenMessage>
      <div className="flex flex-col items-center gap-3">
        <LogoMark size="lg" />
        <p className="text-sm text-slate-400">Loading…</p>
      </div>
    </FullScreenMessage>
  );
}

function PendingApprovalScreen({ onSignOut }) {
  return (
    <FullScreenMessage>
      <Card className="p-6">
        <div className="mb-4 flex justify-center">
          <LogoMark />
        </div>
        <h1 className="pgw-display mb-2 text-lg font-bold text-white">Account pending approval</h1>
        <p className="mb-4 text-sm text-slate-400">
          You're signed in, but a master administrator hasn't assigned your role or store yet. Check back once
          they've set up your access.
        </p>
        <button onClick={onSignOut} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-200">
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </Card>
    </FullScreenMessage>
  );
}

export default function App() {
  const { loadingSession, loadingProfile, session, profile, currentStore, stores, signOut, recoveryMode } = useAuth();
  const [view, setView] = useState("dashboard");

  if (loadingSession) return <LoadingScreen />;
  if (recoveryMode) return <SetPasswordScreen />;
  if (!session) return <LoginScreen />;
  if (loadingProfile && !profile) return <LoadingScreen />;
  if (!profile?.role) return <PendingApprovalScreen onSignOut={signOut} />;
  if (!currentStore && stores.length === 0) {
    return (
      <FullScreenMessage>
        <Card className="p-6">
          <h1 className="pgw-display mb-2 text-lg font-bold text-white">No stores visible</h1>
          <p className="mb-4 text-sm text-slate-400">
            Your account is approved, but no stores are assigned to your scope yet. Contact a master administrator.
          </p>
          <button onClick={signOut} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-200">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </Card>
      </FullScreenMessage>
    );
  }

  return (
    <Shell view={view} setView={setView}>
      {view === "dashboard" && <DashboardView key={"dashboard-" + currentStore.id} store={currentStore} />}
      {view === "hours" && <HoursView key={"hours-" + currentStore.id} store={currentStore} />}
      {view === "drawer" && <DrawerView key={"drawer-" + currentStore.id} store={currentStore} />}
      {view === "documents" && <DocumentsView key={"documents-" + currentStore.id} store={currentStore} />}
      {view === "training" && <TrainingView />}
      {view === "users" && profile.role === "master" && <UsersView />}
    </Shell>
  );
}
