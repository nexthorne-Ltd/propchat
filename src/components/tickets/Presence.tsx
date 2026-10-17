'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, PenLine } from 'lucide-react';
import { setTicketPresenceAction, type PresenceState, type TicketPresence } from '@/app/actions/tickets';

/** How often an open ticket tells the others it is still being looked at. */
const HEARTBEAT_MS = 15_000;

/**
 * Collision detection. While a ticket is open this reports what the agent is
 * doing (viewing, replying, writing a note) and returns who else is on it.
 * Presence lives in the database (ticket_presence) so a closed tab simply
 * stops refreshing and drops off after a short while.
 */
export function usePresence(workspaceId: string, ticketId: string) {
  const [others, setOthers] = useState<TicketPresence[]>([]);
  const stateRef = useRef<PresenceState>('viewing');

  const beat = useCallback(
    (state: PresenceState | null) =>
      setTicketPresenceAction(workspaceId, ticketId, state).then(
        (list) => setOthers(list),
        () => {
          /* presence is a courtesy; a failed beat never gets in the agent's way */
        }
      ),
    [workspaceId, ticketId]
  );

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled && document.visibilityState !== 'hidden') void beat(stateRef.current);
    };
    tick();
    const timer = setInterval(tick, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      void setTicketPresenceAction(workspaceId, ticketId, null).catch(() => {});
    };
  }, [beat, workspaceId, ticketId]);

  /** Called when the agent starts or stops typing; only a change in state is sent. */
  const report = useCallback(
    (state: PresenceState) => {
      if (stateRef.current === state) return;
      stateRef.current = state;
      void beat(state);
    },
    [beat]
  );

  return { others, report };
}

const VERB: Record<PresenceState, string> = {
  viewing: 'viewing',
  replying: 'replying to',
  noting: 'writing a note on',
};

/** Shown above the conversation when someone else is on the ticket. */
export function CollisionBanner({ others }: { others: TicketPresence[] }) {
  if (others.length === 0) return null;
  const replying = others.filter((o) => o.state === 'replying');
  const urgent = replying.length > 0;
  const names = (list: TicketPresence[]) => list.map((o) => o.name).join(', ');

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        urgent
          ? 'px-4 py-2 bg-warn-soft border-b border-warn-line text-xs text-ink flex items-center gap-2 shrink-0'
          : 'px-4 py-2 bg-surface-2 border-b border-line text-xs text-ink-2 flex items-center gap-2 shrink-0'
      }
    >
      {urgent ? <PenLine className="w-3.5 h-3.5 shrink-0 text-warn" /> : <Eye className="w-3.5 h-3.5 shrink-0" />}
      <span className="min-w-0">
        {urgent ? (
          <>
            <strong className="font-semibold">{names(replying)}</strong> {replying.length === 1 ? 'is' : 'are'} replying to this ticket right now. Check before you send.
            {others.length > replying.length && <> Also here: {names(others.filter((o) => o.state !== 'replying'))}.</>}
          </>
        ) : (
          <>
            {others.map((o, i) => (
              <span key={o.agent_id}>
                {i > 0 && ', '}
                <strong className="font-semibold">{o.name}</strong> is {VERB[o.state]} this ticket
              </span>
            ))}
            .
          </>
        )}
      </span>
    </div>
  );
}
