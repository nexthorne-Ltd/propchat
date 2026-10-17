import { serviceClient } from '@/lib/supabase/service';
import type { ProviderConfig, ProviderId } from './provider';
import {
  buildIndex,
  search,
  assess,
  extractPassage,
  type HelpIndex,
  type RetrievableArticle,
  type Confidence,
} from './retrieval';
import {
  BOT_KNOWLEDGE_SECTION,
  buildSemanticModelContext,
  hybridSearchWorkspaceChunks,
} from './semantic-retrieval';
import type { RetrievedChunk } from '@/types/database';
import { searchQueriesFor } from './understanding';

/**
 * Answers a customer from the workspace's own help centre, with no model API.
 *
 * The previous no-API path scored articles by counting substring hits and, when
 * something scored above an arbitrary 4, replied with the article's first 220
 * characters followed by an ellipsis. That is not an answer — it is a preview
 * of one — and it fired on questions the documentation did not cover.
 *
 * This picks the article with `retrieval.ts`, refuses to speak when the
 * evidence is thin, and quotes the passage that actually addresses the
 * question. Everything it says is text the workspace owner wrote.
 */

/**
 * Where a piece of knowledge came from: a published article, a team note, or
 * a Bot knowledge entry (private, so never linked or named to the visitor).
 */
export type KnowledgeSource = 'article' | 'note' | 'knowledge';

/** Keyword-index ids of Bot knowledge entries carry this prefix. */
const KNOWLEDGE_PREFIX = 'knowledge:';

/**
 * How sure retrieval is that the help centre answers the question.
 * 'low' means do not answer: there is nothing to quote that fits.
 */
export type RetrievalConfidence = 'high' | 'medium' | 'low';

/** A published article an answer can point the visitor to. */
export interface CitableArticle {
  id: string;
  title: string;
  slug?: string | null;
  /** Public URL, or null when the workspace has no help-centre address. */
  url: string | null;
  /**
   * 'knowledge' for a Bot knowledge entry: it can ground an answer but is not
   * cited, since there is no public page and its title is internal.
   */
  kind?: 'article' | 'knowledge';
}

/** The public URL of an article, or null without a help-centre address. */
export function articleUrl(
  helpCenterUrl: string | null | undefined,
  article: { id: string; slug?: string | null }
): string | null {
  if (!helpCenterUrl) return null;
  return `${helpCenterUrl.replace(/\/$/, '')}/${article.slug || article.id}`;
}

export interface HelpAnswer {
  /** Whether the answer came from a published article or an internal note. */
  source?: KnowledgeSource;
  /** null when the help centre cannot answer — the caller should hand over. */
  text: string | null;
  confidence: Confidence;
  /** The article the answer came from, for citation and analytics. */
  article: { id: string; title: string; slug?: string | null; url?: string | null } | null;
  /** Human-readable explanation of the decision, for logs and tests. */
  reason: string;
  /** Other articles worth offering when the answer is only partial. */
  alternatives: { id: string; title: string; slug?: string | null }[];
}

/**
 * Index cache. Help content changes rarely; questions arrive constantly.
 *
 * Building the index takes three queries and over a second, which blew the
 * reply-time budget once a minute when the entry expired. An expired entry is
 * now served as-is while a fresh one builds in the background, so only the very
 * first question on a cold server waits for it.
 */
const indexCache = new Map<string, { index: HelpIndex; builtAt: number }>();
const rebuilding = new Map<string, Promise<HelpIndex>>();
// Kept short so an edited article is what the assistant answers from within
// seconds. Past STALE_LIMIT_MS the old copy is not served at all: the question
// waits for the rebuild rather than being answered from outdated content.
const INDEX_TTL_MS = 15_000;
const STALE_LIMIT_MS = 120_000;

export function invalidateHelpIndex(workspaceId: string) {
  indexCache.delete(workspaceId);
}

/** Starts loading the index early, so it is ready by the time it is needed. */
export function warmHelpIndex(workspaceId: string): void {
  loadIndex(workspaceId).catch(() => {});
}

