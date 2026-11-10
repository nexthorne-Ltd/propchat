/**
 * The whole answer pipeline for one visitor message, run against a fixture
 * help centre with the real keyword retrieval, confidence gate, citation and
 * handover summary. Only the database client and the model are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessHoursConfig, RetrievedChunk } from '@/types/database';

const WORKSPACE_ID = 'ws-acme';
const HELP_URL = 'https://acme.help.example';

const db = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
}));

/** Just enough of the Supabase query builder for help-answer.ts. */
function fakeSupabase() {
  const query = (rows: unknown[]) => {
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'or', 'filter', 'upsert']) {
      builder[m] = () => builder;
    }
    builder.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    builder.single = () => Promise.resolve({ data: rows[0] ?? null, error: null });
    builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
    return builder;
  };
  return {
    from: (table: string) => query(db.tables[table] ?? []),
    rpc: (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      if (fn === 'fn_assistant_notes') return Promise.resolve({ data: db.tables.notes ?? [], error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => fakeSupabase(), hasServiceRole: () => true }));

const semantic = vi.hoisted(() => ({ chunks: [] as RetrievedChunk[] }));
vi.mock('@/lib/ai/semantic-retrieval', () => ({
  // No embeddings in tests unless a test provides chunks: the keyword index answers.
  buildSemanticModelContext: async ({ visitorMessage }: { visitorMessage: string }) => {
    if (!semantic.chunks.length) {
      return { text: '', used: [], rewrittenQuery: visitorMessage, queryEmbedding: null, chunks: [], belowThreshold: true };
    }
    return {
      text: semantic.chunks
        .map((c, i) => `[CHUNK ${i + 1}]\nArticle: ${c.article_title}\nSection: ${c.section_name}\n\n${c.content}`)
        .join('\n\n---\n\n'),
      used: semantic.chunks.map((c) => ({ id: c.article_id, title: c.article_title, source: 'article' })),
      rewrittenQuery: visitorMessage,
      queryEmbedding: null,
      chunks: semantic.chunks,
      belowThreshold: false,
    };
  },
  hybridSearchWorkspaceChunks: async () => semantic.chunks,
  BOT_KNOWLEDGE_SECTION: 'Team knowledge',
}));

// The retrieval policy explores at random; the pipeline is tested under the default arm.
vi.mock('@/lib/ai/learning/policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/learning/policy')>();
  return { ...actual, pickPolicyArm: async () => 'standard' };
});

vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  return { ...actual, chat: vi.fn() };
});

import { chat, type ProviderConfig } from '@/lib/ai/provider';
import { generateHelpDeskResponseWithHandover, lowConfidenceReply, partialAnswerHandoverLine, teamHandlesTopicReply } from '@/lib/ai/anthropic';
import type { SubAgentSettings } from '@/lib/ai/sub-agents';
import { noAnswerHandoverReply, pendingUpdateReply, welcomeBackReply } from '@/lib/ai/intent';
import { invalidateHelpIndex } from '@/lib/ai/help-answer';

const ARTICLES = [
  {
    id: 'art-refund',
    slug: 'refund-policy',
    title: 'Refund policy',
    section_id: 'sec-orders',
    category: 'Orders',
    summary: 'When and how you can get your money back.',
    content:
      'You can request a refund within 30 days of delivery. Items must be unused and in their original packaging. Refunds are sent to the original payment method within 5 to 7 business days after we receive the return.',
  },
  {
    id: 'art-shipping',
    slug: 'shipping-times',
    title: 'Shipping times',
    section_id: 'sec-orders',
    category: 'Orders',
    summary: 'How long delivery takes.',
    content:
      'Standard shipping takes 3 to 5 business days within Pakistan. Express shipping takes 1 to 2 business days. International shipping takes 7 to 14 business days.',
  },
  {
    id: 'art-password',
    slug: 'reset-password',
    title: 'Reset your password',
    section_id: 'sec-account',
    category: 'Account',
    summary: null,
    content:
      'To reset your password, open the login page and click "Forgot password". Enter your email address and we will send you a reset link that is valid for 30 minutes.',
  },
  {
    id: 'art-payment',
    slug: 'payment-methods',
    title: 'Payment methods',
    section_id: 'sec-orders',
    category: 'Orders',
    summary: null,
    content: 'We accept Visa and Mastercard credit cards, debit cards, JazzCash, Easypaisa and cash on delivery.',
  },
];

const BOT_KNOWLEDGE = [
  {
    id: 'bk-delivery',
    title: 'Delivery charges by city',
    content: 'Delivery to Karachi costs Rs 200 and arrives in 1 to 2 days. Delivery to Lahore costs Rs 250 and arrives in 2 to 3 days.',
  },
];

const NOTES = [
  {
    id: 'note-1',
    title: 'Gift cards',
    content: 'Internal: gift cards are launching next quarter, do not promise dates. Gift cards cost 5000.',
    tags: ['internal'],
  },
];

function resetFixture() {
  db.tables = {
    help_sections: [
      { id: 'sec-orders', name: 'Orders and delivery' },
      { id: 'sec-account', name: 'Your account' },
    ],
    articles: ARTICLES,
    notes: NOTES,
  };
  db.rpcCalls = [];
  semantic.chunks = [];
  // The keyword index is cached per workspace; a test that changes the tables must not leak into the next.
  invalidateHelpIndex(WORKSPACE_ID);
}

async function ask(
  message: string,
  opts: {
    turns?: { role: 'user' | 'assistant'; content: string }[];
    providerConfig?: ProviderConfig | null;
    businessHours?: BusinessHoursConfig | null;
  } = {}
) {
  return generateHelpDeskResponseWithHandover({
    workspaceId: WORKSPACE_ID,
    conversationId: 'conv-1',
    incomingMessage: message,
    providerConfig: opts.providerConfig ?? null,
    turns: opts.turns,
    businessHours: opts.businessHours ?? null,
    helpCenterUrl: HELP_URL,
    workspaceName: 'Acme Store',
  });
}

const gapsRecorded = () => db.rpcCalls.filter((c) => c.fn.includes('unanswered_question'));

beforeEach(() => {
  resetFixture();
  vi.mocked(chat).mockReset();
});

