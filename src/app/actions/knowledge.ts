'use server';

import { invalidateHelpIndex } from '@/lib/ai/help-answer';
import { serviceClient } from '@/lib/supabase/service';
import { getWorkspaceEffectivePlan } from '@/lib/plans/enforce';
import { getWorkspaceAccess } from '@/lib/team/access';
import type { Capability } from '@/lib/team/permissions';
import { userError } from '@/lib/errors/user-error';

/**
 * Internal team knowledge, and the questions the help centre could not answer.
 *
 * Both sit behind the same tenancy check as the rest of the dashboard. Notes in
 * particular are private by design — the whole point of the feature is that
 * they are not published — so nothing here is reachable without a workspace
 * agent's session.
 */

export interface KnowledgeNote {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
  tags: string[];
  visibility: 'agent_only' | 'assistant';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UnansweredQuestion {
  id: string;
  question: string;
  reason: string | null;
  times_asked: number;
  status: 'open' | 'answered' | 'ignored';
  last_conversation_id: string | null;
  first_asked_at: string;
  last_asked_at: string;
  embedding?: number[] | null;
}

async function assertAgent(workspaceId: string, capability: Capability) {
  const { supabase, user } = await getWorkspaceAccess(workspaceId, capability);
  return { supabase, agentId: user.id };
}

/* ── Notes ────────────────────────────────────────────────────────────── */

export async function listKnowledgeNotesAction(
  workspaceId: string
): Promise<KnowledgeNote[]> {
  const { supabase } = await assertAgent(workspaceId, 'view');
  const { data, error } = await supabase
    .from('knowledge_notes')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false });

  if (error) throw userError(error.message);
  return (data as KnowledgeNote[]) || [];
}

export async function saveKnowledgeNoteAction(
  workspaceId: string,
  note: {
    id?: string;
    title: string;
    content: string;
    tags?: string[];
    visibility?: 'agent_only' | 'assistant';
  }
): Promise<KnowledgeNote> {
  const { supabase, agentId } = await assertAgent(workspaceId, 'edit_content');

  const title = note.title.trim();
  if (!title) throw userError('Give the note a title.');

  const payload = {
    workspace_id: workspaceId,
    title,
    content: note.content ?? '',
    tags: (note.tags || []).map((t) => t.trim()).filter(Boolean),
    visibility: note.visibility || 'agent_only',
    updated_at: new Date().toISOString(),
  };

  const query = note.id
    ? supabase
        .from('knowledge_notes')
        .update(payload)
        .eq('id', note.id)
        .eq('workspace_id', workspaceId)
    : supabase
        .from('knowledge_notes')
        .insert({ ...payload, created_by: agentId });

  const { data, error } = await query.select().single();
  if (error) throw userError(error.message);

  // The assistant caches the index for a minute; a note the team just changed
  // should take effect on the next message, not the next minute.
  invalidateHelpIndex(workspaceId);
  return data as KnowledgeNote;
}

export async function deleteKnowledgeNoteAction(
  workspaceId: string,
  noteId: string
): Promise<void> {
  const { supabase } = await assertAgent(workspaceId, 'edit_content');
  const { error } = await supabase
    .from('knowledge_notes')
    .delete()
    .eq('id', noteId)
    .eq('workspace_id', workspaceId);

  if (error) throw userError(error.message);
  invalidateHelpIndex(workspaceId);
}

/* ── Gaps ─────────────────────────────────────────────────────────────── */

export async function listUnansweredQuestionsAction(
  workspaceId: string,
  status: 'open' | 'answered' | 'ignored' | 'all' = 'open'
): Promise<UnansweredQuestion[]> {
  const { supabase } = await assertAgent(workspaceId, 'view');

  let query = supabase
    .from('unanswered_questions')
    .select('*')
    .eq('workspace_id', workspaceId)
    // Most-asked first: the biggest gap is the one to write about next.
    .order('times_asked', { ascending: false })
    .order('last_asked_at', { ascending: false })
    .limit(200);

  if (status !== 'all') query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw userError(error.message);
  return (data as UnansweredQuestion[]) || [];
}

export async function updateUnansweredStatusAction(
  workspaceId: string,
  id: string,
  status: 'open' | 'answered' | 'ignored',
  resolved?: { articleId?: string; noteId?: string }
): Promise<void> {
  const { supabase } = await assertAgent(workspaceId, 'edit_content');
  const { error } = await supabase
    .from('unanswered_questions')
    .update({
      status,
      resolved_article_id: resolved?.articleId ?? null,
      resolved_note_id: resolved?.noteId ?? null,
    })
    .eq('id', id)
    .eq('workspace_id', workspaceId);

  if (error) throw userError(error.message);
}

/* ── Model provider ───────────────────────────────────────────────────── */

/* ── Workspace Plan AI Usage ─────────────────────────────────────────────── */

export interface WorkspaceAiPlanAndUsage {
  planName: string;
  aiEnabled: boolean;
  repliesUsed: number;
  monthlyLimit: number | null;
  isLimitReached: boolean;
  percentage: number;
  percentUsed: number;
  periodStart: string;
}

/**
 * Retrieves the workspace's plan AI inclusion status and current monthly usage.
 * Accessible to all authorized workspace agents to render the read-only AI card.
 */
export async function getWorkspaceAiPlanAndUsageAction(
  workspaceId: string
): Promise<WorkspaceAiPlanAndUsage> {
  await assertAgent(workspaceId, 'view');
  const effective = await getWorkspaceEffectivePlan(workspaceId);

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
  const aiEnabled = effective?.plan?.ai_enabled ?? true;
  const monthlyLimit = effective?.plan?.ai_monthly_reply_limit ?? null;
  const isLimitReached = monthlyLimit !== null && repliesUsed >= monthlyLimit;
  const percentage =
    monthlyLimit !== null && monthlyLimit > 0
      ? Math.min(100, Math.round((repliesUsed / monthlyLimit) * 100))
      : 0;

  return {
    planName: effective?.plan?.name || 'Legacy (Unlimited)',
    aiEnabled,
    repliesUsed,
    monthlyLimit,
    isLimitReached,
    percentage,
    percentUsed: percentage,
    periodStart,
  };
}