/**
 * Section names and article titles, so the intent classifier can tell what
 * this workspace's help centre is about. Empty when nothing is indexed.
 */
export async function helpCenterTopics(workspaceId: string, max = 40): Promise<string[]> {
  try {
    const index = await loadIndex(workspaceId);
    const topics = new Set<string>();
    for (const doc of index.docs) {
      if (doc.article.id.startsWith('note:')) continue;
      if (doc.article.sectionName && !doc.article.id.startsWith(KNOWLEDGE_PREFIX)) topics.add(doc.article.sectionName);
      topics.add(doc.article.title);
      if (topics.size >= max) break;
    }
    return Array.from(topics).slice(0, max);
  } catch {
    return [];
  }
}

/** The whole help centre as the agent-mode prompt sees it. */
export interface FullKnowledge {
  /** "[ARTICLE n]" blocks, in section order. */
  text: string;
  /** sources[n - 1] is [ARTICLE n]. */
  sources: CitableArticle[];
  /** Some articles did not fit the budget and were left out. */
  truncated: boolean;
}

/**
 * Roughly 25k tokens. A prop firm's rules, FAQ and payout policy are usually
 * 20-60 articles and fit whole; past this the articles that matched the
 * question go first and the rest fill what is left.
 */
export const FULL_KNOWLEDGE_MAX_CHARS = 100_000;

/**
 * Every published article (and every 'ready' Bot knowledge entry) of the
 * workspace, for agent mode. Retrieval hands the model five passages, and a
 * rule split across two articles, or a question worded nothing like the
 * article ("DD kitna hai 10k pe"), never reached it: the bot said it could not
 * find the answer while the answer sat in the help centre. Reading the whole
 * help centre, the model can join rules up the way a trained agent does.
 *
 * Team notes are left out, as in every visitor-facing answer. `priorityIds`
 * are placed first when the help centre is over the budget.
 */
export async function loadFullKnowledge(
  workspaceId: string,
  options: {
    helpCenterUrl?: string | null;
    priorityIds?: string[];
    /** Articles whose title or section matches go first: the answering specialist's topic. */
    priorityMatch?: RegExp | null;
    maxChars?: number;
  } = {}
): Promise<FullKnowledge> {
  const index = await loadIndex(workspaceId);
  const maxChars = options.maxChars ?? FULL_KNOWLEDGE_MAX_CHARS;
  const docs = index.docs
    .map((d) => d.article)
    .filter((a) => !a.id.startsWith('note:') && (a.content || '').trim());

  // Articles grouped by section, Bot knowledge last; the order the help centre reads in.
  const isKnowledge = (id: string) => id.startsWith(KNOWLEDGE_PREFIX);
  docs.sort((a, b) => {
    if (isKnowledge(a.id) !== isKnowledge(b.id)) return isKnowledge(a.id) ? 1 : -1;
    return (a.sectionName || '').localeCompare(b.sectionName || '');
  });
  const priority = new Set(options.priorityIds || []);
  const match = options.priorityMatch;
  if (match) {
    for (const d of docs) if (match.test(`${d.title}\n${d.sectionName || ''}`)) priority.add(d.id);
  }
  const ordered = priority.size
    ? [...docs.filter((d) => priority.has(d.id)), ...docs.filter((d) => !priority.has(d.id))]
    : docs;

  const blocks: string[] = [];
  const sources: CitableArticle[] = [];
  let used = 0;
  let truncated = false;
  for (const a of ordered) {
    const knowledge = isKnowledge(a.id);
    const block = [
      `[ARTICLE ${sources.length + 1}]`,
      `Title: ${a.title}`,
      a.sectionName && !knowledge ? `Section: ${a.sectionName}` : null,
      '',
      a.content.trim(),
    ]
      .filter((l) => l !== null)
      .join('\n');
    if (used + block.length > maxChars) {
      truncated = true;
      continue;
    }
    used += block.length;
    blocks.push(block);
    sources.push(
      knowledge
        ? { id: a.id.slice(KNOWLEDGE_PREFIX.length), title: a.title, slug: null, url: null, kind: 'knowledge' }
        : {
            id: a.id,
            title: a.title,
            slug: a.slug ?? null,
            url: articleUrl(options.helpCenterUrl, { id: a.id, slug: a.slug }),
            kind: 'article',
          }
    );
  }
  return { text: blocks.join('\n\n---\n\n'), sources, truncated };
}

