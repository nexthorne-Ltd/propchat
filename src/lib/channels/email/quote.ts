/**
 * Removing what a customer's mail client quoted below their new text, so a
 * ticket thread shows what they wrote and not the whole history again. Only
 * the tail is ever cut: if nothing would be left, the original text is kept,
 * because losing a customer's words is worse than showing a quote twice.
 */

const ATTRIBUTION = /^(on|le|el|am|em|il|op|den)\s.{3,300}?(wrote|a écrit|escribió|schrieb|escreveu|ha scritto|schreef|skrev)\s*:?\s*$/i;
const SEPARATOR = /^[\s>]*(?:-{2,}|_{3,}|={3,})\s*(?:original message|forwarded message|reply above|mensaje original|message d.origine|ursprüngliche nachricht|messaggio originale)[^\n]*$/i;
const REPLY_ABOVE = /^[\s\-–—_=]*(?:please\s+)?reply\s+above\s+this\s+line[\s\-–—_=]*$/i;
const HEADER_FIELD = /^(from|von|de|da|van)\s*:\s*\S/i;
const HEADER_FOLLOWUP = /^(sent|date|gesendet|envoyé|enviado|datum|to|an|à|para|subject|betreff|objet|asunto|cc)\s*:/i;

function isHeaderBlock(lines: string[], i: number): boolean {
  if (!HEADER_FIELD.test(lines[i].trim())) return false;
  let hits = 0;
  for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
    if (HEADER_FOLLOWUP.test(lines[j].trim())) hits++;
    else if (lines[j].trim() !== '') break;
  }
  return hits >= 2;
}

/** Index of the line where the quoted history starts, or -1. */
function findQuoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (REPLY_ABOVE.test(line) || SEPARATOR.test(line)) return i;
    // "On Tue, 3 Jun 2025 at 10:12, Alice Example <alice@example.com>\nwrote:" wraps in some clients.
    if (/^(on|le|el|am|em|il|op|den)\s/i.test(line)) {
      for (let span = 1; span <= 3 && i + span <= lines.length; span++) {
        const joined = lines.slice(i, i + span).map((l) => l.trim()).join(' ');
        if (ATTRIBUTION.test(joined)) return i;
      }
    }
    if (isHeaderBlock(lines, i)) {
      // Outlook puts a line of underscores or a rule just above the block.
      return i > 0 && /^[_\-–—=\s]{5,}$/.test(lines[i - 1]) ? i - 1 : i;
    }
  }
  return -1;
}

export function splitQuotedText(text: string): { reply: string; quoted: string } {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const start = findQuoteStart(lines);
  let replyLines = start >= 0 ? lines.slice(0, start) : lines;
  let quotedLines = start >= 0 ? lines.slice(start) : [];

  // A trailing run of "> ..." lines is quoted history even without an attribution line.
  let end = replyLines.length;
  while (end > 0 && (replyLines[end - 1].trim() === '' || /^\s*>/.test(replyLines[end - 1]))) end--;
  if (end < replyLines.length && replyLines.slice(end).some((l) => /^\s*>/.test(l))) {
    quotedLines = [...replyLines.slice(end), ...quotedLines];
    replyLines = replyLines.slice(0, end);
  }

  const reply = replyLines.join('\n').trim();
  if (!reply) return { reply: normalized.trim(), quoted: '' };
  return { reply, quoted: quotedLines.join('\n').trim() };
}
