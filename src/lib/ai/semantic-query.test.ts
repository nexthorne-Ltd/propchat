/**
 * The query rewrite is a model call before almost every help-centre answer.
 * Messages that already work as a search query must skip it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}), hasServiceRole: () => true }));
vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  return { ...actual, chat: vi.fn(async () => ({ text: 'refund policy for returned items' })) };
});

import { chat, type ProviderConfig } from '@/lib/ai/provider';
import { expandVisitorQueries, isStandaloneEnglishQuery, rewriteVisitorMessageToEnglishQuery } from '@/lib/ai/semantic-retrieval';

const provider: ProviderConfig = { provider: 'anthropic', apiKey: 'test-key', model: null, baseUrl: null };

describe('isStandaloneEnglishQuery', () => {
  it.each([
    ['How long does express shipping take?', false],
    ['What payment methods do you accept?', true],
  ])('"%s" stands on its own', (message, hasHistory) => {
    expect(isStandaloneEnglishQuery(message, hasHistory)).toBe(true);
  });

  it.each([
    ['refund policy kya hai?', false],
    ['and what about express?', true],
    ['how much does it cost?', true],
    ['refund?', false],
    ['ریفنڈ پالیسی کیا ہے؟', false],
  ])('"%s" needs the rewrite', (message, hasHistory) => {
    expect(isStandaloneEnglishQuery(message, hasHistory)).toBe(false);
  });
});

describe('rewriteVisitorMessageToEnglishQuery', () => {
  it('returns a standalone English question as it is, without a model call', async () => {
    vi.mocked(chat).mockClear();
    const q = await rewriteVisitorMessageToEnglishQuery({
      visitorMessage: 'What payment methods do you accept?',
      providerConfig: provider,
    });
    expect(q).toBe('What payment methods do you accept?');
    expect(chat).not.toHaveBeenCalled();
  });

  it('rewrites Roman Urdu with a small token budget', async () => {
    vi.mocked(chat).mockClear();
    const q = await rewriteVisitorMessageToEnglishQuery({
      visitorMessage: 'refund policy kya hai?',
      providerConfig: provider,
    });
    expect(q).toBe('refund policy for returned items');
    expect(vi.mocked(chat).mock.calls[0][1].maxTokens).toBeLessThanOrEqual(60);
  });
});

describe('expandVisitorQueries', () => {
  it('a plain English question is searched as it is and normalised, without a model call', async () => {
    vi.mocked(chat).mockClear();
    const q = await expandVisitorQueries({ visitorMessage: 'What payment methods do you accept?', providerConfig: provider });
    expect(q).toEqual(['payment methods you accept', 'What payment methods do you accept?']);
    expect(chat).not.toHaveBeenCalled();
  });

  it('a messy message gets one model call; its FAQ-style queries come first, then the rules\' reading and the raw words', async () => {
    vi.mocked(chat).mockClear();
    vi.mocked(chat).mockResolvedValueOnce({ text: '["payout not received after 3 days", "payout processing time"]' } as Awaited<ReturnType<typeof chat>>);
    const q = await expandVisitorQueries({ visitorMessage: 'bhai 3 din se pyout nahi aaya', providerConfig: provider });
    expect(q).toEqual(['payout not received after 3 days', 'payout processing time', '3 days payout not received', 'bhai 3 din se pyout nahi aaya']);
    expect(chat).toHaveBeenCalledTimes(1);
    const req = vi.mocked(chat).mock.calls[0][1];
    expect(req.maxTokens).toBeLessThanOrEqual(90);
    expect(req.messages[0].content).toContain('Rough reading (may be imperfect): 3 days payout not received');
  });

  it('without a model the rules still turn shorthand into search terms', async () => {
    const q = await expandVisitorQueries({ visitorMessage: 'dd kitna hai 10k pe', providerConfig: null });
    expect(q).toEqual(['drawdown how much 10k', 'dd kitna hai 10k pe']);
  });

  it('a failed model call falls back to the rules', async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error('timeout'));
    const q = await expandVisitorQueries({ visitorMessage: 'withdrawl kese karun', providerConfig: provider });
    expect(q).toEqual(['withdrawal how', 'withdrawl kese karun']);
  });
});
