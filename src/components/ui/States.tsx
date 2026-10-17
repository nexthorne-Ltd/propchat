import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The three non-happy states every screen needs. Pair them with EmptyState
 * (EmptyState.tsx) and the skeletons (Skeleton.tsx):
 *   loading → skeleton shaped like the content, or <LoadingState> if unknown
 *   empty   → <EmptyState> with a next step
 *   error   → <ErrorState> with the message and a retry
 */

export function LoadingState({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn('flex flex-col items-center justify-center gap-2 p-8 text-ink-3', className)}>
      <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
      <span className="text-ui">{label}</span>
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center text-center gap-3 p-8 max-w-sm mx-auto', className)}>
      <div className="w-10 h-10 rounded-xl bg-danger-soft border border-danger-line text-danger flex items-center justify-center">
        <AlertTriangle className="w-5 h-5" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-md font-semibold text-ink">{title}</h3>
        {message && <p className="mt-1 text-ui text-ink-2">{message}</p>}
      </div>
      {onRetry && (
        <button type="button" className="btn btn-sm btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** A grey placeholder block with the shimmer from globals.css. */
export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden="true" />;
}