describe('help-center questions, no model configured', () => {
  it.each([
    ['What is your refund policy?', 'Refund policy', 'refund-policy', '30 days'],
    ['How do I reset my password?', 'Reset your password', 'reset-password', 'Forgot password'],
    ['How long does express shipping take?', 'Shipping times', 'shipping-times', '1 to 2 business days'],
    ['refund policy kya hai?', 'Refund policy', 'refund-policy', '30 days'],
  ])('"%s" is answered from "%s" and cites it', async (message, title, slug, fact) => {
    const r = await ask(message);
    expect(r.intent).toBe('help_center_question');
    expect(r.shouldHandover).toBe(false);
    expect(r.citation).toMatchObject({ title, url: `${HELP_URL}/${slug}` });
    expect(r.replyText).toContain(fact);
    expect(r.replyText).toContain(`[${title}](${HELP_URL}/${slug})`);
    expect(gapsRecorded()).toHaveLength(0);
  });

  it('does not guess when no article fits: says so, hands the question to the team, keeps the bot on, logs the gap', async () => {
    const r = await ask('Do you have a store in Islamabad?');
    expect(r.intent).toBe('help_center_question');
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
    expect(r).toMatchObject({ shouldHandover: true, disableAi: false, priority: 'normal' });
    expect(r.internalNote).toContain('Not in the help center');
    expect(r.citation).toBeNull();
    expect(r.retrievalConfidence).toBe('low');
    expect(gapsRecorded()).toHaveLength(1);
  });

  it('spam gets a fixed line: no model, no handover, nothing logged as a gap', async () => {
    const r = await ask('Earn $5000 daily click here', { providerConfig: { provider: 'anthropic', apiKey: 'k', model: null, baseUrl: null } });
    expect(r).toMatchObject({ shouldHandover: false, intent: 'out_of_scope' });
    expect(vi.mocked(chat)).not.toHaveBeenCalled();
    expect(gapsRecorded()).toHaveLength(0);
  });

  it('a time-critical account problem reaches the team as urgent', async () => {
    const r = await ask('My payment was charged twice, please refund today');
    expect(r).toMatchObject({ shouldHandover: true, intent: 'account_specific', priority: 'urgent' });
  });

  it('never answers from team notes, even when a note matches', async () => {
    const r = await ask('How much do gift cards cost?');
    expect(r.replyText).not.toContain('5000');
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
  });

  it('hands over in Roman Urdu when asked in Roman Urdu', async () => {
    const r = await ask('kya aap ka Islamabad mein koi store hai?');
    expect(r.replyText).toBe(noAnswerHandoverReply('roman_ur'));
  });

  it('answers from Bot knowledge without naming or linking it', async () => {
    db.tables.bot_knowledge = BOT_KNOWLEDGE;
    invalidateHelpIndex(WORKSPACE_ID);
    const r = await ask('What are your delivery charges by city?');
    expect(r.shouldHandover).toBe(false);
    expect(r.replyText).toContain('Rs 200');
    expect(r.replyText).not.toContain('Source');
    expect(r.replyText).not.toContain('Delivery charges by city');
    expect(r.citation).toBeNull();
  });

  it('cites the article title without a link when the workspace has no help-centre URL', async () => {
    const r = await generateHelpDeskResponseWithHandover({
      workspaceId: WORKSPACE_ID,
      conversationId: 'conv-1',
      incomingMessage: 'What is your refund policy?',
      workspaceName: 'Acme Store',
    });
    expect(r.replyText).toContain('Source: **Refund policy**');
  });
});

