import sanitizeHtml from 'sanitize-html';

/**
 * HTML from customers is untrusted. This keeps basic formatting and links and
 * nothing else: no scripts, styles, forms, event handlers, remote images (they
 * would tell the sender when and from where an agent opened the ticket) or
 * quoted history. It is shown in a sandboxed frame as well; this is the first
 * of two layers, not the only one.
 */

const QUOTE_CLASS = /\b(gmail_quote|gmail_extra|yahoo_quoted|moz-cite-prefix|protonmail_quote|OutlookMessageHeader)\b/i;
const QUOTE_ID = /^(divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)$/i;

export interface SanitizedHtml {
  html: string;
  /** A quoted history was cut from it. */
  quotedRemoved: boolean;
}

/** `cidMap`: Content-ID → the https URL we stored that inline image at. Other images are dropped. */
export function sanitizeEmailHtml(html: string, cidMap: Record<string, string> = {}): SanitizedHtml {
  let quotedRemoved = false;
  const clean = sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img', 'hr'],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
      div: ['class', 'id'],
      blockquote: ['class', 'type'],
      '*': [],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https'] },
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template'],
    transformTags: {
      a: (tag, attribs) => ({ tagName: 'a', attribs: { href: attribs.href || '', target: '_blank', rel: 'noopener noreferrer nofollow' } }),
      img: (tag, attribs) => {
        const src = attribs.src || '';
        const cid = src.toLowerCase().startsWith('cid:') ? src.slice(4).replace(/^<|>$/g, '') : null;
        // Only images we stored ourselves survive; remote ones are tracking risks.
        return { tagName: 'img', attribs: { src: cid ? cidMap[cid] || '' : Object.values(cidMap).includes(src) ? src : '', alt: attribs.alt || '' } };
      },
    },
    exclusiveFilter: (frame) => {
      const cls = frame.attribs.class || '';
      const id = frame.attribs.id || '';
      const isQuote =
        (frame.tag === 'blockquote' && (frame.attribs.type === 'cite' || QUOTE_CLASS.test(cls))) ||
        (frame.tag === 'div' && (QUOTE_CLASS.test(cls) || QUOTE_ID.test(id)));
      if (isQuote) {
        quotedRemoved = true;
        return true;
      }
      if (frame.tag === 'img' && !frame.attribs.src) return true;
      return false;
    },
  });
  // Drop the class/id hooks used only for detection, and tidy empty wrappers.
  const stripped = clean.replace(/\s(?:class|id|type)="[^"]*"/g, '').replace(/(<div>\s*<\/div>|<p>\s*<\/p>)/g, '').trim();
  return { html: stripped, quotedRemoved };
}

/** Plain text of an HTML body, for emails that only have HTML. */
export function htmlToPlainText(html: string): string {
  const withBreaks = html.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n');
  return sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {}, nonTextTags: ['script', 'style'] })
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
