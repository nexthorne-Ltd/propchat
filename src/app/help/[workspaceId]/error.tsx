'use client';

import React, { useEffect } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

export default function HelpCenterError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Help Center error caught by boundary:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-6 text-ink">
      <div className="max-w-md w-full p-8 rounded-2xl border border-line bg-surface text-center space-y-5 shadow-xl animate-in fade-in zoom-in-95">
        <div className="w-12 h-12 rounded-2xl bg-danger/10 border border-danger/20 text-danger mx-auto flex items-center justify-center">
          <AlertCircle className="w-6 h-6" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold text-ink">Couldn&apos;t load Help Center</h2>
          <p className="text-ui text-ink-3 leading-relaxed">
            Something unexpected occurred while loading this page. Please try refreshing or returning to the homepage.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-10 px-5 rounded-xl bg-accent text-accent-ink text-ui font-semibold inline-flex items-center gap-2 hover:opacity-90 transition-all cursor-pointer shadow-xs"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Reload Page</span>
          </button>
          <button
            type="button"
            onClick={() => reset()}
            className="h-10 px-4 rounded-xl border border-line bg-surface-2 text-ink text-ui font-medium hover:bg-surface-3 transition-colors cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
