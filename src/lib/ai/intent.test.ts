import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}), hasServiceRole: () => false }));
vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  return { ...actual, chat: vi.fn() };
});

import { chat, type ProviderConfig } from '@/lib/ai/provider';
import {
  HANDOFF_OFFER,
  buildHandoverSummary,
  classifyByRules,
  classifyVisitorIntent,
  replyLanguageOf,
  type VisitorIntent,
} from '@/lib/ai/intent';
import { lowConfidenceReply } from '@/lib/ai/anthropic';

type Sample = {
  message: string;
  intent: VisitorIntent;
  lang?: 'en' | 'roman_ur' | 'ur' | 'es';
  /** The assistant's previous message, when context decides the intent. */
  after?: string;
};

/**
 * Messages a support bot actually receives, one row each. Mixed English and
 * Roman Urdu rows are written the way visitors type them.
 */
const SAMPLES: Sample[] = [
  // help_center_question
  { message: 'What is your refund policy?', intent: 'help_center_question', lang: 'en' },
  { message: 'How long does shipping take to Karachi?', intent: 'help_center_question', lang: 'en' },
  { message: 'How do I reset my password?', intent: 'help_center_question', lang: 'en' },
  { message: 'Can I pay with a credit card?', intent: 'help_center_question', lang: 'en' },
  { message: 'hi, do you ship internationally?', intent: 'help_center_question', lang: 'en' },
  { message: 'refund policy kya hai?', intent: 'help_center_question', lang: 'roman_ur' },
  { message: 'Aap ka shipping time kitna hai Lahore ke liye?', intent: 'help_center_question', lang: 'roman_ur' },
  { message: 'order cancel kaise karte hain?', intent: 'help_center_question', lang: 'roman_ur' },
  { message: 'ریفنڈ پالیسی کیا ہے؟', intent: 'help_center_question', lang: 'ur' },
  { message: '¿Cuál es su política de devoluciones?', intent: 'help_center_question', lang: 'es' },

  // account_specific
  { message: 'Where is my order #48213?', intent: 'account_specific', lang: 'en' },
  { message: 'I was charged twice for my subscription', intent: 'account_specific', lang: 'en' },
  { message: "I can't log in to my account, it says my account is locked", intent: 'account_specific', lang: 'en' },
  { message: 'Please cancel my order, I ordered the wrong size', intent: 'account_specific', lang: 'en' },
  { message: 'mera order abhi tak nahi aya, order number 77120', intent: 'account_specific', lang: 'roman_ur' },
  { message: 'meri payment kat gayi lekin order confirm nahi hua', intent: 'account_specific', lang: 'roman_ur' },
  { message: 'my refund still not received, kab milega?', intent: 'account_specific', lang: 'roman_ur' },
  { message: 'account 5512093 withdrawal pending since 3 days', intent: 'account_specific', lang: 'en' },

  // small_talk
  { message: 'hi', intent: 'small_talk', lang: 'en' },
  { message: 'Assalam o alaikum', intent: 'small_talk' },
  { message: 'thanks a lot!', intent: 'small_talk', lang: 'en' },
  { message: 'shukriya bhai', intent: 'small_talk', lang: 'roman_ur' },
  { message: 'Salam, kese ho?', intent: 'small_talk', lang: 'roman_ur' },
  { message: 'are you a bot?', intent: 'small_talk', lang: 'en' },
  { message: 'ok bye', intent: 'small_talk', lang: 'en' },
  { message: 'ok', intent: 'small_talk', lang: 'en' },
  { message: '👍', intent: 'small_talk' },
  { message: '👋', intent: 'small_talk' },
  { message: 'What can you do?', intent: 'small_talk', lang: 'en' },
  { message: "what's your name", intent: 'small_talk', lang: 'en' },
  { message: 'hello, can you help me?', intent: 'small_talk', lang: 'en' },
  { message: 'is anyone there?', intent: 'small_talk', lang: 'en' },
  { message: 'aap kaun ho?', intent: 'small_talk', lang: 'roman_ur' },
  { message: 'ap kese ho?', intent: 'small_talk', lang: 'roman_ur' },
  { message: 'kya haal hai', intent: 'small_talk', lang: 'roman_ur' },
  { message: 'tum kaise ho bhai', intent: 'small_talk', lang: 'roman_ur' },
  { message: 'mujhe madad chahiye', intent: 'small_talk', lang: 'roman_ur' },

  // out_of_scope
  { message: 'Can you give me a chocolate cake recipe?', intent: 'out_of_scope', lang: 'en' },
  { message: "What's the weather in Lahore today?", intent: 'out_of_scope', lang: 'en' },
  { message: 'write me a python script to sort a list', intent: 'out_of_scope', lang: 'en' },
  { message: 'biryani ki recipe batao', intent: 'out_of_scope', lang: 'roman_ur' },
  { message: 'who won the cricket world cup in 1992?', intent: 'out_of_scope', lang: 'en' },
  { message: 'what is 25 * 4', intent: 'out_of_scope', lang: 'en' },

  // wants_human
  { message: 'I want to talk to a real person', intent: 'wants_human', lang: 'en' },
  { message: 'Can I speak with a representative please?', intent: 'wants_human', lang: 'en' },
  { message: 'kisi insaan se baat karwa do', intent: 'wants_human', lang: 'roman_ur' },
  { message: 'mujhe agent se baat karni hai', intent: 'wants_human', lang: 'roman_ur' },
  { message: 'This is a scam, worst service ever', intent: 'wants_human', lang: 'en' },
  { message: 'yes please', intent: 'wants_human', lang: 'en', after: lowConfidenceReply('en') },
  { message: 'haan ji', intent: 'wants_human', lang: 'roman_ur', after: lowConfidenceReply('roman_ur') },
];

