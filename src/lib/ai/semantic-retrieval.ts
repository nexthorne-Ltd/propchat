import { serviceClient } from '@/lib/supabase/service';
import type { ProviderConfig } from './provider';
import { chat, isConfigured } from './provider';
import { getPlatformAiConfigServerOnly } from './platform-gateway';
import type { RetrievedChunk } from '@/types/database';
import { userError } from '@/lib/errors/user-error';
import { searchQueriesFor, understandMessage } from './understanding';

/**
 * Semantic retrieval and embedding engine with pgvector.
 *
 * Replaces pure keyword overlap with:
 * 1. 300-500 token chunking with title & section metadata preserved on every chunk.
 * 2. Supabase pgvector cosine embeddings + automatic sync on article lifecycle.
 * 3. Hybrid search combining cosine similarity and exact keyword/phrase matching.
 * 4. Conversational query rewriting using the last 6 conversation messages.
 */

export interface ArticleChunkInput {
  workspace_id: string;
  article_id: string;
  article_title: string;
  section_name: string | null;
  article_slug: string | null;
  chunk_index: number;
  content: string;
  token_count: number;
}

/**
 * Estimates token count for English and multilingual text.
 * Standard heuristic: 1 token ~= 4 chars or 0.75 words.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  return Math.max(1, Math.round(Math.max(words * 1.3, chars / 4)));
}

/**
 * Splits markdown content into structural blocks (headers, code, paragraphs, lists).
 */
function splitMarkdownBlocks(markdown: string): string[] {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inCode = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      current.push(line);
      continue;
    }
    if (inCode) {
      current.push(line);
      continue;
    }
    if (/^#{1,6}\s+/.test(line.trim())) {
      if (current.length) {
        blocks.push(current.join('\n').trim());
        current = [];
      }
      current.push(line);
      continue;
    }
    if (line.trim() === '' && current.length) {
      blocks.push(current.join('\n').trim());
      current = [];
      continue;
    }
    if (line.trim() !== '') {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join('\n').trim());
  return blocks.filter(Boolean);
}

/**
 * Splits a published help article into chunks of roughly 300 to 500 tokens,
 * keeping the article title and section name with each chunk.
 */
export function splitArticleIntoChunks(article: {
  id: string;
  workspace_id: string;
  title: string;
  sectionName?: string | null;
  category?: string | null;
  slug?: string | null;
  summary?: string | null;
  content: string;
}): ArticleChunkInput[] {
  const title = (article.title || '').trim();
  const sectionName = (article.sectionName || article.category || 'General').trim();
  const header = `Article: ${title}\nSection: ${sectionName}\n\n`;
  const headerTokens = estimateTokenCount(header);

  const TARGET_MAX_TOKENS = 650;
  const blocks = splitMarkdownBlocks(article.content);
  const rawChunks: string[] = [];
  let currentBodyBlocks: string[] = [];
  let currentTokens = headerTokens;

  for (const block of blocks) {
    const blockTokens = estimateTokenCount(block);

    // If a single block exceeds the max chunk budget, split by sentences
    if (blockTokens > TARGET_MAX_TOKENS) {
      if (currentBodyBlocks.length > 0) {
        rawChunks.push(header + currentBodyBlocks.join('\n\n'));
        currentBodyBlocks = [];
        currentTokens = headerTokens;
      }
      const sentences = block.split(/(?<=[.!?])\s+/);
      let subSentences: string[] = [];
      let subTokens = headerTokens;
      for (const sent of sentences) {
        const sTokens = estimateTokenCount(sent);
        if (subTokens + sTokens > TARGET_MAX_TOKENS && subSentences.length > 0) {
          rawChunks.push(header + subSentences.join(' '));
          subSentences = [];
          subTokens = headerTokens;
        }
        subSentences.push(sent);
        subTokens += sTokens;
      }
      if (subSentences.length > 0) {
        rawChunks.push(header + subSentences.join(' '));
      }
      continue;
    }

    // If adding this block exceeds the token target, flush current chunk
    if (currentTokens + blockTokens > TARGET_MAX_TOKENS && currentBodyBlocks.length > 0) {
      rawChunks.push(header + currentBodyBlocks.join('\n\n'));
      currentBodyBlocks = [];
      currentTokens = headerTokens;
    }

    currentBodyBlocks.push(block);
    currentTokens += blockTokens;
  }

  if (currentBodyBlocks.length > 0) {
    rawChunks.push(header + currentBodyBlocks.join('\n\n'));
  }

  // If the article had no blocks (empty content), create a minimal chunk with title & summary
  if (rawChunks.length === 0) {
    rawChunks.push(`${header}${article.summary ? `${article.summary}\n\n` : ''}${title}`);
  }

  return rawChunks.map((content, idx) => ({
    workspace_id: article.workspace_id,
    article_id: article.id,
    article_title: title,
    section_name: sectionName,
    article_slug: article.slug || null,
    chunk_index: idx,
    content,
    token_count: estimateTokenCount(content),
  }));
}