describe('help-center questions with a model configured', () => {
  const provider: ProviderConfig = { provider: 'anthropic', apiKey: 'test-key', model: null, baseUrl: null };
  const mockedChat = vi.mocked(chat);

  /** Classifier calls get JSON; answer calls get `answer`. */
  function modelAnswers(answer: string, intent = 'help_center_question') {
    mockedChat.mockImplementation(async (_cfg, req) => {
      if (req.system.includes('You route customer messages')) {
        return { text: JSON.stringify({ intent, confidence: 0.9, summary: 'test' }) } as Awaited<ReturnType<typeof chat>>;
      }
      return { text: answer } as Awaited<ReturnType<typeof chat>>;
    });
  }

  describe('with Jev beside the model', () => {
    /** Jev's answers: intent says help-center question; the answer check says `supported`. */
    function jevReplies(supported: number) {
      const calls: Record<string, unknown>[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          calls.push(body);
          const answers = body.questions.supported
            ? { supported: { type: 'noul', noul: supported } }
            : {
                intent: { type: 'choice', choice: 'help_center_question', confidence: 0.95, probabilities: {} },
                wants_human: { type: 'noul', noul: 0.02 },
                frustration: { type: 'score', score: 0, confidence: 0.9, probabilities: { '0': 1 } },
                urgent: { type: 'noul', noul: 0.05 },
                spam: { type: 'noul', noul: 0.01 },
              };
          return new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status: 200 });
        })
      );
      return calls;
    }
    const enableJev = (mode: 'shadow' | 'live') => {
      // Set by the super admin on the platform row, next to the DeepSeek key.
      db.tables.platform_ai_settings = [{ jev_settings: { mode }, jev_api_key: 'ts_test' }];
    };
    afterEach(() => vi.unstubAllGlobals());

    it('live: an answer Jev finds unsupported goes to the team instead of the customer', async () => {
      enableJev('live');
      const calls = jevReplies(0.08);
      modelAnswers('Standard delivery takes 3 to 5 business days. [SOURCE: 1]');
      const r = await ask('How long does delivery take?', { providerConfig: provider });
      expect(r.shouldHandover).toBe(true);
      expect(r.handoverReason).toMatch(/Jev/);
      expect(r.replyText).not.toContain('3 to 5 business days');
      expect(calls.some((c) => (c.questions as Record<string, unknown>).supported)).toBe(true);
      // The question lands on the unanswered list, like any the articles do not cover.
      expect(gapsRecorded()).toHaveLength(1);
    });

    it('Jev down: the model still answers', async () => {
      enableJev('live');
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
      modelAnswers('Standard delivery takes 3 to 5 business days. [SOURCE: 1]');
      const r = await ask('How long does delivery take?', { providerConfig: provider });
      expect(r.shouldHandover).toBe(false);
      expect(r.replyText).toContain('3 to 5 business days');
    });

    it('shadow: the same answer is still sent; Jev only records', async () => {
      enableJev('shadow');
      jevReplies(0.08);
      modelAnswers('Standard delivery takes 3 to 5 business days. [SOURCE: 1]');
      const r = await ask('How long does delivery take?', { providerConfig: provider });
      expect(r.shouldHandover).toBe(false);
      expect(r.replyText).toContain('3 to 5 business days');
    });

    it('live: a supported answer goes out as usual', async () => {
      enableJev('live');
      jevReplies(0.93);
      modelAnswers('Standard delivery takes 3 to 5 business days. [SOURCE: 1]');
      const r = await ask('How long does delivery take?', { providerConfig: provider });
      expect(r.shouldHandover).toBe(false);
      expect(r.citation?.id).toBe('art-shipping');
    });
  });

  it('cites the article the model names, and drops any link the model wrote', async () => {
    modelAnswers(
      'Standard delivery takes 3 to 5 business days. [Read more](https://made-up.example/shipping) [SOURCE: 1]'
    );
    const r = await ask('How long does delivery take?', { providerConfig: provider });
    expect(r.citation?.id).toBe('art-shipping');
    expect(r.replyText).not.toContain('made-up.example');
    expect(r.replyText).not.toContain('[SOURCE');
    expect(r.replyText).toMatch(/3 to 5 business days\.\n\nSource: \[Shipping times\]\(https:\/\/acme\.help\.example\/shipping-times\)$/);

    const answerCall = mockedChat.mock.calls.find(([, req]) => req.system.includes('HELP-CENTER ARTICLES'));
    expect(answerCall).toBeDefined();
    expect(answerCall![1].system).not.toContain('Gift cards'); // team notes never reach the model
  });

  it('treats [NOT_COVERED] as low confidence: no answer, hand over, log the gap', async () => {
    modelAnswers('[NOT_COVERED]');
    const r = await ask('How long does delivery take for furniture?', { providerConfig: provider });
    expect(mockedChat.mock.calls.some(([, req]) => req.system.includes('HELP-CENTER ARTICLES'))).toBe(true);
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
    expect(r.shouldHandover).toBe(true);
    expect(gapsRecorded()).toHaveLength(1);
  });

  it('treats [NOT_COVERED] with stray punctuation the same, never sending a near-empty reply', async () => {
    modelAnswers('[NOT_COVERED].');
    const r = await ask('How long does delivery take for furniture?', { providerConfig: provider });
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
    expect(r.shouldHandover).toBe(true);
  });

  it('asks the model for the [SOURCE: n] and [NOT_COVERED] tags the pipeline reads', async () => {
    // Without these instructions a model answers untagged, and every answer
    // short of high confidence is thrown away as unsourced.
    modelAnswers('Standard delivery takes 3 to 5 business days. [SOURCE: 1]');
    await ask('How long does delivery take?', { providerConfig: provider });
    const answerCall = mockedChat.mock.calls.find(([, req]) => req.system.includes('HELP-CENTER ARTICLES'));
    expect(answerCall![1].system).toContain('[SOURCE: n]');
    expect(answerCall![1].system).toContain('[NOT_COVERED]');
  });

  it('does not call the answering model at all when retrieval confidence is low', async () => {
    modelAnswers('Yes, we have a store in Islamabad. [SOURCE: 1]');
    const r = await ask('Do you have a store in Islamabad?', { providerConfig: provider });
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
    expect(mockedChat.mock.calls.some(([, req]) => req.system.includes('HELP-CENTER ARTICLES'))).toBe(false);
  });

  it('rejects an unsourced answer when retrieval was only a partial match', async () => {
    semantic.chunks = [
      {
        id: 'c1', article_id: 'art-payment', article_title: 'Payment methods', section_name: 'Orders and delivery',
        article_slug: 'payment-methods', chunk_index: 0, content: ARTICLES[3].content,
        similarity: 0.5, keyword_score: 0.1, combined_score: 0.4,
      },
    ];
    modelAnswers('We probably accept PayPal too.');
    const r = await ask('Do you accept PayPal?', { providerConfig: provider });
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
  });

  it('hands over for real when the model tells the visitor, in Roman Urdu, that it is passing them on', async () => {
    semantic.chunks = [
      {
        id: 'c1', article_id: 'art-refund', article_title: 'Refund policy', section_name: 'Orders and delivery',
        article_slug: 'refund-policy', chunk_index: 0, content: ARTICLES[0].content,
        similarity: 0.82, keyword_score: 0.4, combined_score: 0.7,
      },
    ];
    modelAnswers('Refund aapke payment se juda mamla hai, isliye main ise team ko pass kar raha hoon. [SOURCE: 1]');
    const r = await ask('refund kaise milega?', { providerConfig: provider });
    expect(r.shouldHandover).toBe(true);
  });

  it('keeps an untagged answer that is written from the article, and cites that article', async () => {
    // DeepSeek often answers correctly and forgets [SOURCE: n].
    semantic.chunks = [
      {
        id: 'c1', article_id: 'art-shipping', article_title: 'Shipping times', section_name: 'Orders and delivery',
        article_slug: 'shipping-times', chunk_index: 0, content: ARTICLES[1].content,
        similarity: 0.5, keyword_score: 0.1, combined_score: 0.4,
      },
    ];
    modelAnswers('Express shipping takes 1 to 2 business days, and standard shipping within Pakistan takes 3 to 5 business days.');
    const r = await ask('How long does shipping take?', { providerConfig: provider });
    expect(r.shouldHandover).toBe(false);
    expect(r.citation?.id).toBe('art-shipping');
  });

  it('keeps an untagged Roman Urdu answer that carries the article terms and figures', async () => {
    semantic.chunks = [
      {
        id: 'c1', article_id: 'art-shipping', article_title: 'Shipping times', section_name: 'Orders and delivery',
        article_slug: 'shipping-times', chunk_index: 0, content: ARTICLES[1].content,
        similarity: 0.5, keyword_score: 0.1, combined_score: 0.4,
      },
    ];
    modelAnswers('Express shipping mein 1 se 2 business days lagte hain, aur standard shipping Pakistan ke andar 3 se 5 business days leti hai.');
    const r = await ask('shipping mein kitne din lagte hain?', { providerConfig: provider });
    expect(r.shouldHandover).toBe(false);
    expect(r.citation?.id).toBe('art-shipping');
  });

  it('a loosely matched question still reaches the model, which answers from the passage', async () => {
    // Two near-identical articles make the match ambiguous (low confidence),
    // like "Instant account rules" against several account-rule articles.
    // Such questions used to go to the team without the model reading them.
    db.tables.articles = [
      ...ARTICLES,
      { id: 'art-gold', slug: 'gold-plan', title: 'Gold plan', section_id: 'sec-orders', category: 'Plans', summary: null, content: 'Gold plan members get free express shipping and a 60 day refund window.' },
      { id: 'art-silver', slug: 'silver-plan', title: 'Silver plan', section_id: 'sec-orders', category: 'Plans', summary: null, content: 'Silver plan members get free standard shipping and a 45 day refund window.' },
    ];
    invalidateHelpIndex(WORKSPACE_ID);
    modelAnswers('Gold plan members get free express shipping and a 60 day refund window.');
    const r = await ask('free shipping for members?', { providerConfig: provider });
    expect(r.retrievalConfidence).toBe('low');
    expect(mockedChat.mock.calls.some(([, req]) => req.system.includes('HELP-CENTER ARTICLES'))).toBe(true);
    expect(r.shouldHandover).toBe(false);
    expect(r.citation?.id).toBe('art-gold');
  });

  it('from a loose match, a tagged answer that is not written from the passage is not sent', async () => {
    db.tables.articles = [
      ...ARTICLES,
      { id: 'art-gold', slug: 'gold-plan', title: 'Gold plan', section_id: 'sec-orders', category: 'Plans', summary: null, content: 'Gold plan members get free express shipping and a 60 day refund window.' },
      { id: 'art-silver', slug: 'silver-plan', title: 'Silver plan', section_id: 'sec-orders', category: 'Plans', summary: null, content: 'Silver plan members get free standard shipping and a 45 day refund window.' },
    ];
    invalidateHelpIndex(WORKSPACE_ID);
    modelAnswers('Every plan comes with lifetime warranty and a personal manager. [SOURCE: 1]');
    const r = await ask('free shipping for members?', { providerConfig: provider });
    expect(r.retrievalConfidence).toBe('low');
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
    expect(r.shouldHandover).toBe(true);
  });

  it('answers the part the articles cover and passes the rest to the team, bot still on', async () => {
    modelAnswers(
      'Refunds are sent to the original payment method within 5 to 7 business days after we receive the return.\n[MISSING: store credit option] [SOURCE: 1]'
    );
    const r = await ask('How long do refunds take, and can I get store credit instead?', { providerConfig: provider });
    expect(r.replyText).toContain('5 to 7 business days');
    expect(r.replyText).not.toContain('MISSING');
    expect(r.replyText).toContain(partialAnswerHandoverLine('en'));
    expect(r.citation?.id).toBe('art-refund');
    expect(r).toMatchObject({ shouldHandover: true, disableAi: false, priority: 'normal' });
    expect(r.internalNote).toContain('store credit option');
    expect(gapsRecorded()).toHaveLength(1);
  });

  it('never sends a money amount or percentage the articles do not have', async () => {
    modelAnswers('You can request a refund within 30 days of delivery, minus a $15 restocking fee. [SOURCE: 1]');
    const r = await ask('What is your refund policy?', { providerConfig: provider });
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
    expect(r.handoverReason).toContain('$15');
  });

  it('does not mistake "transferring your refund" for handing the visitor over', async () => {
    modelAnswers("We'll be transferring your refund to the original payment method within 5 to 7 business days. [SOURCE: 1]");
    const r = await ask('How long do refunds take?', { providerConfig: provider });
    expect(r.shouldHandover).toBe(false);
    expect(r.citation?.id).toBe('art-refund');
  });

  it('rejects an untagged Roman Urdu answer with a figure the article does not have', async () => {
    semantic.chunks = [
      {
        id: 'c1', article_id: 'art-shipping', article_title: 'Shipping times', section_name: 'Orders and delivery',
        article_slug: 'shipping-times', chunk_index: 0, content: ARTICLES[1].content,
        similarity: 0.5, keyword_score: 0.1, combined_score: 0.4,
      },
    ];
    modelAnswers('Express shipping mein 8 business days lagte hain, standard shipping Pakistan ke andar business days.');
    const r = await ask('shipping mein kitne din lagte hain?', { providerConfig: provider });
    expect(r.replyText).toBe(noAnswerHandoverReply('roman_ur'));
  });

  it('still rejects an untagged answer whose numbers are not in the article', async () => {
    semantic.chunks = [
      {
        id: 'c1', article_id: 'art-shipping', article_title: 'Shipping times', section_name: 'Orders and delivery',
        article_slug: 'shipping-times', chunk_index: 0, content: ARTICLES[1].content,
        similarity: 0.5, keyword_score: 0.1, combined_score: 0.4,
      },
    ];
    modelAnswers('Express shipping takes 6 business days and standard shipping within Pakistan takes 9 business days.');
    const r = await ask('How long does shipping take?', { providerConfig: provider });
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
  });

  it('answers in Roman Urdu when the model does, still with the citation', async () => {
    semantic.chunks = [
      {
        id: 'c1', article_id: 'art-refund', article_title: 'Refund policy', section_name: 'Orders and delivery',
        article_slug: 'refund-policy', chunk_index: 0, content: ARTICLES[0].content,
        similarity: 0.82, keyword_score: 0.4, combined_score: 0.7,
      },
    ];
    modelAnswers('Aap delivery ke 30 din ke andar refund le sakte hain. [SOURCE: 1]');
    const r = await ask('refund kitne din mein mil sakta hai?', { providerConfig: provider });
    expect(r.replyText).toContain('30 din');
    expect(r.replyText).toContain('Source: [Refund policy](https://acme.help.example/refund-policy)');
    expect(r.retrievalConfidence).toBe('high');
  });

  it('answers from a Bot knowledge chunk without a citation or link', async () => {
    semantic.chunks = [
      {
        id: 'k1', article_id: 'bk-delivery', article_title: 'Delivery charges by city', section_name: 'Team knowledge',
        article_slug: null, chunk_index: 0, content: BOT_KNOWLEDGE[0].content,
        similarity: 0.8, keyword_score: 0.4, combined_score: 0.7, source: 'knowledge',
      },
    ];
    modelAnswers('Delivery to Karachi costs Rs 200 and arrives in 1 to 2 days. [SOURCE: 1]');
    const r = await ask('How much does delivery to Karachi cost?', { providerConfig: provider });
    expect(r.shouldHandover).toBe(false);
    expect(r.replyText).toBe('Delivery to Karachi costs Rs 200 and arrives in 1 to 2 days.');
    expect(r.citation).toBeNull();
    expect(r.citedArticles).toEqual([]);
    expect(r.usedArticleIds).toEqual([]);
  });
});

