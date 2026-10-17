import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getWorkspaceHelpCenterUrl } from '@/lib/domain';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await context.params;
    const supabase = await createClient();

    // 1. Fetch workspace by UUID, slug, or custom domain
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId);
    const { data: ws } = isUuid
      ? await supabase.from('public_workspaces').select('*').eq('id', workspaceId).maybeSingle()
      : await supabase.from('public_workspaces').select('*').or(`slug.eq.${workspaceId},custom_domain.eq.${workspaceId}`).maybeSingle();

    if (!ws) {
      return new NextResponse('Workspace not found', { status: 404 });
    }

    // 2. Fetch published articles
    const { data: articles } = await supabase
      .from('articles')
      .select('id, slug, updated_at, created_at')
      .eq('workspace_id', ws.id)
      .eq('status', 'published')
      .order('updated_at', { ascending: false });

    // 3. Build XML sitemap using the domain this request actually arrived on,
    // so a help centre reached at help.acme.com advertises help.acme.com.
    const host =
      request.headers.get('x-forwarded-host') || request.headers.get('host');
    const baseUrl = getWorkspaceHelpCenterUrl(ws, null, { host });

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`;

    (articles || []).forEach((art) => {
      const artUrl = getWorkspaceHelpCenterUrl(ws, art, { host });
      const date = (art.updated_at || art.created_at || new Date().toISOString()).split('T')[0];
      xml += `
  <url>
    <loc>${artUrl}</loc>
    <lastmod>${date}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
    });

    xml += `\n</urlset>`;

    return new NextResponse(xml, {
      headers: {
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=59',
      },
    });
  } catch (err: any) {
    console.error('Error generating sitemap:', err);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
