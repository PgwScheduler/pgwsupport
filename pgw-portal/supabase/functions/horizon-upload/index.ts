// =====================================================================
// horizon-upload — Edge Function.
//
// POST { location_id, month: 'YYYY-MM', mode: 'preview' }
// POST { location_id, month: 'YYYY-MM', mode: 'send', confirm_sha256 }
//   Authorization: Bearer <signed-in admin's access token>
//
// Both modes:
// 1. The CALLER's session runs horizon_upload_target(): role check, the
//    sandbox-only switch, shop number, pairing and Front Staff. The
//    attempt is logged under that admin. A refusal stops here.
// 2. The service-role client reads the store-month and builds exactly
//    the fields the store workbook's macro would POST.
//
// preview: returns the fields (password withheld) and their SHA-256
//   fingerprint. The password is never read. Recorded as a preview.
//
// send: the rebuilt fields must have the fingerprint the admin approved
//   (confirm_sha256) or nothing happens -- data that changed after the
//   preview is never sent unseen. Only then is the password released
//   (once, for this attempt), the body posted to Horizon, and Horizon's
//   reply recorded. The password is never returned or logged.
//
// Deployed with --no-verify-jwt: the project signs sessions with the
// new asymmetric keys, so the token is checked here (auth.getUser) and
// again by PostgREST when the caller's session runs the upload check.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildPayload, encodeBody, fieldsDigest, PASSWORD_MARKER } from './payload.ts';
import { loadStoreMonth } from './load.ts';
import { sendToHorizon } from './transport.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// The store's calendar day, which is what the macro's Date means.
const storeToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json(401, { error: 'Sign in first.' });

  let body: { location_id?: string; month?: string; mode?: string; confirm_sha256?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'Body must be JSON.' }); }
  const { location_id, month, mode = 'preview', confirm_sha256 } = body;
  if (!location_id || !UUID.test(location_id)) return json(400, { error: 'location_id must be a uuid.' });
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json(400, { error: 'month must be YYYY-MM.' });
  if (mode !== 'preview' && mode !== 'send') return json(400, { error: 'mode must be "preview" or "send".' });
  if (mode === 'send' && !(confirm_sha256 && SHA256.test(confirm_sha256))) {
    return json(400, { error: 'A send needs confirm_sha256: the fingerprint of the preview you approved. Run a preview first.' });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who, error: whoErr } = await asCaller.auth.getUser(auth.slice(7));
  if (whoErr || !who?.user) return json(401, { error: 'Your session is not valid. Sign in again.' });

  // 1. The upload check, as the caller.
  const { data: verdicts, error: gateErr } = await asCaller.rpc('horizon_upload_target', { p_location_id: location_id });
  if (gateErr) {
    const status = gateErr.code === '42501' ? 403 : gateErr.code === '42704' ? 404 : 500;
    return json(status, { error: gateErr.message });
  }
  const v = verdicts?.[0];
  if (!v?.authorized) {
    return json(403, { error: v?.reason ?? 'Upload refused.', attempt_id: v?.attempt_id ?? null });
  }

  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const record = async (r: { purpose: 'preview' | 'send'; fieldCount: number | null; sha: string | null; authTier?: string | null; status?: number | null; body?: string | null }) => {
    const { error } = await service.rpc('horizon_record_result', {
      p_attempt_id: v.attempt_id,
      p_purpose: r.purpose,
      p_month: `${month}-01`,
      p_field_count: r.fieldCount,
      p_fields_sha256: r.sha,
      p_auth_tier: r.authTier ?? null,
      p_status: r.status ?? null,
      p_body: r.body ?? null,
    });
    return error ? `Could not record the result in the upload log: ${error.message}` : null;
  };

  // 2. Build, with the service role (pay rates are admin-only data).
  let out: ReturnType<typeof buildPayload>;
  let sha: string;
  try {
    const input = await loadStoreMonth(service, location_id, month);
    out = buildPayload({
      ...input,
      shopNumber: v.shop_number,
      frontStaffSlot: v.front_staff_slot,
      today: storeToday(),
    });
    sha = await fieldsDigest(out.pairs);
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e), attempt_id: v.attempt_id });
  }

  const common = {
    attempt_id: v.attempt_id,
    requested_by: who.user.email,
    shop_number: v.shop_number,
    month,
    days_sent: out.days,
    tech_slots_sent: out.techSlotsSent,
    field_count: out.pairs.length,
    fields_sha256: sha,
    totals: out.totals,
    warnings: out.warnings,
  };

  if (mode === 'preview') {
    const recordError = await record({ purpose: 'preview', fieldCount: out.pairs.length, sha });
    return json(200, {
      mode: 'preview',
      sent_to_horizon: false,
      ...common,
      record_error: recordError,
      approx_body_bytes: encodeBody(out.pairs, '').length,
      fields: out.pairs.map(([k, val]) => [k, val === PASSWORD_MARKER ? '(password withheld)' : val]),
    });
  }

  // 3. send — only what was approved.
  if (sha !== confirm_sha256) {
    const recordError = await record({ purpose: 'send', fieldCount: out.pairs.length, sha, body: 'Not sent: the fields changed after the approved preview.' });
    return json(409, {
      mode: 'send', sent_to_horizon: false, ...common, record_error: recordError,
      error: 'The data changed since the preview you approved, so nothing was sent. Run a new preview and check it.',
    });
  }

  const { data: creds, error: credErr } = await service.rpc('horizon_release_credentials', { p_attempt_id: v.attempt_id });
  if (credErr || !creds?.[0]?.password) {
    const why = credErr?.message ?? 'No credentials came back.';
    const recordError = await record({ purpose: 'send', fieldCount: out.pairs.length, sha, body: `Not sent: ${why}` });
    return json(403, { mode: 'send', sent_to_horizon: false, ...common, record_error: recordError, error: why });
  }
  const c = creds[0];
  // The release re-checked everything; it must agree with the gate.
  if (c.shop_number !== v.shop_number || c.front_staff_slot !== v.front_staff_slot || c.location_id !== location_id) {
    const recordError = await record({ purpose: 'send', fieldCount: out.pairs.length, sha, body: 'Not sent: the released credentials did not match the authorized attempt.' });
    return json(409, { mode: 'send', sent_to_horizon: false, ...common, record_error: recordError, error: 'The released credentials did not match the authorized attempt. Nothing was sent.' });
  }

  // The macro sends Trim(B2). A secret pasted into Vault can carry a
  // stray space or line break, so surrounding whitespace is dropped too;
  // the reply says only WHETHER that happened, never the password.
  const password = String(c.password).trim();
  const passwordWasTrimmed = password !== c.password;
  const result = await sendToHorizon(encodeBody(out.pairs, password));
  const recordError = await record({
    purpose: 'send', fieldCount: out.pairs.length, sha,
    authTier: result.authTier, status: result.status, body: result.body,
  });
  return json(result.ok ? 200 : 502, {
    mode: 'send',
    sent_to_horizon: result.status !== null,
    horizon_accepted: result.ok,
    ...common,
    horizon_status: result.status,
    horizon_reply: result.body.slice(0, 4000),
    auth_tier: result.authTier,
    tries: result.tries,
    password_was_trimmed: passwordWasTrimmed,
    record_error: recordError,
  });
});
