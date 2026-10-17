import { serviceClient } from '@/lib/supabase/service';
import { getWorkspaceEffectivePlan } from '@/lib/plans/enforce';
import { chat, ChatRequest, ChatResult, ProviderConfig } from './provider';
import { autoAssignConversation } from '@/lib/team/auto-assign';
import { userError } from '@/lib/errors/user-error';

export interface ExecuteAiReplyParams {
  workspaceId: string;
  conversationId?: string | null;
  request: ChatRequest;
  channel?: string | null;
  visitorName?: string | null;
  providerConfig?: ProviderConfig | null;
}

export type AiUnavailableReason =
  | 'plan_inactive'
  | 'ai_disabled_in_plan'
  | 'limit_reached'
  | 'platform_ai_disabled'
  | 'provider_error';

export interface ExecuteAiReplyResult {
  ok: boolean;
  text: string | null;
  handoverTriggered: boolean;
  unavailableReason?: AiUnavailableReason;
  handoverMessage?: string;
  repliesUsed?: number;
  limit?: number | null;
  tokensIn?: number;
  tokensOut?: number;
}

export const FRIENDLY_HANDOVER_MESSAGE =
  "I'm connecting you with a member of our team who will assist you shortly.";

/**
 * Loads the platform AI settings securely on the server.
 * Never leaks the API key to client bundles or logs.
 */
export async function getPlatformAiConfigServerOnly(): Promise<{
  isEnabled: boolean;
  config: ProviderConfig | null;
  model: string | null;
}> {
  const adminClient = serviceClient();
  const { data: settings, error } = await adminClient
    .from('platform_ai_settings')
    .select('provider, base_url, model, api_key, is_enabled')
    .eq('id', true)
    .maybeSingle();

  if (error || !settings || !settings.is_enabled || !settings.api_key) {
    return { isEnabled: false, config: null, model: settings?.model || null };
  }

  const config: ProviderConfig = {
    provider: (settings.provider as ProviderConfig['provider']) || 'anthropic',
    model: settings.model || null,
    apiKey: settings.api_key.trim(),
    baseUrl: settings.base_url?.trim() || null,
  };

  return {
    isEnabled: true,
    config,
    model: settings.model || null,
  };
}

/**
 * Safely hands over the conversation to a human agent when AI is unavailable.
 * Guarantees that customers never see raw stack traces, API keys, or provider errors.
 */
async function handoverToHuman(
  workspaceId: string,
  conversationId?: string | null,
  reason?: string
): Promise<void> {
  if (!conversationId) return;

  try {
    const adminClient = serviceClient();
    if (reason) {
      console.info(`[Platform AI Gateway] Handover initiated for conversation ${conversationId}: ${reason}`);
    }

    // 1. Mark conversation as ai_mode = 'disabled', status = 'open'
    await adminClient
      .from('conversations')
      .update({
        ai_mode: 'disabled',
        status: 'open',
      })
      .eq('id', conversationId);

    // 2. Trigger auto-assignment so available human agent picks it up
    try {
      await autoAssignConversation(adminClient, conversationId);
    } catch (assignErr) {
      console.warn('[Platform AI Gateway] Auto-assignment skipped during handover:', assignErr);
    }
  } catch (err) {
    console.error('[Platform AI Gateway] Handover execution error:', err);
  }
}

/**
 * Atomic increment of workspace monthly AI usage.
 * Uses the PostgreSQL function `fn_increment_workspace_ai_usage` (safe under concurrent requests).
 */
