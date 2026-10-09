// =====================================================================
// announcement-email — the email itself. Pure: announcement + store in,
// subject + HTML + text out. Table layout + inline styles (Outlook),
// matching missing-entry-alerts and email-templates/*.html.
// =====================================================================

export type Announcement = {
  title: string;
  body: string;
  priority: 'normal' | 'important';
  created_by_name: string | null;
  training_title: string | null;
};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Plain text with blank-line paragraphs and single line breaks.
export function bodyToHtml(body: string) {
  return String(body ?? '')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== '')
    .map((p) => `<p style="margin:0 0 14px; font-size:15px; line-height:1.6; color:#3f3f46;">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function renderAnnouncement(a: Announcement, store: { store_number: string; store_name: string }, portalUrl: string) {
  const important = a.priority === 'important';
  const subject = `${important ? 'Important: ' : ''}${a.title}`;
  const from = a.created_by_name ? `From ${a.created_by_name}` : 'From the home office';
  const training = a.training_title
    ? `<p style="margin:0 0 14px; font-size:14px; color:#3f3f46;">Related training: <strong>${esc(a.training_title)}</strong> — in the portal under Training.</p>`
    : '';

  const html = `<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">${esc(a.title)}</div>
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
        <tr><td style="background-color:${important ? '#B91C1C' : '#F26B21'}; height:4px; line-height:4px; font-size:4px;">&nbsp;</td></tr>
        <tr>
          <td style="padding:28px 32px 8px; font-family:Arial, Helvetica, sans-serif; color:#18181b;">
            <p style="margin:0 0 6px; font-size:12px; font-weight:bold; letter-spacing:1.5px; text-transform:uppercase; color:${important ? '#B91C1C' : '#C2410C'};">${important ? 'Important announcement' : 'Announcement'} · #${esc(store.store_number)} ${esc(store.store_name)}</p>
            <h1 style="margin:0 0 16px; font-size:22px; line-height:1.3;">${esc(a.title)}</h1>
            ${bodyToHtml(a.body)}
            ${training}
            <p style="margin:0 0 4px; font-size:13px; color:#71717a;">${esc(from)}</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 32px 8px; font-family:Arial, Helvetica, sans-serif;">
            <a href="${esc(portalUrl)}" style="display:inline-block; background-color:#F26B21; color:#ffffff; text-decoration:none; font-size:15px; font-weight:bold; padding:12px 28px; border-radius:8px;">Open the portal</a>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 28px; font-family:Arial, Helvetica, sans-serif; font-size:12px; line-height:1.5; color:#71717a;">
            Also posted in the PGW Support Portal under Announcements. Opening it there records that your store has read it.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

  const text = [
    `${important ? 'IMPORTANT ANNOUNCEMENT' : 'Announcement'} — #${store.store_number} ${store.store_name}`,
    '',
    a.title,
    '',
    String(a.body ?? '').replace(/\r/g, ''),
    ...(a.training_title ? ['', `Related training: ${a.training_title} (in the portal under Training)`] : []),
    '',
    from,
    `Open the portal: ${portalUrl}`,
  ].join('\n');

  return { subject, html, text };
}
