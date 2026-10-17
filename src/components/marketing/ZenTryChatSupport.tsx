'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { WidgetLoader } from './WidgetLoader';

/**
 * Zen-try official live support workspace ID.
 * Workspace: "Zen-try" (owner: zentry385@gmail.com)
 */
export const ZENTRY_WORKSPACE_ID = 'b2d91676-2e98-46b7-8543-6e0711c78c44';

/**
 * Embeds Zen-try Live Chat Support widget on public visitor pages.
 *
 * Route exclusions:
 * - /widget: Avoid nested widget recursion.
 * - /dashboard: Avoid overlaying agent workspace controls.
 * - /admin: Avoid overlaying super admin panel.
 * - /help: Customer help centers render their own workspace-specific HelpWidget.
 * - /csat: Customer satisfaction feedback page.
 */
export function ZenTryChatSupport() {
  const pathname = usePathname() || '';

  const isExcluded =
    pathname.startsWith('/widget') ||
    pathname.startsWith('/dashboard') ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/help') ||
    pathname.startsWith('/csat');

  useEffect(() => {
    const root = document.getElementById('zentry-widget-root');
    if (!root) return;

    if (isExcluded) {
      root.style.display = 'none';
      try {
        const api =
          (window as any).Zentry ||
          (window as any)['Zen-try'] ||
          (window as any).Chatify;
        if (api && typeof api.close === 'function' && typeof api.isOpen === 'function' && api.isOpen()) {
          api.close();
        }
      } catch {}
    } else {
      root.style.display = '';
    }
  }, [isExcluded, pathname]);

  if (isExcluded) {
    return null;
  }

  return (
    <WidgetLoader
      workspaceId={ZENTRY_WORKSPACE_ID}
      src="/widget.js"
    />
  );
}