/**
 * Resolves API key for embeddings, checking provider config and environment fallbacks.
 */
function resolveEmbeddingCredentials(providerConfig?: ProviderConfig | null): {
  provider: 'google' | 'openai' | 'compatible';
  apiKey: string;
  baseUrl?: string | null;
} | null {
  const p = providerConfig?.provider;
  const cfgKey = providerConfig?.apiKey;

  if (p === 'google' && cfgKey) {
    return { provider: 'google', apiKey: cfgKey };
  }
  if (p === 'openai' && cfgKey) {
    return { provider: 'openai', apiKey: cfgKey, baseUrl: providerConfig?.baseUrl };
  }
  if (p === 'compatible' && cfgKey) {
    return { provider: 'compatible', apiKey: cfgKey, baseUrl: providerConfig?.baseUrl };
  }

  // Environment fallbacks
  const googleKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (googleKey) return { provider: 'google', apiKey: googleKey };

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) return { provider: 'openai', apiKey: openaiKey };

  return null;
}

/**
 * Generates 768-dimensional float embeddings for an array of texts.
 */
export async function generateEmbeddings(
  texts: string[],
  providerConfig?: ProviderConfig | null
): Promise<number[][]> {
  if (!texts.length) return [];

  let creds = resolveEmbeddingCredentials(providerConfig);
  if (!creds) {
    const platform = await getPlatformAiConfigServerOnly().catch(() => null);
    if (platform?.config) {
      creds = resolveEmbeddingCredentials(platform.config);
    }
  }

  if (!creds) {
    throw userError('No embedding API key configured for Google, OpenAI, or platform AI provider.');
  }

  if (creds.provider === 'google') {
    return generateGoogleEmbeddings(texts, creds.apiKey);
  } else {
    return generateOpenAiEmbeddings(texts, creds.apiKey, creds.baseUrl);
  }
}

async function generateGoogleEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const BATCH_SIZE = 15;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
    const requests = batch.map((text) => ({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
      outputDimensionality: 768,
    }));

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw userError(`Google embeddings error ${res.status}: ${err}`);
    }

    const data = await res.json();
    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw userError('Invalid response structure from Gemini embeddings API');
    }

    for (const e of data.embeddings) {
      results.push(e.values);
    }
  }

  return results;
}

