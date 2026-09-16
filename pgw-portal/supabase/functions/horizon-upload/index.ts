// =====================================================================
// horizon-upload — Edge Function. PREVIEW ONLY in this version.
//
// POST { location_id, month: 'YYYY-MM', mode: 'preview' }
//   Authorization: Bearer <signed-in admin's access token>
//
// 1. The CALLER's session runs horizon_upload_target(): role check, the
//    sandbox-only switch, shop number, pairing and Front Staff. The
//    attempt is logged under that admin. A refusal stops here.
// 2. The service-role client reads the store-month and builds exactly
//    the fields the store workbook's macro would POST.
// 3. The fields come back with the password masked. Nothing is sent to
//    Horizon, and horizon_release_credentials() is never called, so the
//    password is never read.
//
// There is deliberately no send path yet. It is added only after the
// preview has been compared with the store's own workbook and approved.
//
// Deployed with --no-verify-jwt: the project signs sessions with the
// new asymmetric keys, so the token is checked here (auth.getUser) and
// again by PostgREST when the caller's session runs the upload check.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildPayload, encodeBody, PASSWORD_MARKER } from './payload.ts';
import { loadStoreMonth } from './load.ts';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json(401, { error: 'Sign in first.' });

  let body: { location_id?: string; month?: string; mode?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'Body must be JSON.' }); }
  const { location_id, month, mode = 'preview' } = body;
  if (!location_id || !UUID.test(location_id)) return json(400, { error: 'location_id must be a uuid.' });
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json(400, { error: 'month must be YYYY-MM.' });
  if (mode !== 'preview') {
    return json(400, { error: 'Only mode "preview" exists in this version. Nothing can be sent to Horizon yet.' });
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

  // 2. Build, with the service role (pay rates are admin-only data).
  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const input = await loadStoreMonth(service, location_id, month);
    const out = buildPayload({
      ...input,
      shopNumber: v.shop_number,
      frontStaffSlot: v.front_staff_slot,
      today: storeToday(),
    });

    // 3. Return it, password masked. The byte count uses a same-length
    //    stand-in only as an estimate; the real password is never read.
    return json(200, {
      mode: 'preview',
      sent_to_horizon: false,
      attempt_id: v.attempt_id,
      requested_by: who.user.email,
      shop_number: v.shop_number,
      month,
      days_sent: out.days,
      tech_slots_sent: out.techSlotsSent,
      field_count: out.pairs.length,
      approx_body_bytes: encodeBody(out.pairs, '').length,
      totals: out.totals,
      warnings: out.warnings,
      fields: out.pairs.map(([k, val]) => [k, val === PASSWORD_MARKER ? '(password withheld)' : val]),
    });
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e), attempt_id: v.attempt_id });
  }
});
