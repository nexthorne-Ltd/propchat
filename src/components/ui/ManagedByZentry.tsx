'use client';

import React from 'react';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ManagedByZentryProps {
  className?: string;
  message?: string;
}

/**
 * Requirement C: Renders a "Managed by Zentry" note on locked settings
 * inside the workspace dashboard.
 */
export function ManagedByZentry({
  className,
  message = 'Managed by Zentry',
}: ManagedByZentryProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-semibold',
        'bg-accent/10 text-accent border border-accent/20 select-none tracking-tight',
        className
      )}
      title="This setting is locked and controlled by Zentry platform administration."
    >
      <Lock className="w-3 h-3 text-accent shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
