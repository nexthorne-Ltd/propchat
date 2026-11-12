'use server';

import { randomUUID } from 'crypto';
import { serviceClient } from '@/lib/supabase/service';
import { getWorkspaceAccess } from '@/lib/team/access';
import { checkWorkspaceFeature, checkWorkspaceLimit } from '@/lib/plans/enforce';
import { getPlatformAiConfigServerOnly } from '@/lib/ai/platform-gateway';
import { chat } from '@/lib/ai/provider';
import { generateHelpDeskResponseWithHandover } from '@/lib/ai/anthropic';
import { userError } from '@/lib/errors/user-error';

/**
 * Settings → AI bot → Health check. "The bot isn't replying" has many causes
 * (no platform model, the workspace switch, a person took the conversation,
 * a provider error), and each one is silent to the visitor by design. This
 * runs every check the auto-respond route would, plus one real model call,
 * and reads back the reasons ai_reply_events recorded, so the answer is a
 * list instead of a guess. It reads only; nothing is sent to any visitor.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface RecentBotEvent {
  at: string;
  event: string;
  reason: string | null;
  explained: string;
}

export interface BotHealthReport {
  checks: HealthCheck[];
  overall: CheckStatus;
  recent: RecentBotEvent[];
  last24h: { delivered: number; suppressed: number; handovers: number; errors: number };
  botOffConversations: number;
  checkedAt: string;
}

/** Plain-language reasons for the codes the auto-respond route records. */
const REASONS: Record<string, string> = {
  workspace_ai_off: 'The AI bot is switched off in Settings → AI bot → Assistant.',
  workspace_auto_reply_off: 'Auto-reply is switched off in Settings → AI bot → Assistant.',
  workspace_suspended: 'The workspace is suspended by the platform admin.',
  workspace_deleted: 'The workspace was deleted.',
  plan_no_ai_bot: 'The plan did not include the AI bot (now unlimited for everyone).',
  plan_reply_limit_reached: 'The monthly AI reply limit was reached (now unlimited for everyone).',
  human_handling: 'A person replied in this conversation, so the bot stays quiet there.',
  human_reply: 'A person replied in this conversation, so the bot stays quiet there.',
  ai_disabled: 'The bot was switched off for this conversation.',
  nothing_unanswered: 'There was no new visitor message to answer.',
  already_answered: 'That message was already answered.',
  no_visitor_message: 'No visitor message was found to answer.',
  empty_reply: 'The model returned an empty answer.',
  answered_during_generation: 'Someone else answered while the bot was writing.',
  human_replied_during_generation: 'A person replied while the bot was writing.',
  closed_during_generation: 'The conversation was closed while the bot was writing.',
};

function explain(event: string, reason: string | null): string {
  if (event === 'reply_delivered') return 'The bot replied.';
  if (event === 'handover') return `Handed to the team${reason ? ` (${reason})` : ''}.`;
  if (event === 'provider_error') return `The AI provider failed: ${reason || 'unknown error'}.`;
  if (event === 'route_error') return `The reply route crashed: ${reason || 'unknown error'}.`;
  if (reason && REASONS[reason]) return REASONS[reason];
  return reason ? `${event}: ${reason}` : event;
}

