import { serviceClient } from '@/lib/supabase/service';
import {
  providerConfigFrom,
  buildModelContext,
  recordUnanswered,
} from '@/lib/ai/help-answer';
import { dispatchOutboundMessage } from '@/lib/channels/dispatcher';
import {
  generateAutoFirstResponse,
  generateHelpDeskResponseWithHandover,
  executeHandoverToHuman,
} from '@/lib/ai/anthropic';
import { userError } from '@/lib/errors/user-error';


/*
 * Server-side reads of conversations and integration settings. The public
 * anon key cannot read these (docs/AUDIT.md H-3), so this uses the service
 * role; callers have already checked the caller may act on the conversation
 * or workspace.
 */
function getSupabase() {
  return serviceClient();
}

export interface LangGraphTriggerParams {
  conversationId: string;
  workspaceId: string;
  incomingMessage: string;
  recentMessages?: Array<{
    id?: string;
    sender_type: string;
    content: string;
    is_internal?: boolean;
    created_at?: string;
  }>;
  sender: {
    name?: string | null;
    email?: string | null;
    channel: string;
    channel_user_id?: string | null;
  };
  metadata?: Record<string, any>;
}

export interface LangGraphResponse {
  response?: string;
  content?: string;
  message?: string;
  action?: 'reply' | 'escalate' | 'suggest';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  internal_note?: string;
}

/**
 * Triggers the connected LangGraph agent for a conversation.
 */
