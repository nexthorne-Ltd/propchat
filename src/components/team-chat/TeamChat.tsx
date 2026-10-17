'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimePostgresChangesPayload, SupabaseClient } from '@supabase/supabase-js';
import { ArrowLeft, Hash, Link2, MessageCircle, MessagesSquare, Search, Send, Trash2, X } from 'lucide-react';
import type { Agent, TeamInboxRow, TeamMessage } from '@/types/database';
import { Avatar } from '@/components/ui/Avatar';
import { Linkified } from '@/components/ui/Linkified';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { cn } from '@/lib/utils';
import { mentionQuery, mentionedIds, splitMentions } from '@/lib/team-chat/mentions';
import type { useTeamInbox } from '@/lib/team-chat/use-team-inbox';

/**
 * Team chat: the workspace's General channel and direct messages between
 * members, so a question to a colleague does not leave the product.
 *
 * Rules (who sees what, who may write) live in the database
 * (20261118090000_team_chat.sql); this screen only reads and writes through
 * them. The thread list and unread counts come from the dashboard's
 * useTeamInbox, so the sidebar badge and this list always agree.
 */

export interface TeamChatShare {
  conversationId: string;
  label: string;
}

interface TeamChatProps {
  supabase: SupabaseClient;
  workspaceId: string;
  currentAgent: Agent;
  agents: Agent[];
  inbox: ReturnType<typeof useTeamInbox>;
  /** A customer chat to attach to the next message ("Ask team"). */
  share: TeamChatShare | null;
  onClearShare: () => void;
  /** Open this thread (a notification was clicked). */
  requestedThread?: { threadId: string; nonce: number } | null;
  onOpenConversation: (conversationId: string) => void;
  /** Label for a shared customer chat, from the inbox list when it is there. */
  conversationLabel: (conversationId: string) => string | null;
  /** Tells the dashboard which thread is on screen, so it does not ring for it. */
  onOpenThreadChange: (threadId: string | null) => void;
}

const PAGE = 50;
const STATUS_LABEL: Record<string, string> = { online: 'Online', away: 'Away', offline: 'Offline' };

