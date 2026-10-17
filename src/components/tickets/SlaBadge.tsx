'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, PauseCircle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { slaBadge, type SlaCache } from '@/lib/sla/policy';

/**
 * One shared clock for every badge on screen, so a page of 50 tickets runs a
 * single timer instead of 50. It ticks every 30 s, which is as fine as the
 * labels get (minutes).
 */
const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: (now: number) => void) {
  listeners.add(fn);
  if (!timer) {
    timer = setInterval(() => listeners.forEach((l) => l(Date.now())), 30_000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useNow(): Date {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(setNow), []);
  return new Date(now);
}

const ICON = { neutral: Clock, warn: Clock, danger: AlertTriangle, success: CheckCircle2 } as const;

/**
 * Time left on the ticket's nearest SLA target: neutral while there is time,
 * amber from the policy's warning point, red once breached. Paused and met
 * tickets say so. Renders nothing for a ticket with no SLA.
 */
export function SlaBadge({ ticket, className }: { ticket: SlaCache; className?: string }) {
  const now = useNow();
  const info = slaBadge(ticket, now);
  if (!info) return null;
  const paused = ticket.sla_state === 'paused' && !info.breached;
  const Icon = paused ? PauseCircle : ICON[info.tone];
  return (
    <span title={info.detail} className="inline-flex">
      <Badge tone={info.tone === 'neutral' ? 'neutral' : info.tone} className={className}>
        <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span className="tabular-nums whitespace-nowrap">{info.label}</span>
        <span className="sr-only">. {info.detail}</span>
      </Badge>
    </span>
  );
}
