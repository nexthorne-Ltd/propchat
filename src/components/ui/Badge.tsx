import React from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info';

/**
 * Small status label. Colour is never the only signal: always pass text, and
 * `dot` adds a coloured dot for scanning long lists.
 */
export function Badge({
  tone = 'neutral',
  dot,
  className,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn('pill', `pill-${tone}`, className)}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
