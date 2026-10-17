'use server';

import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { getWorkspaceAccess } from '@/lib/team/access';
import { syncArticleChunks, syncWorkspaceArticleEmbeddings, generateEmbeddings } from '@/lib/ai/semantic-retrieval';
import { invalidateHelpIndex } from '@/lib/ai/help-answer';
import { invalidateBotAnswerCacheForArticle } from '@/lib/ai/answer-cache';
import { ensureUniqueArticleSlug } from '@/app/actions/helpdesk';
import { userError } from '@/lib/errors/user-error';

export interface UnansweredQuestionRecord {
  id: string;
  workspace_id: string;
  question: string;
  normalized?: string;
  reason: string | null;
  times_asked: number;
  status: 'open' | 'answered' | 'dismissed' | 'ignored' | 'pending_approval';
  conversation_id: string | null;
  last_conversation_id: string | null;
  created_at: string;
  first_asked_at: string;
  last_asked_at: string;
  resolved_by: string | null;
  resolved_article_id: string | null;
  resolved_note_id: string | null;
  proposed_answer: string | null;
  resolved_article?: { id: string; title: string; slug: string | null } | null;
  resolved_by_agent?: { id: string; name: string; avatar_url: string | null } | null;
}

/**
 * Lists unanswered questions for a workspace, sorted by times_asked DESC.
 */
export async function listUnansweredQuestionsAction(
  workspaceId: string,
  status: 'open' | 'answered' | 'dismissed' | 'pending_approval' | 'all' = 'open'
): Promise<UnansweredQuestionRecord[]> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'view');

  let query = supabase
    .from('unanswered_questions')
    .select(`
      *,
      resolved_article:articles(id, title, slug),
      resolved_by_agent:agents(id, name, avatar_url)
    `)
    .eq('workspace_id', workspaceId)
    .order('times_asked', { ascending: false })
    .order('last_asked_at', { ascending: false })
    .limit(250);

  if (status !== 'all') {
    if (status === 'dismissed') {
      query = query.in('status', ['dismissed', 'ignored']);
    } else {
      query = query.eq('status', status);
    }
  }

  const { data, error } = await query;
  if (error) throw userError(error.message);
  return (data as any[]) || [];
}

/**
 * Gets open count for sidebar badge.
 */
export async function getOpenUnansweredCountAction(workspaceId: string): Promise<number> {
  const { supabase } = await getWorkspaceAccess(workspaceId, 'view');
  const { count, error } = await supabase
    .from('unanswered_questions')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ['open', 'pending_approval']);

  if (error) return 0;
  return count || 0;
}

/**
 * Saves an answer as a Quick Q&A in the knowledge notes.
 * If workspace setting `require_approval_for_new_answers` is on and user is not admin,
 * marks question as `pending_approval`.
 */
