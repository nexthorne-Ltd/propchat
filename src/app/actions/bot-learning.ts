'use server';

/**
 * Settings → AI bot → Self-learning: what the bot has learned from the team's
 * answers, what waits for review, and the switches. Reads go through the
 * signed-in user's client (RLS: admins only); writes use the service role
 * after the capability check, because candidates and learned entries are
 * written only by the learner and these actions. See
 * src/lib/ai/learning/learner.ts.
 */
import { serviceClient } from '@/lib/supabase/service';
import { getWorkspaceAccess } from '@/lib/team/access';
import { approveCandidate, DEFAULT_LEARNING_SETTINGS, type LearningSettings } from '@/lib/ai/learning/learner';
import { forgetPolicyCache, POLICY_ARMS, type PolicyArm } from '@/lib/ai/learning/policy';
import { errorMessage } from '@/lib/errors/user-error';

export type CandidateFilter = 'review' | 'learned' | 'rejected';

export interface LearningCandidate {
  id: string;
  question: string;
  answer: string;
  status: 'pending_review' | 'approved' | 'auto_approved' | 'rejected' | 'stale';
  grounding: 'grounded' | 'new_fact' | 'contradicts' | 'unchecked';
  grounding_detail: Record<string, unknown>;
  occurrences: number;
  knowledge_id: string | null;
  reject_reason: string | null;
  reviewed_at: string | null;
  last_seen_at: string;
  created_at: string;
}

export interface PolicyArmStats {
  arm: PolicyArm;
  pulls: number;
  /** Posterior mean of the reward, 0–1. */
  score: number;
}

export interface LearningOverview {
  settings: LearningSettings;
  counts: Record<CandidateFilter, number>;
  arms: PolicyArmStats[];
}

type Result<T> = ({ success: true } & T) | { success: false; error: string };

const FILTER_STATUSES: Record<CandidateFilter, string[]> = {
  review: ['pending_review', 'stale'],
  learned: ['approved', 'auto_approved'],
  rejected: ['rejected'],
};

export async function getLearningOverviewAction(workspaceId: string): Promise<Result<{ overview: LearningOverview }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const [settingsRes, statusRes, armsRes] = await Promise.all([
      supabase
        .from('bot_learning_settings')
        .select('enabled, auto_approve, min_occurrences, adaptive_retrieval')
        .eq('workspace_id', workspaceId)
        .maybeSingle(),
      supabase.from('bot_learning_candidates').select('status').eq('workspace_id', workspaceId).limit(5000),
      supabase.from('bot_policy_arms').select('arm, alpha, beta, pulls').eq('workspace_id', workspaceId),
    ]);
    if (statusRes.error) return { success: false, error: statusRes.error.message };

    const s = settingsRes.data;
    const settings: LearningSettings = s
      ? {
          enabled: s.enabled !== false,
          autoApprove: s.auto_approve !== false,
          minOccurrences: Number(s.min_occurrences) || 3,
          adaptiveRetrieval: s.adaptive_retrieval !== false,
        }
      : DEFAULT_LEARNING_SETTINGS;

    const counts: Record<CandidateFilter, number> = { review: 0, learned: 0, rejected: 0 };
    for (const row of (statusRes.data as { status: string }[] | null) || []) {
      for (const f of Object.keys(FILTER_STATUSES) as CandidateFilter[]) {
        if (FILTER_STATUSES[f].includes(row.status)) counts[f]++;
      }
    }

    const byArm = new Map(((armsRes.data as { arm: PolicyArm; alpha: number; beta: number; pulls: number }[] | null) || []).map((a) => [a.arm, a]));
    const arms = (Object.keys(POLICY_ARMS) as PolicyArm[]).map((arm) => {
      const a = byArm.get(arm);
      return { arm, pulls: a?.pulls ?? 0, score: a ? a.alpha / (a.alpha + a.beta) : 0.5 };
    });
    return { success: true, overview: { settings, counts, arms } };
  } catch (e) {
    return { success: false, error: errorMessage(e) };
  }
}

