/** Finding a macro from what was typed after "/" in the reply box. */

/** The "/" at the start of a line, and what has been typed after it. */
export function slashQuery(body: string): { start: number; query: string } | null {
  const m = body.match(/(^|\n)\/([^\n]*)$/);
  if (!m) return null;
  return { start: body.length - m[2].length - 1, query: m[2] };
}

/** Macros whose title contains every word typed, personal ones before shared, at most 8. */
export function filterMacros<T extends { title: string; owner_id: string | null }>(macros: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return macros
    .filter((m) => words.every((w) => m.title.toLowerCase().includes(w)))
    .sort((a, b) => Number(a.owner_id === null) - Number(b.owner_id === null) || a.title.localeCompare(b.title))
    .slice(0, 8);
}
