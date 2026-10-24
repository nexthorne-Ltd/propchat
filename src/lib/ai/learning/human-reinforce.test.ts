import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  learnFromHumanAgentReply,
  retrieveWorkspaceDemonstrations,
} from './human-reinforce';
import { buildSupportAgentPrompt } from '@/lib/ai/support-agent';
import { buildHumanSupportSystemPrompt } from '@/lib/ai/anthropic';
import * as semanticRetrieval from '@/lib/ai/semantic-retrieval';

// Mock serviceClient from supabase
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: vi.fn(),
}));

// Mock embedBotKnowledge
vi.mock('@/lib/ai/bot-knowledge', () => ({
  embedBotKnowledge: vi.fn().mockResolvedValue({ chunks: 1 }),
}));

describe('Reinforcement Learning from Human Demonstrations (RLHD)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Quality and Safety Filtering', () => {
    it('rejects agent replies that are too short (< 15 chars)', async () => {
      const res = await learnFromHumanAgentReply({
        workspaceId: 'ws-123',
        conversationId: 'conv-123',
        agentMessageId: 'msg-1',
        agentContent: 'ok sure',
      });
      expect(res.learned).toBe(false);
      expect(res.reason).toContain('too short');
    });

    it('rejects agent replies that are deferrals or greetings', async () => {
      const deferrals = [
        'Let me check with the manager for you.',
        'Please wait a moment while I review your account.',
        'Checking this right now for you, please hold.',
        'Hello! Good morning, welcome to support.',
      ];

      for (const reply of deferrals) {
        const res = await learnFromHumanAgentReply({
          workspaceId: 'ws-123',
          conversationId: 'conv-123',
          agentMessageId: 'msg-1',
          agentContent: reply,
        });
        expect(res.learned).toBe(false);
        expect(res.reason).toContain('greeting or deferral');
      }
    });

    it('rejects replies containing sensitive personal credentials or card numbers', async () => {
      const sensitive = 'Your temporary password is Password123! and card is 4111 2222 3333 4444.';
      const res = await learnFromHumanAgentReply({
        workspaceId: 'ws-123',
        conversationId: 'conv-123',
        agentMessageId: 'msg-1',
        agentContent: sensitive,
      });
      expect(res.learned).toBe(false);
      expect(res.reason).toContain('personal data');
    });
  });

  describe('Demonstration Retrieval and Formatting', () => {
    it('returns null when no demonstrations match or match score is low', async () => {
      vi.spyOn(semanticRetrieval, 'hybridSearchBotKnowledge').mockResolvedValueOnce([
        {
          id: 'chunk-1',
          article_title: 'General FAQ',
          content: 'Some standard docs content',
          similarity: 0.5,
          combined_score: 0.5,
        } as any,
      ]);

      const prompt = await retrieveWorkspaceDemonstrations('ws-123', 'What is the daily loss limit?');
      expect(prompt).toBeNull();
    });

    it('formats high-confidence human demonstrations into an imitation block', async () => {
      vi.spyOn(semanticRetrieval, 'hybridSearchBotKnowledge').mockResolvedValueOnce([
        {
          id: 'chunk-demo-1',
          article_title: 'Demonstration: 100k account ka daily drawdown kitna hai?',
          content: 'Customer Question:\n100k account ka daily drawdown kitna hai?\n\nHuman Agent Answer:\n100k account par daily max loss 5% yani $5,000 hai jo balance aur equity dono se calculate hota hai.',
          similarity: 0.88,
          combined_score: 0.85,
        } as any,
      ]);

      const prompt = await retrieveWorkspaceDemonstrations('ws-123', '100k account daily loss limit?');
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('# WORKSPACE HUMAN AGENT DEMONSTRATIONS (REINFORCEMENT LEARNING)');
      expect(prompt).toContain('100k account par daily max loss 5% yani $5,000 hai');
      expect(prompt).toContain('IMITATION INSTRUCTION');
    });
  });

  describe('Integration with AI Prompt Builders', () => {
    it('injects demonstrations into buildSupportAgentPrompt', () => {
      const demoText = '# WORKSPACE HUMAN AGENT DEMONSTRATIONS (REINFORCEMENT LEARNING)\n- Verified human answer here.';
      const prompt = buildSupportAgentPrompt({
        botName: 'TestBot',
        businessName: 'ApexFirm',
        knowledge: '[ARTICLE 1] Rules',
        lang: 'roman_ur',
        demonstrations: demoText,
      });

      expect(prompt).toContain(demoText);
      expect(prompt).toContain('ApexFirm');
      expect(prompt).toContain('# HELP CENTER');
    });

    it('injects demonstrations into buildHumanSupportSystemPrompt', () => {
      const demoText = '# WORKSPACE HUMAN AGENT DEMONSTRATIONS (REINFORCEMENT LEARNING)\n- Verified human answer here.';
      const prompt = buildHumanSupportSystemPrompt({
        botName: 'TestBot',
        businessName: 'ApexFirm',
        retrievedChunks: '[CHUNK 1] Rules content',
        demonstrations: demoText,
        lang: 'en',
      });

      expect(prompt).toContain(demoText);
      expect(prompt).toContain('ApexFirm');
      expect(prompt).toContain('# HELP-CENTER ARTICLES');
    });
  });
});
