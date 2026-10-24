/**
 * Real-Time Reinforcement Learning from Human Demonstrations (RLHD / In-Context Imitation)
 *
 * When a human agent in a workspace answers a customer's question, this engine:
 * 1. Captures the (Customer Question, Agent Answer) demonstration pair.
 * 2. Filters out noise, personal data, and non-answers (deferrals/greetings).
 * 3. Saves and embeds the demonstration into the workspace's bot knowledge base.
 * 4. Allows the AI to retrieve and imitate approved human demonstrations for future questions in that workspace.
 */

import { serviceClient } from '@/lib/supabase/service';
import { containsPersonalData } from './safety';
import { embedBotKnowledge } from '@/lib/ai/bot-knowledge';
import { hybridSearchBotKnowledge } from '@/lib/ai/semantic-retrieval';

// Deferral patterns: when an agent didn't answer, only promised to check or greeted
const DEFERRAL_OR_EMPTY =
  /^(?:(?:i(?:'| a)m|we(?:'| a)re|i will|we will|i'll|we'll|let me)\s+(?:check|look|ask|escalate|get back|forward|pass)|(?:checking|looking into it)|please wait|one moment|hold on|ok|okay|sure|done|thanks|thank you|hi|hello|hey|welcome|good morning|good afternoon)\b/i;

export interface LearnDemonstrationParams {
  workspaceId: string;
  conversationId: string;
  agentMessageId: string;
  agentContent: string;
}

export interface LearnDemonstrationResult {
  learned: boolean;
  reason?: string;
  knowledgeId?: string;
  question?: string;
  answer?: string;
}

/**
 * Learns from a human agent reply in real time for the given workspace.
 */
export async function learnFromHumanAgentReply({
  workspaceId,
  conversationId,
  agentMessageId,
  agentContent,
}: LearnDemonstrationParams): Promise<LearnDemonstrationResult> {
  const answer = (agentContent || '').trim();

  // 1. Basic length & quality filtering
  if (answer.length < 15) {
    return { learned: false, reason: 'Answer too short (< 15 chars)' };
  }
  if (DEFERRAL_OR_EMPTY.test(answer)) {
    return { learned: false, reason: 'Answer is a greeting or deferral, not a factual resolution' };
  }
  if (containsPersonalData(answer)) {
    return { learned: false, reason: 'Contains personal data or sensitive credentials' };
  }

  const supabase = serviceClient();

  // 2. Fetch the conversation context to find the customer's question that was answered
  const { data: recentMsgs, error: fetchErr } = await supabase
    .from('messages')
    .select('id, sender_type, content, is_internal, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (fetchErr || !recentMsgs || recentMsgs.length === 0) {
    return { learned: false, reason: 'Could not fetch conversation context' };
  }

  // Find the visitor question immediately preceding this agent message
  const sorted = [...recentMsgs].reverse();
  const agentIdx = sorted.findIndex((m) => m.id === agentMessageId);
  const preceding = agentIdx > 0 ? sorted.slice(0, agentIdx) : sorted;

  const visitorLines = preceding
    .filter((m) => m.sender_type === 'visitor' && !m.is_internal && m.content?.trim())
    .map((m) => (m.content || '').trim());

  if (visitorLines.length === 0) {
    return { learned: false, reason: 'No visitor message preceded this agent reply' };
  }

  const question = visitorLines[visitorLines.length - 1];
  if (question.length < 5) {
    return { learned: false, reason: 'Visitor question too short' };
  }
  if (containsPersonalData(question)) {
    return { learned: false, reason: 'Visitor question contains personal details' };
  }

  // 3. Store demonstration in bot_knowledge for this workspace
  const title = `Demonstration: ${question.replace(/\s+/g, ' ').slice(0, 160)}`;
  const content = `Customer Question:\n${question}\n\nHuman Agent Answer:\n${answer}`;

  // Check if a similar demonstration already exists in this workspace to avoid duplication
  const { data: existing } = await supabase
    .from('bot_knowledge')
    .select('id, content')
    .eq('workspace_id', workspaceId)
    .eq('title', title)
    .maybeSingle();

  let knowledgeId: string;
  if (existing) {
    knowledgeId = existing.id;
    await supabase
      .from('bot_knowledge')
      .update({
        content,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
  } else {
    const { data: inserted, error: insertErr } = await supabase
      .from('bot_knowledge')
      .insert({
        workspace_id: workspaceId,
        title,
        content,
        status: 'pending',
      })
      .select('id')
      .single();

    if (insertErr || !inserted) {
      console.warn('[Reinforce] Failed to insert demonstration knowledge:', insertErr?.message);
      return { learned: false, reason: insertErr?.message || 'Insert failed' };
    }
    knowledgeId = inserted.id;
  }

  // 4. Embed the demonstration asynchronously so it is instantly retrievable
  try {
    await embedBotKnowledge(workspaceId, knowledgeId);
  } catch (embedErr: any) {
    console.warn('[Reinforce] Embedding demonstration failed:', embedErr?.message);
  }

  return {
    learned: true,
    knowledgeId,
    question,
    answer,
  };
}

/**
 * Retrieves relevant Human Demonstrations for the current question in this workspace.
 */
export async function retrieveWorkspaceDemonstrations(
  workspaceId: string,
  question: string,
  limit: number = 2
): Promise<string | null> {
  try {
    const chunks = await hybridSearchBotKnowledge({
      workspaceId,
      queryText: question,
      limit: limit * 2,
    });

    // Filter chunks that are human agent demonstrations
    const demonstrations = chunks.filter(
      (c) =>
        (c.article_title.startsWith('Demonstration:') || c.content.includes('Human Agent Answer:')) &&
        c.combined_score >= 0.65
    );

    if (demonstrations.length === 0) return null;

    const formatted = demonstrations.slice(0, limit).map((d, i) => {
      return `[DEMONSTRATION ${i + 1}] (Match Score: ${Math.round(d.combined_score * 100)}%)\n${d.content.trim()}`;
    });

    return [
      '# WORKSPACE HUMAN AGENT DEMONSTRATIONS (REINFORCEMENT LEARNING)',
      'Human agents in this workspace previously answered similar inquiries. Learn from and mirror their exact rules, answers, and style:',
      ...formatted,
      '* IMITATION INSTRUCTION: If the customer is asking the same question as an approved demonstration above, use the verified human agent answer with your natural conversational tone.',
    ].join('\n\n');
  } catch (err: any) {
    console.warn('[Reinforce] Error retrieving demonstrations:', err?.message);
    return null;
  }
}
