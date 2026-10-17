/**
 * Text edits for the article editor's toolbar and shortcuts. Pure functions
 * over (text, selection), so the editor stays a thin layer and every edit is
 * tested: each returns the new text and where the selection should be.
 */

export interface Edit {
  text: string;
  start: number;
  end: number;
}

/** **bold**, _italic_, `code`: wraps the selection, or unwraps it when already wrapped. */
export function wrap(text: string, start: number, end: number, marker: string, placeholder = 'text'): Edit {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);
  if (selected && before.endsWith(marker) && after.startsWith(marker)) {
    return {
      text: before.slice(0, -marker.length) + selected + after.slice(marker.length),
      start: start - marker.length,
      end: end - marker.length,
    };
  }
  const inner = selected || placeholder;
  return {
    text: `${before}${marker}${inner}${marker}${after}`,
    start: start + marker.length,
    end: start + marker.length + inner.length,
  };
}

type LineKind = 'bullet' | 'number' | 'task' | 'quote' | 'h2' | 'h3';

const PREFIX: Record<LineKind, RegExp> = {
  bullet: /^(\s*)[-*]\s+(?!\[[ xX]\])/,
  number: /^(\s*)\d+\.\s+/,
  task: /^(\s*)[-*]\s+\[[ xX]\]\s+/,
  quote: /^(\s*)>\s?/,
  h2: /^##\s+/,
  h3: /^###\s+/,
};
const ANY_PREFIX = /^(\s*)(?:[-*]\s+\[[ xX]\]\s+|[-*]\s+|\d+\.\s+|>\s?|#{1,6}\s+)/;

/**
 * Lists, quotes and headings on every selected line. All lines already of
 * this kind → removed; otherwise the kind replaces whatever was there.
 */
export function toggleLines(text: string, start: number, end: number, kind: LineKind): Edit {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', Math.max(end - (end > start && text[end - 1] === '\n' ? 1 : 0), start));
  if (lineEnd === -1) lineEnd = text.length;
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const all = lines.every((l) => !l.trim() || PREFIX[kind].test(l)) && lines.some((l) => l.trim());

  let n = 0;
  const next = lines.map((l) => {
    if (!l.trim()) return l;
    if (all) return l.replace(PREFIX[kind], '$1');
    const bare = l.replace(ANY_PREFIX, '$1');
    const indent = /^\s*/.exec(bare)?.[0] ?? '';
    const body = bare.slice(indent.length);
    switch (kind) {
      case 'bullet':
        return `${indent}- ${body}`;
      case 'number':
        return `${indent}${++n}. ${body}`;
      case 'task':
        return `${indent}- [ ] ${body}`;
      case 'quote':
        return `${indent}> ${body}`;
      case 'h2':
        return `## ${body}`;
      case 'h3':
        return `### ${body}`;
    }
  });
  const replaced = next.join('\n');
  const out = text.slice(0, lineStart) + replaced + text.slice(lineEnd);
  if (start === end) {
    // Keep the caret on the same word.
    const delta = next[0].length - lines[0].length;
    const pos = Math.max(lineStart, start + delta);
    return { text: out, start: pos, end: pos };
  }
  return { text: out, start: lineStart, end: lineStart + replaced.length };
}

/** A block (table, callout, divider, image) on its own lines at the caret. */
export function insertBlock(text: string, start: number, end: number, block: string): Edit {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const out = `${before}${lead}${block}${tail}${after}`;
  const pos = before.length + lead.length + block.length;
  return { text: out, start: pos, end: pos };
}

/** [selected text](url), selecting the url to type over when none was given. */
export function insertLink(text: string, start: number, end: number, url = 'https://'): Edit {
  const label = text.slice(start, end) || 'link text';
  const piece = `[${label}](${url})`;
  const out = text.slice(0, start) + piece + text.slice(end);
  const urlStart = start + label.length + 3;
  return text.slice(start, end)
    ? { text: out, start: urlStart, end: urlStart + url.length }
    : { text: out, start: start + 1, end: start + 1 + label.length };
}

/**
 * Enter inside a list continues it ("- ", "2. ", "- [ ] "); Enter on an
 * empty item ends the list. Null when Enter should behave normally.
 */
export function continueList(text: string, caret: number): Edit | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const line = text.slice(lineStart, caret);
  const m = /^(\s*)([-*]\s+\[[ xX]\]\s+|[-*]\s+|(\d+)\.\s+|>\s?)/.exec(line);
  if (!m) return null;
  if (line.trim() === m[2].trim()) {
    // Empty item: end the list.
    const out = text.slice(0, lineStart) + text.slice(caret);
    return { text: out, start: lineStart, end: lineStart };
  }
  const marker = m[3] ? `${Number(m[3]) + 1}. ` : m[2].replace(/\[[xX]\]/, '[ ]');
  const insert = `\n${m[1]}${marker}`;
  const out = text.slice(0, caret) + insert + text.slice(caret);
  return { text: out, start: caret + insert.length, end: caret + insert.length };
}

export const BLOCKS = {
  table: '| Column | Column |\n| --- | --- |\n| Value | Value |',
  divider: '---',
  note: '> [!NOTE]\n> Something useful to know.',
  tip: '> [!TIP]\n> A helpful tip.',
  warning: '> [!WARNING]\n> Something to be careful about.',
} as const;
