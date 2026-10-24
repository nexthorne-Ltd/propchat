import { describe, expect, it } from 'vitest';
import {
  extractConversationMemory,
  formatMemoryForPrompt,
  getMicroAcknowledgmentGuideline,
} from '@/lib/ai/memory';
import { buildSupportAgentPrompt } from '@/lib/ai/support-agent';
import { buildHumanSupportSystemPrompt } from '@/lib/ai/anthropic';

describe('Conversation Memory & Context Retention', () => {
  it('extracts account size, platform, and plan from user messages', () => {
    const messages = [
      { role: 'user', content: 'Hi, I bought a 50k 2-step evaluation on MT5 yesterday.' },
      { role: 'assistant', content: 'Welcome! How can I assist you with your 50k challenge?' },
      { role: 'user', content: 'What is the daily loss limit?' },
    ];

    const memory = extractConversationMemory(messages);
    expect(memory.accountSize).toBe('50K');
    expect(memory.platform).toBe('MT5');
    expect(memory.planOrPhase).toBe('2-step');
    expect(memory.topic).toBe('Drawdown Rules & Limits');
  });

  it('extracts customer name and email when provided in chat or visitor profile', () => {
    const messages = [
      { role: 'user', content: 'Mera naam Hamza hai aur mera email hamza.trader@gmail.com hai' },
      { role: 'assistant', content: 'Hello Hamza! How can I help you today?' },
    ];

    const memory = extractConversationMemory(messages, { name: null, email: null });
    expect(memory.visitorName).toBe('Hamza');
    expect(memory.visitorEmail).toBe('hamza.trader@gmail.com');
  });

  it('formats extracted memory into a clean prompt section with retention rules', () => {
    const memory = {
      visitorName: 'Hamza',
      visitorEmail: 'hamza@example.com',
      accountSize: '100K',
      platform: 'MT5',
      planOrPhase: 'instant',
      topic: 'Payouts & Withdrawals',
    };

    const formatted = formatMemoryForPrompt(memory);
    expect(formatted).toContain('# CONVERSATION MEMORY & KNOWN DETAILS (CRITICAL)');
    expect(formatted).toContain('- Customer name: "Hamza"');
    expect(formatted).toContain('- Customer email: hamza@example.com');
    expect(formatted).toContain('- Stated account size: 100K');
    expect(formatted).toContain('- Stated platform: MT5');
    expect(formatted).toContain('NEVER ask them to repeat any of this information');
  });

  it('returns null when no memory facts were detected', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
    ];
    const memory = extractConversationMemory(messages);
    const formatted = formatMemoryForPrompt(memory);
    expect(formatted).toBeNull();
  });
});

describe('Micro-Acknowledgments & Human Pacing Guidelines', () => {
  it('provides Roman Urdu micro-acknowledgments for roman_ur language', () => {
    const guide = getMicroAcknowledgmentGuideline('roman_ur');
    expect(guide).toContain('Acha samajh gaya');
    expect(guide).toContain('Ji bilkul');
    expect(guide).toContain('Pareshan na hon');
    expect(guide).toContain('Dear customer');
  });

  it('provides English micro-acknowledgments for en language', () => {
    const guide = getMicroAcknowledgmentGuideline('en');
    expect(guide).toContain('Got it,');
    expect(guide).toContain('Understood,');
    expect(guide).toContain('Oh, sorry to hear that!');
    expect(guide).toContain('Dear valued customer');
  });

  it('integrates micro-acknowledgments and memory into buildSupportAgentPrompt', () => {
    const memoryContext = '- Stated account size: 50K\n- Stated platform: MT5';
    const prompt = buildSupportAgentPrompt({
      botName: 'Support Agent',
      businessName: 'Apex Trader',
      knowledge: '[ARTICLE 1]\nRules',
      lang: 'en',
      visitorName: 'Ali',
      memoryContext,
    });

    expect(prompt).toContain('You are speaking with Ali.');
    expect(prompt).toContain('MICRO-ACKNOWLEDGMENTS & HUMAN TONE');
    expect(prompt).toContain('Got it,');
    expect(prompt).toContain(memoryContext);
  });

  it('integrates micro-acknowledgments and memory into buildHumanSupportSystemPrompt', () => {
    const memoryContext = '- Stated account size: 100K';
    const prompt = buildHumanSupportSystemPrompt({
      botName: 'Support Agent',
      businessName: 'Apex Trader',
      retrievedChunks: '[CHUNK 1]\nRules',
      lang: 'roman_ur',
      visitorName: 'Hamza',
      memoryContext,
    });

    expect(prompt).toContain('You are speaking with Hamza.');
    expect(prompt).toContain('MICRO-ACKNOWLEDGMENTS & HUMAN TONE (ROMAN URDU)');
    expect(prompt).toContain('Acha samajh gaya');
    expect(prompt).toContain(memoryContext);
  });
});
