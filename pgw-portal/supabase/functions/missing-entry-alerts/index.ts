// =====================================================================
// missing-entry-alerts — Edge Function (migration 80).
//
// The morning "who hasn't entered yesterday's tic sheet" email to
// district and regional managers, sent through Resend.
//
// TWO CALLERS:
//
// 1. The schedule (pg_cron + pg_net, pgw_missing_entry_cron_80a.sql),
//    hourly Mon-Sat. Header  x-cron-secret: <MISSING_ENTRY_CRON_SECRET>.
//    Sends only when missing_entry_config.email_enabled is on AND it is
//    send_hour_et o'clock in Eastern time -- hourly runs make DST a
//    non-issue. A recipient gets at most one email per business day
//    (claimed in missing_entry_email_log BEFORE sending, so a retry or
//    an overlapping run cannot double-send). Nobody with nothing missing
//    is emailed.
//
// 2. A signed-in MASTER, for checking before switching it on:
//      { mode: 'preview' }                  -> every digest + the first
//                                              email's HTML; sends nothing
//      { mode: 'test', recipient_id? }      -> ONE digest (that recipient's,
//                                              or the first with anything
//                                              missing) emailed to the
//                                              master's own address only
//    Both work with email_enabled off, and accept as_of: 'YYYY-MM-DD'.
//
// Secrets (Dashboard -> Edge Functions -> Secrets):
//   RESEND_API_KEY             required to send
//   MISSING_ENTRY_CRON_SECRET  required for the schedule
//   ALERT_FROM                 optional, default 'PGW Support <noreply@pgwsupport.com>'
//   PORTAL_URL                 optional, default 'https://pgwsupport.com'
//
// Deployed with --no-verify-jwt (the cron call carries no user token);
// a master's token is checked here with auth.getUser.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { renderDigest, type Digest } from './email.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Eastern wall clock: hour 0-23 and weekday 0 (Sun) - 6.
function easternNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')!.value);
  return { hour, weekday: wd };
}