async function generateOpenAiEmbeddings(
  texts: string[],
  apiKey: string,
  baseUrl?: string | null
): Promise<number[][]> {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/embeddings';
  const isDeepInfra = (baseUrl || '').includes('deepinfra.com');
  const isCustomBase = Boolean(baseUrl && !baseUrl.includes('api.openai.com'));
  let model = isDeepInfra ? 'google/embeddinggemma-300m' : 'text-embedding-3-small';
  const BATCH_SIZE = 20;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const bodyPayload: Record<string, unknown> = {
      model,
      input: batch,
    };
    if (model === 'text-embedding-3-small') {
      bodyPayload.dimensions = 768;
    }

    let res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok && model === 'text-embedding-3-small' && isCustomBase) {
      // Fallback for compatible providers hosting embeddinggemma-300m or bge-base
      model = isDeepInfra ? 'google/embeddinggemma-300m' : 'BAAI/bge-base-en-v1.5';
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: batch,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    }

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw userError(`OpenAI embeddings error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const sorted = (data.data || []).sort(
      (a: { index: number }, b: { index: number }) => a.index - b.index
    );
    for (const item of sorted) {
      results.push(item.embedding);
    }
  }

  return results;
}

/**
 * Embeddings when a Google/OpenAI key is available; otherwise nulls.
 *
 * Chunks are stored either way: hybrid search also ranks by keywords, so an
 * article without a vector is still found. Throwing here used to mean that a
 * workspace on Anthropic or DeepSeek (no embedding API) stored no chunks at
 * all, and the assistant answered "I don't have that information" about
 * articles that were right there.
 */
async function embedOrNothing(
  texts: string[],
  providerConfig?: ProviderConfig | null
): Promise<(number[] | null)[]> {
  try {
    const out = await generateEmbeddings(texts, providerConfig);
    if (out.length === texts.length) return out;
  } catch (err) {
    console.warn('[Semantic Retrieval] Embeddings unavailable, storing keyword-only chunks:', (err as Error)?.message);
  }
  return texts.map(() => null);
}

/**
 * Re-embeds an article automatically when created, edited, published or unpublished.
 */
export async function syncArticleChunks(articleId: string, workspaceId: string): Promise<void> {
  const chunks = await chunkPublishedArticle(articleId, workspaceId);
  if (!chunks) {
    await deleteArticleChunks(articleId);
    return;
  }

  const { config: providerConfig } = await getPlatformAiConfigServerOnly();
  const embeddings = await embedOrNothing(chunks.map((c) => c.content), providerConfig);
  await replaceArticleChunks(articleId, chunks, embeddings);
}

/**
 * The article's chunks, or null when it should have none (deleted, a draft,
 * or empty).
 */
async function chunkPublishedArticle(
  articleId: string,
  workspaceId: string
): Promise<ArticleChunkInput[] | null> {
  const { data: article } = await serviceClient()
    .from('articles')
    .select('*, section:help_sections(name)')
    .eq('id', articleId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!article || article.status !== 'published') return null;

  const chunks = splitArticleIntoChunks({
    id: article.id,
    workspace_id: workspaceId,
    title: article.title,
    sectionName: article.section?.name || article.category || 'General',
    slug: article.slug,
    summary: article.summary,
    content: article.content,
  });
  return chunks.length ? chunks : null;
}

async function replaceArticleChunks(
  articleId: string,
  chunks: ArticleChunkInput[],
  embeddings: (number[] | null)[]
): Promise<void> {
  const supabase = serviceClient();
  const { error: delErr } = await supabase.from('article_chunks').delete().eq('article_id', articleId);
  if (delErr) throw userError(`Failed to clear article chunks: ${delErr.message}`);

  const rows = chunks.map((chunk, idx) => ({
    ...chunk,
    embedding: (embeddings[idx] as unknown as string) || null,
  }));
  const { error: insErr } = await supabase.from('article_chunks').insert(rows);
  if (insErr) {
    console.error('[Semantic Retrieval] Failed to insert article chunks:', insErr);
    throw userError(`Failed to store article chunks: ${insErr.message}`);
  }
}

/** Which embedding service the platform settings resolve to, if any. */
export async function describeEmbeddingProvider(): Promise<{ available: boolean; provider: string | null }> {
  let creds = resolveEmbeddingCredentials(null);
  if (!creds) {
    const platform = await getPlatformAiConfigServerOnly().catch(() => null);
    if (platform?.config) creds = resolveEmbeddingCredentials(platform.config);
  }
  if (!creds) return { available: false, provider: null };
  const host = creds.baseUrl ? (() => { try { return new URL(creds!.baseUrl!).host; } catch { return null; } })() : null;
  return { available: true, provider: host || creds.provider };
}

export interface ArticleReindexResult {
  articleId: string;
  status: 'embedded' | 'removed' | 'failed';
  chunks: number;
  error?: string;
}

/**
 * Re-embeds one article for the "Re-index knowledge" button. Unlike
 * syncArticleChunks, a failed embedding call is reported rather than stored
 * as keyword-only chunks, and the article's existing chunks are left as they
 * were, so a flaky provider cannot wipe embeddings that already worked.
 */
export async function reindexArticleStrict(articleId: string, workspaceId: string): Promise<ArticleReindexResult> {
  try {
    const chunks = await chunkPublishedArticle(articleId, workspaceId);
    if (!chunks) {
      // Scoped to the workspace: the id comes from the browser, and an id
      // from another workspace must not clear that workspace's chunks.
      const { error } = await serviceClient()
        .from('article_chunks')
        .delete()
        .eq('article_id', articleId)
        .eq('workspace_id', workspaceId);
      if (error) throw userError(error.message);
      return { articleId, status: 'removed', chunks: 0 };
    }

    const { config: providerConfig } = await getPlatformAiConfigServerOnly();
    const embeddings = await generateEmbeddings(chunks.map((c) => c.content), providerConfig);
    if (embeddings.length !== chunks.length || embeddings.some((e) => !Array.isArray(e) || !e.length)) {
      throw userError('The embedding service returned an incomplete result.');
    }

    await replaceArticleChunks(articleId, chunks, embeddings);
    return { articleId, status: 'embedded', chunks: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Semantic Retrieval] Re-index failed for article ${articleId}:`, message);
    return { articleId, status: 'failed', chunks: 0, error: message.slice(0, 300) };
  }
}

