import React, { useEffect, useState } from "react";
import { FileDown } from "lucide-react";
import { useAuth } from "../../context/AuthProvider.jsx";
import { ALL_STORES_ROLES } from "../../lib/payrollAllStores.js";
import { extractAllStores } from "../../lib/payrollAllStoresLoad.js";
import { GhostBtn } from "../ui.jsx";

// "Extract All Stores": the open week for every store plus the Home
// Office, one CSV (lib/payrollAllStores.js). Master/admin only -- the
// roles that already see pay data; nobody else is offered it.
export function ExtractAllStoresButton({ week, cutover }) {
  const { role } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // The last result belongs to the week it was run for.
  useEffect(() => { setMsg(null); }, [week]);
  if (!ALL_STORES_ROLES.includes(role)) return null;

  const run = async () => {
    setBusy(true); setMsg(null);
    try {
      const { rowCount, storeCount } = await extractAllStores({ role, weekStart: week, cutover });
      setMsg({ ok: true, text: `${rowCount} people · ${storeCount} locations` });
    } catch (e) {
      setMsg({ ok: false, text: e.message ?? String(e) });
    }
    setBusy(false);
  };

  return (
    <span className="inline-flex items-center gap-2">
      <GhostBtn onClick={run} disabled={busy || !week} title="One CSV for this week: every store plus the Home Office, with pay">
        <FileDown className="h-4 w-4" /> {busy ? "Extracting…" : "Extract All Stores"}
      </GhostBtn>
      {msg && <span className={"text-xs " + (msg.ok ? "text-content-muted" : "text-danger")}>{msg.text}</span>}
    </span>
  );
}