function loadIndex(workspaceId: string): Promise<HelpIndex> {
  const cached = indexCache.get(workspaceId);
  if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) return Promise.resolve(cached.index);

  let pending = rebuilding.get(workspaceId);
  if (!pending) {
    pending = buildWorkspaceIndex(workspaceId).finally(() => rebuilding.delete(workspaceId));
    rebuilding.set(workspaceId, pending);
    pending.catch(() => {});
  }
  return cached && Date.now() - cached.builtAt < STALE_LIMIT_MS ? Promise.resolve(cached.index) : pending;
}

/**
 * The published articles and Bot knowledge as the bot reads them in agent
 * mode (team notes left out), built fresh rather than from the cache: the
 * coverage check (coverage.ts) runs right after someone publishes or
 * re-indexes, and must see that change.
 */
export async function freshKnowledgeIndex(workspaceId: string): Promise<HelpIndex> {
  const index = await buildWorkspaceIndex(workspaceId);
  return buildIndex(index.docs.map((d) => d.article).filter((a) => !a.id.startsWith('note:')));
}

async function buildWorkspaceIndex(workspaceId: string): Promise<HelpIndex> {
  const supabase = serviceClient();
  const [{ data: sections }, { data: articles }, { data: notes }, { data: knowledge }] = await Promise.all([
    supabase
      .from('help_sections')
      .select('id, name')
      .eq('workspace_id', workspaceId),
    supabase
      .from('articles')
      .select('id, title, slug, summary, content, category, section_id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'published'),
    // Through an RPC, not a table read: knowledge_notes is behind row level
    // security and this runs on the anonymous key, so a direct select returns
    // nothing. The function returns only notes marked 'assistant', which makes
    // the privacy boundary the database's job rather than this file's.
    supabase.rpc('fn_assistant_notes', { p_workspace_id: workspaceId }),
    // Only entries someone has embedded: 'ready' is the "train the bot on
    // this" step, and an edited entry drops back to 'pending' until re-run.
    supabase
      .from('bot_knowledge')
      .select('id, title, content')
      .eq('workspace_id', workspaceId)
      .eq('status', 'ready'),
  ]);

  const sectionName = new Map((sections || []).map((s) => [s.id, s.name]));
  const docs: RetrievableArticle[] = (articles || []).map((a) => ({
    ...a,
    sectionName: a.section_id ? sectionName.get(a.section_id) ?? null : null,
  }));

  for (const n of notes || []) {
    docs.push({
      // Prefixed so the id cannot collide with an article's and so the source
      // is obvious wherever the id travels.
      id: `note:${n.id}`,
      title: n.title,
      slug: null,
      summary: null,
      content: n.content || '',
      category: null,
      section_id: null,
      sectionName: Array.isArray(n.tags) && n.tags.length ? n.tags.join(' ') : 'Team knowledge',
    });
  }

  for (const k of (knowledge as { id: string; title: string; content: string | null }[] | null) || []) {
    docs.push({
      id: `${KNOWLEDGE_PREFIX}${k.id}`,
      title: k.title,
      slug: null,
      summary: null,
      content: k.content || '',
      category: null,
      section_id: null,
      sectionName: BOT_KNOWLEDGE_SECTION,
    });
  }

  const index = buildIndex(docs);
  indexCache.set(workspaceId, { index, builtAt: Date.now() });
  return index;
}

/**
 * Phrases that mean "stop answering me and fetch a person". Checked before
 * retrieval: however well the documentation matches, it is not what was asked
 * for.
 */
const HUMAN_REQUEST =
  // A bare "agent" is not on the list: traders say "EA" and "trading agent",
  // and each false match turns the assistant off for the whole conversation.
  /\b(human|real person|(?:real|live|human) agent|representative|operator|live (?:support|person)|(?:talk|speak) (?:to|with) (?:someone|a human|a person|an agent|support)|customer care|jonli\s+(?:odam|operator|xodim)|odam\s+bilan\s+gaplash\w*|xodim\s+bilan\s+gaplash\w*)\b/i;

/** Arabic has no \b in JS regex, so its phrases are matched on their own. */
const HUMAN_REQUEST_AR =
  /موظف|شخص حقيقي|إنسان حقيقي|انسان حقيقي|التحدث مع (?:شخص|موظف|إنسان|انسان|الدعم)|خدمة العملاء|وكيل بشري/;

export function wantsHuman(message: string): boolean {
  return HUMAN_REQUEST.test(message) || HUMAN_REQUEST_AR.test(message);
}

export interface AnswerRequest {
  workspaceId: string;
  message: string;
  /** Recorded against the gap so the owner can read it in context. */
  conversationId?: string | null;
  /** Earlier visitor turns, most recent first. */
  history?: string[];
  recentMessages?: { sender_type?: string; role?: string; content?: string }[];
  /** Used to open the reply; omitted when unknown. */
  visitorName?: string | null;
  /** Where the help centre lives, so the answer can link to the full article. */
  helpCenterUrl?: string | null;
  chunks?: RetrievedChunk[];
  belowThreshold?: boolean;
  queryEmbedding?: number[] | null;
  intent?: string;
  providerConfig?: ProviderConfig | null;
  /**
   * Answer from published articles only, never from team notes. A visitor
   * asking a help-centre question gets an answer they can verify by following
   * the citation; a team note has nothing to link to. Bot knowledge entries
   * still count: the team wrote them for the bot to answer from.
   */
  articlesOnly?: boolean;
  /** Scores at which the top passage may be quoted (learning/policy.ts). */
  highConfidence?: { similarity: number; combined: number };
}

/**
 * Logs a question the help centre could not answer.
 * If an embedding is provided, groups near-duplicate gaps semantically via pgvector.
 *
 * Deliberately fire-and-forget and deliberately silent on failure: a customer
 * waiting on a reply must not wait on analytics, and a broken log must not
 * break the conversation.
 */
export async function recordUnanswered(
  workspaceId: string,
  question: string,
  reason: string,
  conversationId?: string | null,
  embedding?: number[] | null
): Promise<void> {
  try {
    const supabase = serviceClient();
    await supabase.rpc('fn_record_or_increment_unanswered_question', {
      p_workspace_id: workspaceId,
      p_question: question.slice(0, 1000),
      p_conversation_id: conversationId ?? null,
      p_embedding: embedding && embedding.length > 0 ? embedding : null,
      p_reason: reason,
      p_similarity_threshold: 0.88,
    });
  } catch {
    /* never let bookkeeping affect the reply */
  }
}

const recordGap = (req: AnswerRequest, reason: string) => {
  // Handover Rule 4: Only log a knowledge gap for intent "question" with no answer.
  if (req.intent && req.intent !== 'question' && req.intent !== 'help_center_question') {
    return Promise.resolve();
  }
  return recordUnanswered(req.workspaceId, req.message, reason, req.conversationId, req.queryEmbedding);
};

export async function answerFromHelpCenter(
  req: AnswerRequest
): Promise<HelpAnswer> {
  // Asking for a person is not a gap in the documentation — logging it would
  // fill the backlog with "can I talk to someone".
  if (wantsHuman(req.message)) {
    return {
      text: null,
      confidence: 'none',
      article: null,
      reason: 'customer asked for a human',
      alternatives: [],
    };
  }

  // Never send an article when similarity is below threshold
  if (req.belowThreshold) {
    void recordGap(req, 'below threshold');
    return {
      text: null,
      confidence: 'none',
      article: null,
      reason: 'semantic similarity below threshold',
      alternatives: [],
    };
  }

  // If semantic retrieval provided chunks:
  // Show the single best article ONLY when similarity is high; otherwise return null ("not sure" reply)
  if (req.chunks && req.chunks.length > 0) {
    const topChunk = req.chunks[0];
    const isHighSimilarity =
      topChunk.similarity >= (req.highConfidence?.similarity ?? HIGH_SIMILARITY) ||
      topChunk.combined_score >= (req.highConfidence?.combined ?? HIGH_COMBINED_SCORE);

    if (isHighSimilarity) {
      const cleanContent = topChunk.content
        .replace(/^Article:\s*.*?\nSection:\s*.*?\n\n/i, '')
        .trim();
      const isKnowledge = topChunk.source === 'knowledge';
      const link = isKnowledge ? null : articleUrl(req.helpCenterUrl, { id: topChunk.article_id, slug: topChunk.article_slug });

      // The caller appends the citation, so every answer path cites the same way.
      const body = cleanContent.replace(/^\s*•\s+/gm, '- ').replace(/\n{3,}/g, '\n\n');

      return {
        text: body,
        source: isKnowledge ? 'knowledge' : 'article',
        confidence: 'high',
        article: { id: topChunk.article_id, title: topChunk.article_title, slug: topChunk.article_slug, url: link },
        reason: `semantic hybrid high match (score: ${topChunk.combined_score.toFixed(2)}, similarity: ${topChunk.similarity.toFixed(2)})`,
        alternatives: [], // Single best article only
      };
    } else {
      // Similarity is not high -> refuse to show article, fall back to "not sure" reply
      void recordGap(req, `similarity not high enough for no-api fallback (${topChunk.similarity.toFixed(2)})`);
      return {
        text: null,
        confidence: 'none',
        article: null,
        reason: 'similarity not high enough for fallback',
        alternatives: [],
      };
    }
  }

  const index = await loadIndex(req.workspaceId);
  const hits = search(index, req.message, { history: req.history, limit: req.articlesOnly ? 8 : 4 })
    .filter((h) => !req.articlesOnly || !h.article.id.startsWith('note:'))
    .slice(0, 4);
  const verdict = assess(hits, req.message);

  // In no-API fallback, only show single best article when confidence is high
  if (verdict.confidence !== 'high' || !verdict.hit) {
    void recordGap(req, verdict.reason);
    return {
      text: null,
      confidence: 'none',
      article: verdict.hit
        ? {
            id: verdict.hit.article.id,
            title: verdict.hit.article.title,
            slug: verdict.hit.article.slug,
          }
        : null,
      reason: verdict.reason,
      alternatives: [],
    };
  }

  const article = verdict.hit.article;
  const passage = extractPassage(article.content, req.message, {
    history: req.history,
    maxChars: 700,
  });

  if (!passage) {
    return {
      text: null,
      confidence: 'none',
      article: { id: article.id, title: article.title, slug: article.slug },
      reason: 'matched an article with no readable body',
      alternatives: [],
    };
  }

  const isNote = article.id.startsWith('note:');
  const isKnowledge = article.id.startsWith(KNOWLEDGE_PREFIX);
  const link = isNote || isKnowledge ? null : articleUrl(req.helpCenterUrl, article);

  const body = passage
    .replace(/^\s*•\s+/gm, '- ')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}.*$/gm, '')
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_row, cells: string) => {
      const [first, ...rest] = cells.split('|').map((c) => c.trim());
      return rest.length ? `- **${first}:** ${rest.join(' · ')}` : `- ${first}`;
    })
    .replace(/\n{3,}/g, '\n\n');

  return {
    text: body,
    source: isNote ? 'note' : isKnowledge ? 'knowledge' : 'article',
    confidence: 'high',
    article: { id: article.id, title: article.title, slug: article.slug, url: link },
    reason: verdict.reason,
    alternatives: [],
  };
}


