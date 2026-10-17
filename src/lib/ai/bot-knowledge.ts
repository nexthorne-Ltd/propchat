import { serviceClient } from '@/lib/supabase/service';
import { getPlatformAiConfigServerOnly } from './platform-gateway';
import {
  BOT_KNOWLEDGE_SECTION,
  describeEmbeddingProvider,
  generateEmbeddings,
  splitArticleIntoChunks,
} from './semantic-retrieval';
import { userError } from '@/lib/errors/user-error';

/**
 * Embeds Bot knowledge entries: material the bot answers from that is not a
 * published article (see migration 20261102090000_bot_knowledge.sql).
 *
 * Chunked exactly like articles so the two are searched and scored alike.
 * With no embedding service the chunks are stored keyword-only, which hybrid
 * search still finds; with one that fails, nothing is stored and the entry is
 * marked failed, because storing keyword-only chunks then would quietly hide
 * a broken key behind a "ready" entry.
 */

export interface BotKnowledgeEmbedResult {
  id: string;
  status: 'ready' | 'failed' | 'skipped';
  chunks: number;
  embedded: number;
  error?: string;
}

export async function embedBotKnowledge(workspaceId: string, id: string): Promise<BotKnowledgeEmbedResult> {
  const supabase = serviceClient();
  // Scoped to the workspace: the id comes from the browser.
  const { data: entry, error } = await supabase
    .from('bot_knowledge')
    .select('id, title, content, content_version')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) return { id, status: 'failed', chunks: 0, embedded: 0, error: error.message };
  if (!entry) return { id, status: 'skipped', chunks: 0, embedded: 0, error: 'This entry no longer exists.' };

  const chunks = splitArticleIntoChunks({
    id: entry.id,
    workspace_id: workspaceId,
    title: entry.title,
    sectionName: BOT_KNOWLEDGE_SECTION,
    content: entry.content,
  });

  const store = async (payload: unknown[] | null, failure: string | null) => {
    const { data: stored, error: rpcError } = await supabase.rpc('fn_store_bot_knowledge_chunks', {
      p_knowledge_id: entry.id,
      p_version: entry.content_version,
      p_chunks: payload ?? [],
      p_error: failure,
    });
    if (rpcError) throw userError(rpcError.message);
    return stored === true;
  };

  try {
    let embeddings: (number[] | null)[] = chunks.map(() => null);
    const provider = await describeEmbeddingProvider();
    if (provider.available) {
      try {
        const { config } = await getPlatformAiConfigServerOnly();
        const out = await generateEmbeddings(chunks.map((c) => c.content), config);
        if (out.length !== chunks.length || out.some((e) => !Array.isArray(e) || !e.length)) {
          throw userError('The embedding service returned an incomplete result.');
        }
        embeddings = out;
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        console.warn(`[Bot Knowledge] Embedding failed for ${entry.id}:`, message);
        await store(null, message);
        return { id, status: 'failed', chunks: 0, embedded: 0, error: message };
      }
    }

    const stored = await store(
      chunks.map((c, i) => ({
        chunk_index: c.chunk_index,
        content: c.content,
        token_count: c.token_count,
        embedding: embeddings[i],
      })),
      null
    );
    if (!stored) {
      return { id, status: 'skipped', chunks: 0, embedded: 0, error: 'The entry was edited while it was being embedded. Run it again.' };
    }
    return { id, status: 'ready', chunks: chunks.length, embedded: embeddings.filter(Boolean).length };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.error(`[Bot Knowledge] Storing chunks failed for ${entry.id}:`, message);
    return { id, status: 'failed', chunks: 0, embedded: 0, error: message };
  }
}
