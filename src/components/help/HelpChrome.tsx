'use client';

import React from 'react';
import { ExternalLink, MessageCircle, Search } from 'lucide-react';
import { Workspace } from '@/types/database';
import { isHelpPreview } from '@/components/help/HelpTheme';

/**
 * Shared shell for the public help centre.
 *
 * The index and the article page used to be built independently — one hardcoded
 * zinc colours, the other used the app's design tokens — so moving between them
 * changed the background, the header height and the type scale. Both render
 * through here now, which is also the only place the customer's brand colour is
 * turned into CSS.
 */

/** Reads the workspace's brand colour, falling back to a neutral indigo. */
export function brandOf(workspace: Workspace | null | undefined): string {
  const c = workspace?.brand_color?.trim();
  return c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : '#2E5BFF';
}

/** Header links the owner configured, ignoring malformed rows. */
export function headerLinksOf(
  workspace: Workspace | null | undefined
): { label: string; url: string; target?: string }[] {
  const raw = workspace?.help_center_header_links;
  if (!Array.isArray(raw)) return [];
  return raw.filter((l: unknown): l is { label: string; url: string; target?: string } => {
    const row = l as { label?: unknown; url?: unknown } | null;
    return typeof row?.label === 'string' && typeof row?.url === 'string';
  });
}

export function helpTitleOf(workspace: Workspace | null | undefined): string {
  return workspace?.help_center_title || workspace?.name || 'Help Center';
}