describe('routing other intents', () => {
  it.each([
    ['hi', 'Welcome to Acme Store'],
    ['thanks!', "You're welcome"],
    ['shukriya bhai', 'Koi baat nahi'],
  ])('"%s" gets a short small-talk reply', async (message, expected) => {
    const r = await ask(message);
    expect(r.intent).toBe('small_talk');
    expect(r.replyText).toContain(expected);
    expect(r.shouldHandover).toBe(false);
    expect(r.internalNote).toBeUndefined();
  });

  it('hands a request for a person to the inbox, with a summary, and keeps the bot on for the question that follows', async () => {
    const r = await ask('I want to talk to a real person', {
      turns: [
        { role: 'user', content: 'Do you have a store in Islamabad?' },
        { role: 'assistant', content: lowConfidenceReply('en') },
      ],
    });
    expect(r).toMatchObject({ intent: 'wants_human', shouldHandover: true, disableAi: false, priority: 'high' });
    expect(r.replyText).toContain('tell me your question');
    expect(r.internalNote).toContain('Bot handover: Asked for a human');
    expect(r.internalNote).toContain('Earlier: "Do you have a store in Islamabad?"');
  });

  it('turns "yes" after the offer into a handover that carries the original question', async () => {
    const r = await ask('yes please', {
      turns: [
        { role: 'user', content: 'Do you have a store in Islamabad?' },
        { role: 'assistant', content: lowConfidenceReply('en') },
      ],
    });
    expect(r.intent).toBe('wants_human');
    expect(r.shouldHandover).toBe(true);
    expect(r.internalNote).toContain('Accepted the offer');
    expect(r.internalNote).toContain('Do you have a store in Islamabad?');
  });

  it('hands over a Roman Urdu request for a person and replies in Roman Urdu', async () => {
    const r = await ask('kisi insaan se baat karwa do please');
    expect(r.intent).toBe('wants_human');
    expect(r.replyText).toContain('support team');
    expect(r.replyText).toContain('Maine');
    expect(r.internalNote).toContain('Language: Roman Urdu');
  });

  it('hands out-of-scope messages to the inbox with a summary but keeps the bot on', async () => {
    const r = await ask('Can you write me a poem about cats?');
    expect(r).toMatchObject({ intent: 'out_of_scope', shouldHandover: true, disableAi: false, priority: 'normal' });
    expect(r.replyText).toContain('only help with questions about Acme Store');
    expect(r.internalNote).toContain('Bot handover: Out of scope');
    expect(gapsRecorded()).toHaveLength(0);
  });

  it('hands account questions over, asks for what is missing, and records what was given', async () => {
    const r = await ask('mera order abhi tak nahi aya, order number 77120');
    expect(r).toMatchObject({ intent: 'account_specific', shouldHandover: true, priority: 'high' });
    expect(r.replyText).toContain('email');
    expect(r.replyText).not.toContain('order ya account number');
    expect(r.internalNote).toContain('order 77120');
    expect(gapsRecorded()).toHaveLength(0);
  });
});

