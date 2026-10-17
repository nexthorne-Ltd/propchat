import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The model reads every checklist item against the articles: its verdict
 * replaces the keyword one both ways (other wording found, a word-only match
 * refused), and without a model, or when it fails, the words stand.
 */

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));
vi.mock('@/lib/ai/platform-gateway', () => ({ getPlatformAiConfigServerOnly: async () => ({ config: null }) }));
vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  return { ...actual, chat: vi.fn() };
});

const { chat } = await import('@/lib/ai/provider');
const { buildIndex } = await import('@/lib/ai/retrieval');
const { checkCoverage, coverageJudgePrompt, parseJudgeAnswer } = await import('@/lib/ai/coverage');
const { judgeCoverage } = await import('./coverage-judge');

const provider = { provider: 'deepseek' as const, apiKey: 'k' };
const article = (id: string, title: string, content: string) => ({ id, title, content, sectionName: 'FAQ', slug: id }) as never;

// A firm that says "reward share", and a pasted customer email that names every topic.
const index = buildIndex([
  article('a1', 'What is the reward share for each program?', 'Traders keep 80% of the reward on every program.'),
  article('a2', 'Hello Support Team', 'Please confirm the profit split, payout methods, minimum payout and refund policy before I buy.'),
  article('a3', 'Payout methods', 'Payouts are sent by USDT or bank transfer.'),
]);

beforeEach(() => vi.mocked(chat).mockReset());

describe('judgeCoverage', () => {
  it('finds other wording, refuses a word-only match, and confirms a real one', async () => {
    const words = checkCoverage(index, (id) => id === 'payouts');
    vi.mocked(chat).mockResolvedValue({
      text: '{"payouts.split": 1, "payouts.methods": 3, "payouts.minimum": 0, "payouts.first": 0, "payouts.processing": 0, "payouts.request": 0}',
      provider: 'deepseek',
      model: 'm',
    });
    const out = (await judgeCoverage(index, words, provider)).find((s) => s.agent === 'payouts')!;
    expect(out.items.find((i) => i.id === 'split')).toMatchObject({ covered: true, article: 'What is the reward share for each program?', matchedBy: 'meaning' });
    expect(out.items.find((i) => i.id === 'methods')).toMatchObject({ covered: true, article: 'Payout methods' });
    expect(out.items.find((i) => i.id === 'minimum')).toMatchObject({ covered: false, article: null });
    expect(out.covered).toBe(2);
    expect(vi.mocked(chat).mock.calls.length).toBe(1);
    const user = vi.mocked(chat).mock.calls[0][1].messages[0].content;
    expect(user).toContain('[1] What is the reward share for each program?');
    expect(user).toContain('payouts.split: Profit split');
  });

  it('a topic the model left out keeps the keyword result; a failed call keeps them all', async () => {
    const words = checkCoverage(index, (id) => id === 'payouts');
    const methodsByWords = words.find((s) => s.agent === 'payouts')!.items.find((i) => i.id === 'methods')!;
    vi.mocked(chat).mockResolvedValueOnce({ text: '{"payouts.split": 1}', provider: 'deepseek', model: 'm' });
    const partial = (await judgeCoverage(index, words, provider)).find((s) => s.agent === 'payouts')!;
    expect(partial.items.find((i) => i.id === 'methods')!.covered).toBe(methodsByWords.covered);

    vi.mocked(chat).mockRejectedValueOnce(new Error('timeout'));
    expect(await judgeCoverage(index, words, provider)).toEqual(words);
  });

  it('without a model nothing is asked', async () => {
    const words = checkCoverage(index);
    expect(await judgeCoverage(index, words, null)).toEqual(words);
    expect(chat).not.toHaveBeenCalled();
  });

  it('switched-off specialists are not asked about', async () => {
    vi.mocked(chat).mockResolvedValueOnce({ text: '{}', provider: 'deepseek', model: 'm' });
    await judgeCoverage(index, checkCoverage(index, (id) => id === 'payouts'), provider);
    expect(vi.mocked(chat).mock.calls[0][1].messages[0].content).not.toContain('refunds.policy');
  });
});

describe('parseJudgeAnswer and the prompt', () => {
  it('reads numbers and zeros, drops anything out of range', () => {
    const v = parseJudgeAnswer('Sure: {"a": 2, "b": 0, "c": 9, "d": "x"}', ['a', 'b', 'c', 'd', 'e'], 3);
    expect([...v.entries()]).toEqual([
      ['a', 2],
      ['b', 0],
    ]);
    expect(parseJudgeAnswer('no json', ['a'], 3).size).toBe(0);
  });

  it('numbers the articles and lists every topic', () => {
    const { user, system } = coverageJudgePrompt([{ key: 'x.y', label: 'Thing' }], [{ title: 'T', excerpt: 'E' }]);
    expect(user).toContain('[1] T: E');
    expect(user).toContain('x.y: Thing');
    expect(system).toContain('Be strict');
  });
});
