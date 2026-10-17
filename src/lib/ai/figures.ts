/**
 * Money amounts and percentages in a drafted answer must come from the
 * articles (or the customer's own message), or be one simple step from them
 * ("6% of $5,000 is $300"). For a business whose questions are about limits,
 * prices and payouts, an invented figure is the worst thing the bot can say,
 * and a [SOURCE] tag does not prove the figure came from that source.
 *
 * Plain counts ("3 days", "2 trades") are not checked: they are too common
 * in ordinary wording to judge reliably.
 */

const MONEY = /(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?\s?k?\b|\b\d[\d,]*(?:\.\d+)?\s?k\b|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?|eur|gbp|pkr|inr)\b)/gi;
const PERCENT = /\b\d+(?:\.\d+)?\s?%/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

function value(token: string): number | null {
  const t = token.toLowerCase().replace(/[$€£₹,\s]/g, '').replace(/usd|dollars?|eur|gbp|pkr|inr/g, '');
  const k = t.endsWith('k');
  const n = parseFloat(k ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return null;
  return k ? n * 1000 : n;
}

function amounts(text: string): number[] {
  return (text.match(MONEY) || []).map(value).filter((v): v is number => v !== null);
}

function percents(text: string): number[] {
  return (text.match(PERCENT) || []).map((p) => parseFloat(p)).filter(Number.isFinite);
}

/** Every number in the text, as values ("$100,000" → 100000, "5k" → 5000). */
function allNumbers(text: string): number[] {
  const out = new Set<number>();
  for (const v of amounts(text)) out.add(v);
  for (const m of text.match(NUMBER) || []) {
    const v = parseFloat(m.replace(/,/g, ''));
    if (Number.isFinite(v)) out.add(v);
  }
  return [...out];
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.001);

/**
 * The money amounts and percentages in `answer` that `sources` (articles and
 * the question) do not support. Empty when every figure is accounted for.
 */
export function unsupportedFigures(answer: string, sources: string): string[] {
  const known = allNumbers(sources);
  const knownPercents = [...percents(sources), ...known.filter((n) => n > 0 && n <= 100)];
  const derivable = (v: number) =>
    known.some((n) => near(v, n)) ||
    // p% of an amount, the amount plus or minus p%, or an amount times a small count.
    knownPercents.some((p) =>
      known.some((a) => a > 0 && (near(v, (a * p) / 100) || near(v, a * (1 + p / 100)) || near(v, a * (1 - p / 100))))
    );

  const bad: string[] = [];
  for (const token of answer.match(MONEY) || []) {
    const v = value(token);
    if (v !== null && !derivable(v)) bad.push(token.trim());
  }
  for (const token of answer.match(PERCENT) || []) {
    const v = parseFloat(token);
    if (!knownPercents.some((p) => near(v, p)) && !known.some((n) => near(v, n))) bad.push(token.trim());
  }
  return bad;
}