export async function saveQuickQaAnswerAction(
  workspaceId: string,
  unansweredId: string | null,
  data: {
    question: string;
    answer: string;
  }
): Promise<{ success: boolean; pendingApproval: boolean }> {
  const { supabase, user, role } = await getWorkspaceAccess(workspaceId, 'reply');

  // Check workspace settings for admin approval requirement
  const { data: ws } = await supabase
    .from('workspaces')
    .select('ai_settings')
    .eq('id', workspaceId)
    .single();

  const requireApproval = Boolean(ws?.ai_settings?.require_approval_for_new_answers);
  const isAdminOrOwner = role === 'admin' || role === 'owner';

  if (requireApproval && !isAdminOrOwner) {
    // If approval required and member is not admin: record as pending approval
    if (unansweredId) {
      await supabase
        .from('unanswered_questions')
        .update({
          status: 'pending_approval',
          proposed_answer: data.answer.trim(),
          resolved_by: user.id,
          last_asked_at: new Date().toISOString(),
        })
        .eq('id', unansweredId)
        .eq('workspace_id', workspaceId);
    } else {
      await supabase.from('unanswered_questions').insert({
        workspace_id: workspaceId,
        question: data.question.trim(),
        normalized: data.question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim(),
        status: 'pending_approval',
        proposed_answer: data.answer.trim(),
        resolved_by: user.id,
        times_asked: 1,
      });
    }
    return { success: true, pendingApproval: true };
  }

  // Save directly as published article so it is immediately embedded and available for bot RAG
  const slug = await ensureUniqueArticleSlug(supabase, workspaceId, data.question);
  const { data: article, error: artErr } = await supabase
    .from('articles')
    .insert({
      workspace_id: workspaceId,
      title: data.question.trim(),
      slug,
      content: data.answer.trim(),
      category: 'Quick Q&A',
      status: 'published',
      author_id: user.id,
    })
    .select('id')
    .single();

  if (artErr) throw userError(artErr.message);

  // Embed immediately and invalidate caches
  await syncArticleChunks(article.id, workspaceId);
  invalidateHelpIndex(workspaceId);
  await invalidateBotAnswerCacheForArticle(workspaceId, article.id);

  // Update unanswered question row
  if (unansweredId) {
    await supabase
      .from('unanswered_questions')
      .update({
        status: 'answered',
        resolved_article_id: article.id,
        resolved_by: user.id,
        proposed_answer: null,
      })
      .eq('id', unansweredId)
      .eq('workspace_id', workspaceId);
  }

  return { success: true, pendingApproval: false };
}

/**
 * Converts an unanswered question into a full Help Desk Article.
 */
export async function convertUnansweredToArticleAction(
  workspaceId: string,
  unansweredId: string,
  data: {
    title: string;
    content: string;
    section_id?: string | null;
  }
): Promise<{ success: boolean; articleId: string }> {
  const { supabase, user } = await getWorkspaceAccess(workspaceId, 'edit_content');

  const slug = await ensureUniqueArticleSlug(supabase, workspaceId, data.title);

  // 1. Create Article
  const { data: insertedArticle, error: artErr } = await supabase
    .from('articles')
    .insert({
      workspace_id: workspaceId,
      section_id: data.section_id || null,
      title: data.title.trim(),
      slug,
      content: data.content.trim(),
      status: 'published',
      author_id: user.id,
    })
    .select('id')
    .single();

  if (artErr) throw userError(artErr.message);

  // 2. Synchronize embeddings immediately
  await syncArticleChunks(insertedArticle.id, workspaceId);
  invalidateHelpIndex(workspaceId);
  await invalidateBotAnswerCacheForArticle(workspaceId, insertedArticle.id);

  // 3. Mark question as answered
  await supabase
    .from('unanswered_questions')
    .update({
      status: 'answered',
      resolved_article_id: insertedArticle.id,
      resolved_by: user.id,
      proposed_answer: null,
    })
    .eq('id', unansweredId)
    .eq('workspace_id', workspaceId);

  return { success: true, articleId: insertedArticle.id };
}

/**
 * Links an unanswered question to an existing Help Center article.
 */
export async function linkUnansweredToArticleAction(
  workspaceId: string,
  unansweredId: string,
  articleId: string
): Promise<{ success: boolean }> {
  const { supabase, user } = await getWorkspaceAccess(workspaceId, 'edit_content');

  const { error } = await supabase
    .from('unanswered_questions')
    .update({
      status: 'answered',
      resolved_article_id: articleId,
      resolved_by: user.id,
    })
    .eq('id', unansweredId)
    .eq('workspace_id', workspaceId);

  if (error) throw userError(error.message);
  return { success: true };
}

/**
 * Dismisses an unanswered question.
 */
export async function dismissUnansweredQuestionAction(
  workspaceId: string,
  unansweredId: string
): Promise<{ success: boolean }> {
  const { supabase, user } = await getWorkspaceAccess(workspaceId, 'reply');

  const { error } = await supabase
    .from('unanswered_questions')
    .update({
      status: 'dismissed',
      resolved_by: user.id,
    })
    .eq('id', unansweredId)
    .eq('workspace_id', workspaceId);

  if (error) throw userError(error.message);
  return { success: true };
}

/**
 * Admin approves a pending answer submitted by a workspace member.
 */