/**
 * Deletes all chunks belonging to an article.
 */
export async function deleteArticleChunks(articleId: string): Promise<void> {
  const supabase = serviceClient();
  await supabase.from('article_chunks').delete().eq('article_id', articleId);
}

/**
 * Synchronizes/backfills embeddings for all published articles in a workspace.
 */
export async function syncWorkspaceArticleEmbeddings(
  workspaceId: string
): Promise<{ indexedArticles: number; totalChunks: number }> {
  const supabase = serviceClient();
  const [{ data: sections }, { data: articles }] = await Promise.all([
    supabase.from('help_sections').select('id, name').eq('workspace_id', workspaceId),
    supabase
      .from('articles')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('status', 'published'),
  ]);

  if (!articles || !articles.length) {
    return { indexedArticles: 0, totalChunks: 0 };
  }

  const { config: providerConfig } = await getPlatformAiConfigServerOnly();

  const secMap = new Map((sections || []).map((s) => [s.id, s.name]));
  const allChunks: (ArticleChunkInput & { embedding?: number[] })[] = [];

  for (const art of articles) {
    const secName = art.section_id ? secMap.get(art.section_id) : art.category;
    const chunks = splitArticleIntoChunks({
      ...art,
      sectionName: secName,
    });
    allChunks.push(...chunks);
  }

  if (allChunks.length === 0) return { indexedArticles: 0, totalChunks: 0 };

  const texts = allChunks.map((c) => c.content);
  const embeddings = await embedOrNothing(texts, providerConfig);

  // Clear existing workspace chunks and insert fresh ones
  await supabase.from('article_chunks').delete().eq('workspace_id', workspaceId);

  const BATCH_SIZE = 25;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE).map((c, idx) => ({
      ...c,
      embedding: (embeddings[i + idx] as unknown as string) || null,
    }));
    const { error } = await supabase.from('article_chunks').insert(batch);
    if (error) {
      console.error('[Semantic Retrieval] Batch insert error:', error);
      throw error;
    }
  }

  return { indexedArticles: articles.length, totalChunks: allChunks.length };
}

/**
 * Backfills embeddings for all published articles across all workspaces.
 */
export async function backfillAllWorkspacesArticleEmbeddings(): Promise<{
  workspacesProcessed: number;
  totalArticlesIndexed: number;
  totalChunksCreated: number;
}> {
  const supabase = serviceClient();
  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, name');

  if (error || !workspaces) {
    console.error('[Semantic Retrieval] Failed to fetch workspaces for backfill:', error);
    return { workspacesProcessed: 0, totalArticlesIndexed: 0, totalChunksCreated: 0 };
  }

  let totalArticlesIndexed = 0;
  let totalChunksCreated = 0;
  let workspacesProcessed = 0;

  for (const ws of workspaces) {
    try {
      const res = await syncWorkspaceArticleEmbeddings(ws.id);
      if (res.indexedArticles > 0) {
        workspacesProcessed++;
        totalArticlesIndexed += res.indexedArticles;
        totalChunksCreated += res.totalChunks;
        console.log(`[Semantic Retrieval] Workspace "${ws.name}" (${ws.id}): indexed ${res.indexedArticles} articles, ${res.totalChunks} chunks.`);
      }
    } catch (wsErr) {
      console.warn(`[Semantic Retrieval] Failed to sync workspace ${ws.id}:`, wsErr);
    }
  }

  return {
    workspacesProcessed,
    totalArticlesIndexed,
    totalChunksCreated,
  };
}

