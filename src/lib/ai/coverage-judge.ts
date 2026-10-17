/**
 * The model as the reader for the knowledge check (coverage.ts): every
 * checklist item of the switched-on specialists is given to the platform
 * model with every article's title and opening, in one call, and it names
 * the article that states the answer, or none. Its verdict replaces the
 * keyword one, which both misses other wordings ("reward share" for profit
 * split) and passes long articles that merely list the words.
 *
 * Only on demand (opening Knowledge sources, "Check again", after a
 * re-index), one call per check. No model, a failed call, or a topic the
 * model left out: the keyword result stands for it.
 */
import { chat, isConfigured, type ProviderConfig } from './provider';
import { getPlatformAiConfigServerOnly } from './platform-gateway';
import { toPlainText, type HelpIndex } from './retrieval';
import { coverageJudgePrompt, parseJudgeAnswer, type JudgeArticle, type SpecialistCoverage } from './coverage';

export const COVERAGE_JUDGE_TIMEOUT_MS = 40_000;

export async function judgeCoverage(
  index: HelpIndex,
  report: SpecialistCoverage[],
  providerConfig?: ProviderConfig | null
): Promise<SpecialistCoverage[]> {
  const topics = report.flatMap((s) => (s.enabled ? s.items.map((i) => ({ key: `${s.agent}.${i.id}`, label: i.label })) : []));
  if (!topics.length || !index.docs.length) return report;

  let config = providerConfig ?? null;
  if (!isConfigured(config)) config = (await getPlatformAiConfigServerOnly().catch(() => null))?.config ?? null;
  if (!isConfigured(config)) return report;

  const articles: JudgeArticle[] = index.docs.map((d) => ({
    title: d.article.title,
    excerpt: toPlainText(d.article.content || ''),
  }));
  const { system, user } = coverageJudgePrompt(topics, articles);
  let raw = '';
  try {
    const res = await chat(config!, {
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1500,
      temperature: 0,
      reasoning: 'fast',
      timeoutMs: COVERAGE_JUDGE_TIMEOUT_MS,
    });
    raw = res.text || '';
  } catch (err) {
    console.warn('[Coverage] The model check failed, keeping the keyword result:', (err as Error)?.message);
    return report;
  }

  const verdict = parseJudgeAnswer(raw, topics.map((t) => t.key), articles.length);
  return report.map((s) => {
    const items = s.items.map((i) => {
      const n = verdict.get(`${s.agent}.${i.id}`);
      if (n === undefined) return i;
      return n > 0
        ? { ...i, covered: true, article: articles[n - 1].title, matchedBy: 'meaning' as const }
        : { ...i, covered: false, article: null, matchedBy: undefined };
    });
    return { ...s, items, covered: items.filter((i) => i.covered).length };
  });
}
