'use client';

import React, { useEffect } from 'react';
import { AlertCircle, RotateCcw, LogIn } from 'lucide-react';
import Link from 'next/link';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Dashboard Error Boundary Caught]:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-6 text-ink select-none">
      <div className="max-w-md w-full p-8 rounded-3xl border border-line bg-surface text-center space-y-6 shadow-xl animate-fade-in">
        <div className="w-14 h-14 rounded-2xl bg-warn/10 border border-warn/20 text-warn mx-auto flex items-center justify-center shadow-inner">
          <AlertCircle className="w-7 h-7" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold text-ink tracking-tight">
            Dashboard Encountered an Issue
          </h2>
          <p className="text-ui text-ink-3 leading-relaxed">
            {error?.message ||
              'A client-side initialization issue occurred. Please retry or sign in again to refresh your session.'}
          </p>
        </div>
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => reset()}
            className="btn btn-primary text-xs font-semibold px-4 py-2.5 rounded-xl shadow-xs inline-flex items-center gap-2"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Try Again</span>
          </button>
          <Link
            href="/login"
            className="btn btn-secondary text-xs font-medium px-4 py-2.5 rounded-xl inline-flex items-center gap-2"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Go to Login</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
