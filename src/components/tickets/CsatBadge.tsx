'use client';

import React from 'react';
import { ThumbsUp, ThumbsDown, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CsatTicketData {
  status?: string;
  csat_rating?: 'good' | 'bad' | string | null;
  csat_comment?: string | null;
  csat_rated_at?: string | null;
}

export function CsatBadge({
  ticket,
  compact = false,
  className,
}: {
  ticket: CsatTicketData;
  compact?: boolean;
  className?: string;
}) {
  if (ticket.csat_rating === 'good') {
    return (
      <span
        title={ticket.csat_comment ? `Rated Good: “${ticket.csat_comment}”` : 'Rated Good'}
        className={cn(
          'inline-flex items-center gap-1 font-semibold rounded-full border',
          'bg-success-soft text-success border-success-line',
          compact ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-0.5 text-2xs',
          className
        )}
      >
        <ThumbsUp className="w-3 h-3 shrink-0" />
        <span>Good</span>
      </span>
    );
  }

  if (ticket.csat_rating === 'bad') {
    return (
      <span
        title={ticket.csat_comment ? `Rated Bad: “${ticket.csat_comment}”` : 'Rated Bad'}
        className={cn(
          'inline-flex items-center gap-1 font-semibold rounded-full border',
          'bg-danger-soft text-danger border-danger-line',
          compact ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-0.5 text-2xs',
          className
        )}
      >
        <ThumbsDown className="w-3 h-3 shrink-0" />
        <span>Bad</span>
      </span>
    );
  }

  if (ticket.status === 'solved') {
    return (
      <span
        title="Awaiting customer rating"
        className={cn(
          'inline-flex items-center gap-1 font-medium rounded-full border',
          'bg-surface-3 text-ink-3 border-line',
          compact ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-0.5 text-2xs',
          className
        )}
      >
        <Clock className="w-3 h-3 shrink-0" />
        <span>CSAT pending</span>
      </span>
    );
  }

  return null;
}
