'use client';

import React, { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * A standalone chat page: /widget?workspaceId=<id>.
 *
 * It loads the real widget (public/widget.js) and opens it, rather than a
 * second implementation. The widget reaches the database only through the
 * visitor-session functions (docs/AUDIT.md H-3), so this page needs no
 * database access of its own. widget.js reads the workspace id (and logo,
 * icon) from this page's query string.
 */
function WidgetFrameContent() {
  const searchParams = useSearchParams();
  const workspaceId = searchParams.get('workspaceId') || searchParams.get('ws') || '';

  useEffect(() => {
    if (!workspaceId || document.querySelector('script[data-zentry-standalone]')) return;
    const w = window as unknown as { Zentry?: unknown };
    // The widget flushes calls queued before it loads: open the messenger.
    if (!w.Zentry) w.Zentry = { q: [['open', []]] };
    const script = document.createElement('script');
    script.src = '/widget.js';
    script.async = true;
    script.setAttribute('data-zentry-standalone', '');
    script.setAttribute('data-workspace-id', workspaceId);
    document.body.appendChild(script);
  }, [workspaceId]);

  if (!workspaceId) {
    return (
      <main className="min-h-screen grid place-items-center bg-canvas px-4">
        <p className="text-ui text-ink-2">Add ?workspaceId=… to the address to open a workspace&apos;s chat.</p>
      </main>
    );
  }
  return <main className="min-h-screen bg-transparent" aria-label="Chat" />;
}

export default function WidgetPage() {
  return (
    <Suspense fallback={<div className="w-screen h-screen bg-transparent" />}>
      <WidgetFrameContent />
    </Suspense>
  );
}