describe('intent classification (rules, no model configured)', () => {
  it('covers every intent with mixed-language and off-topic samples', () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(20);
    const intents = new Set(SAMPLES.map((s) => s.intent));
    expect([...intents].sort()).toEqual(
      ['account_specific', 'help_center_question', 'out_of_scope', 'small_talk', 'wants_human']
    );
    expect(SAMPLES.some((s) => s.lang === 'roman_ur')).toBe(true);
  });

  it.each(SAMPLES)('"$message" → $intent', async ({ message, intent, after }) => {
    const recent = after
      ? [
          { role: 'user', content: 'Do you sell gift cards?' },
          { role: 'assistant', content: after },
          { role: 'user', content: message },
        ]
      : [{ role: 'user', content: message }];
    const result = await classifyVisitorIntent({ message, recentMessages: recent, providerConfig: null, workspaceName: 'Acme' });
    expect(result.intent).toBe(intent);
    expect(result.source).toBe('rules');
  });

  it.each(SAMPLES.filter((s) => s.lang))('"$message" is answered in $lang', ({ message, lang }) => {
    expect(replyLanguageOf(message)).toBe(lang);
  });

  it('treats a bare "yes" as small talk when nothing was offered', () => {
    expect(classifyByRules('yes', [{ role: 'assistant', content: 'Our store opens at 9am.' }]).intent).toBe('small_talk');
  });

  it('extracts order numbers, account numbers and emails for the agent', () => {
    const r = classifyByRules('Where is my order #48213? my email is sara@example.com');
    expect(r.orderNumber).toBe('48213');
    expect(r.email).toBe('sara@example.com');
    expect(classifyByRules('account 5512093 withdrawal pending').accountNumber).toBe('5512093');
  });

  it('flags complaints that still carry a question so they get an apology, not a handover', () => {
    const r = classifyByRules('This is ridiculous, how long does shipping take?');
    expect(r.intent).toBe('help_center_question');
    expect(r.isComplaint).toBe(true);
  });

  it.each([
    ['Earn $5000 daily click here', true],
    ['Congratulations, you have won! Click here to claim your free iPhone', true],
    ['Make 500 dollars per day from home, join t.me/richfast', true],
    // One signal alone is a real customer.
    ['I clicked the link in your email but click here does nothing', false],
    ['Can I earn reward points daily?', false],
    ['How do I connect my WhatsApp to the inbox?', false],
    ['bhai mera order abhi tak nahi aya 5 din ho gaye', false],
  ])('spam needs two signals: "%s" → %s', (message, spam) => {
    expect(Boolean(classifyByRules(message).isSpam)).toBe(spam);
  });

  it.each([
    ['My payment was charged twice, please refund today', true],
    ['mujhe refund jaldi chahiye', true],
    // "abhi tak" is "not yet".
    ['bhai mera order abhi tak nahi aya 5 din ho gaye', false],
    ['What is your refund policy?', false],
  ])('urgency: "%s" → %s', (message, urgent) => {
    expect(classifyByRules(message).isUrgent).toBe(urgent);
  });
});

