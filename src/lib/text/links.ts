/*
 * Finds links in chat text: full URLs, "www." addresses, bare domains such as
 * genzprop.com/pricing, and email addresses. Shared by the dashboard (React)
 * and the embeddable widget (HTML strings), so a link is a link in both.
 *
 * Returns plain pieces; callers build the markup (React nodes, or escaped
 * HTML in the widget), so message text can never inject anything.
 */

export interface TextPart {
  text: string;
  /** Set when this piece is a link: where it goes. */
  href?: string;
}

// Bare domains only count with a common top-level domain, so "file.txt",
// "v1.2" or "e.g." stay text. No lookbehind anywhere: the widget runs on old
// Safari, where one would stop the whole script from loading.
const TLDS =
  'com|net|org|io|co|ai|app|dev|site|online|store|shop|tech|info|biz|me|xyz|tv|cc|us|uk|ca|au|de|fr|in|pk|ae|sa|eu|gov|edu';

const LINK = new RegExp(
  [
    // 1. email
    String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`,
    // 2. scheme URL
    String.raw`https?:\/\/[^\s<>"']+`,
    // 3. www. address
    String.raw`www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^\s<>"']*`,
    // 4. bare domain with a known TLD, optional path
    String.raw`(?:[A-Za-z0-9-]+\.)+(?:${TLDS})(?![\w-])(?:[/?#][^\s<>"']*)?`,
  ].join('|'),
  'gi'
);

/** Drops punctuation that ends a sentence rather than the link: "see x.com." */
function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (!last) return out;
    if ('.,;:!?\'"*'.includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    // A closing bracket belongs to the link only if the link opened one.
    if (last === ')' && (out.match(/\(/g) || []).length < (out.match(/\)/g) || []).length) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ']' && (out.match(/\[/g) || []).length < (out.match(/\]/g) || []).length) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  LINK.lastIndex = 0;
  for (let m = LINK.exec(text); m; m = LINK.exec(text)) {
    const start = m.index;
    // A bare domain glued to a word, path or address ("files/my.site.com")
    // is not a link of its own.
    if (!/^(https?:\/\/|www\.)/i.test(m[0]) && !m[0].includes('@') && start > 0 && /[\w@./-]/.test(text[start - 1])) {
      LINK.lastIndex = start + 1;
      continue;
    }
    const raw = trimTrailing(m[0]);
    if (!raw) continue;
    const end = start + raw.length;
    // Resume right after what was kept, so trimmed punctuation stays text.
    LINK.lastIndex = end;
    let href: string;
    if (raw.includes('@') && !/^https?:\/\//i.test(raw) && !raw.includes('/')) href = `mailto:${raw}`;
    else if (/^https?:\/\//i.test(raw)) href = raw;
    else href = `https://${raw}`;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: raw, href });
    last = end;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function hasLinks(text: string): boolean {
  return splitLinks(text).some((p) => p.href);
}
