import { NextRequest, NextResponse, after } from 'next/server';
import { serviceClient } from '@/lib/supabase/service';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  generateHelpDeskResponseWithHandover,
  executeHandoverToHuman,
  buildRunningSummary,
} from '@/lib/ai/anthropic';
import { dispatchOutboundMessage } from '@/lib/channels/dispatcher';
import { answerWithExternalAgent } from '@/lib/agent/external-agent';
import { providerConfigFrom, warmHelpIndex } from '@/lib/ai/help-answer';
import { getPlatformAiConfigServerOnly } from '@/lib/ai/platform-gateway';
import { asksForHuman, replyLanguageOf } from '@/lib/ai/intent';
import {
  botControlState,
  botMayReply,
  deliverAiReply,
  logAiEvent,
  notifyTeamOnly,
  TEAM_MEMBER_PREFIX,
} from '@/lib/ai/bot-control';
import {
  detectLanguage,
  getLanguageInfo,
  isRomanizedText,
  isLikelyEnglishText,
  normalizeDetectedLanguage,
  translateAgentReply,
  translateToEnglish,
  translateWithGoogleGtx,
} from '@/lib/ai/translator';
import { getWorkspaceHelpCenterUrl } from '@/lib/domain';
import { notifyTeamByEmailLater } from '@/lib/team/agent-notify';
import { translateVisitorMessage } from '@/lib/ai/inbound-translation';
import { checkWorkspaceFeature, checkWorkspaceLimit, incrementWorkspaceUsage } from '@/lib/plans/enforce';
import { recordPolicyOutcome } from '@/lib/ai/learning/policy';
import { looksLikeImageUrl, messageWithImage, readScreenshot, type ImageReading } from '@/lib/ai/vision';

export const maxDuration = 60;

const GENERATION_BUDGET_MS = 35_000;

/** The trailing citation formatCitation() adds, in any of its languages. */
const CITATION_LINE = /\n\n(?:Source|ماخذ|स्रोत|المصدر|Fuente): (?:\[[^\]\n]*\]\([^)\s]+\)|\*\*[^\n]*\*\*)\s*$/;

/**
 * The language the visitor wrote in. The word-list detector is instant but
 * only knows a few dozen languages and calls everything else English, so text
 * it cannot place is checked with Google's detector.
 */
async function visitorLanguageOf(text: string): Promise<{ code: string; roman: boolean }> {
  // The pipeline wrote its reply in the language replyLanguageOf chose. Roman
  // Urdu ("kisi insaan se baat karwa do") also passes isLikelyEnglishText, and
  // the bot's Roman Urdu reply was then "translated" into English.
  if (text && replyLanguageOf(text) === 'roman_ur') {
    return { code: 'ur', roman: true };
  }
  if (!text || !/[\p{L}]/u.test(text) || isLikelyEnglishText(text)) {
    return { code: 'en', roman: false };
  }
  let code = normalizeDetectedLanguage(detectLanguage(text).code, text);
  if (code === 'en') {
    const g = await translateWithGoogleGtx(text, 'en', 'auto').catch(() => null);
    if (g?.detectedLanguage) {
      code = g.romanizedSource ? g.detectedLanguage : normalizeDetectedLanguage(g.detectedLanguage, text);
    }
  }
  return { code, roman: code !== 'en' && isRomanizedText(code, text) };
}

/** Epoch ms of the latest of several optional timestamps; -Infinity if none. */
function latest(...values: (string | null | undefined)[]): number {
  let best = -Infinity;
  for (const v of values) {
    const t = v ? Date.parse(v) : NaN;
    if (!Number.isNaN(t) && t > best) best = t;
  }
  return best;
}

/**
 * Where the customer can read the full article.
 * Uses verified custom domain if live, otherwise platform help center subdomain.
 */
function helpCenterUrlFor(ws: any): string | null {
  if (!ws) return null;
  return getWorkspaceHelpCenterUrl(ws);
}

// The embeddable widget calls this after every visitor message, from the
// customer's own site.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, { ...init, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// In-memory sets to prevent concurrent auto-response runs
const inFlightConversations = new Set<string>();
const inFlightMessages = new Set<string>();

