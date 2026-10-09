// =====================================================================
// missing-entry-alerts — the email itself. Pure: digest row in, subject
// + HTML + plain text out, so it can be tested without Deno or Resend.
// Table layout + inline styles on purpose (Outlook desktop), matching
// email-templates/*.html.
// =====================================================================

export type MissingStore = {
  location_id: string;
  store_number: string;
  store_name: string;
  district_name: string | null;
  last_entered: string | null; // 'YYYY-MM-DD'
  days_missed: number;
};

export type Digest = {
  recipient_id: string;
  email: string;
  full_name: string | null;
  role: string;
  scope_name: string | null;
  business_date: string; // 'YYYY-MM-DD'
  store_count: number;
  missing: MissingStore[];
};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// 'YYYY-MM-DD' -> 'Saturday, Oct 10'. Parsed as a calendar date (noon UTC)
// so no timezone can move it a day.
export function longDay(iso: string) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const shortDay = (iso: string) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function lastEnteredText(s: MissingStore) {
  if (!s.last_entered) return 'No entries on record';
  return `Last entered ${shortDay(s.last_entered)}`;
}

export function missedText(s: MissingStore) {
  if (!s.last_entered) return 'Never entered';
  return s.days_missed >= 31 ? '31+ working days' : `${s.days_missed} working day${s.days_missed === 1 ? '' : 's'}`;
}

export function renderDigest(d: Digest, portalUrl: string, opts: { test?: boolean } = {}) {
  const day = longDay(d.business_date);
  const n = d.missing.length;
  const stores = `${n} store${n === 1 ? '' : 's'}`;
  const subject = `${opts.test ? '[TEST] ' : ''}Tic sheet missing: ${stores} for ${day}`;
  const first = (d.full_name ?? '').split(/[\s_]+/)[0] || 'there';
  const scope = d.scope_name ? ` in ${d.scope_name}` : '';
  const multiDistrict = d.role !== 'district';

  const rows = d.missing.map((s) => `
              <tr>
                <td style="padding:10px 12px; border-top:1px solid #e4e4e7; font-size:14px; color:#18181b;">
                  <strong>#${esc(s.store_number)}</strong> ${esc(s.store_name)}${multiDistrict && s.district_name ? `<br><span style="font-size:12px; color:#71717a;">${esc(s.district_name)}</span>` : ''}
                </td>
                <td style="padding:10px 12px; border-top:1px solid #e4e4e7; font-size:13px; color:#52525b; white-space:nowrap;">${esc(lastEnteredText(s))}</td>
                <td align="right" style="padding:10px 12px; border-top:1px solid #e4e4e7; font-size:13px; font-weight:bold; color:${s.days_missed > 1 || !s.last_entered ? '#B91C1C' : '#C2410C'}; white-space:nowrap;">${esc(missedText(s))}</td>
              </tr>`).join('');

  const html = `<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${esc(stores)}${esc(scope)} have not entered ${esc(day)}'s tic sheet.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5; padding:32px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e4e4e7;">
        <tr>
          <td align="center" style="background-color:#ffffff; padding:20px 24px 12px;">
            <a href="${esc(portalUrl)}" style="text-decoration:none;">
              <img src="${esc(portalUrl)}/email/pgw-logo.png" width="180" alt="Palmetto Garage Works"
                   style="display:block; border:0; width:180px; height:auto; color:#18181b; font-family:Arial, Helvetica, sans-serif; font-size:18px; font-weight:bold;">
            </a>
          </td>
        </tr>
        <tr><td style="background-color:#F26B21; height:4px; line-height:4px; font-size:4px;">&nbsp;</td></tr>
        <tr>
          <td style="padding:28px 32px 8px; font-family:Arial, Helvetica, sans-serif; color:#18181b;">
            <p style="margin:0 0 6px; font-size:12px; font-weight:bold; letter-spacing:1.5px; text-transform:uppercase; color:#C2410C;">Daily tic sheet check</p>
            <h1 style="margin:0 0 14px; font-size:22px; line-height:1.3;">${esc(stores)} missing ${esc(day)}</h1>
            <p style="margin:0 0 18px; font-size:15px; line-height:1.55; color:#3f3f46;">
              Hi ${esc(first)}, these stores${esc(scope)} have not entered their tic sheet for ${esc(day)}.
              Every scorecard, the bonus tracker and Tech Ranks read from it.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px; font-family:Arial, Helvetica, sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e4e4e7; border-radius:8px; border-collapse:separate;">
              <tr>
                <td style="padding:8px 12px; font-size:11px; font-weight:bold; letter-spacing:1px; text-transform:uppercase; color:#71717a;">Store</td>
                <td style="padding:8px 12px; font-size:11px; font-weight:bold; letter-spacing:1px; text-transform:uppercase; color:#71717a;">Last entry</td>
                <td align="right" style="padding:8px 12px; font-size:11px; font-weight:bold; letter-spacing:1px; text-transform:uppercase; color:#71717a;">Behind</td>
              </tr>${rows}
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 32px 8px; font-family:Arial, Helvetica, sans-serif;">
            <a href="${esc(portalUrl)}" style="display:inline-block; background-color:#F26B21; color:#ffffff; text-decoration:none; font-size:15px; font-weight:bold; padding:12px 28px; border-radius:8px;">Open the portal</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 28px; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:1.5; color:#71717a;">
            "Entered" means the day has cars or sales on the tic sheet. Sundays and company holidays are never counted.
            You get this because you manage ${d.role === 'district' ? 'a district' : d.role === 'regional' ? 'a region' : 'stores'} in the PGW Support Portal.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

  const text = [
    `Daily tic sheet check — ${stores} missing ${day}${scope}`,
    '',
    ...d.missing.map((s) => `#${s.store_number} ${s.store_name}${multiDistrict && s.district_name ? ` (${s.district_name})` : ''} — ${lastEnteredText(s)} — behind: ${missedText(s)}`),
    '',
    `Open the portal: ${portalUrl}`,
  ].join('\n');

  return { subject, html, text };
}