export async function triggerLangGraphAgent(params: LangGraphTriggerParams) {
  const supabase = getSupabase();
  const { conversationId, workspaceId, incomingMessage, sender } = params;

  try {
    // 1. Fetch workspace integration settings and workspace AI settings
    const [{ data: integration }, { data: workspace }] = await Promise.all([
      supabase
        .from('workspace_integrations')
        .select('*')
        .eq('workspace_id', workspaceId)
        .maybeSingle(),
      supabase
        .from('workspaces')
        .select('ai_settings')
        .eq('id', workspaceId)
        .maybeSingle(),
    ]);

    // Check if Agent is turned ON or OFF
    const isEnabled = integration ? Boolean(integration.langgraph_enabled) : (workspace?.ai_settings?.enabled ?? true);
    if (!isEnabled) {
      return { success: true, action: 'none', reason: 'AI Agent is disabled/turned OFF' };
    }

    // Check if auto-pilot is ON or OFF
    const isAutoPilot = integration ? Boolean(integration.langgraph_auto_pilot) : (workspace?.ai_settings?.auto_response_enabled ?? true);
    if (!isAutoPilot) {
      return { success: true, action: 'none', reason: 'Auto-pilot is turned OFF' };
    }

    // 2. If an external Webhook URL is configured, call it
    if (integration?.langgraph_webhook_url?.trim()) {
      const { data: historyMessages } = await supabase
        .from('messages')
        .select('sender_type, content, created_at, is_internal')
        .eq('conversation_id', conversationId)
        .eq('is_internal', false)
        .order('created_at', { ascending: true })
        .limit(20);

      const history = (historyMessages || []).map((m) => ({
        role: m.sender_type === 'visitor' ? 'user' : 'assistant',
        content: m.content,
        timestamp: m.created_at,
      }));

      // Retrieve first, then hand the agent what it needs to be grounded.
      // Same ranker the built-in assistant uses, so both paths answer from the
      // same knowledge and an agent cannot invent a policy the docs contradict.
      const priorVisitorTurns = (historyMessages || [])
        .filter((m) => m.sender_type === 'visitor')
        .map((m) => m.content as string)
        .reverse()
        .slice(0, 4);

      const retrieved = await buildModelContext(workspaceId, incomingMessage, {
        history: priorVisitorTurns,
      });

      const payload = {
        conversation_id: conversationId,
        workspace_id: workspaceId,
        channel: sender.channel,
        visitor: {
          name: sender.name || 'Customer',
          email: sender.email || null,
          channel_user_id: sender.channel_user_id || null,
        },
        current_message: incomingMessage,
        history,
        system_prompt:
          workspace?.ai_settings?.system_prompt ||
          integration.langgraph_system_prompt ||
          'You are a customer support assistant. Answer from the supplied documentation only, ' +
            'and say so plainly when it does not cover the question.',
        /**
         * Retrieved documentation for this specific question. `context` is the
         * ready-to-use block; `sources` lets the agent cite or log what it used.
         * An agent that ignores these fields behaves exactly as before.
         */
        context: retrieved.text,
        sources: retrieved.used,
        knowledge: {
          has_context: Boolean(retrieved.text),
          article_count: retrieved.used.filter((u) => u.source === 'article').length,
          note_count: retrieved.used.filter((u) => u.source === 'note').length,
        },
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (integration.langgraph_api_key) {
        headers['Authorization'] = `Bearer ${integration.langgraph_api_key}`;
      }

      console.log(`[AI Bridge] Calling external agent endpoint at: ${integration.langgraph_webhook_url}`);

      // An external agent is one more thing that can be down, misconfigured or
      // slow. When it is, the customer should still get the help centre answer
      // rather than nothing at all — so every failure below falls through to
      // the built-in assistant instead of aborting the request.
      try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(integration.langgraph_webhook_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text();
        throw userError(`External agent returned HTTP ${res.status}: ${errText}`);
      }

      const data: LangGraphResponse = await res.json();
      const replyText = data.response || data.content || data.message || '';

      if (data.internal_note) {
        await supabase.from('messages').insert({
          conversation_id: conversationId,
          sender_type: 'ai',
          content: `🤖 [AI Agent Note]: ${data.internal_note}`,
          is_internal: true,
        });
      }

      if (data.action === 'escalate') {
        // Worth recording for the same reason the built-in assistant records
        // its own: it is a question the documentation did not settle.
        void recordUnanswered(
          workspaceId,
          incomingMessage,
          'External agent escalated to a human',
          conversationId
        );
        await supabase
          .from('conversations')
          .update({
            status: 'open',
            priority: data.priority || 'high',
            updated_at: new Date().toISOString(),
          })
          .eq('id', conversationId);

        if (replyText) {
          await insertAndDispatchReply(supabase, conversationId, workspaceId, replyText, sender.channel);
        }
        return { success: true, action: 'escalate' };
      }

      if (replyText) {
        await insertAndDispatchReply(supabase, conversationId, workspaceId, replyText, sender.channel);
        return { success: true, action: 'reply', response: replyText };
      }

      // Reached the agent, got nothing usable back. Fall through.
      console.warn('[AI Bridge] External agent returned an empty reply; using the built-in assistant.');
      } catch (agentErr: any) {
        console.warn(
          `[AI Bridge] External agent unavailable (${agentErr?.name === 'AbortError' ? 'timed out' : agentErr?.message}); using the built-in assistant.`
        );
      }
    }

    // 3. ZERO-CONFIG BUILT-IN HELP DESK KNOWLEDGE AGENT (No URL required!)
    console.log(`[AI Bridge] Running Built-in Help Desk RAG for workspace ${workspaceId}`);

    // The conversation so far, so a follow-up ("and on Instant?") is read in
    // context. The incoming message is already stored, so it is dropped here.
    const { data: recent } = await supabase
      .from('messages')
      .select('id, sender_type, content')
      .eq('conversation_id', conversationId)
      .eq('is_internal', false)
      .in('sender_type', ['visitor', 'agent', 'ai'])
      .order('created_at', { ascending: false })
      .limit(11);
    const prior = (recent || []).slice(1).reverse().filter((m) => m.content?.trim());
    const latestVisitorMsg = (recent || []).find((m) => m.sender_type === 'visitor');

    const result = await generateHelpDeskResponseWithHandover({
      workspaceId,
      conversationId,
      incomingMessage,
      visitorName: sender.name || undefined,
      providerConfig: providerConfigFrom(workspace?.ai_settings),
      systemPrompt:
        workspace?.ai_settings?.system_prompt || integration?.langgraph_system_prompt || null,
      history: prior
        .filter((m) => m.sender_type === 'visitor')
        .map((m) => m.content as string)
        .reverse()
        .slice(0, 4),
      turns: prior.map((m) => ({
        role: (m.sender_type === 'visitor' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content as string,
      })),
    });

    if (result.replyText) {
      await insertAndDispatchReply(supabase, conversationId, workspaceId, result.replyText, sender.channel, latestVisitorMsg?.id);
    }

    // If inquiry cannot be answered from docs or user requested a human, execute handover!
    if (result.shouldHandover) {
      console.log(`[AI Bridge] Handing over conversation ${conversationId} to human. Reason: ${result.handoverReason}`);
      await executeHandoverToHuman({
        supabase,
        conversationId,
        workspaceId,
        visitorMessageId: latestVisitorMsg?.id,
        reason: result.handoverReason || 'Inquiry requires human specialist assistance.',
        channel: sender.channel,
        internalNote: result.internalNote,
        disableAi: Boolean(result.disableAi),
        priority: result.priority || 'high',
      });
      return { success: true, action: 'escalate', reason: result.handoverReason };
    }

    if (result.replyText) {
      return { success: true, action: 'reply', response: result.replyText };
    }

    return { success: true, action: 'none' };
  } catch (err: any) {
    console.error('[AI Bridge Error]:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Inserts AI reply into database and forwards out to the customer's native channel.
 */
async function insertAndDispatchReply(
  supabase: ReturnType<typeof getSupabase>,
  conversationId: string,
  workspaceId: string,
  replyText: string,
  channel: string,
  replyToMessageId?: string
) {
  // 1. Insert into Supabase
  const { data: insertedMsg, error: msgErr } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'ai',
      content: replyText,
      is_internal: false,
      reply_to_message_id: replyToMessageId || null,
      metadata: {
        answered_message_id: replyToMessageId || null,
      },
    })
    .select()
    .single();

  if (msgErr) {
    if ((msgErr as any).code === '23505') {
      console.log(`[AI Bridge] Reply already inserted for message ${replyToMessageId}. Skipping.`);
      return;
    }
    console.error('Failed to insert AI reply:', msgErr);
    return;
  }

  // 2. Touch conversation updated_at
  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);

  // 3. Dispatch outbound if not standard web
  if (channel && channel !== 'web') {
    await dispatchOutboundMessage({
      conversationId,
      workspaceId,
      content: replyText,
      channel,
    });
  }
}

/**
 * Generates an AI suggested draft reply for the human agent without auto-sending.
 */
export async function generateLangGraphDraft(params: LangGraphTriggerParams): Promise<string | null> {
  const supabase = getSupabase();
  const { conversationId, workspaceId, incomingMessage, sender, recentMessages } = params;

  try {
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('ai_settings')
      .eq('id', workspaceId)
      .maybeSingle();

    const { data: integration } = await supabase
      .from('workspace_integrations')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    // Fetch the last 15 messages (including agent replies and internal notes) if not provided
    let thread = recentMessages;
    if (!thread || thread.length === 0) {
      const { data: dbMessages } = await supabase
        .from('messages')
        .select('id, sender_type, content, is_internal, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(15);
      if (dbMessages && dbMessages.length > 0) {
        thread = [...dbMessages].reverse();
      } else {
        thread = [];
      }
    }

    const hasAgentReplied = thread.some(
      (m) => m.sender_type === 'agent' && !m.is_internal
    );

    // Format all turns including agent replies and internal notes
    const turns = thread.map((m) => {
      const role: 'user' | 'assistant' = m.sender_type === 'visitor' ? 'user' : 'assistant';
      let content = m.content;
      if (m.is_internal) {
        content = `[Internal Team Note]: ${m.content}`;
      } else if (m.sender_type === 'agent') {
        content = `[Human Agent]: ${m.content}`;
      } else if (m.sender_type === 'ai') {
        content = `[AI Assistant]: ${m.content}`;
      }
      return { role, content };
    });

    const copilotSystemPrompt = hasAgentReplied
      ? 'You are an AI Copilot assisting a human support agent. A human support agent has already actively replied in this thread. Do NOT repeat handover or escalation lines (such as "I will connect you to a human" or "a team member will be with you"). Do NOT greet the customer as if this is the start of the chat. Directly provide the helpful, accurate answer or solution to the visitor\'s latest question for the human agent to review and send.'
      : (integration?.langgraph_system_prompt || null);

    if (!integration || !integration.langgraph_webhook_url) {
      // Use built-in Help Desk Knowledge Base RAG for suggested draft
      const draft = await generateAutoFirstResponse({
        workspaceId,
        conversationId,
        incomingMessage,
        visitorName: sender.name || undefined,
        providerConfig: providerConfigFrom(workspace?.ai_settings),
        systemPrompt: copilotSystemPrompt,
        turns,
      });
      return draft || `Hi ${sender.name || 'there'}! Thank you for reaching out. How can I assist you with your request today?`;
    }

    const history = turns.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const res = await fetch(integration.langgraph_webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(integration.langgraph_api_key ? { Authorization: `Bearer ${integration.langgraph_api_key}` } : {}),
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        workspace_id: workspaceId,
        channel: sender.channel,
        visitor: sender,
        mode: 'suggestion',
        current_message: incomingMessage,
        has_agent_replied: hasAgentReplied,
        history,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.response || data.content || data.message || null;
  } catch (err) {
    console.error('Error generating LangGraph draft:', err);
    return null;
  }
}
