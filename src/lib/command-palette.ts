/**
 * Ranking for the Ctrl/Cmd+K command palette. Kept free of React so it can
 * be unit-tested: given what the agent typed and every command the palette
 * knows about, return the commands to show, best first, grouped in a fixed
 * order so results don't jump between sections as the query changes.
 */

export type PaletteGroup = 'Navigate' | 'Tickets' | 'Ticket views' | 'Settings' | 'Actions';

export const GROUP_ORDER: readonly PaletteGroup[] = ['Tickets', 'Navigate', 'Ticket views', 'Settings', 'Actions'];

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  title: string;
  subtitle?: string;
  /** Extra words that should find this item ("smtp" → Email settings). */
  keywords?: string[];
  /** Keyboard shortcut shown on the right, e.g. ['G', 'I']. */
  shortcut?: string[];
}

export interface RankedGroup {
  group: PaletteGroup;
  items: PaletteItem[];
}

export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Characters of `query` appear in `text` in order. Returns a score that
 * prefers tight matches (few gaps) or null when they don't all appear.
 */
function subsequence(query: string, text: string): number | null {
  let qi = 0;
  let gaps = 0;
  let last = -1;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      if (last >= 0) gaps += ti - last - 1;
      last = ti;
      qi++;
    }
  }
  if (qi < query.length) return null;
  return Math.max(1, 20 - gaps);
}

/**
 * How well `item` matches `query`; higher is better, null hides the item.
 * Title matches beat subtitle and keyword matches, and a match at the start
 * of a word beats one in the middle. A query that is a ticket number ("1003"
 * or "#1003") only ever matches on the title, where the number is.
 */
export function scoreItem(query: string, item: PaletteItem): number | null {
  const q = normalize(query).replace(/^#(?=\d)/, '');
  if (!q) return 1;
  const title = normalize(item.title);
  const titleBare = title.replace(/#(?=\d)/g, '');

  if (titleBare === q) return 120;
  if (titleBare.startsWith(q)) return 100;
  const words = titleBare.split(/[\s/&,–—-]+/);
  if (words.some((w) => w.startsWith(q))) return 85;
  const idx = titleBare.indexOf(q);
  if (idx >= 0) return 70 - Math.min(idx, 20);
  if (/^\d+$/.test(q)) return null;

  // Every word of a multi-word query matches the start of some title word.
  const qWords = q.split(/\s+/);
  if (qWords.length > 1 && qWords.every((qw) => words.some((w) => w.startsWith(qw)))) return 60;

  const extra = [item.subtitle, ...(item.keywords || [])].filter(Boolean).map((s) => normalize(s as string));
  if (extra.some((e) => e.split(/\s+/).some((w) => w.startsWith(q)))) return 45;
  if (extra.some((e) => e.includes(q))) return 35;

  return subsequence(q, titleBare);
}

/**
 * Filter, rank and group. Within a group, items keep their given order on
 * ties (so an empty query shows commands in their natural order).
 */
export function rankItems(query: string, items: PaletteItem[], perGroup = 8): RankedGroup[] {
  const scored = items
    .map((item, index) => ({ item, index, score: scoreItem(query, item) }))
    .filter((s): s is { item: PaletteItem; index: number; score: number } => s.score !== null);

  return GROUP_ORDER.map((group) => ({
    group,
    items: scored
      .filter((s) => s.item.group === group)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, perGroup)
      .map((s) => s.item),
  })).filter((g) => g.items.length > 0);
}

/** Flattened list in display order, for arrow-key navigation. */
export function flatten(groups: RankedGroup[]): PaletteItem[] {
  return groups.flatMap((g) => g.items);
}

/**
 * Next highlighted index after an arrow key, wrapping at both ends.
 * Returns -1 when there is nothing to highlight.
 */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

/** Ctrl+K on Windows/Linux, Cmd+K on macOS; never with Shift/Alt. */
export function isPaletteShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
}
