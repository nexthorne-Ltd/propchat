import 'server-only';
import { unstable_cache } from 'next/cache';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Article, HelpSection, Workspace } from '@/types/database';
import { HELP_KEYS_TAG, helpTag } from '@/lib/help/tags';

export { HELP_KEYS_TAG, helpTag };

/**
 * The public help center's data, read on the server and cached.
 *
 * The pages used to be client components that, after the HTML arrived, ran
 * five or six Supabase queries one after another from the visitor's browser
 * (workspace, sections, articles, theme, article, siblings), and the metadata
 * layouts ran three or four more on the server before any HTML was sent. An
 * article took two to four seconds to appear. Now one cached read serves the
 * metadata and the page, and the browser starts with everything it needs.
 *
 * Reads use the anon key with no session: exactly what any visitor may see
 * (RLS shows published articles only). Each workspace's data is tagged
 * `help:<workspace id>`; the actions that change articles, sections, branding
 * or the design call refreshHelpCenter, so edits show up at once. Without an
 * edit, data is at most HELP_TTL seconds old.
 */

const HELP_TTL = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


let client: SupabaseClient | null = null;
function anon(): SupabaseClient {
  if (!client) {
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '', {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export const HELP_LIST_COLUMNS = 'id, title, slug, summary, section_id, created_at, updated_at, views_count, order_index';

export type HelpListArticle = Pick<
  Article,
  'id' | 'title' | 'slug' | 'summary' | 'section_id' | 'created_at' | 'updated_at' | 'views_count' | 'order_index'
>;
export type HelpSibling = Pick<Article, 'id' | 'title' | 'slug' | 'summary'>;

export interface HelpSite {
  workspace: Workspace;
  theme: Record<string, unknown>;
  sections: HelpSection[];
  articles: HelpListArticle[];
}

export interface HelpArticlePage {
  article: Article;
  siblings: HelpSibling[];
  /** Set when the address was an old slug or a near match: the page shows the current URL. */
  movedFrom: string | null;
}

/** The workspace id for an address segment: id, slug or custom domain. */
export const resolveHelpWorkspaceId = unstable_cache(
  async (key: string): Promise<string | null> => {
    const k = decodeURIComponent(key).trim().toLowerCase();
    if (!k) return null;
    const q = anon().from('public_workspaces').select('id');
    const { data, error } = UUID_RE.test(k)
      ? await q.eq('id', k).limit(1)
      : await q.or(`slug.eq.${k.replace(/[^a-z0-9.-]/g, '')},custom_domain.eq.${k.replace(/[^a-z0-9.-]/g, '')}`).limit(1);
    if (error) throw new Error(`[Help Data] workspace lookup: ${error.message}`);
    return (data?.[0]?.id as string | undefined) ?? null;
  },
  ['help-workspace-id'],
  { revalidate: 3600, tags: [HELP_KEYS_TAG] }
);

/** Workspace, design, collections and the article list: one round of parallel reads. */
export function getHelpSite(workspaceId: string): Promise<HelpSite | null> {
  return unstable_cache(
    async (): Promise<HelpSite | null> => {
      const db = anon();
      const [ws, theme, sections, articles] = await Promise.all([
        db.from('public_workspaces').select('*').eq('id', workspaceId).maybeSingle(),
        // Missing before its migration: the default design is used then.
        db.rpc('fn_help_center_theme', { p_workspace_id: workspaceId }),
        db
          .from('help_sections')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('order_index', { ascending: true })
          .order('created_at', { ascending: true }),
        db
          .from('articles')
          .select(HELP_LIST_COLUMNS)
          .eq('workspace_id', workspaceId)
          .eq('status', 'published')
          .order('order_index', { ascending: true })
          .order('created_at', { ascending: true }),
      ]);
      if (ws.error) throw new Error(`[Help Data] workspace: ${ws.error.message}`);
      if (!ws.data) return null;
      if (sections.error) throw new Error(`[Help Data] sections: ${sections.error.message}`);
      if (articles.error) throw new Error(`[Help Data] articles: ${articles.error.message}`);
      return {
        workspace: ws.data as Workspace,
        theme: (theme.error ? null : (theme.data as Record<string, unknown> | null)) ?? {},
        sections: (sections.data as HelpSection[]) ?? [],
        articles: (articles.data as HelpListArticle[]) ?? [],
      };
    },
    ['help-site', workspaceId],
    { revalidate: HELP_TTL, tags: [helpTag(workspaceId)] }
  )();
}

/** One article by id, slug, old slug or (last resort) title words, with its collection. */
export function getHelpArticle(workspaceId: string, articleKey: string): Promise<HelpArticlePage | null> {
  const key = decodeURIComponent(articleKey).trim();
  return unstable_cache(
    async (): Promise<HelpArticlePage | null> => {
      const db = anon();
      const base = () =>
        db
          .from('articles')
          .select('*, section:help_sections(id, name, slug, icon, order_index)')
          .eq('workspace_id', workspaceId)
          .eq('status', 'published');

      let article: Article | null = null;
      let movedFrom: string | null = null;

      if (UUID_RE.test(key)) {
        const { data } = await base().or(`id.eq.${key},slug.eq.${key}`).limit(1).maybeSingle();
        article = (data as Article) ?? null;
      } else {
        const [bySlug, redirect] = await Promise.all([
          base().ilike('slug', key).limit(1).maybeSingle(),
          db
            .from('article_slug_redirects')
            .select('article_id')
            .eq('workspace_id', workspaceId)
            .ilike('old_slug', key)
            .limit(1)
            .maybeSingle(),
        ]);
        article = (bySlug.data as Article) ?? null;
        if (!article && redirect.data?.article_id) {
          const { data } = await base().eq('id', redirect.data.article_id).maybeSingle();
          article = (data as Article) ?? null;
          if (article) movedFrom = key;
        }
        // A link shared before the article was renamed still has to resolve.
        if (!article) {
          const words = key.replace(/-/g, ' ').replace(/[%_,()]/g, '').trim();
          if (words) {
            const { data } = await base().ilike('title', `%${words}%`).limit(1).maybeSingle();
            article = (data as Article) ?? null;
            if (article) movedFrom = key;
          }
        }
      }
      if (!article) return null;
      if (article.slug && article.slug.toLowerCase() !== key.toLowerCase() && !UUID_RE.test(key)) movedFrom = key;

      const [siblings, author] = await Promise.all([
        article.section_id
          ? db
              .from('articles')
              .select('id, title, slug, summary')
              .eq('workspace_id', workspaceId)
              .eq('section_id', article.section_id)
              .eq('status', 'published')
              .order('order_index', { ascending: true })
              .order('created_at', { ascending: true })
          : Promise.resolve({ data: [] as HelpSibling[] }),
        // Anon cannot read agents; this returns the name and avatar only.
        article.author_id ? db.rpc('fn_help_article_author', { p_article_id: article.id }) : Promise.resolve({ data: null }),
      ]);

      return {
        article: { ...article, author: (author.data as Article['author']) ?? null },
        siblings: (siblings.data as HelpSibling[]) ?? [],
        movedFrom,
      };
    },
    ['help-article', workspaceId, key.toLowerCase()],
    { revalidate: HELP_TTL, tags: [helpTag(workspaceId)] }
  )();
}

/** Both reads for an address, or null when the help center does not exist. */
export async function loadHelpSite(workspaceKey: string): Promise<HelpSite | null> {
  const id = await resolveHelpWorkspaceId(workspaceKey);
  return id ? getHelpSite(id) : null;
}