/** Resolves the logo to display on the page: explicit help logo, workspace logo, or website icon. */
export function logoOf(workspace: Workspace | null | undefined): string | null {
  if (!workspace) return null;
  const explicit = workspace.help_center_logo_url?.trim() || workspace.logo_url?.trim();
  if (explicit) return explicit;
  if (workspace.website_url?.trim()) {
    try {
      const u = new URL(
        workspace.website_url.trim().startsWith('http')
          ? workspace.website_url.trim()
          : `https://${workspace.website_url.trim()}`
      );
      return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=128`;
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolves the favicon URL for browser tabs. */
export function faviconOf(workspace: Workspace | null | undefined): string {
  if (!workspace) return '/favicon.ico';
  const explicit = workspace.help_center_logo_url?.trim() || workspace.logo_url?.trim();
  if (explicit) return explicit;
  if (workspace.website_url?.trim()) {
    try {
      const u = new URL(
        workspace.website_url.trim().startsWith('http')
          ? workspace.website_url.trim()
          : `https://${workspace.website_url.trim()}`
      );
      return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=128`;
    } catch {
      // ignore
    }
  }
  return '/favicon.ico';
}

/** Dynamically sets the browser tab favicon to match the workspace/website brand. */
export function useHelpFavicon(workspace: Workspace | null | undefined) {
  React.useEffect(() => {
    if (!workspace || typeof document === 'undefined') return;
    const iconUrl = faviconOf(workspace);
    if (!iconUrl) return;

    let link = document.querySelector<HTMLLinkElement>("link[rel*='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = iconUrl;

    let appleLink = document.querySelector<HTMLLinkElement>("link[rel='apple-touch-icon']");
    if (!appleLink) {
      appleLink = document.createElement('link');
      appleLink.rel = 'apple-touch-icon';
      document.head.appendChild(appleLink);
    }
    appleLink.href = iconUrl;
  }, [workspace]);
}

/** Opens the embedded chat widget if it has loaded. */
export function openChat() {
  const w = window as unknown as { Zentry?: { open?: () => void }; Chatify?: { open?: () => void } };
  (w.Zentry?.open || w.Chatify?.open)?.();
}

/** Copies text, reporting whether it worked rather than assuming it did. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Minutes to read, from the article body. */
export function readingTime(content: string | null | undefined): string {
  const words = (content || '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return '1 min read';
  return `${Math.max(1, Math.round(words / 200))} min read`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

interface HelpHeaderProps {
  workspace: Workspace;
  /** Rendered at the far left, before the brand — e.g. a back button. */
  leading?: React.ReactNode;
  /** Rendered just before the configured links — e.g. Share. */
  trailing?: React.ReactNode;
  onHome: () => void;
  /** Shows a search button (pages without the hero search). */
  onSearch?: () => void;
}

/**
 * Top bar: brand, configured links, and a chat button. Colours come from the
 * design (.hc-header in HelpTheme.tsx), so it works on a dark or a light bar.
 */
export function HelpHeader({ workspace, leading, trailing, onHome, onSearch }: HelpHeaderProps) {
  useHelpFavicon(workspace);
  const title = helpTitleOf(workspace);
  const logo = logoOf(workspace);
  const links = headerLinksOf(workspace);

  // When a logo image fails to load (404, network error, or invalid path),
  // fall back gracefully to the workspace initial.
  // Remembering which URL failed resets the fallback when the logo changes.
  const [failedLogo, setFailedLogo] = React.useState<string | null>(null);
  const logoFailed = failedLogo !== null && failedLogo === logo;

  // The website link is only shown when the owner actually gave one. It used to
  // fall back to a hardcoded URL belonging to one specific customer, which
  // every other workspace then advertised as its own website.
  const website = workspace.website_url?.trim();
  const websiteHref = website && (website.startsWith('http') ? website : `https://${website}`);

  return (
    <header className="hc-header sticky top-0 z-40">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center gap-3">
        {leading}

        <button type="button" onClick={onHome} className="flex items-center gap-3 min-w-0 cursor-pointer text-left">
          {logo && !logoFailed ? (
            <img
              src={logo}
              alt={title}
              onError={() => setFailedLogo(logo)}
              className="h-8 sm:h-9 w-auto max-h-9 max-w-[150px] sm:max-w-[180px] object-contain shrink-0"
            />
          ) : (
            <span className="hc-btn w-8 h-8 text-ui font-bold shrink-0">{(title?.trim()?.[0] || 'W').toUpperCase()}</span>
          )}
          <span className="text-md font-semibold truncate">{title}</span>
        </button>

        <div className="flex-1" />

        <nav className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {onSearch && (
            <button
              type="button"
              onClick={onSearch}
              aria-label="Search articles"
              className="hc-header-link inline-flex items-center gap-1.5 h-9 px-2.5 text-ui font-medium cursor-pointer"
            >
              <Search className="w-4 h-4" />
              <span className="hidden md:inline">Search</span>
            </button>
          )}

          {trailing}

          {links.map((link, i) => (
            <a
              key={i}
              href={link.url}
              target={link.target || '_blank'}
              rel={link.target === '_self' ? undefined : 'noreferrer'}
              className="hc-header-link hidden sm:inline-flex items-center gap-1 px-2.5 h-9 text-ui font-medium"
            >
              {link.label}
            </a>
          ))}

          {websiteHref && links.length === 0 && (
            <a
              href={websiteHref}
              target="_blank"
              rel="noreferrer"
              className="hc-header-link hidden sm:inline-flex items-center gap-1.5 px-2.5 h-9 text-ui font-medium"
            >
              <span>Website</span>
              <ExternalLink className="w-3.5 h-3.5 opacity-60" />
            </a>
          )}

          <button type="button" onClick={openChat} className="hc-btn h-9 px-3.5 text-ui ml-1 cursor-pointer">
            <MessageCircle className="w-4 h-4" />
            <span className="hidden sm:inline">Contact us</span>
          </button>
        </nav>
      </div>
    </header>
  );
}

export function HelpFooter({ workspace }: { workspace: Workspace }) {
  const title = helpTitleOf(workspace);

  return (
    <footer className="hc-footer mt-auto border-t hc-line pt-6 pb-28 sm:pb-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs hc-muted">
        <span>{workspace.help_center_footer_text || `© ${new Date().getFullYear()} ${title}. All rights reserved.`}</span>
        <span>
          Powered by <span className="font-medium hc-ink2">Zen-try</span>
        </span>
      </div>
    </footer>
  );
}

/**
 * The chat widget, loaded once per page. Not in the settings preview: it
 * would register the owner as a visitor every time they change a colour.
 */
export function HelpWidget({ workspace, color }: { workspace: Workspace; color?: string }) {
  const [preview] = React.useState(isHelpPreview);
  if (preview) return null;
  return (
    <script
      async
      src="/widget.js"
      data-workspace-id={workspace.id}
      data-color={color || brandOf(workspace)}
      data-title={`${workspace.name} Support`}
    />
  );
}
