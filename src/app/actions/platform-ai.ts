'use server';

import { serviceClient } from '@/lib/supabase/service';
import { assertSuperAdmin, recordSuperAdminAudit } from '@/app/actions/platform';
import { testProvider, ProviderConfig, ProviderId, DEFAULT_MODELS } from '@/lib/ai/provider';
import { PlatformAiSettingsDTO } from '@/types/platform-management';
import { userError } from '@/lib/errors/user-error';

export interface WorkspaceAiUsageItem {
  workspaceId: string;
  workspaceName: string;
  planName: string;
  planSlug: string;
  aiEnabled: boolean;
  repliesUsed: number;
  tokensIn: number;
  tokensOut: number;
  avgTokensPerReply: number;
  monthlyLimit: number | null; // null = unlimited
  percentage: number;
  status: 'normal' | 'near_limit' | 'limit_reached' | 'disabled';
}

export interface PlatformAiUsageOverview {
  currentPeriodStart: string;
  platformTotalReplies: number;
  platformTotalTokensIn: number;
  platformTotalTokensOut: number;
  platformAverageTokensPerReply: number;
  workspacesWithAi: number;
  workspacesNearOrAtLimit: number;
  workspaceBreakdown: WorkspaceAiUsageItem[];
}

/**
 * 1. Retrieves platform AI settings for Super Admin UI.
 * WRITE-ONLY: Only the last 4 characters of the API key are exposed. Full key is NEVER sent.
 */
export async function getPlatformAiSettingsAction(): Promise<{
  success: boolean;
  settings: PlatformAiSettingsDTO;
}> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data, error } = await adminClient
    .from('platform_ai_settings')
    .select('provider, base_url, model, api_key, is_enabled, updated_at')
    .eq('id', true)
    .maybeSingle();

  if (error) {
    throw userError(`Failed to load platform AI settings: ${error.message}`);
  }

  const rawKey = data?.api_key || '';
  const keyLast4 = rawKey ? rawKey.slice(-4) : null;

  return {
    success: true,
    settings: {
      provider: (data?.provider as ProviderId) || 'anthropic',
      base_url: data?.base_url || null,
      model: data?.model || null,
      is_enabled: Boolean(data?.is_enabled),
      has_key: Boolean(rawKey),
      key_last4: keyLast4,
      updated_at: data?.updated_at || new Date().toISOString(),
    },
  };
}

/**
 * 2. Saves platform AI settings (Super Admin).
 * If api_key is left blank or omitted, the previously saved key is preserved.
 */
export async function savePlatformAiSettingsAction(input: {
  provider: ProviderId;
  base_url?: string | null;
  model?: string | null;
  api_key?: string | null;
  is_enabled: boolean;
}): Promise<{
  success: boolean;
  settings?: PlatformAiSettingsDTO;
  error?: string;
}> {
  const { user, agent } = await assertSuperAdmin();
  const adminClient = serviceClient();

  try {
    const { data: existing } = await adminClient
      .from('platform_ai_settings')
      .select('api_key')
      .eq('id', true)
      .maybeSingle();

    const cleanedKey = input.api_key && input.api_key.trim() ? input.api_key.trim() : null;
    const finalApiKey = cleanedKey !== null ? cleanedKey : (existing?.api_key || null);

    const updatePayload = {
      provider: input.provider,
      base_url: input.base_url?.trim() || null,
      model: input.model?.trim() || null,
      api_key: finalApiKey,
      is_enabled: Boolean(input.is_enabled),
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    };

    const { data: updated, error } = await adminClient
      .from('platform_ai_settings')
      .upsert({ id: true, ...updatePayload }, { onConflict: 'id' })
      .select()
      .single();

    if (error) throw error;

    await recordSuperAdminAudit({
      admin: agent,
      action: 'platform_ai_settings_updated',
      details: {
        provider: input.provider,
        model: input.model,
        is_enabled: input.is_enabled,
        key_updated: cleanedKey !== null,
      },
    });

    const keyLast4 = finalApiKey ? finalApiKey.slice(-4) : null;

    return {
      success: true,
      settings: {
        provider: updated.provider,
        base_url: updated.base_url,
        model: updated.model,
        is_enabled: updated.is_enabled,
        has_key: Boolean(finalApiKey),
        key_last4: keyLast4,
        updated_at: updated.updated_at,
      },
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg || 'Failed to save platform AI settings.' };
  }
}

/**
 * 3. Tests platform AI model connection (Super Admin).
 * Makes a small server-side test call and returns success or error.
 */