// Constant-time compare, so the secret can't be guessed a byte at a time.
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function sendResend(args: { to: string; subject: string; html: string; text: string; idempotencyKey: string }) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return { ok: false, error: 'RESEND_API_KEY is not set.' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': args.idempotencyKey },
    body: JSON.stringify({
      from: Deno.env.get('ALERT_FROM') ?? 'PGW Support <noreply@pgwsupport.com>',
      to: [args.to], subject: args.subject, html: args.html, text: args.text,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${body?.message ?? JSON.stringify(body)}` };
  return { ok: true, id: body?.id as string };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  let body: { mode?: string; as_of?: string; recipient_id?: string; force?: boolean } = {};
  try { body = (await req.json()) ?? {}; } catch { /* empty body is fine for the schedule */ }
  if (body.as_of && !ISO.test(body.as_of)) return json(400, { error: 'as_of must be YYYY-MM-DD.' });
  if (body.recipient_id && !UUID.test(body.recipient_id)) return json(400, { error: 'recipient_id must be a uuid.' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const portalUrl = (Deno.env.get('PORTAL_URL') ?? 'https://pgwsupport.com').replace(/\/+$/, '');

  // ---- Who is calling? -------------------------------------------------
  const cronSecret = Deno.env.get('MISSING_ENTRY_CRON_SECRET') ?? '';
  const isCron = sameSecret(req.headers.get('x-cron-secret') ?? '', cronSecret);
  let master: { id: string; email: string } | null = null;
  if (!isCron) {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json(401, { error: 'Sign in first.' });
    const { data: who, error: whoErr } = await service.auth.getUser(auth.slice(7));
    if (whoErr || !who?.user) return json(401, { error: 'Your session is not valid. Sign in again.' });
    const { data: prof } = await service.from('profiles').select('role, email').eq('id', who.user.id).maybeSingle();
    if (prof?.role !== 'master') return json(403, { error: 'Only a master can preview or test the missing-entry email.' });
    master = { id: who.user.id, email: (prof.email || who.user.email || '').trim() };
    if (body.mode !== 'preview' && body.mode !== 'test') return json(400, { error: 'mode must be "preview" or "test".' });
  }

  const { data: cfg, error: cfgErr } = await service.from('missing_entry_config').select('*').maybeSingle();
  if (cfgErr || !cfg) return json(500, { error: cfgErr?.message ?? 'missing_entry_config has no row — run migration 80.' });

  // ---- The schedule's gates ---------------------------------------------
  if (isCron && !body.force) {
    const now = easternNow();
    if (!cfg.email_enabled) return json(200, { skipped: 'email_enabled is off' });
    if (now.weekday === 0) return json(200, { skipped: 'Sunday' });
    if (now.hour !== cfg.send_hour_et) return json(200, { skipped: `not ${cfg.send_hour_et}:00 Eastern (it is ${now.hour}:00)` });
  }

  const { data: rows, error: dgErr } = await service.rpc('missing_entry_digest', { p_as_of: body.as_of ?? null });
  if (dgErr) return json(500, { error: dgErr.message });
  const digests = (rows ?? []) as Digest[];
  const withMissing = digests.filter((d) => d.missing.length > 0);

  // ---- Master: preview ---------------------------------------------------
  if (master && body.mode === 'preview') {
    const sample = withMissing[0] ? renderDigest(withMissing[0], portalUrl) : null;
    return json(200, {
      email_enabled: cfg.email_enabled,
      business_date: digests[0]?.business_date ?? null,
      recipients: digests.map((d) => ({
        recipient_id: d.recipient_id, email: d.email, full_name: d.full_name, role: d.role,
        scope_name: d.scope_name, store_count: d.store_count,
        stores: d.missing.map((s) => `#${s.store_number}`),
      })),
      would_email: withMissing.length,
      sample,
    });
  }

  // ---- Master: one test email to themself ---------------------------------
  if (master && body.mode === 'test') {
    if (!master.email) return json(400, { error: 'Your profile has no email address.' });
    const d = body.recipient_id ? digests.find((x) => x.recipient_id === body.recipient_id) : withMissing[0];
    if (!d) return json(404, { error: body.recipient_id ? 'That recipient is not on the list.' : 'Nobody has anything missing — nothing to test with.' });
    const msg = renderDigest(d, portalUrl, { test: true });
    const sent = await sendResend({ to: master.email, ...msg, idempotencyKey: `missing-test-${d.business_date}-${d.recipient_id}-${Date.now()}` });
    await service.from('missing_entry_email_log').insert({
      business_date: d.business_date, recipient_id: master.id, email: master.email,
      store_count: d.missing.length, status: sent.ok ? 'test' : 'failed',
      resend_id: sent.ok ? sent.id : null, error: sent.ok ? `test copy of ${d.email}'s digest` : sent.error,
    });
    if (!sent.ok) return json(502, { error: sent.error });
    return json(200, { sent_to: master.email, digest_of: d.email, store_count: d.missing.length, resend_id: sent.id, subject: msg.subject });
  }

  // ---- The schedule: send ---------------------------------------------------
  const results: { email: string; status: string; error?: string }[] = [];
  for (const d of withMissing) {
    // Claim first: the unique index on (business_date, recipient_id)
    // where status='sent' turns a second claim into a no-op.
    const { data: claim, error: claimErr } = await service.from('missing_entry_email_log')
      .insert({ business_date: d.business_date, recipient_id: d.recipient_id, email: d.email, store_count: d.missing.length, status: 'sent' })
      .select('id').maybeSingle();
    if (claimErr) {
      results.push({ email: d.email, status: claimErr.code === '23505' ? 'already sent' : 'claim failed', error: claimErr.code === '23505' ? undefined : claimErr.message });
      continue;
    }
    const msg = renderDigest(d, portalUrl);
    const sent = await sendResend({ to: d.email, ...msg, idempotencyKey: `missing-${d.business_date}-${d.recipient_id}` });
    await service.from('missing_entry_email_log')
      .update(sent.ok ? { resend_id: sent.id } : { status: 'failed', error: sent.error })
      .eq('id', claim!.id);
    results.push({ email: d.email, status: sent.ok ? 'sent' : 'failed', error: sent.ok ? undefined : sent.error });
    await sleep(600); // Resend's default limit is 2 requests a second
  }
  return json(200, {
    business_date: digests[0]?.business_date ?? null,
    recipients: digests.length,
    nothing_missing: digests.length - withMissing.length,
    results,
  });
});
