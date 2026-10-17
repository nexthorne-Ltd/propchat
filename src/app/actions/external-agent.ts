'use server';

/**
 * Settings → AI bot → LangGraph: the workspace's own agent endpoint.
 *
 * Written here, with the service role, after assertAdminUser; the API key is
 * write-only (the screen learns only whether one is set). "Test connection"
 * calls the endpoint from our server with the same safety checks as the real
 * calls, so it tests what the bot will actually do. See
 * src/lib/agent/external-agent.ts.
 */
import { assertAdminUser } from '@/app/actions/admin';
import { serviceClient } from '@/lib/supabase/service';
import { AgentCallError, callAgent, checkAgentUrl, loadExternalAgent } from '@/lib/agent/external-agent';

export interface ExternalAgentSettings {
  enabled: boolean;
  autoPilot: boolean;
  url: string;
  hasApiKey: boolean;
  systemPrompt: string;
}

type Result<T> = ({ success: true } & T) | { success: false; error: string };

export async function getExternalAgentSettingsAction(workspaceId: string): Promise<Result<{ settings: ExternalAgentSettings }>> {
  await assertAdminUser(workspaceId);
  const config = await loadExternalAgent(workspaceId);
  return {
    success: true,
    settings: {
      enabled: Boolean(config?.enabled && config.url),
      autoPilot: config?.autoPilot ?? true,
      url: config?.url || '',
      hasApiKey: Boolean(config?.apiKey),
      systemPrompt: config?.systemPrompt || '',
    },
  };
}

export async function saveExternalAgentSettingsAction(
  workspaceId: string,
  input: {
    enabled: boolean;
    autoPilot: boolean;
    url: string;
    systemPrompt: string;
    /** undefined keeps the saved key; null or '' removes it. */
    apiKey?: string | null;
  }
): Promise<Result<{ settings: ExternalAgentSettings }>> {
  await assertAdminUser(workspaceId);
  const url = (input.url || '').trim();
  if (input.enabled || url) {
    const checked = checkAgentUrl(url);
    if (!checked.ok) return { success: false, error: checked.reason };
  }
  if ((input.systemPrompt || '').length > 4000) return { success: false, error: 'The system prompt can be at most 4000 characters.' };
  if (typeof input.apiKey === 'string' && input.apiKey.length > 500) return { success: false, error: 'The API key is too long.' };

  const patch: Record<string, unknown> = {
    workspace_id: workspaceId,
    langgraph_enabled: Boolean(input.enabled && url),
    langgraph_auto_pilot: input.autoPilot,
    langgraph_webhook_url: url || null,
    langgraph_system_prompt: input.systemPrompt?.trim() || null,
    updated_at: new Date().toISOString(),
  };
  if (input.apiKey !== undefined) patch.langgraph_api_key = input.apiKey?.trim() || null;

  const { error } = await serviceClient().from('workspace_integrations').upsert(patch, { onConflict: 'workspace_id' });
  if (error) {
    console.error('[External Agent] Save failed:', error.message);
    return { success: false, error: 'Could not save the agent settings.' };
  }
  return getExternalAgentSettingsAction(workspaceId);
}

/**
 * Sends the endpoint a test message. Uses the URL from the form (so it can be
 * checked before saving) and the key from the form, or the saved key when
 * the form leaves it untouched.
 */
export async function testExternalAgentAction(
  workspaceId: string,
  input: { url: string; apiKey?: string | null }
): Promise<Result<{ reply: string | null; action: string | null; latencyMs: number }>> {
  await assertAdminUser(workspaceId);
  const saved = await loadExternalAgent(workspaceId);
  const apiKey = input.apiKey === undefined ? saved?.apiKey ?? null : input.apiKey?.trim() || null;
  try {
    const { reply, latencyMs } = await callAgent(
      { url: input.url, apiKey },
      {
        event: 'test',
        version: 1,
        conversation_id: 'test',
        workspace_id: workspaceId,
        channel: 'test',
        visitor: { name: 'Zentry connection test' },
        current_message: 'This is a connection test from Zentry. Reply with any short message.',
        history: [],
        context: '',
        sources: [],
        system_prompt: null,
        language: 'en',
        human_context: null,
      },
      10_000
    );
    if (!reply) {
      return { success: false, error: `Connected in ${latencyMs} ms, but the answer had no "response" text. See the expected format below.` };
    }
    return { success: true, reply: reply.text || null, action: reply.action, latencyMs };
  } catch (err) {
    if (err instanceof AgentCallError) return { success: false, error: err.message };
    console.error('[External Agent] Test failed:', err);
    return { success: false, error: 'The test could not be run.' };
  }
}
