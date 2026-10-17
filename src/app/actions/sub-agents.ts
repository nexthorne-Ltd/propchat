'use server';

/**
 * Settings → AI bot → Sub-agents: the prop-firm specialists of agent mode
 * (src/lib/ai/sub-agents.ts). The definitions live in code; what a workspace
 * changes is stored in ai_settings: answer_mode, and per specialist whether it
 * is on and its extra instructions. Admins only (manage_settings), like the
 * rest of the AI settings, and refused when the platform locked ai_settings.
 */
import { assertAdminUser } from '@/app/actions/admin';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { assertSettingNotLocked } from '@/lib/settings/precedence';
import { errorMessage } from '@/lib/errors/user-error';
import {
  isSubAgentId,
  SUB_AGENT_BY_ID,
  SUB_AGENT_INSTRUCTIONS_MAX,
  SUB_AGENTS,
  type SubAgentId,
  type SubAgentSettings,
} from '@/lib/ai/sub-agents';

export interface SubAgentConfig {
  answerMode: 'agent' | 'strict';
  subAgents: SubAgentSettings;
}

/** Last 30 days per specialist; null when the numbers could not be read. */
export type SubAgentStats = Partial<Record<SubAgentId, { replies: number; handovers: number }>> | null;

type Result<T> = ({ success: true } & T) | { success: false; error: string };

function toConfig(ai: Record<string, unknown> | null | undefined): SubAgentConfig {
  const raw = (ai?.sub_agents && typeof ai.sub_agents === 'object' ? ai.sub_agents : {}) as Record<string, unknown>;
  const subAgents: SubAgentSettings = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isSubAgentId(id) || !value || typeof value !== 'object') continue;
    const v = value as { enabled?: unknown; instructions?: unknown };
    subAgents[id] = {
      enabled: v.enabled !== false,
      instructions: typeof v.instructions === 'string' ? v.instructions : '',
    };
  }
  return { answerMode: ai?.answer_mode === 'strict' ? 'strict' : 'agent', subAgents };
}

/**
 * Replies (from the label on each bot message) and handovers (from the bot's
 * decision log) per specialist. Service role after the admin check, filtered
 * to this workspace; any failure only hides the numbers.
 */
async function loadStats(workspaceId: string): Promise<SubAgentStats> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const db = serviceClient();
    const [replies, handovers] = await Promise.all([
      db
        .from('messages')
        .select('sub_agent:metadata->>sub_agent, conversations!inner(workspace_id)')
        .eq('conversations.workspace_id', workspaceId)
        .eq('sender_type', 'ai')
        .gte('created_at', since)
        .not('metadata->>sub_agent', 'is', null)
        .limit(10_000),
      db
        .from('ai_reply_events')
        .select('sub_agent:detail->>sub_agent')
        .eq('workspace_id', workspaceId)
        .eq('event', 'handover')
        .gte('created_at', since)
        .not('detail->>sub_agent', 'is', null)
        .limit(10_000),
    ]);
    if (replies.error || handovers.error) {
      console.warn('[Sub-agents] Stats unavailable:', replies.error?.message || handovers.error?.message);
      return null;
    }
    const stats: NonNullable<SubAgentStats> = {};
    const bump = (id: unknown, key: 'replies' | 'handovers') => {
      if (!isSubAgentId(id)) return;
      stats[id] = stats[id] || { replies: 0, handovers: 0 };
      stats[id]![key] += 1;
    };
    for (const r of (replies.data || []) as { sub_agent?: unknown }[]) bump(r.sub_agent, 'replies');
    for (const r of (handovers.data || []) as { sub_agent?: unknown }[]) bump(r.sub_agent, 'handovers');
    return stats;
  } catch (err) {
    console.warn('[Sub-agents] Stats unavailable:', (err as Error)?.message);
    return null;
  }
}

export async function getSubAgentConfigAction(
  workspaceId: string
): Promise<Result<{ config: SubAgentConfig; stats: SubAgentStats }>> {
  try {
    await assertAdminUser(workspaceId);
    const supabase = await createClient();
    const { data, error } = await supabase.from('workspaces').select('ai_settings').eq('id', workspaceId).maybeSingle();
    if (error) {
      console.error('[Sub-agents] Load failed:', error.message);
      return { success: false, error: 'Could not load the sub-agent settings.' };
    }
    return { success: true, config: toConfig(data?.ai_settings as Record<string, unknown> | null), stats: await loadStats(workspaceId) };
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Could not load the sub-agent settings.') };
  }
}

export async function saveSubAgentConfigAction(
  workspaceId: string,
  input: SubAgentConfig
): Promise<Result<{ config: SubAgentConfig; stats: SubAgentStats }>> {
  try {
    await assertSettingNotLocked(workspaceId, 'ai_settings');
    await assertAdminUser(workspaceId);

    const clean: Record<string, { enabled: boolean; instructions: string }> = {};
    for (const def of SUB_AGENTS) {
      const v = input.subAgents?.[def.id];
      const instructions = (v?.instructions || '').trim();
      if (instructions.length > SUB_AGENT_INSTRUCTIONS_MAX) {
        return {
          success: false,
          error: `Instructions for ${SUB_AGENT_BY_ID[def.id].name} can be at most ${SUB_AGENT_INSTRUCTIONS_MAX} characters.`,
        };
      }
      clean[def.id] = { enabled: def.canDisable ? v?.enabled !== false : true, instructions };
    }

    const supabase = await createClient();
    const { data: existing, error: readError } = await supabase
      .from('workspaces')
      .select('ai_settings')
      .eq('id', workspaceId)
      .maybeSingle();
    if (readError) {
      console.error('[Sub-agents] Read before save failed:', readError.message);
      return { success: false, error: 'Could not save the sub-agent settings.' };
    }
    const ai = { ...((existing?.ai_settings as Record<string, unknown>) || {}) };
    ai.answer_mode = input.answerMode === 'strict' ? 'strict' : 'agent';
    ai.sub_agents = clean;

    const { data: updated, error } = await supabase
      .from('workspaces')
      .update({ ai_settings: ai })
      .eq('id', workspaceId)
      .select('ai_settings')
      .maybeSingle();
    if (error || !updated) {
      console.error('[Sub-agents] Save failed:', error?.message || 'no row updated');
      return { success: false, error: 'Could not save the sub-agent settings.' };
    }
    return { success: true, config: toConfig(updated.ai_settings as Record<string, unknown>), stats: await loadStats(workspaceId) };
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Could not save the sub-agent settings.') };
  }
}
