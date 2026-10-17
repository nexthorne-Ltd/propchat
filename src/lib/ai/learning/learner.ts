import { serviceClient } from '@/lib/supabase/service';
import { chat, isConfigured, type ProviderConfig } from '@/lib/ai/provider';
import { getPlatformAiConfigServerOnly } from '@/lib/ai/platform-gateway';
import { generateEmbeddings, hybridSearchBotKnowledge, hybridSearchWorkspaceChunks } from '@/lib/ai/semantic-retrieval';
import { embedBotKnowledge } from '@/lib/ai/bot-knowledge';
import { jevGrounding, loadJevRuntime, type JevRuntime } from '@/lib/ai/jev';
import type { RetrievedChunk } from '@/types/database';
import {
  containsPersonalData,
  decideGrounding,
  knowledgeEntryFor,
  parseExtraction,
  parseJudgeVerdict,
  scoreOutcome,
  shouldAutoApprove,
  type ExtractedQa,
  type Grounding,
} from './safety';

/**
 * The learning loop described in supabase/migrations/20261119090000_bot_learning.sql,
 * run hourly by /api/cron/bot-learning. Every model call here is background
 * work: it uses the platform model directly (not the reply gateway, so it
 * does not count as a bot reply) and, with no model configured, nothing is
 * learned rather than something unchecked.
 */

type Service = ReturnType<typeof serviceClient>;

export interface LearningSettings {
  enabled: boolean;
  autoApprove: boolean;
  minOccurrences: number;
  adaptiveRetrieval: boolean;
}

export const DEFAULT_LEARNING_SETTINGS: LearningSettings = {
  enabled: true,
  autoApprove: true,
  minOccurrences: 3,
  adaptiveRetrieval: true,
};

export async function loadLearningSettings(workspaceId: string, supabase: Service = serviceClient()): Promise<LearningSettings> {
  const { data } = await supabase
    .from('bot_learning_settings')
    .select('enabled, auto_approve, min_occurrences, adaptive_retrieval')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!data) return DEFAULT_LEARNING_SETTINGS;
  return {
    enabled: data.enabled !== false,
    autoApprove: data.auto_approve !== false,
    minOccurrences: Number(data.min_occurrences) || 3,
    adaptiveRetrieval: data.adaptive_retrieval !== false,
  };
}

/* ── Model calls ──────────────────────────────────────────────────────── */

const EXTRACTION_PROMPT = `You turn a solved support conversation into one reusable answer for a support bot.
CUSTOMER QUESTION is what the bot could not answer. CONVERSATION is what happened next; only lines starting "AGENT:" are the support team.

Return JSON only, no prose:
{"usable": true or false, "reason": "short reason when not usable", "account_specific": true or false, "question": "...", "answer": "..."}

Rules:
- "question": the customer's question rewritten in English as a general question any customer could ask.
- "answer": what the AGENT said, in English, written so it is true for every customer. Use only what the agent stated: never add facts, steps, prices, timelines or links.
- usable=false when the agent did not actually answer (only asked for details, promised to check, or escalated), when the answer is unclear, or when it was a one-off exception.
- account_specific=true (and usable=false) when the answer depends on this customer's own account, order, payment or situation.
- Leave out names, emails, phone numbers, order or account numbers and anything else about this customer.
- Question under 25 words, answer under 120 words.`;

const JUDGE_PROMPT = `You check a support answer against help-center PASSAGES.
Reply with exactly one word:
SUPPORTED - every fact, number, rule and promise in the ANSWER is stated in the passages.
CONTRADICTS - a passage says something different from the ANSWER (another price, limit, rule or step).
NOT_COVERED - the passages do not say whether the ANSWER is true.`;

async function platformModel(): Promise<ProviderConfig | null> {
  const platform = await getPlatformAiConfigServerOnly().catch(() => null);
  return platform?.isEnabled && isConfigured(platform.config) ? platform.config : null;
}