describe('general questions', () => {
  const provider: ProviderConfig = { provider: 'anthropic', apiKey: 'test-key', model: null, baseUrl: null };
  const mockedChat = vi.mocked(chat);

  /** The classifier says out_of_scope; the general answerer gets `answer`. */
  function generalAnswers(answer: string) {
    mockedChat.mockImplementation(async (_cfg, req) => {
      if (req.system.includes('You route customer messages')) {
        return { text: JSON.stringify({ intent: 'out_of_scope', confidence: 0.9, summary: 'general' }) } as Awaited<ReturnType<typeof chat>>;
      }
      return { text: answer } as Awaited<ReturnType<typeof chat>>;
    });
  }
  const generalCall = () => mockedChat.mock.calls.find(([, req]) => req.system.includes('You know nothing about'));

  it.each([
    ['What is the capital of France?', 'Paris is the capital of France.'],
    ['what is 25 * 4', '25 × 4 = 100.'],
    ['Who is the founder of Microsoft?', 'Microsoft was founded by Bill Gates and Paul Allen in 1975.'],
  ])('answers "%s" briefly without handing over', async (message, answer) => {
    generalAnswers(answer);
    const r = await ask(message, { providerConfig: provider });
    expect(r).toMatchObject({ intent: 'out_of_scope', shouldHandover: false, replyText: answer });
    expect(generalCall()![1].maxTokens).toBeLessThanOrEqual(220);
  });

  it('tells the model it knows nothing about the business and must hand over business facts', async () => {
    generalAnswers('Paris.');
    await ask('What is the capital of France?', { providerConfig: provider });
    const system = generalCall()![1].system;
    expect(system).toContain('You know nothing about Acme Store');
    expect(system).toContain('[HANDOVER]');
  });

  it('answers in Roman Urdu when the visitor writes Roman Urdu', async () => {
    generalAnswers('Biryani ke liye chawal, gosht aur masale chahiye.');
    const r = await ask('biryani ki recipe batao', { providerConfig: provider });
    expect(generalCall()![1].system).toContain('Roman Urdu');
    expect(r.shouldHandover).toBe(false);
  });

  it('hands over to the team, bot still on, when the model says it needs business facts', async () => {
    generalAnswers('[HANDOVER]');
    const r = await ask('What is the capital of France?', { providerConfig: provider });
    expect(r).toMatchObject({ shouldHandover: true, disableAi: false, priority: 'normal' });
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
    expect(r.internalNote).toContain('Bot handover: Out of scope');
  });

  it('hands over when the model fails', async () => {
    mockedChat.mockImplementation(async (_cfg, req) => {
      if (req.system.includes('You route customer messages')) {
        return { text: JSON.stringify({ intent: 'out_of_scope', confidence: 0.9 }) } as Awaited<ReturnType<typeof chat>>;
      }
      throw new Error('provider down');
    });
    const r = await ask('What is the capital of France?', { providerConfig: provider });
    expect(r.shouldHandover).toBe(true);
    expect(r.replyText).toBe(noAnswerHandoverReply('en'));
  });

  it('sends the general answerer only the last turns, not the whole thread', async () => {
    generalAnswers('Paris.');
    const turns = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `turn ${i}`,
    }));
    await ask('What is the capital of France?', { providerConfig: provider, turns });
    expect(generalCall()![1].messages.length).toBeLessThanOrEqual(3);
  });
});

