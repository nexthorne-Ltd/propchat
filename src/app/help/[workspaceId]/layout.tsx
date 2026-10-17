import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getWorkspaceHelpCenterUrl } from '@/lib/domain';
import { loadHelpSite } from '@/lib/help/data';

/**
 * The help centre pages render interactive client components, so the
 * workspace's own name, description and icons are set here. Without this the
 * browser tab and search results showed the platform's title on every
 * customer's help centre. Reads the same cached data as the page
 * (src/lib/help/data.ts), so it costs no extra database round trip.
 */
export async function generateMetadata({ params }: { params: Promise<{ workspaceId: string }> }): Promise<Metadata> {
  const { workspaceId } = await params;
  const site = await loadHelpSite(workspaceId);
  if (!site) return { title: 'Help Center' };

  const ws = site.workspace;
  const helpTitle = ws.help_center_title || ws.name;
  const title = `${helpTitle} Help Center`;
  const description = ws.help_center_subtitle || `Guides, troubleshooting steps and answers from the ${helpTitle} team.`;

  // The same help centre is reachable both on the platform path and on the
  // customer's domain. Without a canonical, search engines see two copies of
  // every article and split the ranking between them.
  const h = await headers();
  const canonical = getWorkspaceHelpCenterUrl(ws, null, { host: h.get('x-forwarded-host') || h.get('host') });

  let domain = '';
  const website = ws.website_url?.trim();
  if (website) {
    try {
      domain = new URL(website.startsWith('http') ? website : `https://${website}`).hostname;
    } catch {
      /* not a URL: no website icon */
    }
  } else if (ws.custom_domain) {
    domain = ws.custom_domain;
  }
  const rawLogo = ws.help_center_logo_url?.trim() || ws.logo_url?.trim() || '';
  const google = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : '';
  const faviconUrl = rawLogo || google || '/favicon.ico';
  const extra = google ? [{ url: google, sizes: '128x128', type: 'image/png' }] : [];

  // An empty help centre is not worth indexing yet.
  const hasPublishedArticles = site.articles.length > 0;

  return {
    title: hasPublishedArticles ? title : `${helpTitle} Help Center (Coming Soon)`,
    description: hasPublishedArticles
      ? description
      : `Guides, troubleshooting steps and answers from the ${helpTitle} team are coming soon.`,
    robots: hasPublishedArticles ? undefined : { index: false, follow: false },
    icons: { icon: [{ url: faviconUrl }, ...extra], shortcut: faviconUrl, apple: [{ url: faviconUrl }, ...extra] },
    alternates: { canonical },
    // Nothing here should advertise the platform: this page belongs to the
    // customer's brand, on the customer's domain.
    openGraph: {
      title,
      description,
      siteName: helpTitle,
      type: 'website',
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

export default function HelpCenterLayout({ children }: { children: React.ReactNode }) {
  return children;
}