async function extractQa(
  config: ProviderConfig,
  question: string,
  conversation: { sender_type: string; content: string | null }[],
  names: (string | null)[]
) {
  const lines: string[] = [];
  let budget = 6000;
  for (const m of conversation) {
    const line = `${m.sender_type === 'agent' ? 'AGENT' : 'CUSTOMER'}: ${(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 800)}`;
    if (budget - line.length < 0) break;
    budget -= line.length;
    lines.push(line);
  }
  const res = await chat(config, {
    system: EXTRACTION_PROMPT,
    messages: [{ role: 'user', content: `CUSTOMER QUESTION: ${question.slice(0, 800)}\n\nCONVERSATION:\n${lines.join('\n')}` }],
    maxTokens: 500,
    temperature: 0,
    reasoning: 'fast',
    timeoutMs: 20_000,
  });
  return parseExtraction(res.text || '', names);
}

/* ── Grounding ────────────────────────────────────────────────────────── */

interface GroundingRun {
  grounding: Grounding;
  detail: Record<string, unknown>;
  articleIds: string[];
  knowledgeIds: string[];
}

/** Per run: which Bot knowledge entries are learned, and so cannot vouch for anything. */
const learnedIdsCache = new Map<string, Promise<Set<string>>>();

function learnedIds(workspaceId: string): Promise<Set<string>> {
  let hit = learnedIdsCache.get(workspaceId);
  if (!hit) {
    hit = (async () => {
      const { data } = await serviceClient()
        .from('bot_knowledge')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('origin', 'learned');
      return new Set(((data as { id: string }[] | null) || []).map((r) => r.id));
    })();
    learnedIdsCache.set(workspaceId, hit);
  }
  return hit;
}

/**
 * Checks an answer against the workspace's published articles and the team's
 * own Bot knowledge. The ids of every passage looked at are kept, not only
 * the one that matched, so editing any article on the topic withdraws the
 * learned answer until it has been checked against the new text.
 */
export async function groundAnswer(
  workspaceId: string,
  qa: ExtractedQa,
  config: ProviderConfig,
  jev: JevRuntime | null
): Promise<GroundingRun> {
  const query = `${qa.question}\n${qa.answer}`;
  let embedding: number[] | null = null;
  try {
    embedding = (await generateEmbeddings([query], config))[0] || null;
  } catch {
    /* keyword search still runs */
  }
  const [articles, knowledge, learned] = await Promise.all([
    hybridSearchWorkspaceChunks({ workspaceId, queryText: qa.question, queryEmbedding: embedding, limit: 5 }),
    hybridSearchBotKnowledge({ workspaceId, queryText: qa.question, queryEmbedding: embedding, limit: 5 }),
    learnedIds(workspaceId),
  ]);
  const chunks: RetrievedChunk[] = [
    ...articles.map((c) => ({ ...c, source: 'article' as const })),
    ...knowledge.filter((c) => !learned.has(c.article_id)),
  ]
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, 5);

  const passages = chunks
    .map((c, i) => `[CHUNK ${i + 1}]\nArticle: ${c.article_title}\n\n${c.content}`)
    .join('\n\n---\n\n');
  const articleIds = [...new Set(chunks.filter((c) => c.source !== 'knowledge').map((c) => c.article_id))];
  const knowledgeIds = [...new Set(chunks.filter((c) => c.source === 'knowledge').map((c) => c.article_id))];

  if (!passages) {
    const result = decideGrounding({ judge: null, answer: qa.answer, question: qa.question, passages: '' });
    return { grounding: result.grounding, detail: { ...result.detail, passages: 0 }, articleIds, knowledgeIds };
  }

  const res = await chat(config, {
    system: JUDGE_PROMPT,
    messages: [{ role: 'user', content: `PASSAGES:\n${passages.slice(0, 9000)}\n\nQUESTION: ${qa.question}\nANSWER: ${qa.answer}` }],
    maxTokens: 10,
    temperature: 0,
    reasoning: 'fast',
    timeoutMs: 20_000,
  });
  const judge = parseJudgeVerdict(res.text || '');

  let jevSupported: number | null = null;
  if (jev?.settings.grounding) {
    try {
      jevSupported = (await jevGrounding(jev, { question: qa.question, answer: qa.answer, passages })).supported;
    } catch {
      /* Jev is a second opinion; without it the other checks still decide */
    }
  }

  const result = decideGrounding({
    judge,
    answer: qa.answer,
    question: qa.question,
    passages,
    jevSupported,
    jevThreshold: jev?.settings.minGrounding,
  });
  return { grounding: result.grounding, detail: { ...result.detail, passages: chunks.length }, articleIds, knowledgeIds };
}