const NON_ENGLISH_MARKERS =
  /\b(?:kya|kia|hai|hain|mera|meri|mere|mujhe|kaise|kese|nahi|nahin|aap|ap|ka|ki|ke|ko|se|mein|kitna|kitne|chahiye|karna|kar|hota|hoti|wala|wali)\b/i;
const FOLLOW_UP_MARKERS =
  /^(?:and|also|but|so|then|ok|okay|what\s+about|how\s+about)\b|\b(?:it|its|it's|that|this|those|these|they|them|there|same|one|ones|above)\b/i;

/**
 * True when the message already works as a search query: plain English, long
 * enough to carry its own meaning, and (with a conversation behind it) not a
 * follow-up that leans on an earlier turn. Most questions are like this, and
 * rewriting them would spend a model call to get the same words back.
 */
export function isStandaloneEnglishQuery(message: string, hasHistory: boolean): boolean {
  if (!/^[\x20-\x7E]+$/.test(message)) return false;
  const words = message.split(/\s+/).filter(Boolean).length;
  // Short queries are where shorthand and typos live ("25k instant accounts ruls"):
  // they go through the rewrite, which also fixes spelling.
  if (words < 6 || words > 25) return false;
  if (NON_ENGLISH_MARKERS.test(message)) return false;
  return !hasHistory || !FOLLOW_UP_MARKERS.test(message);
}

/**
 * Rewrites the visitor message into a standalone English search query
 * using the recent messages of the conversation.
 *
 * Handles:
 * - Follow-up questions (e.g. "and what about instant accounts?")
 * - Languages like Roman Urdu/Hindi, Arabic, French, Spanish, Uzbek
 * - Spelling errors, typos, and abbreviations
 * - Preserving exact terms, figures, percentages (e.g. "1% rule", "80/20", "drawdown")
 *
 * Messages that are already standalone English skip the model call.
 */
export async function rewriteVisitorMessageToEnglishQuery({
  visitorMessage,
  recentMessages = [],
  providerConfig,
}: {
  visitorMessage: string;
  recentMessages?: { sender_type?: string; role?: string; content?: string }[];
  providerConfig?: ProviderConfig | null;
}): Promise<string> {
  const trimmed = visitorMessage.trim();
  if (!trimmed) return '';

  // Filter and take the last 6 conversation messages for context
  const last6 = (recentMessages || [])
    .filter((m) => typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map((m) => {
      const isUser = m.sender_type === 'visitor' || m.role === 'user';
      return `${isUser ? 'Customer' : 'Assistant'}: ${m.content!.trim()}`;
    });

  if (!isConfigured(providerConfig) || isStandaloneEnglishQuery(trimmed, last6.length > 0)) {
    return trimmed;
  }

  // Kept short: this runs before almost every help-centre answer.
  const systemInstruction = [
    'Rewrite the customer’s latest message as one standalone English search query (4-12 words) for a support help center.',
    'Resolve follow-ups ("it", "that", "and what about X?") from the conversation, translate any language (including Roman Urdu) into English, fix typos, and keep exact names, numbers and acronyms.',
    'Output only the query: no quotes, prefixes or explanation.',
  ].join('\n');

  const userContent = [
    last6.length ? `Conversation:\n${last6.slice(-4).join('\n')}\n` : '',
    `Latest message: ${trimmed}`,
  ].join('\n');

  try {
    const res = await chat(providerConfig!, {
      system: systemInstruction,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 60,
      temperature: 0.1,
      reasoning: 'fast',
      // The rewrite only sharpens retrieval; the raw message still works, so
      // it must not eat the reply's time budget on a slow provider.
      timeoutMs: 6000,
    });

    const rewritten = (res.text || '').trim().replace(/^["']|["']$/g, '');
    return rewritten && rewritten.length > 2 ? rewritten : trimmed;
  } catch (err) {
    console.warn('[Semantic Retrieval] Query rewrite model call failed, using raw query:', err);
    return trimmed;
  }
}

/**
 * What a message is asking, as up to three English search queries written
 * the way a help centre would phrase it, one per separate question. One
 * model call, the same budget the single rewrite had. "3 din se pyout nahi
 * aaya, scam hai kya?" becomes ["payout not received after 3 days",
 * "payout processing time", "is the firm legit"].
 *
 * The rules (understanding.ts) give the model a cleaned-up reading as a hint
 * and are the whole answer when there is no model or the message already
 * reads as a standalone English question.
 */
export async function expandVisitorQueries({
  visitorMessage,
  recentMessages = [],
  providerConfig,
}: {
  visitorMessage: string;
  recentMessages?: { sender_type?: string; role?: string; content?: string }[];
  providerConfig?: ProviderConfig | null;
}): Promise<string[]> {
  const trimmed = visitorMessage.trim();
  if (!trimmed) return [];
  const understood = understandMessage(trimmed);
  const history = (recentMessages || [])
    .filter((m) => typeof m.content === 'string' && m.content.trim() && m.content.trim() !== trimmed)
    .slice(-4)
    .map((m) => `${m.sender_type === 'visitor' || m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content!.trim().slice(0, 300)}`);

  if (!isConfigured(providerConfig) || (isStandaloneEnglishQuery(trimmed, history.length > 0) && !understood.parts.length)) {
    return searchQueriesFor(trimmed);
  }

  const system = [
    'You turn a customer\'s chat message into search queries for a prop-trading firm\'s help center.',
    'Customers type fast: typos, shorthand (dd = drawdown, acc = account, p1 = phase 1), Roman Urdu, Urdu-English mix, slang, venting. Look past the words to what they actually need.',
    'Resolve follow-ups ("aur 25k pe?", "and for phase 2?") from the conversation. Ignore greetings and venting; keep the request.',
    'Write 1-3 short English queries (3-10 words each), worded like help-center headings or FAQ questions. One per separate question; if there is one question, add a second wording of it. Keep exact numbers, sizes and names.',
    'Output only a JSON array of strings, e.g. ["daily drawdown limit 10k account","maximum daily loss rule"].',
  ].join('\n');
  const user = [
    history.length ? `Conversation:\n${history.join('\n')}\n` : '',
    `Latest message: ${trimmed}`,
    understood.core && understood.core !== trimmed.toLowerCase() ? `Rough reading (may be imperfect): ${understood.core}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await chat(providerConfig!, {
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 90,
      temperature: 0.1,
      reasoning: 'fast',
      timeoutMs: 6000,
    });
    return searchQueriesFor(trimmed, parseQueryList(res.text || ''));
  } catch (err) {
    console.warn('[Semantic Retrieval] Query expansion failed, using the rules:', (err as Error)?.message);
    return searchQueriesFor(trimmed);
  }
}

/** The model's JSON array, or its lines when it ignored the format. */
export function parseQueryList(raw: string): string[] {
  const text = raw.trim();
  const json = text.match(/\[[\s\S]*\]/)?.[0];
  if (json) {
    try {
      const arr = JSON.parse(json);
      if (Array.isArray(arr)) return arr.filter((q): q is string => typeof q === 'string' && q.trim().length > 2).map((q) => q.trim()).slice(0, 3);
    } catch {
      // fall through to lines
    }
  }
  return text
    .split('\n')
    .map((l) => l.replace(/^[\s\-*\d.)"']+|["',]+$/g, '').trim())
    .filter((l) => l.length > 2 && !/^\[|\]$/.test(l))
    .slice(0, 3);
}

/** Reciprocal rank fusion: the usual k, so rank 1 is not everything. */
const RRF_K = 60;

/**
 * Merges the result lists of several queries. A passage found by several
 * wordings of the question ranks above one found by a single wording, which
 * is the agreement a human reader would look for. Each merged chunk keeps its
 * best raw scores, so the threshold check still means what it meant.
 */
export function fuseRankings(lists: RetrievedChunk[][]): (RetrievedChunk & { fused_score: number; hits: number })[] {
  const merged = new Map<string, RetrievedChunk & { fused_score: number; hits: number }>();
  for (const list of lists) {
    list.forEach((c, rank) => {
      const key = `${c.source ?? 'article'}:${c.id}`;
      const prev = merged.get(key);
      const add = 1 / (RRF_K + rank + 1);
      if (!prev) {
        merged.set(key, { ...c, fused_score: add, hits: 1 });
      } else {
        prev.fused_score += add;
        prev.hits += 1;
        prev.similarity = Math.max(prev.similarity, c.similarity);
        prev.keyword_score = Math.max(prev.keyword_score, c.keyword_score);
        prev.combined_score = Math.max(prev.combined_score, c.combined_score);
      }
    });
  }
  return [...merged.values()].sort((a, b) => b.fused_score - a.fused_score || b.combined_score - a.combined_score);
}

/**
 * Executes hybrid search over workspace article chunks:
 * 1. Cosine similarity via pgvector (embedding <=> query_embedding)
 * 2. Full text search and exact phrase matching
 * 3. Scoped strictly to the workspace
 * Returns top 6 chunks.
 */
export async function hybridSearchWorkspaceChunks({
  workspaceId,
  queryText,
  queryEmbedding,
  limit = 6,
}: {
  workspaceId: string;
  queryText: string;
  queryEmbedding?: number[] | null;
  limit?: number;
}): Promise<RetrievedChunk[]> {
  const supabase = serviceClient();

  const { data, error } = await supabase.rpc('fn_hybrid_search_chunks', {
    p_workspace_id: workspaceId,
    p_query_text: queryText,
    p_query_embedding: queryEmbedding || null,
    p_limit: limit,
  });

  if (error) {
    console.warn('[Semantic Retrieval] fn_hybrid_search_chunks RPC failed:', error.message);
    return [];
  }

  return (data as RetrievedChunk[]) || [];
}

/** Section label on Bot knowledge chunks, for the model and the keyword index. */
export const BOT_KNOWLEDGE_SECTION = 'Team knowledge';

/**
 * Hybrid search over the workspace's Bot knowledge entries (only those that
 * have been embedded), shaped like article chunks so the two lists merge.
 * Scored the same way as fn_hybrid_search_chunks.
 */
export async function hybridSearchBotKnowledge({
  workspaceId,
  queryText,
  queryEmbedding,
  limit = 6,
}: {
  workspaceId: string;
  queryText: string;
  queryEmbedding?: number[] | null;
  limit?: number;
}): Promise<RetrievedChunk[]> {
  const { data, error } = await serviceClient().rpc('fn_hybrid_search_bot_knowledge', {
    p_workspace_id: workspaceId,
    p_query_text: queryText,
    p_query_embedding: queryEmbedding || null,
    p_limit: limit,
  });

  if (error) {
    // Before the migration has run the function does not exist; articles still answer.
    console.warn('[Semantic Retrieval] fn_hybrid_search_bot_knowledge RPC failed:', error.message);
    return [];
  }

  return ((data as { id: string; knowledge_id: string; title: string; chunk_index: number; content: string; similarity: number; keyword_score: number; combined_score: number }[]) || []).map((row) => ({
    id: row.id,
    article_id: row.knowledge_id,
    article_title: row.title,
    section_name: BOT_KNOWLEDGE_SECTION,
    article_slug: null,
    chunk_index: row.chunk_index,
    content: row.content,
    similarity: row.similarity,
    keyword_score: row.keyword_score,
    combined_score: row.combined_score,
    source: 'knowledge' as const,
  }));
}

/**
 * Builds the AI model context from semantic retrieved chunks:
 * 1. Rewrites visitor query into standalone English query using last 6 messages.
 * 2. Embeds the query.
 * 3. Retrieves top 6 chunks via hybrid search.
 * 4. Filters out chunks below similarity threshold so unrelated articles are never sent.
 * 5. Assembles clean context blocks with article URLs for the model.
 */
export async function buildSemanticModelContext({
  workspaceId,
  visitorMessage,
  recentMessages = [],
  providerConfig,
  limit = 6,
  messageEmbedding,
}: {
  workspaceId: string;
  visitorMessage: string;
  recentMessages?: { sender_type?: string; role?: string; content?: string }[];
  providerConfig?: ProviderConfig | null;
  limit?: number;
  helpCenterUrl?: string | null;
  /** Embedding of `visitorMessage` itself, reused when the query is not rewritten. */
  messageEmbedding?: number[] | null;
}): Promise<{
  text: string;
  used: { id: string; title: string; source: 'article' | 'knowledge' }[];
  rewrittenQuery: string;
  /** Every query searched (understanding.ts), the first being rewrittenQuery. */
  queries: string[];
  queryEmbedding?: number[] | null;
  chunks: RetrievedChunk[];
  belowThreshold: boolean;
}> {
  let activeConfig = providerConfig;
  if (!isConfigured(activeConfig)) {
    const platform = await getPlatformAiConfigServerOnly().catch(() => null);
    if (platform?.config) activeConfig = platform.config;
  }

  // 1. What the message is asking, as up to four search queries: the
  // model's FAQ-style wordings, each separate question, the normalised
  // request (typos, shorthand and Roman Urdu mapped, venting removed) and the
  // visitor's own words (understanding.ts).
  const queries = await expandVisitorQueries({ visitorMessage, recentMessages, providerConfig: activeConfig });
  if (!queries.length) queries.push(visitorMessage.trim());
  const rewrittenQuery = queries[0];

  // 2. One embedding request for all of them.
  let embeddings: (number[] | null)[] = queries.map((q) => (messageEmbedding?.length && q === visitorMessage.trim() ? messageEmbedding : null));
  const missing = queries.filter((_, i) => !embeddings[i]);
  if (missing.length) {
    try {
      const made = await generateEmbeddings(missing, activeConfig);
      let k = 0;
      embeddings = embeddings.map((e) => e ?? made[k++] ?? null);
    } catch (err) {
      console.warn('[Semantic Retrieval] Query embedding failed, continuing with keyword search:', err);
    }
  }
  const queryEmbedding = embeddings[0] ?? null;

  // 3. Hybrid search over articles and Bot knowledge for every query, merged
  // by reciprocal rank fusion: the passage most wordings agree on wins, the
  // way an agent recognises the FAQ behind a badly typed question.
  const lists = await Promise.all(
    queries.map(async (queryText, i) => {
      const [articleChunks, knowledgeChunks] = await Promise.all([
        hybridSearchWorkspaceChunks({ workspaceId, queryText, queryEmbedding: embeddings[i], limit }),
        hybridSearchBotKnowledge({ workspaceId, queryText, queryEmbedding: embeddings[i], limit }),
      ]);
      return [...articleChunks, ...knowledgeChunks].sort((a, b) => b.combined_score - a.combined_score || b.similarity - a.similarity);
    })
  );
  const chunks: RetrievedChunk[] = fuseRankings(lists).slice(0, limit);

  if (!chunks.length) {
    return { text: '', used: [], rewrittenQuery, queries, queryEmbedding, chunks: [], belowThreshold: true };
  }

  // 4. Threshold check: if top match is below threshold, refuse to pass unrelated articles
  const topChunk = chunks[0];
  const isBelowThreshold =
    topChunk.similarity < 0.42 && topChunk.keyword_score < 0.20 && topChunk.combined_score < 0.38;

  if (isBelowThreshold) {
    return { text: '', used: [], rewrittenQuery, queries, queryEmbedding, chunks: [], belowThreshold: true };
  }

  // 5. Select only top 3-5 chunks above similarity threshold, and cap context at ~1,500 tokens (~6,000 chars)
  // Long articles (rule lists) were cut before the part that answered.
  const MAX_KNOWLEDGE_CHARS = 9000;
  const eligibleChunks = chunks
    .filter((c, i) => i === 0 || c.similarity >= 0.38 || c.combined_score >= 0.35)
    .slice(0, 5);

  const usedMap = new Map<string, { id: string; title: string; source: 'article' | 'knowledge' }>();
  const blocks: string[] = [];
  const finalChunks: RetrievedChunk[] = [];
  let totalChars = 0;

  for (let idx = 0; idx < eligibleChunks.length; idx++) {
    const c = eligibleChunks[idx];
    const cleanContent = c.content.replace(/^Article:\s*.*?\nSection:\s*.*?\n\n/i, '').trim();

    // No URL for the model: it is told not to write links, and the citation is added by code.
    const lines = [
      `[CHUNK ${idx + 1}]`,
      `Article: ${c.article_title}`,
      `Section: ${c.section_name || 'General'}`,
      '',
      cleanContent,
    ];
    const blockText = lines.join('\n');

    if (totalChars + blockText.length > MAX_KNOWLEDGE_CHARS && blocks.length >= 3) {
      break;
    }

    blocks.push(blockText);
    finalChunks.push(c);
    totalChars += blockText.length;
    usedMap.set(c.article_id, {
      id: c.article_id,
      title: c.article_title,
      source: c.source === 'knowledge' ? 'knowledge' : 'article',
    });
  }

  return {
    text: blocks.join('\n\n---\n\n'),
    used: Array.from(usedMap.values()),
    rewrittenQuery,
    queries,
    queryEmbedding,
    chunks: finalChunks,
    belowThreshold: false,
  };
}
