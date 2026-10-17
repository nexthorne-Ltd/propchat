'use client';

import { useEffect, useState } from 'react';
import { preconnect } from 'react-dom';

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || '';

/** Interaction signals that mean a visitor is engaging with the page. */
const INTENT_EVENTS = ['pointerdown', 'pointermove', 'touchstart', 'keydown', 'scroll', 'focusin'] as const;

declare global {
  interface Window {
    __zentryLoaderInjected?: boolean;
  }
}

function findLauncher(): Element | null {
  return document.getElementById('zentry-widget-root')?.shadowRoot?.getElementById('chatifyLauncherBtn') ?? null;
}

/**
 * Loads the real widget on our own marketing site as soon as the visitor shows
 * intent (first pointer/scroll/key) or the browser goes idle — whichever comes
 * first — instead of waiting for every asset to finish loading. A shimmering
 * launcher holds the spot meanwhile so it is clear help is on its way.
 */
export function WidgetLoader({ workspaceId, src = '/widget.js' }: { workspaceId: string; src?: string }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'gone'>('loading');

  // Only a warm-up for the widget's first request; without the env var there
  // is nothing to connect to, and React rejects an empty href.
  if (SUPABASE_URL) preconnect(SUPABASE_URL);

  useEffect(() => {
    let injected = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let idleHandle: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const removeIntentListeners = () => {
      INTENT_EVENTS.forEach((e) => window.removeEventListener(e, inject));
    };

    const watchForLauncher = () => {
      const startedAt = Date.now();
      pollTimer = setInterval(() => {
        if (findLauncher()) {
          setPhase('ready');
          if (pollTimer) clearInterval(pollTimer);
        } else if (Date.now() - startedAt > 20000) {
          // Workspace inactive or network failure — don't leave a ghost button.
          setPhase('gone');
          if (pollTimer) clearInterval(pollTimer);
        }
      }, 120);
    };

    function inject() {
      if (injected) return;
      injected = true;
      removeIntentListeners();
      if (idleHandle !== null && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle);
      if (fallbackTimer) clearTimeout(fallbackTimer);

      if (!window.__zentryLoaderInjected) {
        window.__zentryLoaderInjected = true;
        const script = document.createElement('script');
        script.id = 'zentry-chat-widget-script';
        script.src = src;
        script.async = true;
        script.defer = true;
        script.setAttribute('data-workspace-id', workspaceId);
        script.onerror = () => setPhase('gone');
        document.body.appendChild(script);
      }
      watchForLauncher();
    }

    // Already on the page (e.g. client-side navigation back here): just confirm.
    if (findLauncher()) {
      inject();
      return () => {
        if (pollTimer) clearInterval(pollTimer);
      };
    }

    INTENT_EVENTS.forEach((e) => window.addEventListener(e, inject, { passive: true }));
    if ('requestIdleCallback' in window) {
      idleHandle = window.requestIdleCallback(inject, { timeout: 2000 });
    } else {
      fallbackTimer = setTimeout(inject, 1200);
    }

    return () => {
      removeIntentListeners();
      if (idleHandle !== null && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [src, workspaceId]);

  if (phase !== 'loading') return null;

  return (
    <div aria-hidden className="fixed right-5 bottom-5 z-40 pointer-events-none">
      <div className="skeleton w-14 h-14 shadow-md" style={{ borderRadius: 9999 }} />
    </div>
  );
}