describe('opening hours', () => {
  const day = (enabled: boolean) => ({ enabled, start: '00:00', end: '23:59' });
  const always: BusinessHoursConfig = {
    enabled: true,
    timezone: 'UTC',
    schedule: {
      monday: day(true), tuesday: day(true), wednesday: day(true), thursday: day(true),
      friday: day(true), saturday: day(true), sunday: day(true),
    },
  };
  const never: BusinessHoursConfig = {
    ...always,
    schedule: {
      monday: day(false), tuesday: day(false), wednesday: day(false), thursday: day(false),
      friday: day(false), saturday: day(false), sunday: day(false),
    },
  };

  it.each(['What are your opening hours?', 'are you open now?', 'aap ke auqat kya hain?'])(
    '"%s" is answered from the workspace calendar, with no model call',
    async (message) => {
      const r = await ask(message, { businessHours: always });
      expect(r.shouldHandover).toBe(false);
      expect(r.replyText).toMatch(/available right now|abhi available/);
      expect(vi.mocked(chat)).not.toHaveBeenCalled();
    }
  );

  it('says the team is away outside the hours', async () => {
    const r = await ask('are you open now?', { businessHours: never });
    expect(r.replyText).toContain('away right now');
  });

  it('leaves hours questions to the help center when no calendar is set', async () => {
    const r = await ask('What are your opening hours?');
    expect(r.replyText).not.toContain('available right now');
  });
});

describe('small talk the bot used to miss', () => {
  it.each([
    ['What can you do?', 'Acme Store assistant'],
    ['aap kaun ho?', 'Acme Store ka assistant'],
    ['can you help me?', 'What can I help you with'],
  ])('"%s" gets an answer, not a handover', async (message, expected) => {
    const r = await ask(message);
    expect(r.intent).toBe('small_talk');
    expect(r.shouldHandover).toBe(false);
    expect(r.replyText).toContain(expected);
  });
});

describe('carrying on after a person (bot switched back on)', () => {
  const provider: ProviderConfig = { provider: 'anthropic', apiKey: 'test-key', model: null, baseUrl: null };
  const promise = {
    lastReply: "I've forwarded your issue to our technical team. I'll update you once I receive their response.",
    at: new Date().toISOString(),
  };
  const turns = [
    { role: 'user' as const, content: 'My dashboard shows an error' },
    { role: 'assistant' as const, content: `[Team member] ${promise.lastReply}` },
  ];

  function resume(message: string, opts: { providerConfig?: ProviderConfig | null } = {}) {
    return generateHelpDeskResponseWithHandover({
      workspaceId: WORKSPACE_ID,
      conversationId: 'conv-1',
      incomingMessage: message,
      providerConfig: opts.providerConfig ?? null,
      turns,
      helpCenterUrl: HELP_URL,
      workspaceName: 'Acme Store',
      humanContext: promise,
      resuming: true,
    });
  }

  it.each([
    ['Any update?', 'en'],
    ['still waiting', 'en'],
    ['koi update?', 'roman_ur'],
  ] as const)('"%s" after a promised update: no false update, the team is told, the bot stays on', async (message, lang) => {
    const r = await resume(message);
    expect(r.replyText).toBe(pendingUpdateReply(lang));
    expect(r).toMatchObject({ shouldHandover: true, disableAi: false, priority: 'high' });
    expect(r.internalNote).toContain('promised');
    expect(vi.mocked(chat)).not.toHaveBeenCalled();
  });

  it('does not treat "any update?" as a pending update when nobody promised one', async () => {
    const r = await generateHelpDeskResponseWithHandover({
      workspaceId: WORKSPACE_ID,
      conversationId: 'conv-1',
      incomingMessage: 'Any update?',
      workspaceName: 'Acme Store',
      humanContext: { lastReply: 'Your order shipped yesterday.', at: new Date().toISOString() },
    });
    expect(r.replyText).not.toBe(pendingUpdateReply('en'));
  });

  it('does not greet again in a conversation a person already handled', async () => {
    const r = await resume('hello');
    expect(r.replyText).toBe(welcomeBackReply('en'));
    expect(r.replyText).not.toContain('Welcome to');
  });

  it('greets a brand-new conversation with the welcome', async () => {
    const r = await ask('hello');
    expect(r.replyText).toContain('Welcome to Acme Store');
  });

  it("tells the model what the person said, not to contradict it, and not to speak as them", async () => {
    vi.mocked(chat).mockImplementation(async (_cfg, req) => {
      if (req.system.includes('You route customer messages')) {
        return { text: JSON.stringify({ intent: 'help_center_question', confidence: 0.9 }) } as Awaited<ReturnType<typeof chat>>;
      }
      return { text: 'Standard delivery takes 3 to 5 business days. [SOURCE: 1]' } as Awaited<ReturnType<typeof chat>>;
    });
    await resume('How long does delivery take?', { providerConfig: provider });
    const answerCall = vi.mocked(chat).mock.calls.find(([, req]) => req.system.includes('HELP-CENTER ARTICLES'));
    expect(answerCall![1].system).toContain("I'll update you once I receive their response.");
    expect(answerCall![1].system).toContain('do not contradict');
    expect(answerCall![1].system).toContain('do not write as if you were them');
  });
});

