'use client';

import React from 'react';
import type { Workspace } from '@/types/database';
import { helpFontsHref, helpThemeVars, resolveHelpTheme, type ResolvedHelpTheme } from '@/lib/help/theme';

/**
 * Applies a workspace's help center design (src/lib/help/theme.ts) to the
 * public pages.
 *
 * The design becomes CSS variables on one root element. The app's own design
 * tokens (--ds-*) are pointed at those variables inside the root, so shared
 * components such as the article renderer follow the design too, including a
 * dark body.
 *
 * Live preview: Settings → Help Center → Design shows the real help center in
 * an iframe named PREVIEW_FRAME_NAME and posts the unsaved design to it. A
 * frame's name survives navigation, so the preview keeps the unsaved design
 * when the owner clicks through to a collection or an article. Only messages
 * from this same origin are accepted.
 */

export const PREVIEW_FRAME_NAME = 'zentry-help-preview';
export const PREVIEW_MESSAGE = 'zentry:help-theme';
export const PREVIEW_READY = 'zentry:help-preview-ready';

/** True inside the settings preview frame. */
export function isHelpPreview(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.name === PREVIEW_FRAME_NAME && window.parent !== window;
  } catch {
    return false;
  }
}

/**
 * The resolved design for a workspace: the saved one (read on the server with
 * the page, see src/lib/help/data.ts), replaced by the unsaved one while
 * previewing.
 */
export function useHelpTheme(
  workspace: Workspace | null,
  saved: unknown
): { theme: ResolvedHelpTheme; preview: boolean } {
  const [draft, setDraft] = React.useState<unknown>(undefined);
  const [preview] = React.useState(isHelpPreview);

  React.useEffect(() => {
    if (!preview) return;
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const msg = e.data as { type?: string; theme?: unknown } | null;
      if (msg?.type === PREVIEW_MESSAGE) setDraft(msg.theme ?? {});
    }
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: PREVIEW_READY }, window.location.origin);
    return () => window.removeEventListener('message', onMessage);
  }, [preview]);

  const theme = React.useMemo(
    () => resolveHelpTheme(draft !== undefined ? draft : saved, workspace?.brand_color),
    [draft, saved, workspace?.brand_color]
  );
  return { theme, preview };
}

/** The design's root: variables, fonts, base styles and the owner's CSS. */
export function HelpThemeRoot({
  theme,
  className,
  children,
}: {
  theme: ResolvedHelpTheme;
  className?: string;
  children: React.ReactNode;
}) {
  const fonts = helpFontsHref(theme);
  return (
    <div className={`hc-root min-h-screen flex flex-col ${className ?? ''}`} style={helpThemeVars(theme) as React.CSSProperties}>
      {fonts && <link rel="stylesheet" href={fonts} precedence="default" />}
      <style>{HELP_CSS}</style>
      {theme.custom_css && <style data-help-custom-css>{theme.custom_css}</style>}
      {children}
    </div>
  );
}

/**
 * Base styles for every help center surface. Classes rather than one-off
 * utilities, so the owner's custom CSS has stable names to target:
 * .hc-header, .hc-hero, .hc-card, .hc-btn, .hc-collection, .hc-article ...
 */
