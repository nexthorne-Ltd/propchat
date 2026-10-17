import { serviceClient } from '@/lib/supabase/service';
import type { CitableArticle } from './help-answer';

export interface CachedBotAnswer {
  id: string;
  answerText: string;
  sourceArticleIds: string[];
  citation?: CitableArticle | null;
  similarity: number;
}

/**
 * Checks per-workspace bot answer cache for a near-duplicate question (high cosine similarity)
 * that was answered from unchanged source articles.
 *
 * Scoped strictly by workspace_id.
 */
export async function lookupBotAnswerCache({
  workspaceId,
  queryEmbedding,
  similarityThreshold = 0.90,
}: {
  workspaceId: string;
  queryEmbedding: number[] | null | undefined;
  similarityThreshold?: number;
}): Promise<CachedBotAnswer | null> {
  if (!queryEmbedding || !Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    return null;
  }

  try {
    const supabase = serviceClient();
    const { data, error } = await supabase.rpc('fn_lookup_bot_answer_cache', {
      p_workspace_id: workspaceId,
      p_embedding: queryEmbedding,
      p_similarity_threshold: similarityThreshold,
    });

    if (error || !data || data.length === 0) {
      return null;
    }

    const hit = data[0];
    const sourceIds: string[] = Array.isArray(hit.source_article_ids) ? hit.source_article_ids : [];

    // Verify source articles still exist and are published
    if (sourceIds.length > 0) {
      const { data: validArticles } = await supabase
        .from('articles')
        .select('id, status')
        .eq('workspace_id', workspaceId)
        .in('id', sourceIds)
        .eq('status', 'published');

      if (!validArticles || validArticles.length < sourceIds.length) {
        // One of the source articles was modified, unpublished, or deleted - invalidate
        await supabase
          .from('bot_answer_cache')
          .delete()
          .eq('id', hit.id)
          .eq('workspace_id', workspaceId);
        return null;
      }
    }

    return {
      id: hit.id,
      answerText: hit.answer_text,
      sourceArticleIds: sourceIds,
      citation: hit.citation,
      similarity: hit.similarity,
    };
  } catch (err) {
    console.warn('[Answer Cache] Lookup failed:', err);
    return null;
  }
}

/**
 * Caches a high-quality answered question from Help Desk articles.
 * Invalidate automatically if any source article is edited or deleted.
 */
export async function saveBotAnswerCache({
  workspaceId,
  question,
  queryEmbedding,
  answerText,
  sourceArticleIds,
  citation,
}: {
  workspaceId: string;
  question: string;
  queryEmbedding: number[] | null | undefined;
  answerText: string;
  sourceArticleIds: string[];
  citation?: CitableArticle | null;
}): Promise<void> {
  if (!queryEmbedding || !Array.isArray(queryEmbedding) || !answerText.trim()) {
    return;
  }

  try {
    const supabase = serviceClient();
    await supabase.from('bot_answer_cache').insert({
      workspace_id: workspaceId,
      question_text: question.trim(),
      question_embedding: queryEmbedding,
      answer_text: answerText.trim(),
      source_article_ids: sourceArticleIds || [],
      citation: citation || null,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    console.warn('[Answer Cache] Save failed:', err);
  }
}

/**
 * Invalidates cache entries when source articles change.
 */
export async function invalidateBotAnswerCacheForArticle(
  workspaceId: string,
  articleId: string
): Promise<void> {
  try {
    const supabase = serviceClient();
    await supabase.rpc('fn_invalidate_bot_answer_cache', {
      p_workspace_id: workspaceId,
      p_article_id: articleId,
    });
  } catch (err) {
    console.warn('[Answer Cache] Invalidation failed:', err);
  }
}