export async function POST(req: NextRequest) {
  let lockAcquired = false;
  let messageLockAcquired = false;
  let conversation_id: string | undefined;
  let targetVisitorMsgId: string | undefined;
  // Set once the conversation is known to belong to the workspace, so an
  // error can be recorded against it.
  let eventScope: { workspaceId: string; conversationId: string } | null = null;

  try {
    const body = await req.json();
    conversation_id = body.conversation_id;
    const workspace_id = body.workspace_id;
    const requested_message_id = body.message_id || body.messageId;

    if (!conversation_id || !workspace_id) {
      return json({ error: 'Missing conversation_id or workspace_id' }, { status: 400 });
    }

    if (!(await checkRateLimit(`auto_respond:${conversation_id}`, 30, 60))) {
      return json({ error: 'rate_limited' }, { status: 429 });
    }

    console.log('[Auto-Respond Step 1] AI reply triggered for message:', {
      requested_message_id,
      conversation_id,
      workspace_id,
    });

    // Agents read every visitor message in English. This runs whether or not
    // the assistant answers, and after the response so it never slows a reply.
    if (requested_message_id) {
      try {
        after(() =>
          translateVisitorMessage(requested_message_id).catch((err: unknown) =>
            console.warn('[Auto-Respond] Inbound translation failed:', err)
          )
        );
      } catch {
        translateVisitorMessage(requested_message_id).catch((err: unknown) =>
          console.warn('[Auto-Respond] Inbound translation failed:', err)
        );
      }
    }

    if (requested_message_id && inFlightMessages.has(requested_message_id)) {
      return json({ replied: false, reason: 'Auto-response already in progress for this message' });
    }

    // 0. One run per conversation at a time on this instance, so a burst of
    // visitor messages is answered in order. This only saves model calls:
    // other instances are not covered, and fn_deliver_ai_reply is what keeps
    // a conversation to one answer. Waiting too long therefore carries on
    // rather than dropping the message, whose run may be the one that answers.
    const waitUntil = Date.now() + 45_000;
    while (inFlightConversations.has(conversation_id) && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 200));
    }
    inFlightConversations.add(conversation_id);
    lockAcquired = true;

    // Privileged: this route has no user session, and row level security
    // otherwise hides the workspace's own settings from it.
    const supabase = serviceClient();

    // The reply has a two-second budget, so everything this route reads is
    // fetched at once rather than one query after another, and the help index
    // starts loading alongside.
    warmHelpIndex(workspace_id);
    const [{ data: workspace }, { data: conv }, { data: recentMessages }] = await Promise.all([
      supabase
        .from('workspaces')
        .select('name, greeting_title, greeting_message, ai_settings, slug, custom_domain, custom_domain_status, business_hours, is_suspended, deleted_at')
        .eq('id', workspace_id)
        .single(),
      supabase
        .from('conversations')
        // '*' rather than a column list, so the route keeps working before
        // the last_resolved_at migration has been run.
        .select('*, visitor:visitors(name, email)')
        .eq('id', conversation_id)
        .single(),
      // Only the recent end of the thread is ever used below.
      supabase
        .from('messages')
        .select('id, sender_type, sender_id, content, attachment_url, is_internal, created_at, metadata, reply_to_message_id')
        .eq('conversation_id', conversation_id)
        .order('created_at', { ascending: false })
        .limit(40),
    ]);

    // First, before anything is recorded: the caller is the public widget and
    // names both ids itself.
    if (!workspace || !conv || (conv.workspace_id && conv.workspace_id !== workspace_id)) {
      return json({ replied: false, reason: 'Conversation not found or workspace mismatch', code: 'not_found' });
    }

    eventScope = { workspaceId: workspace_id, conversationId: conversation_id };

    // Every silent "no" is recorded with its reason, so "the bot didn't
    // reply" can be answered from ai_reply_events instead of guessed at. The
    // widget ignores the response, so nothing here reaches the visitor.
    const skip = async (code: string, reason: string, visitorMessageId?: string | null) => {
      console.log('[Auto-Respond] Not replying:', code);
      await logAiEvent(supabase, {
        workspaceId: workspace_id,
        conversationId: conversation_id!,
        visitorMessageId: visitorMessageId ?? requested_message_id ?? null,
        event: 'reply_suppressed',
        reason: code,
      });
      return json({ replied: false, reason, code });
    };

    if (workspace.deleted_at) {
      return skip('workspace_deleted', 'Workspace was deleted');
    }
    if (workspace.is_suspended) {
      return skip('workspace_suspended', 'Workspace is suspended');
    }

    const featureCheck = await checkWorkspaceFeature(workspace_id, 'ai_bot');
    const limitCheck = await checkWorkspaceLimit(workspace_id, 'max_ai_bot_replies_per_month');
    console.log('[Auto-Respond Step 3] Plan check:', {
      featureAllowed: featureCheck.allowed,
      limitAllowed: limitCheck.allowed,
    });
    if (!featureCheck.allowed) {
      return skip('plan_no_ai_bot', featureCheck.upgradeMessage || 'AI bot not in plan');
    }
    if (!limitCheck.allowed) {
      return skip('plan_reply_limit_reached', limitCheck.upgradeMessage || 'AI reply limit reached');
    }

    const msgs = (recentMessages || []).reverse();
    const isVisitorLine = (m: (typeof msgs)[number]) =>
      m.sender_type === 'visitor' && !m.is_internal;

    // Gather all visitor message IDs that have already been answered or handed over
    const answeredVisitorMessageIds = new Set<string>();
    for (const m of msgs) {
      if (m.sender_type === 'ai' || m.sender_type === 'agent') {
        if (m.reply_to_message_id) answeredVisitorMessageIds.add(m.reply_to_message_id);
        if (m.metadata?.answered_message_id) answeredVisitorMessageIds.add(m.metadata.answered_message_id);
        if (m.metadata?.reply_to_message_id) answeredVisitorMessageIds.add(m.metadata.reply_to_message_id);
        if (m.metadata?.handover_for_message_id) answeredVisitorMessageIds.add(m.metadata.handover_for_message_id);
      }
    }

    // Determine target visitor message
    let visitorMsg: (typeof msgs)[number] | undefined;
    if (requested_message_id) {
      visitorMsg = msgs.find((m) => m.id === requested_message_id && isVisitorLine(m));
      if (!visitorMsg) {
        const { data: specificMsg } = await supabase
          .from('messages')
          .select('id, sender_type, sender_id, content, attachment_url, is_internal, created_at, metadata, reply_to_message_id')
          .eq('id', requested_message_id)
          .eq('conversation_id', conversation_id)
          .maybeSingle();

        if (specificMsg && isVisitorLine(specificMsg)) {
          visitorMsg = specificMsg;
        }
      }
    }

    if (!visitorMsg) {
      const lastReply = [...msgs]
        .reverse()
        .find((m) => (m.sender_type === 'agent' || m.sender_type === 'ai') && !m.is_internal);
      const answeredUntil = lastReply
        ? Date.parse(
            (lastReply.sender_type === 'ai' && lastReply.metadata?.answered_until) ||
              lastReply.created_at
          )
        : -Infinity;

      const unanswered = msgs.filter(
        (m) =>
          isVisitorLine(m) &&
          !answeredVisitorMessageIds.has(m.id) &&
          Date.parse(m.created_at) > answeredUntil
      );

      if (unanswered.length === 0) {
        return skip('nothing_unanswered', 'Already responded');
      }

      visitorMsg = unanswered[unanswered.length - 1];
    }

    if (!visitorMsg) {
      return skip('no_visitor_message', 'No visitor message found to answer');
    }

    const currentVisitorMsgId: string = visitorMsg.id;
    targetVisitorMsgId = currentVisitorMsgId;

    // Idempotency Guard 1: In-flight duplicate prevention
    if (inFlightMessages.has(currentVisitorMsgId)) {
      return json({ replied: false, reason: `Auto-response already in progress for message ${currentVisitorMsgId}` });
    }
    inFlightMessages.add(currentVisitorMsgId);
    messageLockAcquired = true;

    // Idempotency Guard 2: In-memory answered check
    if (answeredVisitorMessageIds.has(currentVisitorMsgId)) {
      return skip('already_answered', `Already responded to message ${currentVisitorMsgId}`, currentVisitorMsgId);
    }

    // Idempotency Guard 3: Database-level existence check
    const { data: existingAnswer } = await supabase
      .from('messages')
      .select('id, sender_type, is_internal, reply_to_message_id, metadata')
      .eq('conversation_id', conversation_id)
      .or(`reply_to_message_id.eq.${currentVisitorMsgId},metadata->>answered_message_id.eq.${currentVisitorMsgId},metadata->>handover_for_message_id.eq.${currentVisitorMsgId}`)
      .limit(1);

    if (existingAnswer && existingAnswer.length > 0) {
      return skip('already_answered', `Already responded to message ${targetVisitorMsgId}`, currentVisitorMsgId);
    }

    const aiSettings = workspace?.ai_settings;

    // Only an explicit "off" counts. Settings shows a missing flag as on, and
    // ai_settings rows written before a flag existed (or trimmed when the
    // model moved to platform level) do not carry it.
    if (aiSettings && (aiSettings.enabled === false || aiSettings.auto_response_enabled === false)) {
      console.log('[Auto-Respond Step 2] Bot disabled in workspace settings:', {
        enabled: aiSettings?.enabled,
        auto_response_enabled: aiSettings?.auto_response_enabled,
      });
      return skip(
        aiSettings.enabled === false ? 'workspace_ai_off' : 'workspace_auto_reply_off',
        'AI auto-first-response disabled',
        currentVisitorMsgId
      );
    }

    // Who answers. The database decides (migration 20261031090000): a
    // person's public reply hands the conversation to people, and only a
    // person turns the bot back on. A paused bot does not wake up because the
    // conversation went quiet; it used to after 20 minutes, which answered
    // over agents who were still on the case.
    //
    // closed_at cannot tell us about a resolution: the visitor's own message
    // reopens the conversation and clears it before this route runs. The
    // last_resolved_at column (never cleared) and channel_metadata carry the
    // history instead.
    const meta = ((conv.channel_metadata as Record<string, any>) || {}) as Record<string, any>;
    const isHumanLine = (m: (typeof msgs)[number]) =>
      m.sender_type === 'agent' && !m.is_internal && m.sender_id != null && !m.metadata?.is_welcome;
    const lastHumanReply = [...msgs].reverse().find(isHumanLine);
    const lastBotReply = [...msgs]
      .reverse()
      .find((m) => m.sender_type === 'ai' && !m.is_internal && !m.metadata?.system_event);

    const resolvedAt = latest(conv.last_resolved_at, conv.closed_at, meta.last_resolved_at);
    const lastHumanAt = latest(lastHumanReply?.created_at, meta.last_human_reply_at);
    const autopilotAt = latest(meta.autopilot_enabled_at, conv.ai_resumed_at);
    // When the assistant was switched off: by a human reply, by hand, or by a handover.
    const disabledAt = latest(lastHumanReply?.created_at, meta.last_human_reply_at, meta.ai_disabled_at, conv.ai_control_changed_at);

    // A resolution after the switch-off starts a new exchange, and the bot
    // gets its turn back. (The database does this when a closed conversation
    // reopens; this covers resolutions it cannot see, such as a solved ticket.)
    if (conv.ai_mode === 'disabled' && resolvedAt > -Infinity && resolvedAt > disabledAt) {
      const { error: resumeErr } = await supabase
        .from('conversations')
        .update({ ai_mode: 'autopilot' })
        .eq('id', conversation_id)
        .eq('ai_mode', 'disabled');
      if (resumeErr) {
        console.error('[Auto-Respond] Could not resume the bot after resolution:', resumeErr);
      } else {
        const { data: fresh } = await supabase.from('conversations').select('*').eq('id', conversation_id).single();
        if (fresh) Object.assign(conv, fresh);
      }
    }

    // Rows written before the takeover trigger: a person replied after the
    // bot was last switched on, but the row still says autopilot.
    const legacyHumanOwned =
      conv.ai_mode !== 'disabled' && lastHumanAt > -Infinity && lastHumanAt > autopilotAt && lastHumanAt > resolvedAt;
    const botState = legacyHumanOwned ? 'human_handling' : botControlState(conv, lastBotReply?.created_at);
    // Read before generating; delivery is refused if it changes meanwhile.
    const controlVersion: number | null =
      typeof conv.ai_control_version === 'number' ? conv.ai_control_version : null;

    const isAskingForHuman = asksForHuman(visitorMsg.content);

    console.log('[Auto-Respond Step 2] Bot control check:', {
      bot_enabled: aiSettings?.enabled !== false && aiSettings?.auto_response_enabled !== false,
      botState,
      controlVersion,
      isAskingForHuman,
    });

    if (legacyHumanOwned || !botMayReply(conv)) {
      // A person owns this conversation, so the bot says nothing to the
      // visitor. Asking for a person again still reaches the team.
      if (isAskingForHuman) {
        await notifyTeamOnly({
          supabase,
          conversationId: conversation_id,
          visitorMessageId: currentVisitorMsgId,
          note: '🙋 The visitor asked for a person again. The bot is off on this conversation, so it did not reply.',
        });
      }
      await logAiEvent(supabase, {
        workspaceId: workspace_id,
        conversationId: conversation_id,
        visitorMessageId: currentVisitorMsgId,
        event: 'reply_suppressed',
        reason: botState,
      });
      // Nobody else will answer: tell the person handling it (or whoever is
      // on shift) by email, at most once every few minutes per conversation.
      notifyTeamByEmailLater({
        workspaceId: workspace_id,
        conversationId: conversation_id,
        event: 'customer_reply',
        preview: visitorMsg.content,
      });
      return json({ replied: false, reason: `Bot is not answering this conversation (${botState})` });
    }

    // The person who last handled this exchange, so the bot carries on from
    // what they said instead of starting over or contradicting them.
    const humanContext =
      lastHumanReply && Date.parse(lastHumanReply.created_at) > resolvedAt
        ? { lastReply: String(lastHumanReply.content || ''), at: lastHumanReply.created_at as string }
        : null;

    const burstContext = msgs
      .filter((m) => isVisitorLine(m) && m.id !== targetVisitorMsgId && Date.parse(m.created_at) <= Date.parse(visitorMsg.created_at))
      .slice(-3)
      .map((m) => m.content as string)
      .reverse();

    const earlier = msgs
      .filter((m) => isVisitorLine(m) && m.id !== targetVisitorMsgId && !burstContext.includes(m.content as string))
      .map((m) => m.content as string)
      .reverse();

    const history = [...burstContext, ...earlier].slice(0, 4);

    const targetAt = Date.parse(visitorMsg.created_at);
    const turns = msgs
      .filter(
        (m) =>
          m.id !== targetVisitorMsgId &&
          // Only what came before the message being answered.
          Date.parse(m.created_at) <= targetAt &&
          !m.is_internal &&
          // The widget's welcome line is not part of the conversation, and
          // would make every first "hi" look like a returning one.
          !m.metadata?.is_welcome &&
          !m.metadata?.system_event &&
          ['visitor', 'agent', 'ai'].includes(m.sender_type) &&
          typeof m.content === 'string' &&
          m.content.trim()
      )
      .map((m) => ({
        role: (m.sender_type === 'visitor' ? 'user' : 'assistant') as
          | 'user'
          | 'assistant',
        // Marked, so the model does not take a person's words for its own
        // and answer as if it had made their promises.
        content: isHumanLine(m)
          ? `${TEAM_MEMBER_PREFIX}${m.content}`
          : messageWithImage(m.content as string, m.metadata?.image_reading as ImageReading | undefined),
      }));

    // Send the last 6 messages in full; summarize anything older
    const recentTurns = turns.slice(-6);
    let runningSummary: string | null = (conv as any)?.running_summary || null;
    if (!runningSummary && turns.length > 6) {
      const older = turns.slice(0, -6);
      runningSummary = buildRunningSummary(null, older);
      supabase.from('conversations').update({ running_summary: runningSummary }).eq('id', conversation_id).then();
    }

    // Step 4: Check platform AI settings
    const platformConfig = await getPlatformAiConfigServerOnly().catch(() => null);
    console.log('[Auto-Respond Step 4] Platform AI settings check:', {
      isEnabled: platformConfig?.isEnabled,
      provider: platformConfig?.config?.provider,
      baseUrl: platformConfig?.config?.baseUrl,
      model: platformConfig?.model,
      hasKey: Boolean(platformConfig?.config?.apiKey),
    });

    const botName = aiSettings?.bot_name || workspace?.greeting_title || 'Support Agent';
    console.log('[Auto-Respond Step 5] Generating RAG response:', {
      botName,
      workspace: workspace?.name,
      incomingLength: visitorMsg.content?.length,
    });

    // A screenshot is read once (vision.ts) and kept on the message, so the
    // team sees the reading in the inbox and a retry does not read it again.
    // The bot then works with the words plus what the image shows.
    let imageReading = (visitorMsg.metadata?.image_reading as ImageReading | undefined) ?? null;
    if (!imageReading && looksLikeImageUrl(visitorMsg.attachment_url)) {
      const read = await readScreenshot({
        url: visitorMsg.attachment_url as string,
        caption: visitorMsg.content as string,
      });
      imageReading = read.reading;
      await logAiEvent(supabase, {
        workspaceId: workspace_id,
        conversationId: conversation_id,
        visitorMessageId: currentVisitorMsgId,
        event: 'image_read',
        reason: read.reason,
        detail: { kind: read.reading?.kind ?? null, latency_ms: read.latencyMs, provider: read.reading?.provider ?? null },
      });
      if (imageReading) {
        const { error: readingErr } = await supabase
          .from('messages')
          .update({ metadata: { ...(visitorMsg.metadata || {}), image_reading: imageReading } })
          .eq('id', currentVisitorMsgId);
        if (readingErr) console.error('[Auto-Respond] Could not keep the screenshot reading:', readingErr.message);
      }
    }

    // 3. Generate the reply, with a fail-safe handover if it takes too long.
    // A reply can take up to three sequential model calls (intent, query
    // rewrite, answer), each with its own shorter timeout and fallback. 15 s
    // was below their sum on slower providers such as DeepSeek, so a busy
    // minute timed most replies out. 35 s still leaves room inside
    // maxDuration for translation and the insert.
    let result: Awaited<ReturnType<typeof generateHelpDeskResponseWithHandover>>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`AI response timed out after ${GENERATION_BUDGET_MS / 1000} seconds`)),
          GENERATION_BUDGET_MS
        );
      });

      const convId = conversation_id;
      const visitorText = messageWithImage(visitorMsg.content as string, imageReading);
      const builtIn = () =>
        generateHelpDeskResponseWithHandover({
          workspaceId: workspace_id,
          conversationId: convId,
          incomingMessage: visitorText,
          visitorName: (conv.visitor as { name?: string | null } | null)?.name || undefined,
          botName,
          providerConfig: providerConfigFrom(aiSettings),
          systemPrompt: aiSettings?.system_prompt || null,
          history,
          turns: recentTurns,
          helpCenterUrl: helpCenterUrlFor(workspace),
          workspaceName: workspace?.name,
          hasHumanReplied: lastHumanAt > -Infinity && lastHumanAt > resolvedAt,
          botFailureCount: (conv as any)?.bot_failure_count || 0,
          runningSummary,
          businessHours: workspace?.business_hours || null,
          cannedGreeting: aiSettings?.greeting_message || null,
          humanContext,
          resuming: botState === 'ai_resuming',
          // Agent mode unless the workspace chose the strict path in settings.
          answerMode: aiSettings?.answer_mode === 'strict' ? 'strict' : 'agent',
          subAgents: aiSettings?.sub_agents ?? null,
        });

      // The workspace's own agent (Settings → AI bot → LangGraph) answers
      // first when it is on. A request for a person always goes the built-in
      // way, so reaching the team never depends on someone else's endpoint.
      const generate = async () => {
        if (!isAskingForHuman) {
          const external = await answerWithExternalAgent({
            workspaceId: workspace_id,
            conversationId: convId,
            incomingMessage: visitorText,
            channel: conv.channel || 'web',
            visitorName: (conv.visitor as { name?: string | null } | null)?.name || null,
            turns: [...recentTurns, { role: 'user' as const, content: visitorText }],
            humanContext,
            workspaceSystemPrompt: aiSettings?.system_prompt || null,
          });
          if (external) return external;
        }
        return builtIn();
      };

      result = await Promise.race([generate(), timeoutPromise]);
    } catch (timeoutErr: any) {
      console.warn('[Auto-Respond] Timeout or error during AI generation:', timeoutErr?.message);
      // Seamless fail-safe handover to human: never show error to customer!
      await executeHandoverToHuman({
        supabase,
        conversationId: conversation_id,
        workspaceId: workspace_id,
        visitorMessageId: targetVisitorMsgId,
        reason: 'AI generation timed out or encountered an error. Gracefully handed over.',
        channel: conv.channel || 'web',
        // A slow or failing provider is not the visitor's choice: the
        // assistant stays on so their next message still gets an answer.
        // Switching it off here silenced the bot for the whole conversation.
        disableAi: false,
        priority: 'high',
        internalNote: `🤖 [AI Timeout/Failover]: Bot response took too long or failed (${timeoutErr?.message || 'timeout'}). Handed to a human agent so the visitor was not kept waiting.`,
        controlVersion,
      });
      await logAiEvent(supabase, {
        workspaceId: workspace_id,
        conversationId: conversation_id,
        visitorMessageId: targetVisitorMsgId,
        event: 'provider_error',
        reason: String(timeoutErr?.message || 'timeout').slice(0, 200),
      });
      return json({ replied: true, handed_over: true, reason: 'Handed over due to timeout or failover' });
    } finally {
      clearTimeout(timer);
    }

    console.log('[Auto-Respond Step 5 Result]', {
      ok: Boolean(result.replyText),
      replyLength: result.replyText?.length,
      shouldHandover: result.shouldHandover,
      canAnswerFromDocs: result.canAnswerFromDocs,
      intent: result.intent,
      citedCount: result.citedArticles?.length || (result.citation ? 1 : 0),
    });

    let aiResponseText = result.replyText;
    if (!aiResponseText || !aiResponseText.trim()) {
      return skip('empty_reply', 'Empty auto-response generated', targetVisitorMsgId);
    }

    // 3b. ATOMIC DOUBLE-CHECK: Re-query messages to guarantee no agent or AI replied during RAG generation
    const { data: lateReplies } = await supabase
      .from('messages')
      .select('id, sender_type, is_internal, reply_to_message_id, metadata, created_at')
      .eq('conversation_id', conversation_id)
      .or(`reply_to_message_id.eq.${targetVisitorMsgId},metadata->>answered_message_id.eq.${targetVisitorMsgId},metadata->>handover_for_message_id.eq.${targetVisitorMsgId}`)
      .limit(5);

    if (lateReplies && lateReplies.length > 0) {
      return skip('answered_during_generation', 'Already responded for this visitor message during generation', targetVisitorMsgId);
    }

    const { data: humanReplies } = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', conversation_id)
      .eq('is_internal', false)
      .eq('sender_type', 'agent')
      .not('sender_id', 'is', null)
      .gt('created_at', visitorMsg.created_at)
      .limit(1);

    if (humanReplies && humanReplies.length > 0) {
      return skip('human_replied_during_generation', 'A person replied during generation', targetVisitorMsgId);
    }

    // Check if conversation was closed during generation
    const { data: freshConv } = await supabase
      .from('conversations')
      .select('status')
      .eq('id', conversation_id)
      .single();

    if (freshConv && freshConv.status === 'closed') {
      return skip('closed_during_generation', 'Conversation was closed during generation', targetVisitorMsgId);
    }

    // The reply must be in the language of the visitor's latest message. The
    // model is told so, but the documentation it quotes is usually English,
    // and the no-provider fallback answers straight from that documentation —
    // so check, and translate when the reply came out in the wrong language.
    const visitorText = (visitorMsg.content || '').trim();
    const visitorLang = await visitorLanguageOf(visitorText);
    // The citation line ("Source: [Title](url)") is added by code. Sent
    // through a translator it comes back as a broken link, and it skews
    // language detection, so only the answer above it is translated.
    const citationLine = aiResponseText.match(CITATION_LINE)?.[0] ?? '';
    let replyBody = citationLine ? aiResponseText.slice(0, -citationLine.length) : aiResponseText;
    let englishBody = replyBody;
    const replyLang =
      replyLanguageOf(replyBody) === 'roman_ur' ? 'ur' : isLikelyEnglishText(replyBody) ? 'en' : detectLanguage(replyBody).code;
    const providerConfig = providerConfigFrom(aiSettings);

    if (visitorLang.code !== 'en' && replyLang === 'en') {
      try {
        const t = await translateAgentReply({
          text: replyBody,
          targetLanguageCode: visitorLang.code,
          sourceLanguageCode: 'en',
          providerConfig,
          businessName: workspace?.name,
          romanize: visitorLang.roman,
        });
        const translated = t.translatedText?.trim();
        // A visitor writing Roman Urdu asked for Latin letters; a translator
        // that falls back to Urdu script gives them text in a script they did
        // not write in. The untranslated reply reads better than that.
        const wrongScript = visitorLang.roman && translated && /[؀-ۿऀ-ॿ]/.test(translated);
        if (translated && !wrongScript) replyBody = translated;
        else if (wrongScript) console.warn('[Auto-Respond] Translation came back in the wrong script; sending the reply as written.');
      } catch (err) {
        console.warn('[Auto-Respond] Reply translation failed, sending as written:', err);
      }
    } else if (visitorLang.code === 'en' && replyLang !== 'en') {
      try {
        const t = await translateToEnglish({ text: replyBody, providerConfig });
        if (t.englishText?.trim()) replyBody = t.englishText.trim();
        englishBody = replyBody;
      } catch (err) {
        console.warn('[Auto-Respond] Reply translation to English failed:', err);
      }
    } else if (visitorLang.code !== 'en') {
      // Already in the visitor's language: keep an English copy for agents.
      // Only agents read it, so the free translator does; a model call here
      // was spent on every non-English reply.
      try {
        const g = await translateWithGoogleGtx(replyBody, 'en', 'auto');
        if (g?.translated?.trim()) englishBody = g.translated.trim();
      } catch (err) {
        console.warn('[Auto-Respond] English copy of the reply failed:', err);
      }
    }
    let preassignedAgent: { id: string; name: string | null; avatar_url: string | null } | null = null;
    if (result.shouldHandover) {
      try {
        if (conv.assigned_agent_id) {
          const { data: a } = await supabase.from('agents').select('id, name, avatar_url').eq('id', conv.assigned_agent_id).maybeSingle();
          if (a) preassignedAgent = a;
        }
        if (!preassignedAgent) {
          const { data: ags } = await supabase
            .from('agents')
            .select('id, name, avatar_url, status')
            .eq('workspace_id', workspace_id)
            .neq('is_active', false)
            .neq('role', 'light_agent');
          if (ags && ags.length > 0) {
            const rank = (s: string | null) => (s === 'online' ? 0 : s === 'away' ? 1 : 2);
            const sorted = [...ags].sort((a, b) => rank(a.status) - rank(b.status));
            preassignedAgent = sorted[0];
          }
        }

        // If visitor asked for human and an agent name is available, append professional connecting notice
        if (preassignedAgent?.name && result.intent === 'wants_human') {
          const agentName = preassignedAgent.name;
          const connectingNotice =
            visitorLang.code === 'ur'
              ? visitorLang.roman
                ? `\n\n🔄 Main aapko hamare available support agent **${agentName}** se connect kar raha hoon...`
                : `\n\n🔄 میں آپ کو ہمارے دستیاب سپورٹ ایجنٹ **${agentName}** سے منسلک کر رہا ہوں۔`
              : `\n\n🔄 Connecting you with our available support agent, **${agentName}**...`;
          if (!replyBody.includes(agentName)) {
            replyBody = `${replyBody}${connectingNotice}`;
          }
        }
      } catch (err) {
        console.warn('[Auto-Respond] Pre-assign agent lookup failed:', err);
      }
    }

    aiResponseText = `${replyBody}${citationLine}`;
    const aiEnglishTranslation = `${englishBody}${citationLine}`;
    const detected = { code: visitorLang.code, name: getLanguageInfo(visitorLang.code).name };
    const citedArticleIds = result.usedArticleIds || (result.citation?.id ? [result.citation.id] : []);
    const citedArticles = result.citedArticles || (result.citation ? [{ id: result.citation.id, title: result.citation.title }] : []);

    console.log('[Auto-Respond Step 6] Delivering AI reply:', {
      conversation_id,
      reply_to_message_id: targetVisitorMsgId,
      control_version: controlVersion,
      delivered_language: detected.code,
      cited_articles_count: citedArticles.length,
    });

    const replyMetadata = {
      answered_message_id: targetVisitorMsgId,
      reply_to_message_id: targetVisitorMsgId,
      answered_until: visitorMsg.created_at,
      delivered_language: detected.code,
      delivered_language_name: detected.name,
      english_translation: aiEnglishTranslation,
      bot_intent: result.intent ?? null,
      bot_intent_source: result.intentSource ?? null,
      bot_state: botState,
      bot_engine: result.engine ?? 'built_in',
      retrieval_confidence: result.retrievalConfidence ?? null,
      cited_article_id: result.citation?.id ?? null,
      cited_article_ids: citedArticleIds,
      cited_articles: citedArticles,
      policy_arm: result.policyArm ?? null,
      // Agent mode's specialist, shown on the reply in the inbox.
      sub_agent: result.subAgent ?? null,
      // Quick reply chips rendered in the widget below the bot bubble.
      // Null means no chips; an empty array is treated the same.
      quick_replies: result.quickReplies?.length ? result.quickReplies : null,
      handover: result.shouldHandover ? true : null,
      assigned_agent_id: preassignedAgent?.id || null,
      assigned_agent_name: preassignedAgent?.name || null,
      assigned_agent_avatar: preassignedAgent?.avatar_url || null,
      system_event: result.shouldHandover
        ? {
            type: 'handover',
            agent_id: preassignedAgent?.id || null,
            agent_name: preassignedAgent?.name || null,
            agent_avatar: preassignedAgent?.avatar_url || null,
          }
        : undefined,
    };

    // 4. Deliver. fn_deliver_ai_reply locks the conversation and refuses the
    // reply if a person answered, the bot was switched off, the conversation
    // was closed or the visitor wrote again while it was being written. Only
    // before the migration has run does the plain insert below happen.
    let insertedMsg: Record<string, unknown> | null = null;
    const delivery = await deliverAiReply(supabase, {
      conversationId: conversation_id,
      visitorMessageId: targetVisitorMsgId,
      expectedVersion: controlVersion,
      content: aiResponseText,
      metadata: replyMetadata,
    });

    if (delivery && !delivery.delivered) {
      console.log('[Auto-Respond] Reply not delivered:', delivery.reason);
      return json({ replied: false, reason: `Reply not delivered: ${delivery.reason}` });
    }

    if (delivery) {
      insertedMsg = delivery.message;
    } else {
      const { data, error: msgErr } = await supabase
        .from('messages')
        .insert({
          conversation_id,
          sender_type: 'ai',
          sender_id: null,
          content: aiResponseText,
          is_internal: false,
          reply_to_message_id: targetVisitorMsgId,
          metadata: replyMetadata,
        })
        .select()
        .single();
      if (msgErr) {
        if ((msgErr as any).code === '23505') {
          return json({ replied: false, reason: 'Already responded for this visitor message' });
        }
        throw msgErr;
      }
      insertedMsg = data;
    }

    incrementWorkspaceUsage(workspace_id, 'ai_replies', 1).catch(() => {});
    // The retrieval policy learns from what happens after this reply
    // (src/lib/ai/learning/policy.ts). Awaited so a serverless function does
    // not stop before it is written; it never throws.
    if (result.policyArm && insertedMsg?.id) {
      await recordPolicyOutcome({
        workspaceId: workspace_id,
        conversationId: conversation_id,
        messageId: String(insertedMsg.id),
        arm: result.policyArm,
        kind: result.shouldHandover && !result.canAnswerFromDocs ? 'handover' : 'answer',
      });
    }
    console.log('[Auto-Respond Step 6 Success] AI reply delivered:', {
      message_id: insertedMsg?.id,
      created_at: insertedMsg?.created_at,
    });

    // 4b. If Help Desk cannot answer or customer requested a real agent, execute handover!
    if (result.shouldHandover) {
      console.log(`[Auto-Respond] Handing over conversation ${conversation_id} to real agent. Reason: ${result.handoverReason}`);
      const handoverResult = await executeHandoverToHuman({
        supabase,
        conversationId: conversation_id,
        workspaceId: workspace_id,
        visitorMessageId: targetVisitorMsgId,
        reason: result.handoverReason || 'Inquiry not covered in Help Desk documentation.',
        channel: conv.channel || 'web',
        disableAi: Boolean(result.disableAi),
        pausedReason: result.intent === 'wants_human' ? 'human_requested' : 'needs_attention',
        internalNote: result.internalNote,
        priority: result.priority || 'high',
        // The reply just delivered already tells the visitor what happens next.
        announce: false,
      });

      const finalAgent = (handoverResult as any)?.assignedAgent || preassignedAgent;
      if (insertedMsg?.id && finalAgent) {
        try {
          await supabase
            .from('messages')
            .update({
              metadata: {
                ...replyMetadata,
                handover: true,
                assigned_agent_id: finalAgent.id,
                assigned_agent_name: finalAgent.name,
                assigned_agent_avatar: finalAgent.avatar_url,
                system_event: {
                  type: 'handover',
                  agent_id: finalAgent.id,
                  agent_name: finalAgent.name,
                  agent_avatar: finalAgent.avatar_url,
                },
              },
            })
            .eq('id', insertedMsg.id);
        } catch (updateErr) {
          console.warn('[Auto-Respond] Failed to attach final agent metadata to message:', updateErr);
        }
      }
      await logAiEvent(supabase, {
        workspaceId: workspace_id,
        conversationId: conversation_id,
        visitorMessageId: targetVisitorMsgId,
        event: 'handover',
        reason: String(result.handoverReason || result.intent || '').slice(0, 200),
        // intent: the learner (src/lib/ai/learning/learner.ts) learns only from
        // help-centre questions the team then answered.
        detail: {
          disable_ai: Boolean(result.disableAi),
          priority: result.priority || 'high',
          intent: result.intent ?? null,
          sub_agent: result.subAgent ?? null,
        },
      });
    }

    // 5. If channel is multi-channel (WhatsApp, Meta, LinkedIn), dispatch outbound
    if (conv.channel && conv.channel !== 'web') {
      await dispatchOutboundMessage({
        conversationId: conversation_id,
        workspaceId: workspace_id,
        content: aiResponseText,
        channel: conv.channel,
      });
    }

    return json({ replied: true, message: insertedMsg, handed_over: result.shouldHandover });
  } catch (error: any) {
    if (error?.code === '23505') {
      return json({ replied: false, reason: 'Already responded for this visitor message' });
    }
    console.error('Error in AI auto-respond:', error);
    if (eventScope) {
      await logAiEvent(serviceClient(), {
        ...eventScope,
        visitorMessageId: targetVisitorMsgId ?? null,
        event: 'route_error',
        reason: String(error?.message || error).slice(0, 200),
      });
    }
    return json({ error: error.message || 'Auto-respond failed' }, { status: 500 });
  } finally {
    if (lockAcquired && conversation_id) {
      inFlightConversations.delete(conversation_id);
    }
    if (messageLockAcquired && targetVisitorMsgId) {
      inFlightMessages.delete(targetVisitorMsgId);
    }
  }
}
