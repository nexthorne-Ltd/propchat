/**
 * The branded email every outgoing message uses: agent replies and the
 * notifications triggers send. Email clients ignore stylesheets, so styling is
 * inline and table-based by necessity (the app's design tokens do not apply
 * here). The workspace's brand colour and logo come from its settings; both
 * are validated, and every other value is escaped.
 */

export interface BrandedEmailInput {
  workspaceName: string;
  brandColor?: string | null;
  logoUrl?: string | null;
  /** The message, as plain text. Blank lines separate paragraphs. */
  body: string;
  /** Appended under the body, e.g. "Alex\nAcme Support". Plain text. */
  signature?: string | null;
  ticketNumber?: number | null;
  /** The marker agents' mail clients and our own stripper recognise. */
  replyAboveLine?: boolean;
  /** One line under the card, e.g. why the customer got this. */
  footerNote?: string | null;
  /** Links for Good and Bad CSAT rating in solved notifications. */
  csatLinks?: { goodUrl: string; badUrl: string } | null;
}

const FALLBACK_COLOR = '#2563eb';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function safeColor(value: string | null | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : FALLBACK_COLOR;
}

function safeHttpsUrl(value: string | null | undefined): string | null {
  try {
    const u = new URL(value || '');
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Escapes text, keeps line breaks, and turns http(s) links into anchors. */
export function textToHtml(text: string): string {
  return escapeHtml(text.trim())
    .split(/\n{2,}/)
    .map((para) => {
      const linked = para.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (url) => `<a href="${url}" style="color:inherit;text-decoration:underline">${url}</a>`);
      return `<p style="margin:0 0 14px 0">${linked.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

export function renderBrandedEmail(input: BrandedEmailInput): { html: string; text: string } {
  const color = safeColor(input.brandColor);
  const logo = safeHttpsUrl(input.logoUrl);
  const name = escapeHtml(input.workspaceName || 'Support');
  const signature = (input.signature || '').trim();
  const above = input.replyAboveLine !== false;

  const csatBlockHtml = input.csatLinks
    ? `<div style="margin:22px 0 10px 0;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;text-align:center">
        <p style="margin:0 0 12px 0;font-size:13px;font-weight:600;color:#1f2933">How would you rate our support?</p>
        <div>
          <a href="${escapeHtml(input.csatLinks.goodUrl)}" style="display:inline-block;padding:8px 18px;margin:0 6px;background:#10b981;color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">👍 Good</a>
          <a href="${escapeHtml(input.csatLinks.badUrl)}" style="display:inline-block;padding:8px 18px;margin:0 6px;background:#ef4444;color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">👎 Bad</a>
        </div>
      </div>`
    : '';

  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${name}" height="28" style="display:block;max-height:28px;border:0">`
    : `<span style="font-size:16px;font-weight:600;color:#ffffff">${name}</span>`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7">
${above ? '<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f4f5f7">-- Please reply above this line --</div>' : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:${FONT}">
<tr><td style="background:${color};padding:16px 24px">${header}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.55;color:#1f2933">
${above ? '<p style="margin:0 0 16px 0;font-size:12px;color:#8a94a0">-- Please reply above this line --</p>' : ''}
${textToHtml(input.body)}
${csatBlockHtml}
${signature ? `<p style="margin:18px 0 0 0;padding-top:14px;border-top:1px solid #e4e7eb;color:#52606d">${escapeHtml(signature).replace(/\n/g, '<br>')}</p>` : ''}
</td></tr>
${input.ticketNumber ? `<tr><td style="padding:12px 24px;background:#f9fafb;font-size:12px;color:#8a94a0">Ticket #${input.ticketNumber}. Reply to this email to add to it.</td></tr>` : ''}
</table>
${input.footerNote ? `<p style="max-width:600px;margin:12px 0 0 0;font-family:${FONT};font-size:12px;color:#8a94a0">${escapeHtml(input.footerNote)}</p>` : ''}
</td></tr></table></body></html>`;

  const text = [
    above ? '-- Please reply above this line --\n' : '',
    input.body.trim(),
    input.csatLinks ? `\nHow would you rate our support?\nGood: ${input.csatLinks.goodUrl}\nBad: ${input.csatLinks.badUrl}` : '',
    signature ? `\n-- \n${signature}` : '',
    input.ticketNumber ? `\nTicket #${input.ticketNumber}. Reply to this email to add to it.` : '',
    input.footerNote ? `\n${input.footerNote}` : '',
  ].join('\n').trim();

  return { html, text };
}

export type NotificationTemplate = 'received' | 'replied' | 'solved';

export interface NotificationInput {
  template: NotificationTemplate;
  requesterName: string;
  ticketNumber: number;
  ticketSubject: string;
  /** For "replied": what the agent wrote. */
  reply?: string | null;
  agentName?: string | null;
}

/** The wording of the three requester notifications. Short on purpose. */
export function notificationContent(input: NotificationInput): { subject: string; body: string } {
  const first = (input.requesterName || '').split(' ')[0] || 'there';
  const ref = `[#${input.ticketNumber}]`;
  const subject = input.ticketSubject.trim() || 'your request';
  switch (input.template) {
    case 'received':
      return {
        subject: `We received your request ${ref}`,
        body: `Hi ${first},\n\nThanks for getting in touch. We received your request “${subject}” and will get back to you soon. It is ticket #${input.ticketNumber}.\n\nYou can reply to this email to add more details.`,
      };
    case 'replied':
      return {
        subject: `Re: ${subject} ${ref}`,
        body: `Hi ${first},\n\n${input.agentName ? `${input.agentName} replied to` : 'There is a reply to'} your request “${subject}”:\n\n${(input.reply || '').trim()}\n\nReply to this email to continue the conversation.`,
      };
    default:
      return {
        subject: `Your request was solved ${ref}`,
        body: `Hi ${first},\n\nWe marked your request “${subject}” (ticket #${input.ticketNumber}) as solved. If it is not, just reply to this email and we will reopen it.`,
      };
  }
}