/* ── Approval ─────────────────────────────────────────────────────────── */

export type ApproveResult = { ok: true; knowledgeId: string; embedded: boolean } | { ok: false; error: string };

/**
 * Turns a candidate into a learned Bot knowledge entry. The status is claimed
 * first, conditionally, so two runs (or a run and a reviewer) cannot create
 * the entry twice. A contradiction is never approved: if the article is the
 * part that is wrong, the article is what needs fixing.
 */
export async function approveCandidate(
  workspaceId: string,
  candidateId: string,
  opts: { auto?: boolean; reviewerId?: string | null; question?: string; answer?: string } = {}
): Promise<ApproveResult> {
  const supabase = serviceClient();
  const { data: c, error } = await supabase
    .from('bot_learning_candidates')
    .select('id, question, answer, status, grounding')
    .eq('id', candidateId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!c) return { ok: false, error: 'This suggestion no longer exists.' };
  if (c.grounding === 'contradicts') {
    return { ok: false, error: 'This answer contradicts your help center. If the article is out of date, update the article instead.' };
  }
  if (c.status === 'approved' || c.status === 'auto_approved') return { ok: false, error: 'Already approved.' };

  const qa: ExtractedQa = {
    question: (opts.question ?? c.question).replace(/\s+/g, ' ').trim(),
    answer: (opts.answer ?? c.answer).trim(),
  };
  if (qa.question.length < 3 || qa.question.length > 500) return { ok: false, error: 'The question must be 3–500 characters.' };
  if (qa.answer.length < 3 || qa.answer.length > 4000) return { ok: false, error: 'The answer must be 3–4000 characters.' };
  if (containsPersonalData(`${qa.question}\n${qa.answer}`)) {
    return { ok: false, error: 'Remove personal details (emails, phone, order or account numbers) first: every visitor would see them.' };
  }
  // A person who edits the answer has vouched for the new text; an automatic
  // approval only ever uses the text that was checked.
  const edited = qa.question !== c.question || qa.answer !== c.answer;
  if (opts.auto && edited) return { ok: false, error: 'Automatic approval cannot change the text.' };

  const status = opts.auto ? 'auto_approved' : 'approved';
  const { data: claimed, error: claimError } = await supabase
    .from('bot_learning_candidates')
    .update({
      status,
      question: qa.question,
      answer: qa.answer,
      reviewed_by: opts.auto ? null : opts.reviewerId ?? null,
      reviewed_at: new Date().toISOString(),
      reject_reason: null,
    })
    .eq('id', candidateId)
    .eq('workspace_id', workspaceId)
    .eq('status', c.status)
    .select('id');
  if (claimError) return { ok: false, error: claimError.message };
  if (!claimed?.length) return { ok: false, error: 'Someone else changed this suggestion. Refresh and try again.' };

  const entry = knowledgeEntryFor(qa);
  const { data: inserted, error: insertError } = await supabase
    .from('bot_knowledge')
    .insert({
      workspace_id: workspaceId,
      title: entry.title,
      content: entry.content,
      origin: 'learned',
      learning_candidate_id: candidateId,
      created_by: opts.auto ? null : opts.reviewerId ?? null,
      updated_by: opts.auto ? null : opts.reviewerId ?? null,
    })
    .select('id')
    .single();
  if (insertError || !inserted) {
    const { error: revertError } = await supabase
      .from('bot_learning_candidates')
      .update({ status: c.status, reviewed_by: null, reviewed_at: null })
      .eq('id', candidateId);
    if (revertError) console.error('[Bot Learning] Could not revert a failed approval:', revertError.message);
    return { ok: false, error: insertError?.message || 'Could not create the Bot knowledge entry.' };
  }

  const { error: linkError } = await supabase
    .from('bot_learning_candidates')
    .update({ knowledge_id: inserted.id })
    .eq('id', candidateId);
  if (linkError) console.error('[Bot Learning] Could not link the knowledge entry:', linkError.message);
  learnedIdsCache.delete(workspaceId);

  // Until it is embedded the entry is 'pending' and the bot does not use it;
  // a failed embedding shows in Help Center → Bot knowledge like any other.
  const embedded = await embedBotKnowledge(workspaceId, inserted.id).catch((err) => {
    console.error('[Bot Learning] Embedding failed:', err);
    return null;
  });
  return { ok: true, knowledgeId: inserted.id, embedded: embedded?.status === 'ready' };
}

