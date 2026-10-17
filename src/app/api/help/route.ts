import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspaceId');
    const search = searchParams.get('search')?.toLowerCase().trim();
    const articleId = searchParams.get('articleId');
    const sectionId = searchParams.get('sectionId');

    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const supabase = await createClient();

    // 1. Fetch Workspace Public Branding
    const { data: workspace, error: wsErr } = await supabase
      .from('public_workspaces')
      .select('id, name, website_url, brand_color, logo_url, greeting_title')
      .eq('id', workspaceId)
      .maybeSingle();

    if (wsErr || !workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // 2. Fetch Single Article if requested
    if (articleId) {
      const cleanArticleId = decodeURIComponent(articleId).trim();
      const isArtUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanArticleId);
      const artQuery = supabase
        .from('articles')
        .select('*, author:agents(id, name, avatar_url), section:help_sections(id, name, icon)')
        .eq('workspace_id', workspaceId)
        .eq('status', 'published');

      let { data: article, error: artErr } = isArtUuid
        ? await artQuery.or(`id.eq.${cleanArticleId},slug.eq.${cleanArticleId}`).maybeSingle()
        : await artQuery.ilike('slug', cleanArticleId).maybeSingle();

      if (!article && !isArtUuid) {
        const { data: redir } = await supabase
          .from('article_slug_redirects')
          .select('article_id')
          .eq('workspace_id', workspaceId)
          .ilike('old_slug', cleanArticleId)
          .maybeSingle();

        if (redir?.article_id) {
          const { data: targetArt } = await artQuery.eq('id', redir.article_id).maybeSingle();
          if (targetArt) {
            article = targetArt;
            artErr = null;
          }
        }
      }

      if (artErr || !article) {
        return NextResponse.json({ error: 'Article not found' }, { status: 404 });
      }

      return NextResponse.json({ workspace, article });
    }

    // 3. Fetch Sections
    const { data: sections } = await supabase
      .from('help_sections')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('order_index', { ascending: true })
      .order('created_at', { ascending: true });

    // 4. Fetch Published Articles
    let query = supabase
      .from('articles')
      .select('id, workspace_id, section_id, title, slug, category, summary, content, views_count, helpful_count, not_helpful_count, order_index, created_at, updated_at, author:agents(id, name, avatar_url), section:help_sections(id, name, icon)')
      .eq('workspace_id', workspaceId)
      .eq('status', 'published')
      .order('order_index', { ascending: true })
      .order('created_at', { ascending: true });

    if (sectionId) {
      query = query.eq('section_id', sectionId);
    }

    const { data: articles, error: artErr } = await query;
    if (artErr) {
      return NextResponse.json({ error: artErr.message }, { status: 500 });
    }

    let filteredArticles = articles || [];
    if (search) {
      filteredArticles = filteredArticles.filter(
        (a) =>
          a.title.toLowerCase().includes(search) ||
          a.summary?.toLowerCase().includes(search) ||
          a.content.toLowerCase().includes(search) ||
          a.category?.toLowerCase().includes(search)
      );
    }

    // Map section counts
    const countMap: Record<string, number> = {};
    (articles || []).forEach((a) => {
      if (a.section_id) {
        countMap[a.section_id] = (countMap[a.section_id] || 0) + 1;
      }
    });

    const sectionsWithCount = (sections || []).map((s) => ({
      ...s,
      article_count: countMap[s.id] || 0,
    }));

    return NextResponse.json({
      workspace,
      sections: sectionsWithCount,
      articles: filteredArticles,
      totalCount: filteredArticles.length,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
