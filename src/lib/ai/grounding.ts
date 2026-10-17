/**
 * Whether an answer was written from a passage: shared by the bot's answer
 * check (anthropic.ts) and the learner's grounding check (learning/safety.ts),
 * so a learned answer passes exactly the test a live answer must pass.
 */
import type { ReplyLanguage } from './intent';

const GROUNDING_STOPWORDS = new Set([
  'about', 'after', 'also', 'been', 'before', 'being', 'can', 'could', 'does', 'each', 'from', 'have', 'here',
  'into', 'just', 'more', 'most', 'need', 'only', 'other', 'please', 'should', 'some', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'very', 'want', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'within', 'would', 'your', 'yours', 'you', 'the', 'and', 'for', 'are',
]);

function groundingTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const w of text.toLowerCase().match(/\d+(?:[.,]\d+)?%?|[a-z][a-z'-]{3,}/g) || []) {
    if (!GROUNDING_STOPWORDS.has(w)) terms.add(w);
  }
  return terms;
}

/**
 * Which numbered chunk an untagged answer was written from, if any. Models
 * (DeepSeek above all) often answer correctly but forget the [SOURCE: n]
 * tag, and every such answer used to be thrown away as unsourced. An answer
 * counts as grounded when most of its words and every one of its numbers
 * appear in one chunk; a guess ("we probably accept PayPal too") does not.
 * Returns the 0-based chunk index, or null.
 */
export function groundedChunkIndex(answer: string, knowledge: string, lang: ReplyLanguage = 'en'): number | null {
  const terms = groundingTerms(answer);
  if (terms.size < 3) return null;
  const numbers = [...terms].filter((t) => /\d/.test(t));
  const chunks = knowledge.split(/\[CHUNK \d+\]/).slice(1);
  let best: { index: number; score: number; hits: number } | null = null;
  chunks.forEach((chunk, index) => {
    const have = groundingTerms(chunk);
    if (numbers.some((num) => !have.has(num))) return;
    let hits = 0;
    for (const t of terms) if (have.has(t)) hits++;
    const score = hits / terms.size;
    if (!best || score > best.score) best = { index, score, hits };
  });
  const found = best as { index: number; score: number; hits: number } | null;
  if (!found) return null;
  // An answer in Roman Urdu or another language shares few words with English
  // articles even when it is a faithful translation; the names, terms and
  // figures it keeps from the article are the evidence instead.
  if (lang !== 'en') return found.hits >= 4 ? found.index : null;
  return found.score >= 0.5 ? found.index : null;
}