/* ── Context for a language model ─────────────────────────────────────── */

const MODEL_CONTEXT_TOP_CHARS = 4500;
const MODEL_CONTEXT_OTHER_CHARS = 1800;

export interface ModelContext {
  /** The documentation to put in front of the model. Empty when nothing fits. */
  text: string;
  /** What went in, for citation and for logging what the answer was based on. */
  used: { id: string; title: string; source: KnowledgeSource }[];
}

export interface RetrievedContext extends ModelContext {
  rewrittenQuery?: string;
  queryEmbedding?: number[] | null;
  chunks?: RetrievedChunk[];
  belowThreshold?: boolean;
  /** How well the best passage fits the question. */
  confidence: RetrievalConfidence;
  /**
   * The article behind each numbered block in `text`: `sources[0]` is
   * `[CHUNK 1]`. Team-note blocks have no entry and are numbered after these.
   */
  sources: CitableArticle[];
}

/** Semantic scores at which the top passage counts as a direct answer. */
const HIGH_SIMILARITY = 0.65;
const HIGH_COMBINED_SCORE = 0.55;

/**
 * The passages a model should be given to answer this question.
 * Uses semantic retrieval (rewrites query, embeds, and executes pgvector hybrid search).
 * Falls back to BM25 index if semantic retrieval is unavailable or empty.
 */
