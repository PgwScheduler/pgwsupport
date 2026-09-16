// =====================================================================
// Sends one encoded body to Horizon's importer. No Supabase, no data
// access: the caller passes the body, and `fetchImpl` so a test can
// stand in for Horizon.
//
// What the macro does (Module1.SendDataToServer):
//   http.Open "POST", Website, False, Username, Password
//   http.send(Data)          ' 200 = success, anything else = failure
// MSXML sends Username/Password only if the server answers 401. So:
//   tier 'none'     — no Authorization header (what normally happens)
//   tier 'username' — only after a 401: Basic "username:" (the macro's
//                     placeholder, blank password)
// A second 401 stops. A third tier (a real basic-auth password) is not
// built: nothing suggests Horizon needs it, and it would need its own
// Vault secret.
//
// The macro sets no Content-Type. This sends
// application/x-www-form-urlencoded, which a PHP importer parses into
// $_POST and still leaves readable as raw input, so it works whichever
// way coaching.php reads the body.
//
// Redirects are NOT followed: a redirected POST silently becomes a GET
// without the body, which would read as a strange success.
// =====================================================================

export const HORIZON_IMPORTER_URL = 'https://coaching.horizontmg.com/importer/coaching.php';
const MACRO_USERNAME = 'username';
const TIMEOUT_MS = 60_000;

export type SendResult = {
  ok: boolean;                        // HTTP 200 and the reply is not "Error..."
  status: number | null;              // null = no reply at all
  authTier: 'none' | 'username' | null;
  body: string;                       // Horizon's reply, or the network error
  tries: { authTier: 'none' | 'username'; status: number | null }[];
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function sendToHorizon(encodedBody: string, fetchImpl: FetchLike = fetch): Promise<SendResult> {
  const tries: SendResult['tries'] = [];
  const attempt = async (authTier: 'none' | 'username') => {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (authTier === 'username') headers.Authorization = 'Basic ' + btoa(`${MACRO_USERNAME}:`);
    try {
      const res = await fetchImpl(HORIZON_IMPORTER_URL, {
        method: 'POST',
        headers,
        body: encodedBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text().catch(() => '');
      tries.push({ authTier, status: res.status });
      return { status: res.status, text };
    } catch (e) {
      tries.push({ authTier, status: null });
      return { status: null, text: `No reply from Horizon: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  let tier: 'none' | 'username' = 'none';
  let r = await attempt(tier);
  if (r.status === 401) {
    tier = 'username';
    r = await attempt(tier);
  }
  // A 200 is NOT enough. Horizon answers a wrong shop password with
  // HTTP 200 and the text "Error: Password not accepted." (seen on the
  // first sandbox send, 2026-09-16). The macro would have shown that
  // text in its success box; here a reply starting "Error" is a failure.
  return {
    ok: r.status === 200 && !/^\s*error\b/i.test(r.text),
    status: r.status,
    authTier: r.status === null ? null : tier,
    body: r.status === 401
      ? `Horizon refused both without a login and with the macro's username (401). ${r.text}`.trim()
      : r.text,
    tries,
  };
}