async function maybeAutoApprove(workspaceId: string, candidateId: string, settings: LearningSettings): Promise<boolean> {
  const { data: c } = await serviceClient()
    .from('bot_learning_candidates')
    .select('status, grounding, occurrences')
    .eq('id', candidateId)
    .maybeSingle();
  if (!c || !shouldAutoApprove(c, settings)) return false;
  const res = await approveCandidate(workspaceId, candidateId, { auto: true });
  if (!res.ok) console.warn('[Bot Learning] Auto-approval skipped:', res.error);
  return res.ok;
}

/* ── Harvesting ───────────────────────────────────────────────────────── */

export interface HarvestSummary {
  scanned: number;
  candidates: number;
  repeats: number;
  autoApproved: number;
  skipped: Record<string, number>;
}

const LOOKBACK_DAYS = 14;
const MAX_CONVERSATION_IDS = 20;

/**
 * Looks at help-centre questions the bot handed over in the last two weeks
 * whose ticket a person has since solved. Exchanges that are not finished yet
 * are left for a later run; everything else is recorded in bot_learning_scans
 * with why it was or was not learned.
 */
export async function harvestCandidates({ limit = 15, deadline }: { limit?: number; deadline: number }): Promise<HarvestSummary> {
  const summary: HarvestSummary = { scanned: 0, candidates: 0, repeats: 0, autoApproved: 0, skipped: {} };
  const skip = (why: string) => (summary.skipped[why] = (summary.skipped[why] || 0) + 1);
  const config = await platformModel();
  if (!config) {
    skip('no_model');
    return summary;
  }
  const supabase = serviceClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const until = new Date(Date.now() - 30 * 60_000).toISOString();

  const { data: events, error } = await supabase
    .from('ai_reply_events')
    .select('workspace_id, conversation_id, visitor_message_id, created_at')
    .eq('event', 'handover')
    .eq('detail->>intent', 'help_center_question')
    .not('visitor_message_id', 'is', null)
    .gte('created_at', since)
    .lte('created_at', until)
    .order('created_at', { ascending: true })
    .limit(300);
  if (error) {
    console.error('[Bot Learning] Could not read handovers:', error.message);
    return summary;
  }
  const rows = (events as { workspace_id: string; conversation_id: string; visitor_message_id: string }[] | null) || [];
  if (!rows.length) return summary;

  const { data: scanned } = await supabase
    .from('bot_learning_scans')
    .select('visitor_message_id')
    .in('visitor_message_id', rows.map((r) => r.visitor_message_id));
  const done = new Set(((scanned as { visitor_message_id: string }[] | null) || []).map((s) => s.visitor_message_id));

  const settingsByWorkspace = new Map<string, LearningSettings>();
  const jev = await loadJevRuntime().catch(() => null);
  let processed = 0;

  for (const ev of rows) {
    if (processed >= limit || Date.now() > deadline) break;
    if (done.has(ev.visitor_message_id)) continue;
    done.add(ev.visitor_message_id);

    let settings = settingsByWorkspace.get(ev.workspace_id);
    if (!settings) {
      settings = await loadLearningSettings(ev.workspace_id, supabase);
      settingsByWorkspace.set(ev.workspace_id, settings);
    }
    // Not marked as scanned: if the workspace turns learning on, recent
    // exchanges are still there to learn from.
    if (!settings.enabled) {
      skip('learning_off');
      continue;
    }

    const mark = async (outcome: string, candidateId: string | null = null) => {
      const { error: markError } = await supabase.from('bot_learning_scans').upsert(
        {
          visitor_message_id: ev.visitor_message_id,
          workspace_id: ev.workspace_id,
          conversation_id: ev.conversation_id,
          outcome,
          candidate_id: candidateId,
        },
        { onConflict: 'visitor_message_id' }
      );
      if (markError) console.warn('[Bot Learning] Could not record scan:', markError.message);
      if (!candidateId) skip(outcome);
    };

    const outcome: LearnOutcome = await learnFromHandover(supabase, ev, settings, config, jev, deadline).catch(
      (err): LearnOutcome => {
        console.error('[Bot Learning] Exchange failed:', err);
        // Recorded, not retried: a failure that repeats would cost a model call
        // every hour for two weeks, and a common question comes up again anyway.
        return { kind: 'skip', why: 'error', usedModel: true };
      }
    );
    if (outcome.kind === 'wait') {
      skip('not_solved_yet');
      continue;
    }
    if (outcome.kind === 'skip') {
      if (outcome.retry) skip(outcome.why);
      else await mark(outcome.why);
      if (outcome.usedModel) processed++;
      continue;
    }
    processed++;
    summary.scanned++;
    await mark(outcome.kind, outcome.candidateId);
    if (outcome.kind === 'new_candidate') summary.candidates++;
    else summary.repeats++;
    if (outcome.autoApproved) summary.autoApproved++;
  }
  return summary;
}