export async function buildModelContext(
  workspaceId: string,
  question: string,
  options: {
    history?: string[];
    turns?: { role: 'user' | 'assistant'; content: string }[];
    recentMessages?: { sender_type?: string; role?: string; content?: string }[];
    limit?: number;
    providerConfig?: ProviderConfig | null;
    helpCenterUrl?: string | null;
    /** Published articles and Bot knowledge only; team notes are left out. */
    articlesOnly?: boolean;
    /** The visitor message's embedding, when the caller already has it. */
    queryEmbedding?: number[] | null;
    /** Scores at which the top passage counts as a direct answer (learning/policy.ts). */
    highConfidence?: { similarity: number; combined: number };
  } = {}
): Promise<RetrievedContext> {
  // The live keyword index reads the published articles and the team's
  // assistant notes straight from the database, so it always reflects the
  // help centre as it is now. It runs alongside semantic search: it is the
  // fallback when semantic search finds nothing (no embedding key, chunks not
  // synced yet), and the only source for team notes, which have no chunks.
  const indexPromise = loadIndex(workspaceId).catch(() => null);

  // 1. Primary: Semantic Retrieval with pgvector & query rewriting
  let rewrittenQuery: string | undefined;
  let searchedQueries: string[] = [];
  let queryEmbedding: number[] | null | undefined;
  try {
    const messages = options.recentMessages || options.turns || (options.history || []).map((h) => ({ role: 'user', content: h }));
    const semantic = await buildSemanticModelContext({
      workspaceId,
      visitorMessage: question,
      recentMessages: messages,
      providerConfig: options.providerConfig,
      limit: options.limit ?? 6,
      helpCenterUrl: options.helpCenterUrl,
      messageEmbedding: options.queryEmbedding,
    });
    rewrittenQuery = semantic.rewrittenQuery;
    searchedQueries = semantic.queries ?? [];
    queryEmbedding = semantic.queryEmbedding;

    if (!semantic.belowThreshold && semantic.text) {
      const top = semantic.chunks[0];
      const confidence: RetrievalConfidence =
        top &&
        (top.similarity >= (options.highConfidence?.similarity ?? HIGH_SIMILARITY) ||
          top.combined_score >= (options.highConfidence?.combined ?? HIGH_COMBINED_SCORE))
          ? 'high'
          : 'medium';
      const sources: CitableArticle[] = semantic.chunks.map((c) =>
        c.source === 'knowledge'
          ? { id: c.article_id, title: c.article_title, slug: null, url: null, kind: 'knowledge' }
          : {
              id: c.article_id,
              title: c.article_title,
              slug: c.article_slug ?? null,
              url: articleUrl(options.helpCenterUrl, { id: c.article_id, slug: c.article_slug }),
              kind: 'article',
            }
      );

      // Add team notes that match, which semantic search cannot see.
      const index = options.articlesOnly ? null : await indexPromise;
      const noteHits = index
        ? search(index, `${rewrittenQuery || ''}\n${question}`, { history: options.history, limit: 4 })
            .filter((h) => h.article.id.startsWith('note:') && h.score >= 1)
            .slice(0, 2)
        : [];
      const noteBlocks = noteHits.map((h, i) =>
        [`[TEAM NOTE ${i + 1}]`, `Title: ${h.article.title}`, '', h.article.content].join('\n')
      );
      return {
        text: [semantic.text, ...noteBlocks].join('\n\n---\n\n'),
        used: [
          ...semantic.used,
          ...noteHits.map((h) => ({ id: h.article.id, title: h.article.title, source: 'note' as KnowledgeSource })),
        ],
        rewrittenQuery,
        queryEmbedding,
        chunks: semantic.chunks,
        belowThreshold: false,
        confidence,
        sources,
      };
    }
  } catch (err) {
    console.warn('[Semantic Retrieval] buildModelContext fallback to keyword index:', err);
  }

  const nothing = (): RetrievedContext => ({
    text: '',
    used: [],
    belowThreshold: true,
    rewrittenQuery,
    queryEmbedding,
    confidence: 'low',
    sources: [],
  });

  // 2. Keyword index: semantic search found nothing usable.
  const index = await indexPromise;
  if (!index) return nothing();
  // Search with the English rewrite as well as the visitor's own words, so a
  // question in Roman Urdu or Spanish still meets English articles.
  // Every reading counts: the model's queries, or the rules' normalised one
  // (understanding.ts) when there was no model, so shorthand and typos meet
  // the articles too.
  const readings = searchedQueries.length ? searchedQueries : searchQueriesFor(question, rewrittenQuery ? [rewrittenQuery] : []);
  const searchText = [...new Set([...readings, question])].join('\n');
  const limit = options.limit ?? 4;
  const hits = search(index, searchText, {
    history: options.history,
    limit: options.articlesOnly ? limit * 2 : limit,
  })
    .filter((h) => !options.articlesOnly || !h.article.id.startsWith('note:'))
    .slice(0, limit);

  // Only what plausibly relates
  const relevant = hits.filter((h) => h.score >= 1);
  if (relevant.length === 0) return nothing();

  const verdict = assess(hits, searchText);
  const confidence: RetrievalConfidence =
    verdict.confidence === 'high' ? 'high' : verdict.confidence === 'medium' ? 'medium' : 'low';

  const budgets = [MODEL_CONTEXT_TOP_CHARS, ...Array(relevant.length).fill(MODEL_CONTEXT_OTHER_CHARS)];

  const used: ModelContext['used'] = [];
  const sources: CitableArticle[] = [];
  const blocks = relevant.map((h, i) => {
    const a = h.article;
    const isNote = a.id.startsWith('note:');
    const isKnowledge = a.id.startsWith(KNOWLEDGE_PREFIX);
    used.push({ id: a.id, title: a.title, source: isNote ? 'note' : isKnowledge ? 'knowledge' : 'article' });

    const url = isNote || isKnowledge ? null : articleUrl(options.helpCenterUrl, a);
    sources.push({ id: a.id, title: a.title, slug: a.slug ?? null, url, kind: isKnowledge ? 'knowledge' : 'article' });

    const body =
      a.content.length <= budgets[i]
        ? a.content
        : extractPassage(a.content, question, {
            history: options.history,
            maxChars: budgets[i],
          });

    const lines = [
      `[CHUNK ${i + 1}]`,
      `Article: ${a.title}`,
      `Section: ${a.sectionName || 'General'}`,
    ];
    // No URL for the model: it is told not to write links, and the citation is added by code.
    lines.push('', a.summary ? `${a.summary}\n\n${body}` : body);
    return lines.join('\n');
  });

  return {
    text: blocks.join('\n\n---\n\n'),
    used,
    belowThreshold: false,
    rewrittenQuery,
    queryEmbedding,
    confidence,
    sources,
  };
}


/**
 * Deprecated workspace-level helper. Model credentials are now exclusively
 * managed at the platform level via platform_ai_settings.
 */
export function providerConfigFrom(
  _aiSettings?: Record<string, any> | null
): ProviderConfig | null {
  return null;
}