const HELP_CSS = `
.hc-root{
  --ds-canvas:var(--hc-page);--ds-canvas-alt:var(--hc-page);
  --ds-surface:var(--hc-card);--ds-surface-2:var(--hc-hover);--ds-surface-3:var(--hc-hover);
  --ds-ink:var(--hc-ink);--ds-ink-2:var(--hc-ink-2);--ds-ink-3:var(--hc-ink-3);
  --ds-line:var(--hc-line);--ds-line-2:var(--hc-line);--ds-line-3:var(--hc-line);
  --ds-accent:var(--hc-accent-text);--ds-accent-hover:var(--hc-accent-text);
  --ds-accent-ink:var(--hc-on-accent);
  --ds-accent-soft:color-mix(in srgb,var(--hc-accent) 12%,transparent);
  --ds-accent-line:color-mix(in srgb,var(--hc-accent) 35%,transparent);
  background:var(--hc-page);color:var(--hc-ink);font-family:var(--hc-font);
  -webkit-font-smoothing:antialiased;
}
.hc-root h1,.hc-root h2,.hc-root h3,.hc-root h4{font-family:var(--hc-heading-font)}
.hc-root ::selection{background:color-mix(in srgb,var(--hc-accent) 25%,transparent)}
.hc-root :focus-visible{outline:2px solid var(--hc-accent);outline-offset:2px}

.hc-header{background:var(--hc-header-bg);color:var(--hc-header-fg);
  border-bottom:1px solid color-mix(in srgb,var(--hc-header-fg) 10%,transparent)}
.hc-header-link{color:color-mix(in srgb,var(--hc-header-fg) 72%,transparent);border-radius:var(--hc-radius-sm)}
.hc-header-link:hover{color:var(--hc-header-fg);background:color-mix(in srgb,var(--hc-header-fg) 8%,transparent)}

.hc-hero{background:var(--hc-hero-bg);color:var(--hc-hero-fg)}
.hc-hero :where(h1,h2,h3,h4),.hc-header :where(h1,h2,h3,h4){color:inherit}
.hc-hero-muted{color:color-mix(in srgb,var(--hc-hero-fg) 70%,transparent)}
.hc-hero[data-style="image"] h1,.hc-hero[data-style="image"] p{text-shadow:0 1px 12px rgba(0,0,0,.35)}
.hc-search{background:var(--hc-card);color:var(--hc-ink);border:1px solid var(--hc-line);
  border-radius:var(--hc-radius);box-shadow:0 10px 30px -12px rgba(0,0,0,.35)}
.hc-search:focus-within{border-color:var(--hc-accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--hc-accent) 22%,transparent),0 10px 30px -12px rgba(0,0,0,.35)}
.hc-search input::placeholder{color:var(--hc-ink-3)}

.hc-card{background:var(--hc-card);border:1px solid var(--hc-card-border);border-radius:var(--hc-radius);box-shadow:var(--hc-card-shadow)}
.hc-card-link{transition:border-color .15s,box-shadow .15s,transform .15s}
.hc-card-link:hover{border-color:color-mix(in srgb,var(--hc-accent) 45%,var(--hc-line));
  box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 28px -14px rgba(0,0,0,.25);transform:translateY(-1px)}
.hc-row{border-radius:var(--hc-radius-sm);transition:background .12s}
.hc-row:hover,.hc-row[data-active="true"]{background:var(--hc-hover)}
.hc-divide>*+*{border-top:1px solid var(--hc-line)}

.hc-icon{display:grid;place-items:center;flex-shrink:0;border-radius:var(--hc-radius-sm);
  background:color-mix(in srgb,var(--hc-accent) 12%,var(--hc-card));color:var(--hc-accent-text)}
.hc-chip{display:inline-flex;align-items:center;gap:.25rem;border-radius:999px;padding:.125rem .5rem;
  background:var(--hc-hover);color:var(--hc-ink-3);border:1px solid var(--hc-line)}
.hc-accent{color:var(--hc-accent-text)}
.hc-muted{color:var(--hc-ink-3)}
.hc-ink2{color:var(--hc-ink-2)}
.hc-line{border-color:var(--hc-line)}

.hc-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;font-weight:600;
  background:var(--hc-accent);color:var(--hc-on-accent);border-radius:var(--hc-radius-sm);transition:filter .15s,transform .1s}
.hc-btn:hover{filter:brightness(1.08)}
.hc-btn:active{transform:scale(.98)}
.hc-btn-ghost{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;font-weight:500;
  background:var(--hc-card);color:var(--hc-ink);border:1px solid var(--hc-line);border-radius:var(--hc-radius-sm);transition:background .15s,border-color .15s}
.hc-btn-ghost:hover{background:var(--hc-hover)}

.hc-toc a[data-active="true"]{color:var(--hc-ink);border-color:var(--hc-accent);font-weight:500}
.hc-nav-item[data-active="true"]{background:color-mix(in srgb,var(--hc-accent) 10%,transparent);color:var(--hc-accent-text);font-weight:600}
.hc-progress{background:var(--hc-accent)}
.hc-skeleton{background:var(--hc-hover);border-radius:var(--hc-radius-sm)}
@media (prefers-reduced-motion:reduce){.hc-root *{transition:none!important;animation:none!important}}
`;
