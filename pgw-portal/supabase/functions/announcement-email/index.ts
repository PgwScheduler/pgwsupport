// =====================================================================
// announcement-email — Edge Function (migration 86).
//
// POST { announcement_id }      Authorization: Bearer <signed-in user>
//
// Emails an announcement to each targeted store's Directory email
// (locations.store_email) through Resend. Optional per announcement --
// the portal calls this right after posting when "Also email" is ticked.
//
// WHO: anyone who may MANAGE the announcement (its author, master/admin,
// or a poster who can post to every one of its stores). That check runs
// as the CALLER (announcement_email_targets), so it is the same rule the
// portal uses. Only then does the service role read the announcement and
// record the result.
//
// ONCE: an announcement that already reached at least one store is
// refused, so a double click can't send it twice. One that reached
// nobody (every send failed) may be retried. Stores with no email are skipped and
// listed in the result.
//
// Secrets: RESEND_API_KEY (shared with missing-entry-alerts),
// optional ALERT_FROM and PORTAL_URL.
// Deployed with --no-verify-jwt; the token is checked here.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { renderAnnouncement, type Announcement } from './email.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json(401, { error: 'Sign in first.' });
  let body: { announcement_id?: string } = {};
  try { body = await req.json(); } catch { return json(400, { error: 'Body must be JSON.' }); }
  const id = body.announcement_id ?? '';
  if (!UUID.test(id)) return json(400, { error: 'announcement_id must be a uuid.' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who, error: whoErr } = await asCaller.auth.getUser(auth.slice(7));
  if (whoErr || !who?.user) return json(401, { error: 'Your session is not valid. Sign in again.' });

  // 1. The rule, as the caller.
  const { data: targets, error: tErr } = await asCaller.rpc('announcement_email_targets', { p_id: id });
  if (tErr) return json(tErr.code === '42501' ? 403 : 500, { error: tErr.message });

  // 2. The announcement, read with the service role.
  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: a, error: aErr } = await service.from('announcements')
    .select('title, body, priority, created_by_name, emailed_at, email_result, archived_at, training:training_id ( title )')
    .eq('id', id).maybeSingle();
  if (aErr || !a) return json(404, { error: aErr?.message ?? 'Announcement not found.' });
  if (a.archived_at) return json(409, { error: 'This announcement is archived.' });
  const prevSent = (a as { email_result?: { sent?: number } | null }).email_result?.sent ?? 0;
  if (a.emailed_at && prevSent > 0) return json(409, { error: 'This announcement was already emailed.' });

  // Claim it first, so an overlapping call sends nothing. A retry after
  // a send that reached nobody re-claims from the old timestamp.
  let claimQ = service.from('announcements')
    .update({ emailed_at: new Date().toISOString(), email_requested: true }).eq('id', id);
  claimQ = a.emailed_at ? claimQ.eq('emailed_at', a.emailed_at) : claimQ.is('emailed_at', null);
  const { data: claim } = await claimQ.select('id');
  if (!claim?.length) return json(409, { error: 'This announcement was already emailed.' });

  const portalUrl = (Deno.env.get('PORTAL_URL') ?? 'https://pgwsupport.com').replace(/\/+$/, '');
  const ann: Announcement = {
    title: a.title, body: a.body, priority: a.priority, created_by_name: a.created_by_name,
    training_title: (a as { training?: { title?: string } | null }).training?.title ?? null,
  };

  const sent: { store_number: string; email: string; resend_id: string }[] = [];
  const failed: { store_number: string; email: string; error: string }[] = [];
  const no_email: string[] = [];
  for (const t of (targets ?? []) as { store_number: string; store_name: string; store_email: string | null }[]) {
    if (!t.store_email) { no_email.push(t.store_number); continue; }
    const msg = renderAnnouncement(ann, t, portalUrl);
    const r = await sendResend({ to: t.store_email, ...msg, idempotencyKey: `announcement-${id}-${t.store_number}` });
    if (r.ok) sent.push({ store_number: t.store_number, email: t.store_email, resend_id: r.id! });
    else failed.push({ store_number: t.store_number, email: t.store_email, error: r.error! });
    await sleep(600); // Resend's default limit is 2 requests a second
  }

  const result = { sent: sent.length, failed, no_email, by: who.user.id, at: new Date().toISOString(), detail: sent };
  await service.from('announcements').update({ email_result: result }).eq('id', id);
  return json(200, { sent: sent.length, failed, no_email });
});
