/**
 * @mentions in team chat. The composer inserts "@Name" when someone is picked
 * from the list; on send, the people whose "@Name" is still in the text are
 * the mentions (deleting the name removes the mention). The database keeps
 * only ids of the workspace's own people.
 */

export interface MentionPerson {
  id: string;
  name: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ids of the people mentioned by name in `text`; longest names first, so "Ali Khan" wins over "Ali". */
export function mentionedIds(text: string, people: MentionPerson[]): string[] {
  const found = new Set<string>();
  let rest = text;
  for (const p of [...people].filter((x) => x.name.trim()).sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`(^|[^\\w@])@${escape(p.name.trim())}(?![\\w])`, 'gi');
    if (re.test(rest)) {
      found.add(p.id);
      rest = rest.replace(re, '$1');
    }
  }
  return [...found];
}

/** The "@partial" being typed just before the caret, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** Splits text into plain parts and @mention parts, for rendering. */
export function splitMentions(text: string, names: string[]): { text: string; mention: boolean }[] {
  const sorted = names.filter((n) => n.trim()).sort((a, b) => b.length - a.length);
  if (!sorted.length) return [{ text, mention: false }];
  const re = new RegExp(`@(?:${sorted.map(escape).join('|')})(?![\\w])`, 'gi');
  const out: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > 0 && /[\w@]/.test(text[at - 1])) continue;
    if (at > last) out.push({ text: text.slice(last, at), mention: false });
    out.push({ text: m[0], mention: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out;
}