async function incrementUsageAtomically(
  workspaceId: string,
  periodStart: string,
  replies = 1,
  tokensIn = 0,
  tokensOut = 0
): Promise<number> {
  const adminClient = serviceClient();

  try {
    const { data, error } = await adminClient.rpc('fn_increment_workspace_ai_usage', {
      p_workspace_id: workspaceId,
      p_period_start: periodStart,
      p_replies: replies,
      p_tokens_in: tokensIn,
      p_tokens_out: tokensOut,
    });

    if (!error && data && typeof data.replies_used === 'number') {
      return data.replies_used;
    }
  } catch (rpcErr) {
    console.warn('[Platform AI Gateway] RPC increment failed, trying atomic upsert fallback:', rpcErr);
  }

  // Fallback atomic upsert if RPC is temporarily unavailable
  const { data: fallbackRow } = await adminClient
    .from('workspace_ai_usage')
    .select('replies_used, tokens_in, tokens_out')
    .eq('workspace_id', workspaceId)
    .eq('period_start', periodStart)
    .maybeSingle();

  const currentReplies = fallbackRow?.replies_used || 0;
  const currentTokensIn = (fallbackRow as any)?.tokens_in || 0;
  const currentTokensOut = (fallbackRow as any)?.tokens_out || 0;
  const newReplies = currentReplies + replies;

  await adminClient.from('workspace_ai_usage').upsert(
    {
      workspace_id: workspaceId,
      period_start: periodStart,
      replies_used: newReplies,
      tokens_in: currentTokensIn + tokensIn,
      tokens_out: currentTokensOut + tokensOut,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id, period_start' }
  );

  return newReplies;
}

/**
 * SINGLE SERVER FUNCTION that every AI reply goes through:
 * 1. Load workspace's active plan. If inactive or ai_enabled is false, do not call model.
 * 2. Check this month's usage against ai_monthly_reply_limit. If limit reached, do not call model.
 * 3. Load the key from platform_ai_settings (server only) and call the model.
 * 4. On success, increment usage atomically (Postgres function safe under concurrent requests).
 * 5. If AI is unavailable for any reason (disabled, limit reached, provider error), hand conversation
 *    to a human agent and never show a raw error to the end customer.
 */
export async function executePlatformAiReply(
  params: ExecuteAiReplyParams
): Promise<ExecuteAiReplyResult> {
  const { workspaceId, conversationId, request } = params;

  // 1. Load workspace's active plan
  const effective = await getWorkspaceEffectivePlan(workspaceId);
  const plan = effective.plan;

  // If plan is inactive (canceled, suspended, expired trial)
  if (
    effective.status === 'canceled' ||
    effective.status === 'suspended' ||
    effective.isTrialExpired
  ) {
    await handoverToHuman(workspaceId, conversationId, 'plan_inactive');
    return {
      ok: false,
      text: null,
      handoverTriggered: true,
      unavailableReason: 'plan_inactive',
      handoverMessage: FRIENDLY_HANDOVER_MESSAGE,
    };
  }

  // If plan has AI disabled
  if (plan.ai_enabled === false) {
    await handoverToHuman(workspaceId, conversationId, 'ai_disabled_in_plan');
    return {
      ok: false,
      text: null,
      handoverTriggered: true,
      unavailableReason: 'ai_disabled_in_plan',
      handoverMessage: FRIENDLY_HANDOVER_MESSAGE,
    };
  }

  // 2. Check this month's usage against ai_monthly_reply_limit
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .split('T')[0];

  const adminClient = serviceClient();
  const { data: usageRow } = await adminClient
    .from('workspace_ai_usage')
    .select('replies_used')
    .eq('workspace_id', workspaceId)
    .eq('period_start', periodStart)
    .maybeSingle();

  const repliesUsed = usageRow?.replies_used ?? 0;
  const replyLimit = plan.ai_monthly_reply_limit;

  if (replyLimit !== null && replyLimit !== undefined && repliesUsed >= replyLimit) {
    await handoverToHuman(workspaceId, conversationId, 'limit_reached');
    return {
      ok: false,
      text: null,
      handoverTriggered: true,
      unavailableReason: 'limit_reached',
      handoverMessage: FRIENDLY_HANDOVER_MESSAGE,
      repliesUsed,
      limit: replyLimit,
    };
  }

  // 3. Load key from platform_ai_settings (server only) and call model
  const platform = await getPlatformAiConfigServerOnly();
  const activeConfig = params.providerConfig || (platform.isEnabled ? platform.config : null);
  if (!activeConfig || !activeConfig.apiKey) {
    return {
      ok: false,
      text: null,
      handoverTriggered: false,
      unavailableReason: 'platform_ai_disabled',
      handoverMessage: FRIENDLY_HANDOVER_MESSAGE,
      repliesUsed,
      limit: replyLimit,
    };
  }

  let chatResult: ChatResult;
  try {
    chatResult = await chat(activeConfig, request);
    if (!chatResult || !chatResult.text || !chatResult.text.trim()) {
      throw userError('Empty reply received from model provider.');
    }
  } catch (providerErr: unknown) {
    const errMessage = providerErr instanceof Error ? providerErr.message : String(providerErr);
    console.warn(
      `[Platform AI Gateway] Model call failed for workspace ${workspaceId}: ${errMessage || 'Unknown error'}`
    );
    return {
      ok: false,
      text: null,
      handoverTriggered: false,
      unavailableReason: 'provider_error',
      handoverMessage: FRIENDLY_HANDOVER_MESSAGE,
      repliesUsed,
      limit: replyLimit,
    };
  }

  // 4. On success, increment usage atomically
  const tokensIn = chatResult.tokensIn || 0;
  const tokensOut = chatResult.tokensOut || 0;
  const newRepliesUsed = await incrementUsageAtomically(workspaceId, periodStart, 1, tokensIn, tokensOut);

  return {
    ok: true,
    text: chatResult.text.trim(),
    handoverTriggered: false,
    repliesUsed: newRepliesUsed,
    limit: replyLimit,
    tokensIn,
    tokensOut,
  };
}