export async function approvePendingAnswerAction(
  workspaceId: string,
  unansweredId: string
): Promise<{ success: boolean }> {
  const { supabase, user, role } = await getWorkspaceAccess(workspaceId, 'manage_team');

  if (role !== 'admin' && role !== 'owner') {
    throw userError('Only admins or owners can approve answers.');
  }

  const { data: item, error: fetchErr } = await supabase
    .from('unanswered_questions')
    .select('*')
    .eq('id', unansweredId)
    .eq('workspace_id', workspaceId)
    .single();

  if (fetchErr || !item || !item.proposed_answer) {
    throw userError('Pending answer not found.');
  }

  // Create published article and embed immediately
  const slug = await ensureUniqueArticleSlug(supabase, workspaceId, item.question);
  const { data: article, error: artErr } = await supabase
    .from('articles')
    .insert({
      workspace_id: workspaceId,
      title: item.question.trim(),
      slug,
      content: item.proposed_answer.trim(),
      category: 'Quick Q&A',
      status: 'published',
      author_id: user.id,
    })
    .select('id')
    .single();

  if (artErr) throw userError(artErr.message);

  await syncArticleChunks(article.id, workspaceId);
  invalidateHelpIndex(workspaceId);
  await invalidateBotAnswerCacheForArticle(workspaceId, article.id);

  // Mark question as answered
  await supabase
    .from('unanswered_questions')
    .update({
      status: 'answered',
      resolved_article_id: article.id,
      resolved_by: user.id,
      proposed_answer: null,
    })
    .eq('id', unansweredId)
    .eq('workspace_id', workspaceId);

  return { success: true };
}

/**
 * Quality check: Agent marks a bot reply as good or wrong in the inbox.
 * If wrong, creates or updates an entry in unanswered_questions.
 */
export async function rateBotReplyAction(
  workspaceId: string,
  messageId: string,
  rating: 'good' | 'wrong',
  feedback?: string
): Promise<{ success: boolean }> {
  const { supabase, user } = await getWorkspaceAccess(workspaceId, 'reply');

  // 1. Fetch message and metadata
  const { data: msg, error: msgErr } = await supabase
    .from('messages')
    .select('id, conversation_id, content, reply_to_message_id, metadata')
    .eq('id', messageId)
    .single();

  if (msgErr || !msg) throw userError('Message not found.');

  const updatedMetadata = {
    ...(msg.metadata || {}),
    bot_quality_rating: rating,
    bot_quality_rated_by: user.id,
    bot_quality_rated_at: new Date().toISOString(),
    bot_quality_feedback: feedback || null,
  };

  await supabase
    .from('messages')
    .update({ metadata: updatedMetadata })
    .eq('id', messageId);

  // 2. If wrong, add to unanswered questions list for correction
  if (rating === 'wrong') {
    let questionText = '';

    if (msg.reply_to_message_id) {
      const { data: visitorMsg } = await supabase
        .from('messages')
        .select('content')
        .eq('id', msg.reply_to_message_id)
        .maybeSingle();
      if (visitorMsg?.content) questionText = visitorMsg.content;
    }

    if (!questionText && msg.conversation_id) {
      // Find latest visitor message before this bot reply
      const { data: priorVisitorMsgs } = await supabase
        .from('messages')
        .select('content')
        .eq('conversation_id', msg.conversation_id)
        .eq('sender_type', 'visitor')
        .order('created_at', { ascending: false })
        .limit(1);

      if (priorVisitorMsgs && priorVisitorMsgs.length > 0) {
        questionText = priorVisitorMsgs[0].content;
      }
    }

    if (questionText && questionText.trim()) {
      const reason = `Flagged wrong by agent in inbox. Bot reply was: "${(msg.content || '').slice(0, 100)}..."`;
      await serviceClient().rpc('fn_record_or_increment_unanswered_question', {
        p_workspace_id: workspaceId,
        p_question: questionText.trim(),
        p_conversation_id: msg.conversation_id,
        p_reason: reason,
        p_similarity_threshold: 0.88,
      });
    }
  }

  return { success: true };
}