type Pending = TeamMessage & { pending?: boolean; failed?: boolean };

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function TeamChat({
  supabase,
  workspaceId,
  currentAgent,
  agents,
  inbox,
  share,
  onClearShare,
  requestedThread,
  onOpenConversation,
  conversationLabel,
  onOpenThreadChange,
}: TeamChatProps) {
  const me = currentAgent.id;
  const teammates = useMemo(
    () => agents.filter((a) => a.id !== me && a.is_active !== false).sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [agents, me]
  );
  const people = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const nameOf = useCallback((id: string) => people.get(id)?.name || people.get(id)?.email || 'Teammate', [people]);

  const [openThread, setOpenThread] = useState<string | null>(requestedThread?.threadId ?? null);
  // A clicked notification opens its thread, also when the screen is open.
  const [seenRequest, setSeenRequest] = useState(requestedThread?.nonce);
  if (requestedThread && requestedThread.nonce !== seenRequest) {
    setSeenRequest(requestedThread.nonce);
    setOpenThread(requestedThread.threadId);
  }
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const general = inbox.threads.find((t) => t.kind === 'channel' && t.name === 'General') ?? null;
  const directByAgent = useMemo(() => {
    const m = new Map<string, TeamInboxRow>();
    for (const t of inbox.threads) if (t.kind === 'direct' && t.other_agent_id) m.set(t.other_agent_id, t);
    return m;
  }, [inbox.threads]);

  // The General channel exists once anyone has opened team chat.
  const ensuredGeneral = useRef(false);
  useEffect(() => {
    if (inbox.loading || !inbox.available || general || ensuredGeneral.current) return;
    ensuredGeneral.current = true;
    void supabase.rpc('fn_team_general', { p_workspace_id: workspaceId }).then(({ error }) => {
      if (error) console.error('[Team Chat] General channel:', error.message);
      else void inbox.reload();
    });
  }, [inbox, general, supabase, workspaceId]);

  // Start on General (or the thread something was shared into).
  const firstOpen = useRef(false);
  useEffect(() => {
    if (firstOpen.current || !general) return;
    firstOpen.current = true;
    setOpenThread((current) => current ?? general.thread_id);
  }, [general]);

  useEffect(() => {
    onOpenThreadChange(openThread);
    return () => onOpenThreadChange(null);
  }, [openThread, onOpenThreadChange]);

  const openDirect = async (agentId: string) => {
    const existing = directByAgent.get(agentId);
    if (existing) {
      setOpenThread(existing.thread_id);
      return;
    }
    setOpening(agentId);
    setOpenError(null);
    const { data, error } = await supabase.rpc('fn_team_open_direct', { p_workspace_id: workspaceId, p_agent_id: agentId });
    setOpening(null);
    if (error || !data) {
      setOpenError(error?.message || 'Could not open that conversation.');
      return;
    }
    setOpenThread(data as string);
    void inbox.reload();
  };

  const thread = inbox.threads.find((t) => t.thread_id === openThread) ?? null;
  const other = thread?.kind === 'direct' && thread.other_agent_id ? people.get(thread.other_agent_id) ?? null : null;

  const q = filter.trim().toLowerCase();
  const listed = teammates
    .filter((a) => !q || (a.name || '').toLowerCase().includes(q) || (a.email || '').toLowerCase().includes(q))
    .sort((a, b) => {
      // People you talk to first, most recent on top; then everyone else.
      const ta = directByAgent.get(a.id)?.last_message_at || '';
      const tb = directByAgent.get(b.id)?.last_message_at || '';
      return tb.localeCompare(ta);
    });

  if (!inbox.available) {
    return (
      <div className="flex-1 grid place-items-center p-6">
        <div className="max-w-sm text-center space-y-2">
          <MessagesSquare className="w-9 h-9 text-ink-3 mx-auto" />
          <h2 className="text-md font-semibold text-ink">Team chat is almost ready</h2>
          <p className="text-ui text-ink-3">Its database update has not been applied yet. Ask your platform admin to apply the team chat migration.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-w-0 h-screen bg-canvas">
      {/* Threads */}
      <aside
        className={cn(
          'w-full md:w-72 shrink-0 border-r border-line bg-surface flex flex-col min-h-0',
          openThread ? 'hidden md:flex' : 'flex'
        )}
        aria-label="Team chat threads"
      >
        <div className="p-4 border-b border-line space-y-3">
          <h1 className="text-md font-semibold text-ink flex items-center gap-2">
            <MessagesSquare className="w-4 h-4 text-accent" />
            Team chat
          </h1>
          <label className="relative block">
            <span className="sr-only">Find a teammate</span>
            <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a teammate"
              className="input input-sm w-full pl-8"
            />
          </label>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {inbox.loading ? (
            <LoadingState label="Loading team chat…" />
          ) : inbox.error ? (
            <ErrorState message={inbox.error} onRetry={() => void inbox.reload()} />
          ) : (
            <>
              <div>
                <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">Channels</p>
                {general ? (
                  <ThreadButton
                    active={openThread === general.thread_id}
                    onClick={() => setOpenThread(general.thread_id)}
                    icon={
                      <span className="w-8 h-8 rounded-lg bg-accent-soft text-accent grid place-items-center">
                        <Hash className="w-4 h-4" />
                      </span>
                    }
                    title="General"
                    preview={general.last_message ? `${general.last_message.sender_id === me ? 'You' : nameOf(general.last_message.sender_id)}: ${general.last_message.content}` : 'Everyone on the team'}
                    unread={general.unread}
                    urgent={general.mentions_me > 0}
                  />
                ) : (
                  <p className="px-2 py-1 text-xs text-ink-3">Setting up…</p>
                )}
              </div>

              <div>
                <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">Direct messages</p>
                {openError && <p className="px-2 py-1 text-xs text-danger">{openError}</p>}
                {listed.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-ink-3">
                    {teammates.length === 0 ? 'Invite teammates in Settings → Team to chat with them here.' : 'Nobody matches that name.'}
                  </p>
                ) : (
                  listed.map((a) => {
                    const t = directByAgent.get(a.id);
                    return (
                      <ThreadButton
                        key={a.id}
                        active={!!t && openThread === t.thread_id}
                        busy={opening === a.id}
                        onClick={() => void openDirect(a.id)}
                        icon={<Avatar name={a.name || a.email || '?'} seed={a.id} size="sm" online={a.status === 'online'} />}
                        title={a.name || a.email || 'Teammate'}
                        preview={
                          t?.last_message
                            ? `${t.last_message.sender_id === me ? 'You: ' : ''}${t.last_message.content}`
                            : STATUS_LABEL[a.status || 'offline'] || 'Offline'
                        }
                        unread={t?.unread || 0}
                        urgent={!!t?.unread}
                      />
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Messages */}
      <section className={cn('flex-1 min-w-0 flex-col', openThread ? 'flex' : 'hidden md:flex')}>
        {thread ? (
          <ThreadView
            key={thread.thread_id}
            supabase={supabase}
            workspaceId={workspaceId}
            me={me}
            thread={thread}
            title={thread.kind === 'channel' ? `# ${thread.name}` : other?.name || other?.email || 'Teammate'}
            subtitle={
              thread.kind === 'channel'
                ? `Everyone on the team · ${agents.filter((a) => a.is_active !== false).length} people`
                : `${STATUS_LABEL[other?.status || 'offline'] || 'Offline'}${other?.role ? ` · ${other.role.replace('_', ' ')}` : ''}`
            }
            headerIcon={
              thread.kind === 'channel' ? (
                <span className="w-9 h-9 rounded-lg bg-accent-soft text-accent grid place-items-center">
                  <Hash className="w-4 h-4" />
                </span>
              ) : (
                <Avatar name={other?.name || other?.email || '?'} seed={other?.id} size="md" online={other?.status === 'online'} />
              )
            }
            mentionable={thread.kind === 'channel' ? teammates : other ? [other] : []}
            nameOf={nameOf}
            agents={agents}
            share={share}
            onClearShare={onClearShare}
            onOpenConversation={onOpenConversation}
            conversationLabel={conversationLabel}
            onBack={() => setOpenThread(null)}
            onRead={() => inbox.markReadLocally(thread.thread_id)}
          />
        ) : (
          <div className="flex-1 grid place-items-center p-6 text-center">
            <div className="space-y-2 max-w-xs">
              <MessageCircle className="w-9 h-9 text-ink-3 mx-auto" />
              <p className="text-ui text-ink-3">Pick General or a teammate to start talking.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ThreadButton({
  active,
  busy,
  onClick,
  icon,
  title,
  preview,
  unread,
  urgent,
}: {
  active: boolean;
  busy?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  preview: string;
  unread: number;
  urgent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      disabled={busy}
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors',
        active ? 'bg-accent-soft' : 'hover:bg-surface-2',
        busy && 'opacity-60'
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-ui truncate', unread ? 'font-semibold text-ink' : 'font-medium text-ink')}>{title}</span>
        <span className={cn('block text-xs truncate', unread ? 'text-ink-2' : 'text-ink-3')}>{preview}</span>
      </span>
      {unread > 0 && (
        <span
          className={cn(
            'shrink-0 min-w-5 h-5 px-1.5 rounded-full text-2xs font-bold grid place-items-center',
            urgent ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-ink-2'
          )}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

/* ── One thread ────────────────────────────────────────────────────────── */

function ThreadView({
  supabase,
  workspaceId,
  me,
  thread,
  title,
  subtitle,
  headerIcon,
  mentionable,
  nameOf,
  agents,
  share,
  onClearShare,
  onOpenConversation,
  conversationLabel,
  onBack,
  onRead,
}: {
  supabase: SupabaseClient;
  workspaceId: string;
  me: string;
  thread: TeamInboxRow;
  title: string;
  subtitle: string;
  headerIcon: React.ReactNode;
  mentionable: Agent[];
  nameOf: (id: string) => string;
  agents: Agent[];
  share: TeamChatShare | null;
  onClearShare: () => void;
  onOpenConversation: (id: string) => void;
  conversationLabel: (id: string) => string | null;
  onBack: () => void;
  onRead: () => void;
}) {
  const [messages, setMessages] = useState<Pending[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const tempSeq = useRef(0);

  const markRead = useCallback(() => {
    onRead();
    void supabase.rpc('fn_team_mark_read', { p_thread_id: thread.thread_id }).then(({ error: err }) => {
      if (err) console.warn('[Team Chat] mark read:', err.message);
    });
  }, [supabase, thread.thread_id, onRead]);

  const load = useCallback(
    async (before?: string) => {
      let query = supabase
        .from('team_messages')
        .select('*')
        .eq('thread_id', thread.thread_id)
        .order('created_at', { ascending: false })
        .limit(PAGE);
      if (before) query = query.lt('created_at', before);
      const { data, error: err } = await query;
      if (err) throw err;
      return ((data as TeamMessage[]) || []).reverse();
    },
    [supabase, thread.thread_id]
  );

  useEffect(() => {
    let cancelled = false;
    load()
      .then((rows) => {
        if (cancelled) return;
        setMessages(rows);
        setHasMore(rows.length === PAGE);
        setLoading(false);
        markRead();
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message || 'Messages could not be loaded.');
        setLoading(false);
      });

    const channel = supabase
      .channel(`team-thread-${thread.thread_id}-${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'team_messages', filter: `thread_id=eq.${thread.thread_id}` },
        (payload: RealtimePostgresChangesPayload<TeamMessage>) => {
          const row = payload.new as TeamMessage;
          if (!row?.id) return;
          setMessages((prev) => {
            const at = prev.findIndex((m) => m.id === row.id);
            if (at >= 0) return prev.map((m, i) => (i === at ? row : m));
            return [...prev, row];
          });
          if (payload.eventType === 'INSERT' && row.sender_id !== me && document.visibilityState === 'visible') markRead();
        }
      )
      .subscribe();
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [supabase, thread.thread_id, load, markRead, me]);

  // Stay at the newest message unless the reader scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const loadEarlier = async () => {
    const first = messages.find((m) => !m.pending);
    if (!first) return;
    const el = scrollRef.current;
    const height = el?.scrollHeight ?? 0;
    setLoadingMore(true);
    try {
      const rows = await load(first.created_at);
      setHasMore(rows.length === PAGE);
      atBottom.current = false;
      setMessages((prev) => [...rows, ...prev]);
      // Keep the reader's place while older messages appear above.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - height;
      });
    } catch (err) {
      setError((err as { message?: string })?.message || 'Older messages could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  };

  const send = async (content: string, mentions: string[], conversationId: string | null, retryOf?: string) => {
    tempSeq.current += 1;
    const tempId = retryOf || `temp-${tempSeq.current}`;
    const draft: Pending = {
      id: tempId,
      thread_id: thread.thread_id,
      workspace_id: workspaceId,
      sender_id: me,
      content,
      conversation_id: conversationId,
      mentions,
      created_at: new Date().toISOString(),
      deleted_at: null,
      pending: true,
    };
    atBottom.current = true;
    setMessages((prev) => (retryOf ? prev.map((m) => (m.id === retryOf ? draft : m)) : [...prev, draft]));
    const { data, error: err } = await supabase
      .from('team_messages')
      .insert({
        thread_id: thread.thread_id,
        workspace_id: workspaceId,
        sender_id: me,
        content,
        conversation_id: conversationId,
        mentions,
      })
      .select()
      .single();
    if (err || !data) {
      console.error('[Team Chat] send:', err?.message);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)));
      return false;
    }
    const saved = data as TeamMessage;
    // Realtime may have delivered it already.
    setMessages((prev) => (prev.some((m) => m.id === saved.id) ? prev.filter((m) => m.id !== tempId) : prev.map((m) => (m.id === tempId ? saved : m))));
    return true;
  };

  const remove = async (id: string) => {
    const { error: err } = await supabase.rpc('fn_team_delete_message', { p_message_id: id });
    if (err) setError(err.message);
  };

  const names = useMemo(() => agents.map((a) => a.name || '').filter(Boolean), [agents]);

  return (
    <>
      <header className="shrink-0 h-16 px-3 sm:px-5 flex items-center gap-3 border-b border-line bg-surface">
        <button type="button" onClick={onBack} className="md:hidden btn btn-sm btn-ghost px-2" aria-label="Back to threads">
          <ArrowLeft className="w-4 h-4" />
        </button>
        {headerIcon}
        <div className="min-w-0">
          <h2 className="text-md font-semibold text-ink truncate">{title}</h2>
          <p className="text-xs text-ink-3 truncate">{subtitle}</p>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto px-3 sm:px-5 py-4"
        aria-live="polite"
      >
        {loading ? (
          <LoadingState label="Loading messages…" />
        ) : error && messages.length === 0 ? (
          <ErrorState message={error} onRetry={() => window.location.reload()} />
        ) : messages.length === 0 ? (
          <div className="h-full grid place-items-center text-center">
            <div className="space-y-2 max-w-xs">
              <MessageCircle className="w-9 h-9 text-ink-3 mx-auto" />
              <p className="text-ui font-medium text-ink">No messages yet</p>
              <p className="text-xs text-ink-3">
                {thread.kind === 'channel' ? 'Say hello to the team, or ask something everyone should see.' : 'Ask them anything. Only the two of you can see this.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {hasMore && (
              <div className="text-center pb-3">
                <button type="button" onClick={() => void loadEarlier()} disabled={loadingMore} className="btn btn-xs btn-secondary">
                  {loadingMore ? 'Loading…' : 'Load earlier messages'}
                </button>
              </div>
            )}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
              const grouped =
                !newDay && prev && prev.sender_id === m.sender_id && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
              return (
                <React.Fragment key={m.id}>
                  {newDay && (
                    <div className="flex items-center gap-3 py-3" role="separator">
                      <span className="h-px flex-1 bg-line" />
                      <span className="text-2xs font-semibold text-ink-3">{dayLabel(m.created_at)}</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  <MessageRow
                    message={m}
                    grouped={!!grouped}
                    mine={m.sender_id === me}
                    mentionsMe={m.mentions?.includes(me)}
                    senderName={m.sender_id === me ? 'You' : nameOf(m.sender_id)}
                    senderSeed={m.sender_id}
                    avatarName={nameOf(m.sender_id)}
                    names={names}
                    conversationLabel={conversationLabel}
                    onOpenConversation={onOpenConversation}
                    onDelete={() => void remove(m.id)}
                    onRetry={() => void send(m.content, m.mentions, m.conversation_id, m.id)}
                  />
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>

      <Composer
        placeholder={thread.kind === 'channel' ? 'Message the team' : `Message ${title}`}
        mentionable={mentionable}
        share={share}
        onClearShare={onClearShare}
        onSend={async (text, mentions) => {
          const ok = await send(text, mentions, share?.conversationId ?? null);
          if (ok && share) onClearShare();
          return ok;
        }}
      />
    </>
  );
}

function MessageRow({
  message: m,
  grouped,
  mine,
  mentionsMe,
  senderName,
  senderSeed,
  avatarName,
  names,
  conversationLabel,
  onOpenConversation,
  onDelete,
  onRetry,
}: {
  message: Pending;
  grouped: boolean;
  mine: boolean;
  mentionsMe?: boolean;
  senderName: string;
  senderSeed: string;
  /** The real name, also for your own messages (shown as "You"). */
  avatarName: string;
  names: string[];
  conversationLabel: (id: string) => string | null;
  onOpenConversation: (id: string) => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const deleted = !!m.deleted_at;
  return (
    <div
      className={cn(
        'group relative flex gap-3 px-2 -mx-2 rounded-lg hover:bg-surface-2/60',
        grouped ? 'py-0.5' : 'pt-2.5 pb-0.5',
        mentionsMe && !deleted && 'bg-accent-soft/60 hover:bg-accent-soft'
      )}
    >
      <div className="w-8 shrink-0">
        {!grouped && <Avatar name={avatarName} seed={senderSeed} size="sm" />}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <p className="flex items-baseline gap-2">
            <span className="text-ui font-semibold text-ink">{senderName}</span>
            <span className="text-2xs text-ink-3">{timeLabel(m.created_at)}</span>
          </p>
        )}
        {deleted ? (
          <p className="text-ui text-ink-3 italic">Message deleted</p>
        ) : (
          <p className={cn('text-ui text-ink whitespace-pre-wrap break-words', m.pending && 'opacity-60')}>
            {splitMentions(m.content, names).map((part, i) =>
              part.mention ? (
                <span key={i} className="font-semibold text-accent bg-accent-soft rounded px-0.5">
                  {part.text}
                </span>
              ) : (
                <Linkified key={i} text={part.text} />
              )
            )}
          </p>
        )}
        {m.conversation_id && !deleted && (
          <button
            type="button"
            onClick={() => onOpenConversation(m.conversation_id!)}
            className="mt-1.5 inline-flex items-center gap-2 max-w-full px-3 py-2 rounded-lg border border-line bg-surface hover:border-accent-line hover:bg-accent-soft/40 transition-colors text-left"
          >
            <Link2 className="w-3.5 h-3.5 text-accent shrink-0" />
            <span className="min-w-0">
              <span className="block text-2xs font-semibold uppercase tracking-wider text-ink-3">Customer chat</span>
              <span className="block text-ui font-medium text-ink truncate">{conversationLabel(m.conversation_id) || 'Open the conversation'}</span>
            </span>
          </button>
        )}
        {m.failed && (
          <p className="text-xs text-danger mt-0.5">
            Not sent.{' '}
            <button type="button" onClick={onRetry} className="underline font-medium">
              Try again
            </button>
          </p>
        )}
      </div>
      {mine && !deleted && !m.pending && !m.failed && (
        <button
          type="button"
          onClick={onDelete}
          className="absolute right-2 top-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 btn btn-xs btn-ghost px-1.5 text-ink-3 hover:text-danger"
          aria-label="Delete message"
          title="Delete message"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/* ── Composer with @mentions ───────────────────────────────────────────── */

function Composer({
  placeholder,
  mentionable,
  share,
  onClearShare,
  onSend,
}: {
  placeholder: string;
  mentionable: Agent[];
  share: TeamChatShare | null;
  onClearShare: () => void;
  onSend: (text: string, mentions: string[]) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [suggest, setSuggest] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const people = useMemo(() => mentionable.map((a) => ({ id: a.id, name: a.name || a.email || '' })).filter((p) => p.name), [mentionable]);
  const matches = suggest
    ? people.filter((p) => p.name.toLowerCase().includes(suggest.query.toLowerCase())).slice(0, 6)
    : [];

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const pick = (name: string) => {
    if (!suggest) return;
    const caret = ref.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, suggest.start)}@${name} ${text.slice(caret)}`;
    setText(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      const pos = suggest.start + name.length + 2;
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
      resize();
    });
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const ok = await onSend(body, mentionedIds(body, people));
    setSending(false);
    if (ok) {
      setText('');
      requestAnimationFrame(resize);
    }
  };

  return (
    <div className="shrink-0 border-t border-line bg-surface px-3 sm:px-5 py-3">
      {share && (
        <div className="mb-2 inline-flex items-center gap-2 max-w-full px-2.5 py-1.5 rounded-lg bg-accent-soft text-accent text-xs font-medium">
          <Link2 className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">Attaching customer chat: {share.label}</span>
          <button type="button" onClick={onClearShare} aria-label="Remove the attached chat" className="shrink-0 hover:opacity-70">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      <div className="relative flex items-end gap-2">
        {suggest && matches.length > 0 && (
          <ul className="popover absolute bottom-full left-0 mb-2 w-64 max-w-full p-1 z-20" role="listbox" aria-label="Mention a teammate">
            {matches.map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(p.name);
                  }}
                  className={cn('w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-ui', i === active ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-2')}
                >
                  <Avatar name={p.name} seed={p.id} size="xs" />
                  <span className="truncate">{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={`${placeholder} — @ to mention`}
          aria-label={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setSuggest(mentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length));
            setActive(0);
            resize();
          }}
          onKeyDown={(e) => {
            if (suggest && matches.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => (i + 1) % matches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => (i - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick(matches[active].name);
                return;
              }
              if (e.key === 'Escape') {
                setSuggest(null);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          className="input textarea flex-1 min-h-10 max-h-40 resize-none py-2.5"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!text.trim() || sending}
          className="btn btn-primary h-10 w-10 p-0 shrink-0 disabled:opacity-50"
          aria-label="Send"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
      <p className="mt-1.5 text-2xs text-ink-3 hidden sm:block">Enter to send · Shift + Enter for a new line</p>
    </div>
  );
}
