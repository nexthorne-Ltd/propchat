import React from 'react';
import { cn } from '@/lib/utils';

/**
 * A centred line in a conversation thread for things that happened rather
 * than things someone said: day dividers, auto-resolve, merges, hand-overs.
 * Rendering these as bubbles made them look like the visitor had written
 * them. `rule` draws hairlines either side (day dividers).
 */
export function ConversationEvent({
  icon,
  rule,
  time,
  className,
  children,
}: {
  icon?: React.ReactNode;
  rule?: boolean;
  time?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-1.5 py-1 text-xs text-ink-3 text-center',
        rule && 'gap-3',
        className
      )}
    >
      {rule && <span aria-hidden="true" className="flex-1 h-px bg-line" />}
      {icon && <span aria-hidden="true" className="shrink-0 inline-flex [&>svg]:w-3.5 [&>svg]:h-3.5">{icon}</span>}
      <span className="min-w-0">
        {children}
        {time && <span className="tabular-nums"> · {time}</span>}
      </span>
      {rule && <span aria-hidden="true" className="flex-1 h-px bg-line" />}
    </div>
  );
}
