import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getWorkspaceHelpCenterUrl } from '@/lib/domain';
import { getHelpArticle, getHelpSite, resolveHelpWorkspaceId } from '@/lib/help/data';

/**
 * Title, description and canonical URL for an article, plus the redirect from
 * an old slug. Both read the same cached data as the page
 * (src/lib/help/data.ts); they used to make three or four database round
 * trips of their own before any HTML was sent.
 */
async function load(workspaceKey: string, articleKey: string) {
  const id = await resolveHelpWorkspaceId(workspaceKey);
  if (!id) return null;
  const [site, page] = await Promise.all([getHelpSite(id), getHelpArticle(id, articleKey)]);
  return site ? { site, page } : null;
}

async function requestHost() {
  const h = await headers();
  return h.get('x-forwarded-host') || h.get('host');
}

function siteIcons(ws: { website_url?: string | null; custom_domain?: string | null; help_center_logo_url?: string | null; logo_url?: string | null }) {
  let domain = '';
  const site = ws.website_url?.trim();
  if (site) {
    try {
      domain = new URL(site.startsWith('http') ? site : `https://${site}`).hostname;
    } catch {
      /* not a URL: no website icon */
    }
  } else if (ws.custom_domain) {
    domain = ws.custom_domain;
  }
  const rawLogo = ws.help_center_logo_url?.trim() || ws.logo_url?.trim() || '';
  const google = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : '';
  const favicon = rawLogo || google || '/favicon.ico';
  const extra = google ? [{ url: google, sizes: '128x128', type: 'image/png' }] : [];
  return { rawLogo, icons: { icon: [{ url: favicon }, ...extra], shortcut: favicon, apple: [{ url: favicon }, ...extra] } };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspaceId: string; articleId: string }>;
}): Promise<Metadata> {
  const { workspaceId, articleId } = await params;
  const data = await load(workspaceId, articleId);
  if (!data) return { title: 'Help Center' };

  const ws = data.site.workspace;
  const helpTitle = ws.help_center_title || ws.name;
  const article = data.page?.article;
  if (!article) return { title: `${helpTitle} Help Center` };

  const title = `${article.title} — ${helpTitle} Help Center`;
  const description = article.summary || `Help article from the ${helpTitle} team.`;
  // One article, two reachable URLs (platform path and the customer's
  // domain), one canonical.
  const canonical = getWorkspaceHelpCenterUrl(ws, article, { host: await requestHost() });
  const { rawLogo, icons } = siteIcons(ws);

  return {
    title,
    description,
    icons,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      siteName: helpTitle,
      type: 'article',
      url: canonical,
      ...(rawLogo ? { images: [{ url: rawLogo }] } : {}),
    },
    twitter: {
      card: 'summary',
      title,
      description,
      ...(rawLogo ? { images: [rawLogo] } : {}),
    },
  };
}

export default async function HelpArticleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string; articleId: string }>;
}) {
  const { workspaceId, articleId } = await params;
  // An old slug (renamed article) answers with a real redirect, so search
  // engines move the ranking to the new address.
  const data = await load(workspaceId, articleId);
  if (data?.page?.movedFrom && data.page.article.slug) {
    redirect(getWorkspaceHelpCenterUrl(data.site.workspace, data.page.article, { host: await requestHost() }));
  }
  return children;
}