export async function testPlatformAiConnectionAction(override?: {
  provider?: ProviderId;
  base_url?: string | null;
  model?: string | null;
  api_key?: string | null;
}): Promise<{
  ok: boolean;
  model?: string;
  error?: string;
}> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const { data: stored } = await adminClient
    .from('platform_ai_settings')
    .select('*')
    .eq('id', true)
    .maybeSingle();

  const provider = override?.provider || stored?.provider || 'anthropic';
  const apiKey = override?.api_key && override.api_key.trim()
    ? override.api_key.trim()
    : stored?.api_key || null;

  if (!apiKey) {
    return { ok: false, error: 'No API key provided or saved. Please enter a key first.' };
  }

  const model = override?.model?.trim() || stored?.model?.trim() || DEFAULT_MODELS[provider as ProviderId] || null;
  const baseUrl = override?.base_url?.trim() || stored?.base_url?.trim() || null;

  const config: ProviderConfig = {
    provider: provider as ProviderId,
    model,
    apiKey,
    baseUrl,
  };

  try {
    const result = await testProvider(config);
    return result;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errorMsg || 'Connection test failed.' };
  }
}

/**
 * 4. Retrieves Platform & Per-Workspace AI Usage Overview (Super Admin).
 * Calculates replies used this month vs. plan limit, plus a platform total.
 */
export async function getPlatformAiUsageAction(): Promise<{
  success: boolean;
  overview: PlatformAiUsageOverview;
}> {
  await assertSuperAdmin();
  const adminClient = serviceClient();

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .split('T')[0];

  // 1. Fetch all workspaces with subscriptions and plans
  const [{ data: workspaces }, { data: plans }, { data: subscriptions }, { data: usageRows }] =
    await Promise.all([
      adminClient.from('workspaces').select('id, name, is_suspended').order('name', { ascending: true }),
      adminClient.from('platform_plans').select('id, slug, name, ai_enabled, ai_monthly_reply_limit'),
      adminClient.from('workspace_subscriptions').select('workspace_id, plan_id, status'),
      adminClient.from('workspace_ai_usage').select('*').eq('period_start', periodStart),
    ]);

  const planMap = new Map((plans || []).map((p) => [p.id, p]));
  const subMap = new Map((subscriptions || []).map((s) => [s.workspace_id, s]));
  const usageMap = new Map((usageRows || []).map((u) => [u.workspace_id, u]));

  let platformTotalReplies = 0;
  let platformTotalTokensIn = 0;
  let platformTotalTokensOut = 0;
  let workspacesWithAi = 0;
  let workspacesNearOrAtLimit = 0;

  const workspaceBreakdown: WorkspaceAiUsageItem[] = (workspaces || []).map((ws) => {
    const sub = subMap.get(ws.id);
    const plan = sub ? planMap.get(sub.plan_id) : (plans || []).find((p) => p.slug === 'legacy') || plans?.[0];
    const usage = usageMap.get(ws.id);

    const repliesUsed = usage?.replies_used || 0;
    const tokensIn = usage?.tokens_in || 0;
    const tokensOut = usage?.tokens_out || 0;
    const totalTokens = tokensIn + tokensOut;
    const avgTokensPerReply = repliesUsed > 0 ? Math.round(totalTokens / repliesUsed) : 0;

    platformTotalReplies += repliesUsed;
    platformTotalTokensIn += tokensIn;
    platformTotalTokensOut += tokensOut;

    const aiEnabled = plan?.ai_enabled ?? true;
    if (aiEnabled) workspacesWithAi++;

    const monthlyLimit = plan?.ai_monthly_reply_limit ?? null;

    let percentage = 0;
    let status: WorkspaceAiUsageItem['status'] = 'normal';

    if (!aiEnabled || ws.is_suspended || sub?.status === 'suspended' || sub?.status === 'canceled') {
      status = 'disabled';
    } else if (monthlyLimit !== null && monthlyLimit > 0) {
      percentage = Math.min(100, Math.round((repliesUsed / monthlyLimit) * 100));
      if (repliesUsed >= monthlyLimit) {
        status = 'limit_reached';
        workspacesNearOrAtLimit++;
      } else if (percentage >= 80) {
        status = 'near_limit';
        workspacesNearOrAtLimit++;
      }
    }

    return {
      workspaceId: ws.id,
      workspaceName: ws.name || 'Untitled Workspace',
      planName: plan?.name || 'Standard Plan',
      planSlug: plan?.slug || 'starter',
      aiEnabled,
      repliesUsed,
      tokensIn,
      tokensOut,
      avgTokensPerReply,
      monthlyLimit,
      percentage,
      status,
    };
  });

  const platformAverageTokensPerReply =
    platformTotalReplies > 0
      ? Math.round((platformTotalTokensIn + platformTotalTokensOut) / platformTotalReplies)
      : 0;

  return {
    success: true,
    overview: {
      currentPeriodStart: periodStart,
      platformTotalReplies,
      platformTotalTokensIn,
      platformTotalTokensOut,
      platformAverageTokensPerReply,
      workspacesWithAi,
      workspacesNearOrAtLimit,
      workspaceBreakdown,
    },
  };
}