function worst(checks: HealthCheck[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

async function guard(workspaceId: string) {
  try {
    return await getWorkspaceAccess(workspaceId, 'view');
  } catch (e) {
    throw userError((e as Error)?.message || 'You do not have access to this workspace.');
  }
}

export async function runBotHealthCheckAction(workspaceId: string): Promise<BotHealthReport> {
  await guard(workspaceId);
  const checks: HealthCheck[] = [];

  const hasServiceKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  checks.push({
    id: 'service_key',
    label: 'Server key',
    status: hasServiceKey ? 'ok' : 'fail',
    detail: hasServiceKey
      ? 'SUPABASE_SERVICE_ROLE_KEY is set on the server.'
      : 'SUPABASE_SERVICE_ROLE_KEY is missing, so the bot cannot read settings or send replies.',
    fix: hasServiceKey ? undefined : 'Add SUPABASE_SERVICE_ROLE_KEY in Vercel → Project → Settings → Environment Variables, then redeploy.',
  });

  const supabase = serviceClient();
  const { data: ws, error: wsErr } = await supabase
    .from('workspaces')
    .select('ai_settings, is_suspended, deleted_at')
    .eq('id', workspaceId)
    .maybeSingle();
  if (wsErr) console.error('[Bot Health] Could not read the workspace:', wsErr.message);

  const ai = (ws?.ai_settings || {}) as Record<string, unknown>;
  const switchedOff = ai.enabled === false || ai.auto_response_enabled === false;
  checks.push({
    id: 'workspace_switch',
    label: 'Bot switch',
    status: switchedOff ? 'fail' : 'ok',
    detail: switchedOff
      ? ai.enabled === false
        ? 'The AI bot is switched off for this workspace.'
        : 'Auto-reply is switched off for this workspace.'
      : 'The bot is switched on for this workspace.',
    fix: switchedOff ? 'Turn it on in Settings → AI bot → Assistant & tone.' : undefined,
  });

  if (ws?.is_suspended || ws?.deleted_at) {
    checks.push({
      id: 'workspace_state',
      label: 'Workspace',
      status: 'fail',
      detail: ws.deleted_at ? 'This workspace was deleted.' : 'This workspace is suspended by the platform admin.',
      fix: 'Ask the platform admin to restore it.',
    });
  }

  const [feature, limit] = await Promise.all([
    checkWorkspaceFeature(workspaceId, 'ai_bot'),
    checkWorkspaceLimit(workspaceId, 'max_ai_bot_replies_per_month'),
  ]);
  const planOk = feature.allowed && limit.allowed;
  checks.push({
    id: 'plan',
    label: 'Plan access',
    status: planOk ? 'ok' : 'fail',
    detail: planOk
      ? `AI bot allowed${limit.isUnlimited ? ', unlimited replies' : `, ${limit.currentUsage}/${limit.limit} replies this month`}.`
      : feature.upgradeMessage || limit.upgradeMessage || 'The plan blocks the AI bot.',
    fix: planOk ? undefined : 'Deploy the latest code (plan limits are switched off there) or raise the limit in Super admin → Plans.',
  });

  const platform = await getPlatformAiConfigServerOnly().catch((e) => {
    console.error('[Bot Health] Could not read platform AI settings:', e);
    return null;
  });
  const modelReady = Boolean(platform?.isEnabled && platform.config?.apiKey);
  checks.push({
    id: 'platform_model',
    label: 'AI model',
    status: modelReady ? 'ok' : 'fail',
    detail: modelReady
      ? `${platform!.config!.provider} · ${platform!.model || 'default model'}`
      : 'No AI model is set up for the platform, so the bot cannot write answers and hands every message to the team.',
    fix: modelReady ? undefined : 'Super admin → Platform AI: choose a provider, paste the API key, switch it on and save.',
  });

  if (modelReady) {
    const started = Date.now();
    try {
      const res = await chat(platform!.config!, {
        system: 'You are a health check. Reply with the single word OK.',
        messages: [{ role: 'user', content: 'Health check' }],
        maxTokens: 20,
        temperature: 0,
        timeoutMs: 20_000,
      });
      const ms = Date.now() - started;
      const answered = Boolean(res.text?.trim());
      checks.push({
        id: 'model_call',
        label: 'Live model call',
        status: answered ? (ms > 15_000 ? 'warn' : 'ok') : 'fail',
        detail: answered ? `The model answered in ${(ms / 1000).toFixed(1)} s.` : 'The model answered with nothing.',
        fix: answered ? (ms > 15_000 ? 'The provider is slow; replies may time out. Try a faster model.' : undefined) : 'Check the model name in Super admin → Platform AI.',
      });
    } catch (e) {
      const msg = String((e as Error)?.message || e).slice(0, 300);
      checks.push({
        id: 'model_call',
        label: 'Live model call',
        status: 'fail',
        detail: `The provider refused the call: ${msg}`,
        fix: 'Check the API key, its credit balance and the model name in Super admin → Platform AI.',
      });
    }
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [
    { data: events, error: evErr },
    { count: offCount, error: offErr },
    { count: visitorCount, error: vmErr },
    { data: triggerStatus, error: tsErr },
  ] = await Promise.all([
    supabase
      .from('ai_reply_events')
      .select('created_at, event, reason')
      .eq('workspace_id', workspaceId)
      .in('event', ['reply_delivered', 'reply_suppressed', 'handover', 'provider_error', 'route_error'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('ai_mode', 'disabled')
      .neq('status', 'closed'),
    supabase
      .from('messages')
      .select('id, conversations!inner(workspace_id)', { count: 'exact', head: true })
      .eq('conversations.workspace_id', workspaceId)
      .eq('sender_type', 'visitor')
      .eq('is_internal', false)
      .gte('created_at', since),
    supabase.rpc('fn_bot_reply_trigger_status'),
  ]);
  if (evErr) console.error('[Bot Health] Could not read bot events:', evErr.message);
  if (offErr) console.error('[Bot Health] Could not count paused conversations:', offErr.message);
  if (vmErr) console.error('[Bot Health] Could not count visitor messages:', vmErr.message);

  // The database asks for a reply on every visitor message (migration
  // 20261123090000), so a widget that cannot reach the app no longer
  // silences the bot. It needs the migration and the Vault app URL.
  const ts = (tsErr ? null : triggerStatus) as { trigger?: boolean; pg_net?: boolean; app_url?: boolean } | null;
  const triggerReady = Boolean(ts?.trigger && ts?.pg_net && ts?.app_url);
  checks.push({
    id: 'server_trigger',
    label: 'Server-side reply request',
    status: triggerReady ? 'ok' : 'warn',
    detail: triggerReady
      ? 'The database asks the bot to reply to every visitor message, even when the widget cannot reach the app.'
      : !ts || !ts.trigger
        ? 'Not installed: the bot is only asked by the visitor\'s browser, so if the widget cannot reach the app the bot never replies.'
        : !ts.app_url
          ? 'Installed, but the Vault secret zentry_app_url is not set, so it cannot reach the app.'
          : 'Installed, but the pg_net extension is off.',
    fix: triggerReady
      ? undefined
      : !ts || !ts.trigger
        ? 'Run supabase/migrations/20261123090000_bot_reply_server_trigger.sql in the Supabase SQL editor.'
        : !ts.app_url
          ? "In the Supabase SQL editor run: select vault.create_secret('https://your-live-domain', 'zentry_app_url');"
          : 'Supabase → Database → Extensions: enable pg_net.',
  });

  const rows = (events || []) as { created_at: string; event: string; reason: string | null }[];
  const last24h = {
    delivered: rows.filter((r) => r.event === 'reply_delivered').length,
    suppressed: rows.filter((r) => r.event === 'reply_suppressed').length,
    handovers: rows.filter((r) => r.event === 'handover').length,
    errors: rows.filter((r) => r.event === 'provider_error' || r.event === 'route_error').length,
  };

  const visitorMessages = visitorCount || 0;
  if (rows.length === 0 && visitorMessages > 0) {
    checks.push({
      id: 'activity',
      label: 'Recent activity',
      status: 'fail',
      detail: `Visitors sent ${visitorMessages} message(s) in the last 24 hours, but the bot was never asked to reply to any of them. The widget's request is not reaching this app.`,
      fix: triggerReady
        ? 'The server-side request is set up now; send a new widget message and run the check again.'
        : 'Set up the server-side reply request (the check above), or make sure the embed script on your site is loaded from this app\'s live domain.',
    });
  } else if (rows.length === 0) {
    checks.push({
      id: 'activity',
      label: 'Recent activity',
      status: 'warn',
      detail: 'No visitor messages and no bot activity in the last 24 hours.',
      fix: 'Send a message from the widget on your site (or /demo.html?workspaceId=…), then run the check again.',
    });
  } else if (last24h.errors > 0 && last24h.delivered === 0) {
    checks.push({
      id: 'activity',
      label: 'Recent activity',
      status: 'fail',
      detail: `${last24h.errors} provider error(s) and no replies in the last 24 hours.`,
      fix: 'See the errors below; usually the API key or its balance.',
    });
  } else {
    checks.push({
      id: 'activity',
      label: 'Recent activity',
      status: last24h.delivered > 0 ? 'ok' : 'warn',
      detail: `Last 24 h: ${last24h.delivered} replied, ${last24h.handovers} handed over, ${last24h.suppressed} skipped, ${last24h.errors} errors.`,
    });
  }

  const botOffConversations = offCount || 0;
  if (botOffConversations > 0) {
    checks.push({
      id: 'paused',
      label: 'Conversations with the bot off',
      status: 'warn',
      detail: `${botOffConversations} open conversation(s) have the bot off, usually because a person replied there. The bot stays quiet in them until someone turns it back on.`,
      fix: 'Use "Turn the bot back on" below, or start a new chat to test.',
    });
  }

  return {
    checks,
    overall: worst(checks),
    recent: rows.slice(0, 12).map((r) => ({
      at: r.created_at,
      event: r.event,
      reason: r.reason,
      explained: explain(r.event, r.reason),
    })),
    last24h,
    botOffConversations,
    checkedAt: new Date().toISOString(),
  };
}

export interface BotTestAnswer {
  replyText: string | null;
  handedOver: boolean;
  handoverReason: string | null;
  intent: string | null;
  subAgent: string | null;
  ms: number;
  error?: string;
}

/**
 * Runs one question through the real answer pipeline (same help centre,
 * prompt and model as a visitor gets) without a conversation, so nothing is
 * written to any chat and no visitor sees it.
 */
export async function askBotTestQuestionAction(workspaceId: string, question: string): Promise<BotTestAnswer> {
  await guard(workspaceId);
  const text = String(question || '').trim().slice(0, 1000);
  if (!text) throw userError('Type a question to test.');

  const { data: ws } = await serviceClient()
    .from('workspaces')
    .select('name, greeting_title, ai_settings, business_hours')
    .eq('id', workspaceId)
    .maybeSingle();
  const ai = (ws?.ai_settings || {}) as {
    bot_name?: string;
    system_prompt?: string;
    greeting_message?: string;
    answer_mode?: string;
    sub_agents?: Parameters<typeof generateHelpDeskResponseWithHandover>[0]['subAgents'];
  };

  const started = Date.now();
  try {
    const result = await Promise.race([
      generateHelpDeskResponseWithHandover({
        workspaceId,
        // A throwaway id: no conversation row exists, so any per-conversation
        // write the pipeline attempts matches nothing.
        conversationId: randomUUID(),
        incomingMessage: text,
        botName: ai.bot_name || ws?.greeting_title || 'Support Agent',
        providerConfig: null,
        systemPrompt: ai.system_prompt || null,
        history: [],
        turns: [],
        helpCenterUrl: null,
        workspaceName: ws?.name,
        businessHours: ws?.business_hours || null,
        cannedGreeting: ai.greeting_message || null,
        answerMode: ai.answer_mode === 'strict' ? 'strict' : 'agent',
        subAgents: ai.sub_agents ?? null,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The bot took longer than 40 seconds.')), 40_000)),
    ]);
    return {
      replyText: result.replyText || null,
      handedOver: Boolean(result.shouldHandover),
      handoverReason: result.handoverReason || null,
      intent: (result.intent as string) || null,
      subAgent: (result.subAgent as string) || null,
      ms: Date.now() - started,
    };
  } catch (e) {
    console.error('[Bot Health] Test question failed:', e);
    return {
      replyText: null,
      handedOver: false,
      handoverReason: null,
      intent: null,
      subAgent: null,
      ms: Date.now() - started,
      error: String((e as Error)?.message || e).slice(0, 300),
    };
  }
}

/**
 * Switches the bot back on in every open conversation where it is off.
 * Through the member's own session so RLS and the bot-control triggers
 * decide, as they would for the per-conversation toggle in the inbox.
 */
export async function resumeBotEverywhereAction(workspaceId: string): Promise<{ resumed: number }> {
  const access = await getWorkspaceAccess(workspaceId, 'edit_ticket').catch((e) => {
    throw userError((e as Error)?.message || 'Only agents and admins can do this.');
  });
  const { data, error } = await access.supabase
    .from('conversations')
    .update({ ai_mode: 'autopilot' })
    .eq('workspace_id', workspaceId)
    .eq('ai_mode', 'disabled')
    .neq('status', 'closed')
    .select('id');
  if (error) {
    console.error('[Bot Health] Could not turn the bot back on:', error.message);
    throw userError('Could not turn the bot back on. Try again.');
  }
  return { resumed: data?.length || 0 };
}