type LearnOutcome =
  | { kind: 'wait' }
  | { kind: 'skip'; why: string; retry?: boolean; usedModel?: boolean }
  | { kind: 'new_candidate' | 'repeat'; candidateId: string; autoApproved: boolean };

async function learnFromHandover(
  supabase: Service,
  ev: { workspace_id: string; conversation_id: string; visitor_message_id: string },
  settings: LearningSettings,
  config: ProviderConfig,
  jev: JevRuntime | null,
  deadline: number
): Promise<LearnOutcome> {
  const { data: question } = await supabase
    .from('messages')
    .select('id, content, created_at, ticket_id, sender_type, conversation_id')
    .eq('id', ev.visitor_message_id)
    .maybeSingle();
  if (!question || question.sender_type !== 'visitor' || question.conversation_id !== ev.conversation_id) {
    return { kind: 'skip', why: 'message_gone' };
  }

  const { data: conv } = await supabase
    .from('conversations')
    .select('id, workspace_id, status, visitor_id')
    .eq('id', ev.conversation_id)
    .maybeSingle();
  if (!conv || conv.workspace_id !== ev.workspace_id) return { kind: 'skip', why: 'conversation_gone' };

  // Learn only from exchanges a person closed out, and never from one the
  // customer rated badly.
  let solved = conv.status === 'closed';
  let csat: string | null = null;
  if (question.ticket_id) {
    const { data: ticket } = await supabase
      .from('tickets')
      .select('status, csat_rating, workspace_id')
      .eq('id', question.ticket_id)
      .maybeSingle();
    if (ticket && ticket.workspace_id === ev.workspace_id) {
      solved = ticket.status === 'solved' || ticket.status === 'closed';
      csat = ticket.csat_rating ?? null;
    }
  }
  if (!solved) return { kind: 'wait' };
  if (csat === 'bad') return { kind: 'skip', why: 'bad_rating' };

  let after = supabase
    .from('messages')
    .select('sender_type, content, created_at')
    .eq('conversation_id', ev.conversation_id)
    .eq('is_internal', false)
    .in('sender_type', ['visitor', 'agent'])
    .gt('created_at', question.created_at)
    .order('created_at', { ascending: true })
    .limit(30);
  if (question.ticket_id) after = after.eq('ticket_id', question.ticket_id);
  const { data: thread } = await after;
  const conversation = (thread as { sender_type: string; content: string | null; created_at: string }[] | null) || [];
  if (!conversation.some((m) => m.sender_type === 'agent' && (m.content || '').trim().length >= 15)) {
    return { kind: 'skip', why: 'no_agent_answer' };
  }

  let visitorName: string | null = null;
  if (conv.visitor_id) {
    const { data: visitor } = await supabase.from('visitors').select('name').eq('id', conv.visitor_id).maybeSingle();
    visitorName = visitor?.name ?? null;
  }

  const extracted = await extractQa(config, question.content || '', conversation, [visitorName]);
  if (!extracted.ok) return { kind: 'skip', why: extracted.reason, usedModel: true };
  if (Date.now() > deadline) return { kind: 'skip', why: 'out_of_time', retry: true };
  const qa = extracted.qa;

  let embedding: number[] | null = null;
  try {
    embedding = (await generateEmbeddings([qa.question], config))[0] || null;
  } catch {
    /* matched by normalised text instead */
  }

  const { data: matches } = await supabase.rpc('fn_bot_learning_match', {
    p_workspace_id: ev.workspace_id,
    p_embedding: embedding,
    p_question: qa.question,
    p_threshold: 0.88,
  });
  const match = ((matches as { id: string; status: string; grounding: string }[] | null) || [])[0];

  if (match) {
    const { data: existing } = await supabase
      .from('bot_learning_candidates')
      .select('occurrences, conversation_ids')
      .eq('id', match.id)
      .single();
    const ids = [...new Set([...(existing?.conversation_ids || []), ev.conversation_id])].slice(-MAX_CONVERSATION_IDS);
    const patch: Record<string, unknown> = {
      occurrences: (existing?.occurrences || 1) + 1,
      conversation_ids: ids,
      last_seen_at: new Date().toISOString(),
    };
    // An unverified suggestion is replaced by this one when this one checks
    // out against the help centre: the team said it in a way the articles back.
    if (match.status === 'pending_review' && match.grounding !== 'grounded') {
      const g = await groundAnswer(ev.workspace_id, qa, config, jev);
      if (g.grounding === 'grounded') {
        Object.assign(patch, {
          question: qa.question,
          answer: qa.answer,
          grounding: g.grounding,
          grounding_detail: g.detail,
          source_article_ids: g.articleIds,
          source_knowledge_ids: g.knowledgeIds,
          checked_at: new Date().toISOString(),
        });
      }
    }
    const { error } = await supabase.from('bot_learning_candidates').update(patch).eq('id', match.id);
    if (error) throw error;
    const autoApproved = await maybeAutoApprove(ev.workspace_id, match.id, settings);
    return { kind: 'repeat', candidateId: match.id, autoApproved };
  }

  const g = await groundAnswer(ev.workspace_id, qa, config, jev);
  const { data: created, error } = await supabase
    .from('bot_learning_candidates')
    .insert({
      workspace_id: ev.workspace_id,
      question: qa.question,
      answer: qa.answer,
      question_embedding: embedding,
      status: g.grounding === 'contradicts' ? 'rejected' : 'pending_review',
      reject_reason: g.grounding === 'contradicts' ? 'Contradicts the help center' : null,
      grounding: g.grounding,
      grounding_detail: g.detail,
      source_article_ids: g.articleIds,
      source_knowledge_ids: g.knowledgeIds,
      conversation_ids: [ev.conversation_id],
      checked_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error || !created) throw error || new Error('Candidate insert returned nothing');
  const autoApproved = await maybeAutoApprove(ev.workspace_id, created.id, settings);
  return { kind: 'new_candidate', candidateId: created.id, autoApproved };
}

/* ── Re-checking after a source changed ───────────────────────────────── */

/**
 * Candidates whose article or entry changed (fn_bot_learning_withdraw) are
 * checked again against the current text. Grounded ones go back to the bot
 * on their own when the workspace allows it; anything else needs a person,
 * even if a person approved it before, because what it was approved against
 * is gone.
 */
export async function recheckStaleCandidates({ limit = 10, deadline }: { limit?: number; deadline: number }) {
  const result = { rechecked: 0, restored: 0, rejected: 0 };
  const config = await platformModel();
  if (!config) return result;
  const supabase = serviceClient();
  const { data } = await supabase
    .from('bot_learning_candidates')
    .select('id, workspace_id, question, answer')
    .eq('status', 'stale')
    .order('last_seen_at', { ascending: false })
    .limit(limit);
  const jev = await loadJevRuntime().catch(() => null);
  for (const c of (data as { id: string; workspace_id: string; question: string; answer: string }[] | null) || []) {
    if (Date.now() > deadline) break;
    const settings = await loadLearningSettings(c.workspace_id, supabase);
    try {
      const g = await groundAnswer(c.workspace_id, { question: c.question, answer: c.answer }, config, jev);
      const contradicts = g.grounding === 'contradicts';
      const { error } = await supabase
        .from('bot_learning_candidates')
        .update({
          status: contradicts ? 'rejected' : 'stale',
          reject_reason: contradicts ? 'Contradicts the updated help center' : null,
          grounding: g.grounding,
          grounding_detail: g.detail,
          source_article_ids: g.articleIds,
          source_knowledge_ids: g.knowledgeIds,
          checked_at: new Date().toISOString(),
        })
        .eq('id', c.id)
        .eq('status', 'stale');
      if (error) throw error;
      result.rechecked++;
      if (contradicts) {
        result.rejected++;
        continue;
      }
      if (await maybeAutoApprove(c.workspace_id, c.id, settings)) {
        result.restored++;
      } else {
        const { error: queueError } = await supabase
          .from('bot_learning_candidates')
          .update({ status: 'pending_review' })
          .eq('id', c.id)
          .eq('status', 'stale');
        if (queueError) throw queueError;
      }
    } catch (err) {
      console.error('[Bot Learning] Re-check failed:', err);
    }
  }
  return result;
}

/* ── Scoring the retrieval policy ─────────────────────────────────────── */

export async function scorePolicyOutcomes({ limit = 300 }: { limit?: number } = {}) {
  const result = { scored: 0, pending: 0 };
  const supabase = serviceClient();
  const { data } = await supabase
    .from('bot_policy_outcomes')
    .select('message_id, conversation_id, workspace_id')
    .is('reward', null)
    .eq('kind', 'answer')
    .lte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(limit);
  const outcomes = (data as { message_id: string; conversation_id: string; workspace_id: string }[] | null) || [];
  if (!outcomes.length) return result;

  const { data: replies } = await supabase
    .from('messages')
    .select('id, created_at, ticket_id')
    .in('id', outcomes.map((o) => o.message_id));
  const replyById = new Map(((replies as { id: string; created_at: string; ticket_id: string | null }[] | null) || []).map((r) => [r.id, r]));

  for (const o of outcomes) {
    const reply = replyById.get(o.message_id);
    if (!reply) {
      // The reply was deleted: nothing to learn, and it must not stay pending.
      await supabase.from('bot_policy_outcomes').delete().eq('message_id', o.message_id);
      continue;
    }
    const { data: after } = await supabase
      .from('messages')
      .select('sender_type, content, is_internal, created_at')
      .eq('conversation_id', o.conversation_id)
      .gt('created_at', reply.created_at)
      .order('created_at', { ascending: true })
      .limit(10);
    let csat: string | null = null;
    if (reply.ticket_id) {
      const { data: ticket } = await supabase.from('tickets').select('csat_rating').eq('id', reply.ticket_id).maybeSingle();
      csat = ticket?.csat_rating ?? null;
    }
    const reward = scoreOutcome({ answeredAt: reply.created_at, after: after || [], csat });
    if (reward === null) {
      result.pending++;
      continue;
    }
    const { error } = await supabase.rpc('fn_bot_policy_reward', { p_message_id: o.message_id, p_reward: reward });
    if (error) console.warn('[Bot Policy] Could not score outcome:', error.message);
    else result.scored++;
  }
  return result;
}

/* ── One run ──────────────────────────────────────────────────────────── */

export async function runBotLearning({ budgetMs = 50_000 }: { budgetMs?: number } = {}) {
  const deadline = Date.now() + budgetMs;
  learnedIdsCache.clear();
  const policy = await scorePolicyOutcomes();
  const stale = await recheckStaleCandidates({ deadline: deadline - 20_000 });
  const harvest = await harvestCandidates({ deadline });
  return { policy, stale, harvest };
}
