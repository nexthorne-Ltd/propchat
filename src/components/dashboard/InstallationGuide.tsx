'use client';

import { getWidgetOrigin } from '@/lib/domain';
import React, { useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Palette,
} from 'lucide-react';
import { Workspace } from '@/types/database';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/Avatar';

interface InstallationGuideProps {
  workspace: Workspace | null;
  hasVisitors: boolean;
  latestVisitorUrl?: string;
  /** Rendered inside the Settings hub, which supplies its own page header. */
  embedded?: boolean;
}

type Platform = 'html' | 'wordpress' | 'shopify' | 'react';

const PLATFORM_LABEL: Record<Platform, string> = {
  html: 'HTML',
  wordpress: 'WordPress',
  shopify: 'Shopify',
  react: 'React / Next.js',
};

export function InstallationGuide({
  workspace,
  hasVisitors,
  latestVisitorUrl,
  embedded = false,
}: InstallationGuideProps) {
  const [copied, setCopied] = useState(false);
  const [activePlatform, setActivePlatform] = useState<Platform>('html');

  const origin = getWidgetOrigin();
  const workspaceId = workspace?.id || 'YOUR_WORKSPACE_ID';

  const embedScript = `<!-- Zen-try Live Chat Support -->
<script
  src="${origin}/widget.js"
  data-workspace-id="${workspaceId}"
  defer>
</script>`;

  const copyCode = () => {
    navigator.clipboard.writeText(embedScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const GUIDES: Record<Platform, React.ReactNode> = {
    html: (
      <ol className="space-y-3">
        {[
          'Open your site\'s main HTML template or master layout file.',
          'Scroll to the bottom and find the closing </body> tag.',
          'Paste the Zen-try snippet directly above it.',
          'Save and deploy — the launcher appears for every visitor.',
        ].map((s, i) => (
          <li key={i} className="flex gap-3.5 items-center">
            <span className="shrink-0 w-6 h-6 rounded-lg bg-accent text-white text-xs font-extrabold flex items-center justify-center shadow-xs">
              {i + 1}
            </span>
            <span className="text-ui leading-relaxed text-ink font-medium">{s}</span>
          </li>
        ))}
      </ol>
    ),
    wordpress: (
      <ol className="space-y-3">
        {[
          'Log in to your WordPress admin dashboard.',
          'Install a free header/footer plugin such as WPCode.',
          'Go to Code Snippets → Header & Footer.',
          'Paste the snippet into the Footer box and save.',
        ].map((s, i) => (
          <li key={i} className="flex gap-3.5 items-center">
            <span className="shrink-0 w-6 h-6 rounded-lg bg-accent text-white text-xs font-extrabold flex items-center justify-center shadow-xs">
              {i + 1}
            </span>
            <span className="text-ui leading-relaxed text-ink font-medium">{s}</span>
          </li>
        ))}
      </ol>
    ),
    shopify: (
      <ol className="space-y-3">
        {[
          'Open your Shopify store admin.',
          'Go to Online Store → Themes.',
          'Next to your live theme: Actions (…) → Edit code.',
          'Open theme.liquid, paste above </body>, then Save.',
        ].map((s, i) => (
          <li key={i} className="flex gap-3.5 items-center">
            <span className="shrink-0 w-6 h-6 rounded-lg bg-accent text-white text-xs font-extrabold flex items-center justify-center shadow-xs">
              {i + 1}
            </span>
            <span className="text-ui leading-relaxed text-ink font-medium">{s}</span>
          </li>
        ))}
      </ol>
    ),
    react: (
      <div className="space-y-3">
        <p className="text-ui leading-relaxed text-ink-2">
          Render the script from your root{' '}
          <code className="font-mono text-xs text-ink">app/layout.tsx</code>{' '}
          using the Next.js Script component:
        </p>
        <pre className="code-block">{`import Script from 'next/script';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script
          src="${origin}/widget.js"
          data-workspace-id="${workspaceId}"
          strategy="lazyOnload"
        />
      </body>
    </html>
  );
}`}</pre>
      </div>
    ),
  };

  return (
    <div
      className={cn(
        'flex-1 min-w-0 flex flex-col bg-canvas',
        !embedded && 'h-screen'
      )}
    >
      {!embedded && (
        <header className="shrink-0 px-7 h-16 flex items-center justify-between gap-4 border-b border-line bg-surface">
          <div className="min-w-0">
            <h1 className="text-md font-semibold tracking-tight">
              Install the widget
            </h1>
            <p className="text-xs text-ink-3 mt-0.5">
              One script tag. Works on any site, no build step required.
            </p>
          </div>

          <span
            className={cn(
              'pill shrink-0',
              hasVisitors ? 'pill-success' : 'pill-warn'
            )}
          >
            {hasVisitors ? (
              <>
                <span className="live-dot" />
                Connected — receiving traffic
              </>
            ) : (
              'Awaiting first visit'
            )}
          </span>
        </header>
      )}

      <div className={cn('flex-1 p-7', !embedded && 'overflow-y-auto')}>
        <div className="max-w-3xl space-y-6">
          {/* Workspace summary */}
          <div className="card p-5 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-4 min-w-0">
              <Avatar
                name={workspace?.name || 'W'}
                seed={workspace?.id || 'workspace'}
                color={workspace?.brand_color || undefined}
                size="md"
              />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold truncate">
                  {workspace?.name || 'My workspace'}
                </h2>
                <div className="mt-1 flex items-center gap-3 flex-wrap text-xs text-ink-3">
                  {workspace?.website_url && (
                    <span className="inline-flex items-center gap-1.5 truncate">
                      <Globe className="w-3.5 h-3.5" />
                      {workspace.website_url}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5">
                    <Palette className="w-3.5 h-3.5" />
                    <span
                      className="w-2.5 h-2.5 rounded-full border border-line"
                      style={{
                        backgroundColor: workspace?.brand_color || '#2e5bff',
                      }}
                    />
                    <span className="font-mono uppercase">
                      {workspace?.brand_color || '#2e5bff'}
                    </span>
                  </span>
                  <span className="font-mono truncate">
                    id: {workspaceId.slice(0, 13)}…
                  </span>
                </div>
              </div>
            </div>

            <a
              href={`/demo.html?workspaceId=${workspaceId}&name=${encodeURIComponent(workspace?.name || '')}`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-sm btn-secondary shrink-0"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open demo site
            </a>
          </div>

          {/* Snippet */}
          <div className="card p-6 border-2 border-line-2 shadow-xs space-y-3">
            <div className="flex items-center justify-between mb-1">
              <div>
                <h2 className="text-md font-bold text-ink">Your Embed Code</h2>
                <p className="text-xs text-ink-2">Copy this snippet and paste it right before the closing &lt;/body&gt; tag on your website.</p>
              </div>
              <button onClick={copyCode} className="btn btn-sm btn-primary font-bold shadow-xs px-4 py-2 shrink-0">
                {copied ? (
                  <>
                    <Check className="w-4 h-4 text-success" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>Copy snippet</span>
                  </>
                )}
              </button>
            </div>

            <pre className="p-4.5 rounded-xl bg-invert text-success font-mono text-xs border-2 border-line-3 shadow-inner overflow-x-auto leading-relaxed">{embedScript}</pre>
          </div>

          {/* Platform guides */}
          <div className="card p-6 border-2 border-line-2 shadow-xs space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap border-b border-line-2 pb-3.5">
              <h2 className="text-md font-bold text-ink">
                Platform-Specific Installation Steps
              </h2>
              <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-surface-2 border-2 border-line-2">
                {(Object.keys(PLATFORM_LABEL) as Platform[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setActivePlatform(p)}
                    className={cn(
                      'h-7.5 px-3 rounded-lg text-xs font-bold transition-all',
                      activePlatform === p
                        ? 'bg-accent text-white shadow-xs'
                        : 'text-ink-2 hover:text-ink hover:bg-surface-3'
                    )}
                  >
                    {PLATFORM_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-1">{GUIDES[activePlatform]}</div>
          </div>

          {/* Verify */}
          <div className="card p-5 border-2 border-line-2 shadow-xs flex items-center justify-between gap-4 flex-wrap bg-surface">
            <div className="flex items-center gap-3 min-w-0">
              <div className={cn(
                'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 shadow-2xs',
                hasVisitors ? 'bg-success/15 text-success border border-success/30' : 'bg-warn/15 text-warn border border-warn/30'
              )}>
                <Check className="w-4 h-4" />
              </div>
              <div className="text-ui leading-relaxed text-ink min-w-0 font-medium">
                {hasVisitors ? (
                  <>
                    <span className="font-bold text-success">Traffic detected</span> on{' '}
                    <span className="font-mono text-ink font-bold">
                      {latestVisitorUrl || 'your site'}
                    </span>
                  </>
                ) : (
                  <span className="text-ink-2 font-medium">No live visitor traffic detected yet. Use the simulator below to test in real-time.</span>
                )}
              </div>
            </div>

            <a
              href={`/demo.html?workspaceId=${workspaceId}&name=${encodeURIComponent(
                workspace?.name || 'Workspace'
              )}`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-sm btn-secondary font-bold border-2 border-line-2 hover:border-line-3 shrink-0 shadow-2xs gap-1.5"
            >
              <span>Test in Simulator</span>
              <ExternalLink className="w-3.5 h-3.5 text-accent" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