describe('handoff offers', () => {
  it('recognises every language of the low-confidence offer, so "yes" can be understood', () => {
    for (const lang of ['en', 'roman_ur', 'ur', 'hi', 'ar', 'es', 'fr'] as const) {
      expect(HANDOFF_OFFER.test(lowConfidenceReply(lang))).toBe(true);
    }
  });
});

describe('asking for a person', () => {
  // Each of these was handed to the team, with the bot switched off, before
  // the bot read the question in it.
  it.each([
    'mujhe payout ke bare mein baat karni hai',
    'drawdown ki baat kar sakta hun?',
    'mere account ki baat krni thi',
    'i want to know about the handover of funded account',
  ])('does not read a topic question as one: %s', async (message) => {
    const { asksForHuman } = await import('@/lib/ai/intent');
    expect(asksForHuman(message)).toBe(false);
  });

  it.each([
    'I want to speak with a team member.',
    'kisi se baat karni hai',
    'baat karwa do',
    'team se connect karo',
    'handover karo',
    'please hand me over to a human',
  ])('still recognises: %s', async (message) => {
    const { asksForHuman } = await import('@/lib/ai/intent');
    expect(asksForHuman(message)).toBe(true);
  });
});

describe('handover summary', () => {
  it('tells the agent what happened, what was said, and what was given', () => {
    const message = 'mera order abhi tak nahi aya, order number 77120';
    const intent = classifyByRules(message);
    const note = buildHandoverSummary({
      intent,
      message,
      lang: replyLanguageOf(message),
      recentMessages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: message },
      ],
    });
    expect(note).toContain('Bot handover: Account / order issue');
    expect(note).toContain('order 77120');
    expect(note).toContain(`Visitor said: "${message}"`);
    expect(note).toContain('Earlier: "hello"');
    expect(note).toContain('Language: Roman Urdu');
  });
});

describe('intent classification with a model configured', () => {
  const provider: ProviderConfig = { provider: 'anthropic', apiKey: 'test-key', model: null, baseUrl: null };
  const mockedChat = vi.mocked(chat);

  beforeEach(() => mockedChat.mockReset());

  it('lets the model decide ambiguous messages, with the workspace topics in the prompt', async () => {
    mockedChat.mockResolvedValue({
      text: '{"intent": "out_of_scope", "confidence": 0.9, "summary": "Asks for a stock tip"}',
    } as Awaited<ReturnType<typeof chat>>);

    const result = await classifyVisitorIntent({
      message: 'which stock should I buy this week?',
      providerConfig: provider,
      workspaceName: 'Acme Shoes',
      topics: ['Shipping', 'Returns and refunds'],
    });

    expect(result).toMatchObject({ intent: 'out_of_scope', source: 'model', summary: 'Asks for a stock tip' });
    const request = mockedChat.mock.calls[0][1];
    expect(request.system).toContain('Acme Shoes');
    expect(request.system).toContain('Shipping; Returns and refunds');
  });

  it('does not ask the model when the rules are certain', async () => {
    for (const message of ['hi', 'kisi insaan se baat karwa do', 'Where is my order #48213?']) {
      await classifyVisitorIntent({ message, providerConfig: provider });
    }
    expect(mockedChat).not.toHaveBeenCalled();
  });

  it('falls back to the rules when the model returns nonsense or fails', async () => {
    mockedChat.mockResolvedValueOnce({ text: 'I think it is a question' } as Awaited<ReturnType<typeof chat>>);
    const garbled = await classifyVisitorIntent({ message: 'What is your refund policy?', providerConfig: provider });
    expect(garbled).toMatchObject({ intent: 'help_center_question', source: 'rules' });

    mockedChat.mockRejectedValueOnce(new Error('timeout'));
    const failed = await classifyVisitorIntent({ message: 'biryani ki recipe batao', providerConfig: provider });
    expect(failed).toMatchObject({ intent: 'out_of_scope', source: 'rules' });

    mockedChat.mockResolvedValueOnce({ text: '{"intent": "complaint"}' } as Awaited<ReturnType<typeof chat>>);
    const unknown = await classifyVisitorIntent({ message: 'What is your refund policy?', providerConfig: provider });
    expect(unknown.intent).toBe('help_center_question');
  });
});