describe('agent mode (whole help centre in the prompt)', () => {
  const provider: ProviderConfig = { provider: 'anthropic', apiKey: 'test-key', model: null, baseUrl: null };
  const mockedChat = vi.mocked(chat);

  const PROP_ARTICLES = [
    {
      id: 'art-dd',
      slug: 'maximum-loss-rules',
      title: 'Maximum loss rules',
      section_id: 'sec-rules',
      category: 'Rules',
      summary: null,
      content:
        'The maximum drawdown is 10% of the starting balance and the daily drawdown is 5%. Breaking either is a hard breach and the account is closed.',
    },
    {
      id: 'art-sizes',
      slug: 'account-sizes',
      title: 'Account sizes',
      section_id: 'sec-plans',
      category: 'Plans',
      summary: null,
      content: 'Evaluation accounts come in 10,000, 25,000 and 100,000. Phase 1 has a profit target of 8% and phase 2 a profit target of 5%.',
    },
    {
      id: 'art-payout',
      slug: 'payouts',
      title: 'Payouts',
      section_id: 'sec-funded',
      category: 'Funded',
      summary: null,
      content: 'Funded traders can request a payout every 14 days. The profit split is 80%. Payouts are processed within 2 business days.',
    },
  ];

  beforeEach(() => {
    db.tables.articles = PROP_ARTICLES;
    db.tables.help_sections = [
      { id: 'sec-rules', name: 'Trading rules' },
      { id: 'sec-plans', name: 'Plans' },
      { id: 'sec-funded', name: 'Funded accounts' },
    ];
    invalidateHelpIndex(WORKSPACE_ID);
  });

  /** Classifier calls get JSON; agent calls get `answers` in turn (the last one repeats). */
  function agentAnswers(answers: string | string[], intent = 'help_center_question') {
    const queue = Array.isArray(answers) ? [...answers] : [answers];
    mockedChat.mockImplementation(async (_cfg, req) => {
      if (req.system.includes('You route customer messages')) {
        return { text: JSON.stringify({ intent, confidence: 0.9, summary: 'test' }) } as Awaited<ReturnType<typeof chat>>;
      }
      const raw = queue.length > 1 ? queue.shift()! : queue[0];
      // {{n:Title}} becomes that article's number: the specialist's articles come first, so numbers move.
      const text = raw.replace(/\{\{n:([^}]+)\}\}/g, (_m, title: string) => req.system.match(new RegExp('\\[ARTICLE (\\d+)\\]\\nTitle: ' + title))?.[1] ?? '0');
      return { text } as Awaited<ReturnType<typeof chat>>;
    });
  }
  const agentCalls = () => mockedChat.mock.calls.filter(([, req]) => req.system.includes('# HELP CENTER'));

  function askAgent(message: string, opts: { systemPrompt?: string; subAgents?: SubAgentSettings; botFailureCount?: number } = {}) {
    return generateHelpDeskResponseWithHandover({
      workspaceId: WORKSPACE_ID,
      conversationId: 'conv-1',
      incomingMessage: message,
      providerConfig: provider,
      botFailureCount: opts.botFailureCount ?? 0,
      systemPrompt: opts.systemPrompt ?? null,
      helpCenterUrl: HELP_URL,
      workspaceName: 'Apex Funding',
      answerMode: 'agent',
      subAgents: opts.subAgents ?? null,
    });
  }

  it('reads every published rule, with the trader vocabulary and the workspace instructions', async () => {
    agentAnswers('Max drawdown is 10% and daily is 5%. [SOURCE: {{n:Maximum loss rules}}]');
    await askAgent('What are the drawdown rules?', { systemPrompt: 'Always call the customer "trader".' });
    const system = agentCalls()[0][1].system;
    for (const a of PROP_ARTICLES) expect(system).toContain(a.content);
    expect(system).toContain('HOW TRADERS TALK');
    expect(system).toContain('Always call the customer "trader".');
    expect(system).not.toContain(NOTES[0].content);
  });

  it('answers a short Roman Urdu question itself, with arithmetic from the rules, and cites the rule', async () => {
    agentAnswers('10k account pe max drawdown 10% hai, yani 1,000 tak loss allowed hai. Daily limit 5% (500) hai. [SOURCE: {{n:Maximum loss rules}}]');
    const r = await askAgent('dd kitna hai 10k pe');
    expect(r.shouldHandover).toBe(false);
    expect(r.replyText).toContain('1,000');
    expect(r.replyText).not.toMatch(/\[SOURCE/);
    expect(r.citation).toMatchObject({ title: 'Maximum loss rules', url: `${HELP_URL}/maximum-loss-rules` });
  });

  it('an upset trader with a question is answered, not queued', async () => {
    agentAnswers("I'm sorry this happened. Losing more than 5% in one day is a hard breach, which closes the account. [SOURCE: {{n:Maximum loss rules}}]");
    const r = await askAgent('This is so unfair, why was my account closed after one bad day');
    expect(r.shouldHandover).toBe(false);
    expect(r.replyText).toContain('hard breach');
    expect(agentCalls()[0][1].system).toContain('The customer is upset');
  });

  it('a retry is answered, not queued, even after earlier retries in the conversation', async () => {
    agentAnswers('The daily drawdown limit is 5% of the starting balance. [SOURCE: {{n:Maximum loss rules}}]');
    for (const botFailureCount of [1, 2]) {
      const r = await askAgent('still not working, what is the daily drawdown limit?', { botFailureCount });
      expect(r.shouldHandover).toBe(false);
      expect(r.replyText).toContain('5%');
    }
  });

  it('hands over only when the agent says a person must act, in its own words, and stays on', async () => {
    agentAnswers(
      'Payouts are processed within 2 business days of the request. I am asking the team to check where yours is. [HANDOVER: payout status check]',
      'account_specific'
    );
    const r = await askAgent('I requested my payout last week and still have nothing, where is it?');
    expect(r).toMatchObject({ shouldHandover: true, disableAi: false, handoverReason: 'payout status check', priority: 'high' });
    expect(r.replyText).toContain('2 business days');
    expect(r.replyText).not.toContain('[HANDOVER');
    expect(agentCalls()[0][1].system).toContain('cannot see');
  });

  it('a figure the rules do not have is rewritten once before anything is sent', async () => {
    agentAnswers(['The profit split is 90%. [SOURCE: {{n:Payouts}}]', 'The profit split is 80%. [SOURCE: {{n:Payouts}}]']);
    const r = await askAgent('what is the profit split');
    expect(agentCalls()).toHaveLength(2);
    expect(agentCalls()[1][1].system).toContain('# CORRECTION');
    expect(r.replyText).toContain('80%');
    expect(r.replyText).not.toContain('90%');
  });

  it('a request for a person still goes straight to the team, without asking the agent', async () => {
    agentAnswers('should not be used');
    const r = await askAgent('I want to talk to a human');
    expect(r).toMatchObject({ shouldHandover: true, intent: 'wants_human' });
    expect(agentCalls()).toHaveLength(0);
  });

  it('small talk is the Greeting specialist: an instant welcome that says what it can help with', async () => {
    agentAnswers('should not be used');
    const r = await askAgent('hello');
    expect(r.replyText).toContain('Welcome to Apex Funding');
    expect(r.replyText).toContain('trading rules');
    expect(r.subAgent).toBe('greeting');
    expect(agentCalls()).toHaveLength(0);
  });

  it('the router picks the specialist, whose brief and extra instructions reach the model, and labels the reply', async () => {
    agentAnswers('Funded traders can request a payout every 14 days. [SOURCE: {{n:Payouts}}]');
    const r = await askAgent('payout kab milega?', {
      subAgents: { payouts: { instructions: 'Always mention the payout dashboard.' } },
    });
    expect(r.subAgent).toBe('payouts');
    const system = agentCalls()[0][1].system;
    expect(system).toContain('PAYOUTS SPECIALIST');
    expect(system).toContain('Always mention the payout dashboard.');
    // The specialist's own articles are read first.
    expect(system.indexOf('Title: Payouts')).toBeLessThan(system.indexOf('Title: Maximum loss rules'));
  });

  it('a specialist the workspace switched off sends its topic to the team without asking the model', async () => {
    agentAnswers('should not be used');
    const r = await askAgent('10k challenge kitne ka hai?', { subAgents: { pricing_offers: { enabled: false } } });
    expect(r).toMatchObject({ shouldHandover: true, subAgent: 'pricing_offers', disableAi: false });
    expect(r.replyText).toBe(teamHandlesTopicReply('roman_ur'));
    expect(agentCalls()).toHaveLength(0);
  });

  it('a request for a person is labelled Human handover', async () => {
    agentAnswers('should not be used');
    const r = await askAgent('connect me to a human');
    expect(r.subAgent).toBe('human_handover');
  });

  /*
   * Regression: a correct answer must never end as "I couldn't find this".
   * Jev sees part of the help centre; when it refused a right answer the
   * bot fell to the strict path and handed the question over.
   */
  describe('a correct answer is never lost to the answer check', () => {
    /** Jev live: the answer check says supported[0], then supported[1], …; everything else is plain triage. */
    function jevLive(supported: number[]) {
      db.tables.platform_ai_settings = [{ jev_settings: { mode: 'live' }, jev_api_key: 'ts_test' }];
      const checks: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          let answers: Record<string, unknown>;
          if (body.questions.supported) {
            checks.push(String(body.state.help_center_passages));
            answers = { supported: { type: 'noul', noul: supported[Math.min(checks.length - 1, supported.length - 1)] } };
          } else if (body.questions.specialist) {
            answers = { specialist: { type: 'choice', choice: Object.keys(body.questions.specialist.criteria)[0], confidence: 0.4, probabilities: {} } };
          } else {
            answers = {
              intent: { type: 'choice', choice: 'help_center_question', confidence: 0.95, probabilities: {} },
              wants_human: { type: 'noul', noul: 0.02 },
              frustration: { type: 'score', score: 0, confidence: 0.9, probabilities: { '0': 1 } },
              urgent: { type: 'noul', noul: 0.05 },
              spam: { type: 'noul', noul: 0.01 },
            };
          }
          return new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status: 200 });
        })
      );
      return checks;
    }
    afterEach(() => vi.unstubAllGlobals());

    it('Jev sees the article that holds the figure, even when another article is cited', async () => {
      const checks = jevLive([0.9]);
      agentAnswers('Phase 1 has a profit target of 8%, and breaking the 5% daily drawdown closes the account. [SOURCE: {{n:Maximum loss rules}}]');
      const r = await askAgent('phase 1 ka target kitna hai aur dd kya hai');
      expect(r.shouldHandover).toBe(false);
      expect(checks[0]).toContain('profit target of 8%');
      expect(checks[0]).toContain('daily drawdown is 5%');
    });

    it('one refusal is followed by one rewrite, which is sent when it passes, not handed over', async () => {
      const checks = jevLive([0.02, 0.9]);
      agentAnswers([
        'Phase 1 needs 8%. [SOURCE: {{n:Maximum loss rules}}]',
        'The phase 1 profit target is 8%. [SOURCE: {{n:Account sizes}}]',
      ]);
      const r = await askAgent('tell me fase 1 targt');
      expect(checks).toHaveLength(2);
      expect(agentCalls()).toHaveLength(2);
      expect(agentCalls()[1][1].system).toContain('A checker could not match your previous draft');
      expect(r.shouldHandover).toBe(false);
      expect(r.replyText).toContain('8%');
    });

    it('two refusals of a rules answer whose figures are all in the help centre still send it, not a handover', async () => {
      jevLive([0.02, 0.02]);
      agentAnswers(['Phase 1 needs 8%. [SOURCE: {{n:Maximum loss rules}}]', 'Phase 1 needs 8%. [SOURCE: {{n:Maximum loss rules}}]']);
      const r = await askAgent('tell me phase 1 target');
      expect(agentCalls().length).toBeGreaterThanOrEqual(2);
      expect(r.shouldHandover).toBe(false);
      expect(r.replyText).toContain('8%');
    });
  });
});
