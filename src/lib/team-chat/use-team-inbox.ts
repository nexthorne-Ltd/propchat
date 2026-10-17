'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimePostgresChangesPayload, SupabaseClient } from '@supabase/supabase-js';
import type { TeamInboxRow, TeamMessage } from '@/types/database';

/**
 * The signed-in member's team-chat threads (fn_team_inbox) kept live.
 *
 * Used once, by the dashboard, so the sidebar badge and the alerts work on
 * every view; the Team chat screen reads the same list. Every new team
 * message (realtime, filtered to the workspace; RLS limits it to threads the
 * member can read) refreshes the counts and goes to onMessage, which decides
 * whether to ring.
 *
 * Before the migration is applied the function is missing: the list stays
 * empty and `available` is false, so the screen can say so.
 */
export function useTeamInbox(
  supabase: SupabaseClient,
  workspaceId: string | null | undefined,
  onMessage?: (message: TeamMessage, threads: TeamInboxRow[]) => void
) {
  const [threads, setThreads] = useState<TeamInboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const threadsRef = useRef<TeamInboxRow[]>([]);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    const { data, error: err } = await supabase.rpc('fn_team_inbox', { p_workspace_id: workspaceId });
    setLoading(false);
    if (err) {
      // PGRST202 / 42883: the function does not exist yet.
      if (/fn_team_inbox|PGRST202|42883/.test(`${err.code} ${err.message}`)) setAvailable(false);
      else setError(err.message);
      return;
    }
    setError(null);
    setAvailable(true);
    const rows = (data as TeamInboxRow[]) || [];
    threadsRef.current = rows;
    setThreads(rows);
  }, [supabase, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A burst of messages is one reload.
    const reloadSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 250);
    };
    // The first load is a subscription callback, like every later one.
    const first = setTimeout(() => void reload(), 0);
    const channel = supabase
      .channel(`team-inbox-${workspaceId}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_messages', filter: `workspace_id=eq.${workspaceId}` },
        (payload: RealtimePostgresChangesPayload<TeamMessage>) => {
          if (cancelled) return;
          if (payload.eventType === 'INSERT') onMessageRef.current?.(payload.new as TeamMessage, threadsRef.current);
          reloadSoon();
        }
      )
      .subscribe();
    // Coming back to the tab catches anything realtime missed while asleep.
    const onVisible = () => document.visibilityState === 'visible' && reloadSoon();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(first);
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [supabase, workspaceId, reload]);

  const totals = useMemo(() => {
    let unread = 0;
    let urgent = false;
    for (const t of threads) {
      unread += t.unread;
      if (t.unread && (t.kind === 'direct' || t.mentions_me)) urgent = true;
    }
    return { unread, urgent };
  }, [threads]);

  /** Clears a thread's count at once, before the server confirms. */
  const markReadLocally = useCallback((threadId: string) => {
    setThreads((prev) => {
      const next = prev.map((t) => (t.thread_id === threadId ? { ...t, unread: 0, mentions_me: 0 } : t));
      threadsRef.current = next;
      return next;
    });
  }, []);

  return { threads, loading, error, available, reload, markReadLocally, ...totals };
}
