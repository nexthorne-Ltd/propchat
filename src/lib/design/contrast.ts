/**
 * WCAG 2.x contrast maths, used by the token tests to keep the palette AA.
 * Accepts #rgb, #rrggbb and rgba() (alpha is composited over `backdrop`).
 */

type RGB = [number, number, number];

export function parseColor(input: string, backdrop: RGB = [255, 255, 255]): RGB {
  const s = input.trim().toLowerCase();
  if (s.startsWith('#')) {
    const hex = s.length === 4 ? s.slice(1).split('').map((c) => c + c).join('') : s.slice(1, 7);
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (!m) throw new Error(`Unsupported colour: ${input}`);
  const [r, g, b, a = 1] = m[1].split(',').map((p) => Number(p.trim()));
  return [r, g, b].map((c, i) => Math.round(c * a + backdrop[i] * (1 - a))) as RGB;
}

export function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fg: string, bg: string): number {
  const back = parseColor(bg);
  const a = luminance(parseColor(fg, back));
  const b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Pulls `--ds-*: value;` declarations out of one CSS block. */
export function readTokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--(ds-[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** Resolves `var(--ds-x)` references against the same token set. */
export function resolveToken(tokens: Record<string, string>, name: string, depth = 0): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`Unknown token --${name}`);
  const ref = /^var\(--(ds-[\w-]+)\)$/.exec(value);
  if (ref && depth < 5) return resolveToken(tokens, ref[1], depth + 1);
  return value;
}