export async function listLearningCandidatesAction(
  workspaceId: string,
  filter: CandidateFilter
): Promise<Result<{ candidates: LearningCandidate[] }>> {
  try {
    const { supabase } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const { data, error } = await supabase
      .from('bot_learning_candidates')
      .select('id, question, answer, status, grounding, grounding_detail, occurrences, knowledge_id, reject_reason, reviewed_at, last_seen_at, created_at')
      .eq('workspace_id', workspaceId)
      .in('status', FILTER_STATUSES[filter] ?? FILTER_STATUSES.review)
      .order('occurrences', { ascending: false })
      .order('last_seen_at', { ascending: false })
      .limit(200);
    if (error) return { success: false, error: error.message };
    return { success: true, candidates: (data as LearningCandidate[]) || [] };
  } catch (e) {
    return { success: false, error: errorMessage(e) };
  }
}

export async function saveLearningSettingsAction(
  workspaceId: string,
  input: LearningSettings
): Promise<Result<{ settings: LearningSettings }>> {
  try {
    const { user } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const minOccurrences = Math.round(Number(input.minOccurrences));
    if (!Number.isFinite(minOccurrences) || minOccurrences < 2 || minOccurrences > 20) {
      return { success: false, error: 'Times asked must be between 2 and 20.' };
    }
    const settings: LearningSettings = {
      enabled: Boolean(input.enabled),
      autoApprove: Boolean(input.autoApprove),
      minOccurrences,
      adaptiveRetrieval: Boolean(input.adaptiveRetrieval),
    };
    const { error } = await serviceClient().from('bot_learning_settings').upsert(
      {
        workspace_id: workspaceId,
        enabled: settings.enabled,
        auto_approve: settings.autoApprove,
        min_occurrences: settings.minOccurrences,
        adaptive_retrieval: settings.adaptiveRetrieval,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id' }
    );
    if (error) return { success: false, error: error.message };
    forgetPolicyCache(workspaceId);
    return { success: true, settings };
  } catch (e) {
    return { success: false, error: errorMessage(e) };
  }
}

export async function approveLearningCandidateAction(
  workspaceId: string,
  candidateId: string,
  edits: { question: string; answer: string }
): Promise<Result<{ embedded: boolean }>> {
  try {
    const { user } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const res = await approveCandidate(workspaceId, candidateId, {
      reviewerId: user.id,
      question: edits.question,
      answer: edits.answer,
    });
    if (!res.ok) return { success: false, error: res.error };
    return { success: true, embedded: res.embedded };
  } catch (e) {
    return { success: false, error: errorMessage(e) };
  }
}

/**
 * Rejects a suggestion, or takes a learned answer away from the bot. A
 * rejected question is remembered, so the same answer is not suggested again
 * the next time the team gives it.
 */
export async function rejectLearningCandidateAction(
  workspaceId: string,
  candidateId: string,
  reason?: string
): Promise<Result<object>> {
  try {
    const { user } = await getWorkspaceAccess(workspaceId, 'manage_settings');
    const service = serviceClient();
    const { data: c, error } = await service
      .from('bot_learning_candidates')
      .select('id, knowledge_id')
      .eq('id', candidateId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (error) return { success: false, error: error.message };
    if (!c) return { success: false, error: 'This suggestion no longer exists.' };

    const { error: updateError } = await service
      .from('bot_learning_candidates')
      .update({
        status: 'rejected',
        reject_reason: (reason || '').trim().slice(0, 200) || 'Rejected by a team member',
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        knowledge_id: null,
      })
      .eq('id', candidateId)
      .eq('workspace_id', workspaceId);
    if (updateError) return { success: false, error: updateError.message };

    if (c.knowledge_id) {
      const { error: deleteError } = await service
        .from('bot_knowledge')
        .delete()
        .eq('id', c.knowledge_id)
        .eq('workspace_id', workspaceId)
        .eq('origin', 'learned');
      if (deleteError) return { success: false, error: deleteError.message };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: errorMessage(e) };
  }
}
