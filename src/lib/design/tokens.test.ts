import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, readTokens, resolveToken } from './contrast';

/*
 * The colour tokens in globals.css are the design system's contract. These
 * tests read the real stylesheet, so a token edit that breaks WCAG AA, or that
 * changes one of the two dark-mode blocks but not the other, fails CI.
 */

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

function block(startMarker: string): string {
  const start = css.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing block ${startMarker}`);
  const open = css.indexOf('{', start + startMarker.length - 1);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('Unbalanced CSS');
}

const light = readTokens(block(':root {'));
const darkExplicit = { ...light, ...readTokens(block(':root[data-theme="dark"],')) };
const darkSystem = { ...light, ...readTokens(block('@media (prefers-color-scheme: dark) {')) };

/** Text token on background token, at the AA threshold for body text. */
const TEXT_PAIRS: [string, string][] = [
  ['ds-ink', 'ds-canvas'],
  ['ds-ink', 'ds-surface'],
  ['ds-ink-2', 'ds-surface'],
  ['ds-ink-2', 'ds-surface-2'],
  ['ds-ink-2', 'ds-surface-3'],
  ['ds-ink-3', 'ds-canvas'],
  ['ds-ink-3', 'ds-surface'],
  ['ds-ink-3', 'ds-surface-2'],
  ['ds-ink-3', 'ds-surface-3'],
  ['ds-accent', 'ds-surface'],
  ['ds-accent', 'ds-canvas'],
  ['ds-accent', 'ds-accent-soft'],
  ['ds-accent-ink', 'ds-accent'],
  ['ds-primary-ink', 'ds-primary'],
  ['ds-bubble-out-ink', 'ds-bubble-out'],
  ['ds-success', 'ds-success-soft'],
  ['ds-success', 'ds-surface'],
  ['ds-warn', 'ds-warn-soft'],
  ['ds-warn', 'ds-surface'],
  ['ds-danger', 'ds-danger-soft'],
  ['ds-danger', 'ds-surface'],
  ['ds-info', 'ds-info-soft'],
  ['ds-invert-ink', 'ds-invert'],
  ['ds-invert-ink-2', 'ds-invert'],
];

describe.each([
  ['light', light],
  ['dark', darkExplicit],
])('%s theme contrast', (_name, tokens) => {
  it.each(TEXT_PAIRS)('%s on %s meets WCAG AA (4.5:1)', (fg, bg) => {
    const ratio = contrastRatio(resolveToken(tokens, fg), resolveToken(tokens, bg));
    expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it('focus colour is visible against the surface (3:1 for UI)', () => {
    expect(contrastRatio(resolveToken(tokens, 'ds-focus'), resolveToken(tokens, 'ds-surface'))).toBeGreaterThanOrEqual(3);
  });
});

describe('dark mode blocks', () => {
  it('system-default dark is identical to the explicit dark theme', () => {
    expect(darkSystem).toEqual(darkExplicit);
  });
});
