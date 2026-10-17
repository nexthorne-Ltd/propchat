/**
 * The one layout every email uses: workspace emails to customers and team
 * members, and platform emails (sign-up codes, admin invitations).
 *
 * Built for inboxes, not browsers: table layout, inline styles, a "bulletproof"
 * button (works in Outlook), a hidden preheader, no external CSS or web fonts,
 * no images except an optional logo, and a plain-text part made from the same
 * content. A matching text part, real wording and a reason-for-this-email
 * footer all help keep mail out of spam; authentication (SPF, DKIM, DMARC) on
 * the sending domain matters more still.
 *
 * Everything that reaches the HTML is escaped here, so callers pass plain text.
 */

export interface EmailButton {
  label: string;
  url: string;
}

export interface EmailContent {
  /** Shown in the header: the workspace (or platform) name. */
  brandName: string;
  /** #rrggbb; anything else falls back to the default accent. */
  brandColor?: string | null;
  /** https image; anything else is ignored and the name is shown instead. */
  logoUrl?: string | null;
  /** The inbox preview line, after the subject. */
  preheader: string;
  title: string;
  /** Plain text, one entry per paragraph. */
  paragraphs?: string[];
  /** A message quoted from a person (a reply, a customer's words). */
  quote?: { label?: string; text: string };
  /** A one-time code, shown large. */
  code?: string;
  /** Label/value rows (ticket number, role, …). */
  details?: [string, string][];
  button?: EmailButton;
  /** Shown under the button in small type. */
  afterButton?: string;
  /** Why the recipient got this email (one or two sentences). */
  footer: string;
}

const DEFAULT_ACCENT = '#2e5bff';

export function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Only http(s) links reach an href or src. */
export function safeUrl(url: string | null | undefined): string | null {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function safeColor(color: string | null | undefined): string {
  return /^#[0-9a-f]{6}$/i.test(color || '') ? (color as string) : DEFAULT_ACCENT;
}

/** Dark text on light brand colours, white otherwise. */
function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.55 ? '#18181b' : '#ffffff';
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function paragraphHtml(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3f3f46;">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
}

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const accent = safeColor(c.brandColor);
  const onAccent = textOn(accent);
  const logo = safeUrl(c.logoUrl);
  const buttonUrl = c.button ? safeUrl(c.button.url) : null;
  const brand = escapeHtml(c.brandName || 'Support');

  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${brand}" height="32" style="display:block;height:32px;max-width:180px;border:0;outline:none;">`
    : `<span style="font-size:17px;font-weight:700;letter-spacing:-0.2px;color:#18181b;">${brand}</span>`;

  const parts: string[] = [];
  parts.push(`<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:700;letter-spacing:-0.3px;color:#18181b;">${escapeHtml(c.title)}</h1>`);
  for (const p of c.paragraphs || []) parts.push(paragraphHtml(p));

  if (c.code) {
    parts.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;"><tr><td style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:10px;padding:14px 22px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:30px;line-height:36px;font-weight:700;letter-spacing:8px;color:#18181b;">${escapeHtml(c.code)}</td></tr></table>`
    );
  }

  if (c.quote?.text) {
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;"><tr><td style="border-left:3px solid ${accent};background:#fafafa;border-radius:0 8px 8px 0;padding:14px 18px;">` +
        (c.quote.label ? `<div style="font-size:12px;line-height:16px;font-weight:600;color:#71717a;margin-bottom:6px;">${escapeHtml(c.quote.label)}</div>` : '') +
        `<div style="font-size:15px;line-height:24px;color:#18181b;white-space:pre-wrap;word-break:break-word;">${escapeHtml(c.quote.text).replace(/\n/g, '<br>')}</div></td></tr></table>`
    );
  }

  if (c.details?.length) {
    parts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;border:1px solid #e4e4e7;border-radius:10px;">` +
        c.details
          .map(
            ([k, v], i) =>
              `<tr><td style="padding:10px 16px;font-size:13px;line-height:20px;color:#71717a;${i ? 'border-top:1px solid #f4f4f5;' : ''}width:40%;">${escapeHtml(k)}</td><td style="padding:10px 16px;font-size:13px;line-height:20px;color:#18181b;font-weight:600;${i ? 'border-top:1px solid #f4f4f5;' : ''}">${escapeHtml(v)}</td></tr>`
          )
          .join('') +
        `</table>`
    );
  }

  if (c.button && buttonUrl) {
    parts.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px;"><tr><td align="center" bgcolor="${accent}" style="border-radius:8px;background:${accent};">` +
        `<a href="${escapeHtml(buttonUrl)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${onAccent};text-decoration:none;border-radius:8px;">${escapeHtml(c.button.label)}</a>` +
        `</td></tr></table>` +
        `<p style="margin:12px 0 0;font-size:12px;line-height:18px;color:#a1a1aa;">${escapeHtml(
          c.afterButton || 'If the button does not work, copy this link into your browser:'
        )}<br><a href="${escapeHtml(buttonUrl)}" style="color:#71717a;word-break:break-all;">${escapeHtml(buttonUrl)}</a></p>`
    );
  } else if (c.afterButton) {
    parts.push(`<p style="margin:12px 0 0;font-size:12px;line-height:18px;color:#a1a1aa;">${escapeHtml(c.afterButton)}</p>`);
  }

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(c.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:${FONT};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(c.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 4px 18px;">${header}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;border-top:3px solid ${accent};padding:32px 32px 28px;font-family:${FONT};">
${parts.join('\n')}
</td></tr>
<tr><td style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:#a1a1aa;">${escapeHtml(c.footer)}<br>&copy; ${new Date().getFullYear()} ${brand}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    c.brandName,
    '',
    c.title,
    '',
    ...(c.paragraphs || []).flatMap((p) => [p, '']),
    ...(c.code ? [`Code: ${c.code}`, ''] : []),
    ...(c.quote?.text ? [`${c.quote.label ? `${c.quote.label}:\n` : ''}"${c.quote.text}"`, ''] : []),
    ...(c.details?.length ? [...c.details.map(([k, v]) => `${k}: ${v}`), ''] : []),
    ...(c.button && buttonUrl ? [`${c.button.label}: ${buttonUrl}`, ''] : []),
    '--',
    c.footer,
  ].join('\n');

  return { html, text };
}
