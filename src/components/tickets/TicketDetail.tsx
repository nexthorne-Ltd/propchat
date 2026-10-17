'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Clock,
  CornerDownRight,
  ExternalLink,
  History,
  Lock,
  Mail,
  Globe,
  MapPin,
  MessageSquare,
  Monitor,
  Paperclip,
  Phone,
  Plus,
  Send,
  X,
} from 'lucide-react';
import { isSubAgentId, SUB_AGENT_BY_ID } from '@/lib/ai/sub-agents';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { createClient } from '@/lib/supabase/client';
import { Avatar } from '@/components/ui/Avatar';
import { Linkified } from '@/components/ui/Linkified';
import { ChatMarkdown } from '@/components/ui/ChatMarkdown';
import { isVisitorOnline, formatTimeOnPage, calculateTimeOnPage, formatPageDisplay } from '@/lib/tracking/visitor-tracking';
import { Menu } from '@/components/ui/Menu';
import {
  getTicketAction,
  replyToTicketAction,
  retryTicketMessageAction,
  sendTicketTemplateAction,
  updateTicketAction,
  type TicketDetail as Detail,
  type TicketPatch,
} from '@/app/actions/tickets';
import { actorLabel, describeEvent } from '@/lib/tickets/events';
import {
  CHANNEL_LABEL,
  PRIORITY_LABEL,
  SETTABLE_STATUSES,
  STATUS_LABEL,
  TICKET_PRIORITIES,
  TICKET_TYPES,
  TYPE_LABEL,
  normalizeTag,
} from '@/lib/tickets/views';
import type { TicketGroup, TicketPriority, TicketStatus, TicketType } from '@/types/database';
import { ChannelIcon, StatusBadge, fullTime, inputClass, timeAgo } from './TicketBits';
import { SlaBadge, useNow } from './SlaBadge';
import { CsatBadge } from './CsatBadge';
import { TicketCustomFields } from './CustomFields';
import { METRIC_LABEL, formatMinutes, formatRemaining } from '@/lib/sla/policy';
import { roleCan, type Role } from '@/lib/team/permissions';
import { CollisionBanner, usePresence } from './Presence';
import { EmailMessageExtras, isEmailMessage } from './EmailBits';
import { applyMacroAction } from '@/app/actions/automation';
import { useMacroSlash } from './MacroMenu';
import { ChannelBanner, DeliveryStatus, PostedPublicly, PrivateReplyNotice, PublicItemChip, PublicReplyNotice, StoryContextCard, TemplateComposer, channelNotice, useServiceWindow } from './ChannelBits';
import { errorMessage } from '@/lib/errors/user-error';

interface Props {
  workspaceId: string;
  ticketId: string;
  agents: Teammate[];
  groups: (TicketGroup & { member_ids?: string[] })[];
  /** The signed-in agent; decides what the screen offers. Null until the workspace has loaded. */
  me: { id: string; role: Role } | null;
  onBack: () => void;
  onOpenTicket: (id: string) => void;
  /** Something changed that the list and counts should reflect. */
  onChanged: () => void;
}

export interface Teammate {
  id: string;
  name: string;
  status?: string;
  role?: Role;
  is_active?: boolean;
  max_open_tickets?: number | null;
  open_tickets?: number;
}

export function TicketDetail({ workspaceId, ticketId, agents, groups, me, onBack, onOpenTicket, onChanged }: Props) {
  const canEdit = roleCan(me?.role, 'edit_ticket');
  const canReply = roleCan(me?.role, 'reply');
  const { others, report } = usePresence(workspaceId, ticketId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'conversation' | 'audit'>('conversation');

  const load = useCallback(async () => {
    try {
      setDetail(await getTicketAction(workspaceId, ticketId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [workspaceId, ticketId]);

  // The parent keys this component by ticket, so state starts fresh per ticket.
  useEffect(() => {
    let cancelled = false;
    getTicketAction(workspaceId, ticketId)
      .then((d) => !cancelled && setDetail(d))
      .catch((err: Error) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, ticketId]);

  // Live: new chat messages and changes made by anyone else.
  const conversationId = detail?.ticket.conversation_id;
  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    };
    const channel = supabase.channel(`ticket-${ticketId}-${Math.random().toString(36).slice(2, 7)}`);
    channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tickets', filter: `id=eq.${ticketId}` }, refresh);
    if (conversationId) {
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        refresh
      );
    }
    channel.subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [ticketId, conversationId, load]);

  const people = useMemo(() => {
    const map: Record<string, string> = { ...(detail?.people || {}) };
    for (const a of agents) map[a.id] = a.name;
    return map;
  }, [detail, agents]);
  const groupNames = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g.name])), [groups]);

  const update = async (patch: TicketPatch) => {
    try {
      await updateTicketAction(workspaceId, ticketId, patch);
      await load();
      onChanged();
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <ErrorState title="Couldn't open this ticket" message={error} />
        <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>
          Back to tickets
        </button>
      </div>
    );
  }
  if (!detail) {
    return <LoadingState label="Loading ticket…" className="flex-1" />;
  }

  const { ticket } = detail;
  const closed = ticket.status === 'closed';
  const followUp = detail.related.find((r) => r.follow_up_of_id === ticket.id);
  const followUpOf = detail.related.find((r) => r.id === ticket.follow_up_of_id);
  const mergedInto = detail.related.find((r) => r.id === ticket.merged_into_id);
  const mergedFrom = detail.related.filter((r) => r.merged_into_id === ticket.id);

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      <section className="flex-1 flex flex-col min-w-0 border-r border-line">
        <header className="px-4 py-3 border-b border-line flex items-start gap-3 shrink-0">
          <button type="button" className="btn btn-ghost btn-icon shrink-0" onClick={onBack} aria-label="Back to tickets">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs text-ink-3">
              <ChannelIcon channel={ticket.channel} />
              <span className="tabular-nums">#{ticket.number}</span>
              <StatusBadge status={ticket.status} />
              <SlaBadge ticket={ticket} />
              <CsatBadge ticket={ticket} />
              <span>· {CHANNEL_LABEL[ticket.channel]} · opened {timeAgo(ticket.created_at)}</span>
            </div>
            <SubjectEditor
              key={ticket.subject}
              value={ticket.subject}
              disabled={closed}
              onSave={(subject) => update({ subject })}
            />
          </div>
        </header>

        {closed && (
          <div className="px-4 py-2.5 bg-surface-2 border-b border-line text-xs text-ink-2 flex items-center gap-2 shrink-0">
            <Lock className="w-3.5 h-3.5 shrink-0" />
            <span>
              This ticket is closed and read-only.
              {mergedInto ? (
                <>
                  {' '}It was merged into{' '}
                  <LinkButton onClick={() => onOpenTicket(mergedInto.id)}>#{mergedInto.number}</LinkButton>.
                </>
              ) : followUp ? (
                <>
                  {' '}The customer&apos;s later messages are on{' '}
                  <LinkButton onClick={() => onOpenTicket(followUp.id)}>follow-up #{followUp.number}</LinkButton>.
                </>
              ) : (
                ' A new message from the customer will open a follow-up ticket.'
              )}
            </span>
          </div>
        )}
        {followUpOf && (
          <div className="px-4 py-2 border-b border-line text-xs text-ink-2 flex items-center gap-2 shrink-0">
            <CornerDownRight className="w-3.5 h-3.5 shrink-0" />
            Follow-up to <LinkButton onClick={() => onOpenTicket(followUpOf.id)}>#{followUpOf.number}</LinkButton>
            <span className="truncate text-ink-3">{followUpOf.subject}</span>
          </div>
        )}
        {mergedFrom.length > 0 && (
          <div className="px-4 py-2 border-b border-line text-xs text-ink-2 flex flex-wrap items-center gap-x-2 shrink-0">
            Merged into this ticket:
            {mergedFrom.map((m) => (
              <LinkButton key={m.id} onClick={() => onOpenTicket(m.id)}>
                #{m.number}
              </LinkButton>
            ))}
          </div>
        )}
        {notice && (
          <div className="px-4 py-2 bg-warn-soft border-b border-warn-line text-xs text-ink flex items-center gap-2 shrink-0" role="status">
            <span className="flex-1">{notice}</span>
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setNotice(null)} aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <CollisionBanner others={others} />

        <div className="flex items-center gap-1 px-4 pt-2 border-b border-line shrink-0" role="tablist">
          {(
            [
              ['conversation', 'Conversation', MessageSquare],
              ['audit', `Audit log (${detail.events.length})`, History],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 h-9 text-xs font-semibold border-b-2 -mb-px',
                tab === key ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'
              )}
            >
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>

        {tab === 'conversation' ? (
          <>
            <Thread
              detail={detail}
              people={people}
              onRetry={
                canReply
                  ? async (messageId) => {
                      const result = await retryTicketMessageAction(workspaceId, messageId).catch((e: Error) => {
                        setNotice(errorMessage(e));
                        return null;
                      });
                      const text = result && channelNotice(result.channel, detail.channelState?.label || 'the channel');
                      setNotice(text || null);
                      load();
                    }
                  : undefined
              }
            />
            {!closed && (
              <Composer
                key={ticket.id}
                workspaceId={workspaceId}
                ticketId={ticket.id}
                status={ticket.status}
                channel={ticket.channel}
                channelState={detail.channelState}
                canReply={canReply}
                canEditStatus={canEdit}
                onActivity={report}
                onSendTemplate={async (template) => {
                  const result = await sendTicketTemplateAction(workspaceId, ticketId, template);
                  setNotice(channelNotice(result.channel, detail.channelState?.label || 'the channel'));
                  load();
                  onChanged();
                }}
                onMacroApplied={() => {
                  load();
                  onChanged();
                }}
                onSend={async (body, internal, submitAs) => {
                  const result = await replyToTicketAction(workspaceId, ticketId, { body, internal, submitAs });
                  const sentNotice = channelNotice(result.channel, detail.channelState?.label || 'the channel');
                  if (sentNotice) setNotice(sentNotice);
                  else if (result.emailError) setNotice(result.emailError);
                  else if (result.emailed) setNotice('Reply emailed to the requester.');
                  // Not awaited: the composer clears as soon as the reply is saved,
                  // so nothing typed meanwhile is wiped by a late clear.
                  load();
                  onChanged();
                }}
              />
            )}
          </>
        ) : (
          <AuditLog detail={detail} people={people} groups={groupNames} />
        )}
      </section>

      <aside className="w-[300px] shrink-0 overflow-y-auto bg-surface hidden md:block" aria-label="Ticket details">
        <SlaSection detail={detail} />
        <Properties detail={detail} agents={agents} groups={groups} disabled={closed || !canEdit} readOnlyReason={!canEdit ? 'Your role can view tickets and add internal notes.' : null} onUpdate={update} />
        <TicketCustomFields
          workspaceId={workspaceId}
          ticketId={detail.ticket.id}
          values={detail.ticket.custom_fields}
          disabled={closed || !canEdit}
        />
        <Requester detail={detail} onOpenTicket={onOpenTicket} />
      </aside>
    </div>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="font-semibold text-accent hover:underline">
      {children}
    </button>
  );
}

function SubjectEditor({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <input
      value={draft}
      disabled={disabled}
      aria-label="Subject"
      placeholder="Add a subject"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() !== value && onSave(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className="w-full mt-1 bg-transparent text-lg font-bold text-ink placeholder:text-ink-3 rounded-md px-1 -mx-1 hover:bg-surface-2 focus:bg-surface-2 focus:outline-none disabled:hover:bg-transparent"
    />
  );
}

/* ── Conversation ─────────────────────────────────────────────────────── */

function Thread({
  detail,
  people,
  onRetry,
}: {
  detail: Detail;
  people: Record<string, string>;
  onRetry?: (messageId: string) => Promise<void>;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [detail.messages.length]);

  const requesterName = detail.requester?.name || detail.requester?.email || 'Customer';

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-canvas">
      {detail.messages.length === 0 && <p className="text-center text-ui text-ink-3 py-10">No messages yet.</p>}
      {detail.messages.map((m) => {
        const time = <span title={fullTime(m.created_at)}>{timeAgo(m.created_at)}</span>;
        if (m.sender_type === 'system' && !m.is_internal) {
          return (
            <p key={m.id} className="text-center text-xs text-ink-3">
              {m.content} · {time}
            </p>
          );
        }
        if (m.is_internal) {
          const author =
            m.sender_type === 'agent' ? people[m.sender_id || ''] || 'Agent' : m.sender_type === 'ai' ? 'Bot' : 'System';
          return (
            <article key={m.id} className="rounded-xl border border-warn-line bg-warn-soft px-3.5 py-2.5" aria-label="Internal note">
              <header className="flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wide text-warn mb-1">
                <Lock className="w-3 h-3" /> Internal note · <span className="normal-case tracking-normal">{author}</span>
                <span className="ml-auto font-medium normal-case tracking-normal text-ink-3">{time}</span>
              </header>
              <div className="text-ui text-ink whitespace-pre-wrap break-words"><Linkified text={m.content} /></div>
            </article>
          );
        }
        const fromCustomer = m.sender_type === 'visitor';
        // Agent mode labels each bot reply with the specialist that wrote it.
        const botLabel = isSubAgentId(m.metadata?.sub_agent) ? `Bot · ${SUB_AGENT_BY_ID[m.metadata.sub_agent].name}` : 'Bot';
        const author = fromCustomer ? requesterName : m.sender_type === 'ai' ? botLabel : people[m.sender_id || ''] || 'Agent';
        return (
          <div key={m.id} className={cn('flex gap-2.5', fromCustomer ? '' : 'flex-row-reverse')}>
            {m.sender_type === 'ai' ? (
              <span className="w-8 h-8 rounded-full bg-surface-3 flex items-center justify-center shrink-0" aria-hidden>
                <Bot className="w-4 h-4 text-ink-2" />
              </span>
            ) : (
              <Avatar name={author} seed={fromCustomer ? detail.requester?.id : m.sender_id || undefined} size="sm" />
            )}
            <div className={cn('max-w-[75%] min-w-0', fromCustomer ? '' : 'text-right')}>
              <div className="text-xs text-ink-3 mb-0.5">
                <span className="font-semibold text-ink-2">{author}</span> · {time}
              </div>
              {fromCustomer && m.metadata?.channel_story && <StoryContextCard story={m.metadata.channel_story} />}
              {fromCustomer && m.metadata?.channel_public && <PublicItemChip item={m.metadata.channel_public} label={detail.channelState?.label || 'the platform'} />}
              <div
                className={cn(
                  'inline-block text-left rounded-2xl px-3.5 py-2 text-ui break-words',
                  fromCustomer ? 'bg-surface border border-line text-ink' : 'bg-bubble-out text-bubble-out-ink'
                )}
              >
                {m.content && <ChatMarkdown content={m.content} />}
                {isEmailMessage(m.metadata) && <EmailMessageExtras metadata={m.metadata} />}
                {m.attachment_url && !isEmailMessage(m.metadata) && (
                  <a
                    href={m.attachment_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 underline underline-offset-2"
                  >
                    <Paperclip className="w-3.5 h-3.5" /> Attachment
                  </a>
                )}
              </div>
              {!fromCustomer && m.channel_status && (
                <DeliveryStatus status={m.channel_status} error={m.channel_error} onRetry={onRetry ? () => onRetry(m.id) : undefined} />
              )}
              {!fromCustomer && m.metadata?.channel_visibility === 'public' && <PostedPublicly />}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

function Composer({
  workspaceId,
  ticketId,
  status,
  channel,
  channelState,
  canReply,
  canEditStatus,
  onActivity,
  onSend,
  onSendTemplate,
  onMacroApplied,
}: {
  workspaceId: string;
  ticketId: string;
  /** Called after a macro's field changes were applied, so the screen refreshes. */
  onMacroApplied: () => void;
  status: TicketStatus;
  channel: Detail['ticket']['channel'];
  /** Set for tickets from WhatsApp (and later other channels): window and connection state. */
  channelState: Detail['channelState'];
  onSendTemplate: (template: { name: string; language: string; body: string; params: string[] }) => Promise<void>;
  /** Light agents cannot reply to customers: the composer is notes only. */
  canReply: boolean;
  canEditStatus: boolean;
  onActivity: (state: 'viewing' | 'replying' | 'noting') => void;
  onSend: (body: string, internal: boolean, submitAs?: TicketStatus) => Promise<void>;
}) {
  const [internal, setInternal] = useState(!canReply);
  const [body, setBody] = useState('');
  const [submitAs, setSubmitAs] = useState<TicketStatus>(status === 'new' ? 'open' : status);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const win = useServiceWindow(channelState);
  // "/" in a public reply lists macros. Notes and light agents do not use them.
  const macro = useMacroSlash({ workspaceId, ticketId, body, setBody, enabled: canReply && !internal, canChangeFields: canEditStatus });
  // Outside the window only templates may go out; notes are always fine.
  const templateOnly = Boolean(channelState && !internal && win && !win.open && channelState.templates);
  const channelDown = Boolean(channelState && !internal && channelState.connectionStatus === 'disconnected');
  // Channels without templates (Instagram): past the window nothing may be sent.
  const replyLocked = Boolean(channelState && !internal && win && !win.open && !channelState.templates);
  // A reply on a public post, comment or reply is posted where everyone can read it.
  const publicReply = Boolean(channelState && !internal && channelState.audience === 'public');
  const tooLong = publicReply && channelState!.maxReplyLength !== null && Array.from(body).length > channelState!.maxReplyLength!;
  const nothingToAnswer = publicReply && !channelState!.publicTarget;

  const send = async () => {
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      // A macro that sets the status decides it; otherwise "Submit as" does.
      const macroSetsStatus = macro.pending?.actions.some((a) => a.type === 'set_status');
      await onSend(body, internal, internal || !canEditStatus || macroSetsStatus ? undefined : submitAs);
      setBody('');
      if (macro.pending && !internal) {
        const applied = await applyMacroAction(workspaceId, ticketId, macro.pending.id);
        macro.clearPending();
        if (applied.success) onMacroApplied();
        else setError(`Reply sent, but the macro's changes were not applied: ${applied.error}`);
      }
      onActivity('viewing');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={cn('border-t px-4 py-3 shrink-0', internal ? 'border-warn-line bg-warn-soft/60' : 'border-line bg-surface')}>
      <div className="flex items-center gap-1 mb-2" role="tablist" aria-label="Reply type">
        {([false, true] as const).filter((isNote) => canReply || isNote).map((isNote) => (
          <button
            key={String(isNote)}
            type="button"
            role="tab"
            aria-selected={internal === isNote}
            onClick={() => {
              setInternal(isNote);
              if (body.trim()) onActivity(isNote ? 'noting' : 'replying');
            }}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 h-7 rounded-lg text-xs font-semibold',
              internal === isNote
                ? isNote
                  ? 'bg-warn-soft text-warn border border-warn-line'
                  : 'bg-accent-soft text-accent border border-accent-line'
                : 'text-ink-3 hover:text-ink-2'
            )}
          >
            {isNote ? (
              <Lock className="w-3.5 h-3.5" />
            ) : channelState?.audience === 'public' ? (
              <Globe className="w-3.5 h-3.5" />
            ) : channelState ? (
              <Phone className="w-3.5 h-3.5" />
            ) : channel === 'chat' ? (
              <MessageSquare className="w-3.5 h-3.5" />
            ) : (
              <Mail className="w-3.5 h-3.5" />
            )}
            {isNote ? 'Internal note' : channelState?.audience === 'public' ? `Public reply on ${channelState.label}` : channelState ? `Public reply (${channelState.label})` : channel === 'chat' ? 'Public reply (chat)' : 'Public reply (email)'}
          </button>
        ))}
      </div>
      {channelState && !internal && <ChannelBanner state={channelState} window={win} />}
      {publicReply && <PublicReplyNotice state={channelState!} length={Array.from(body).length} />}
      {channelState && !internal && channelState.audience === 'private' && channelState.offersPublic && <PrivateReplyNotice state={channelState} />}
      {templateOnly && !channelDown ? (
        <TemplateComposer workspaceId={workspaceId} channel={channelState!.channel} onSend={onSendTemplate} />
      ) : (
        <>
          {macro.chip}
          <div className="relative">
          {macro.menu}
          <textarea
            {...macro.comboProps}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              onActivity(e.target.value.trim() ? (internal ? 'noting' : 'replying') : 'viewing');
            }}
            onKeyDown={(e) => {
              if (macro.onKeyDown(e)) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
            }}
            rows={3}
            disabled={replyLocked}
            aria-label={internal ? 'Internal note' : publicReply ? 'Public reply' : 'Reply'}
            placeholder={
              replyLocked
                ? 'Replies are closed on this channel until the customer writes again'
                : internal
                  ? 'Only your team can see this note'
                  : publicReply
                    ? `Write a public reply on ${channelState!.label}`
                    : 'Write a reply to the customer'
            }
            className={cn(inputClass, 'h-auto py-2 resize-y min-h-[76px]', internal && 'bg-surface border-warn-line')}
          />
          </div>
          {!internal && canReply && !body && <p className="text-2xs text-ink-3 mt-1">Type / to insert a macro.</p>}
          {error && <p className="text-xs text-danger mt-1.5">{error}</p>}
          <div className="flex items-center justify-end gap-2 mt-2">
            {!canReply && <span className="mr-auto text-xs text-ink-3">Light agents can add internal notes only.</span>}
            {!internal && canEditStatus && (
              <Menu<TicketStatus>
                value={submitAs}
                onChange={setSubmitAs}
                label="Status after sending"
                side="top"
                options={SETTABLE_STATUSES.filter((s) => s !== 'closed').map((s) => ({ value: s, label: `Submit as ${STATUS_LABEL[s]}` }))}
              />
            )}
            <button
              type="button"
              className={cn('btn btn-sm', internal ? 'btn-secondary' : 'btn-accent')}
              onClick={send}
              disabled={sending || !body.trim() || channelDown || replyLocked || tooLong || nothingToAnswer}
            >
              {publicReply ? <Globe className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}{' '}
              {sending ? (publicReply ? 'Posting…' : 'Sending…') : internal ? 'Add note' : publicReply ? 'Post public reply' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AuditLog({ detail, people, groups }: { detail: Detail; people: Record<string, string>; groups: Record<string, string> }) {
  const ctx = { people, groups };
  return (
    <ol className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5 bg-canvas" aria-label="Audit log">
      {[...detail.events].reverse().map((e) => (
        <li key={e.id} className="flex items-start gap-3 py-2 border-b border-line/70 text-xs">
          <span className="w-36 shrink-0 text-ink-3 tabular-nums" title={e.created_at}>
            {fullTime(e.created_at)}
          </span>
          <span className="w-32 shrink-0 font-semibold text-ink truncate">{actorLabel(e, ctx)}</span>
          <span className="text-ink-2 min-w-0 break-words">{describeEvent(e, ctx)}</span>
        </li>
      ))}
    </ol>
  );
}

/* ── Sidebar ──────────────────────────────────────────────────────────── */

/** Each SLA timer on the ticket: what it is, where it stands, and when it is due. */
function SlaSection({ detail }: { detail: Detail }) {
  const now = useNow();
  const { ticket, sla } = detail;
  if (sla.timers.length === 0) return null;
  return (
    <section className="p-4 border-b border-line" aria-label="SLA">
      <h3 className="text-2xs font-bold uppercase tracking-wide text-ink-3 mb-1">SLA</h3>
      {sla.policyName && <p className="text-xs text-ink-3 mb-2">Policy: {sla.policyName}</p>}
      <ul className="space-y-2">
        {sla.timers.map((t) => {
          const due = t.due_at ? new Date(t.due_at) : null;
          let state: string;
          let tone: 'neutral' | 'success' | 'warn' | 'danger' = 'neutral';
          if (t.status === 'met') {
            state = t.breached_at ? 'Met late' : 'Met';
            tone = t.breached_at ? 'danger' : 'success';
          } else if (t.breached_at || (t.status === 'running' && due && due <= now)) {
            state = `Breached ${formatRemaining(now.getTime() - new Date(t.breached_at ?? t.due_at!).getTime())} ago`;
            tone = 'danger';
          } else if (t.status === 'paused') {
            state = 'Paused';
          } else if (due) {
            state = `Due in ${formatRemaining(due.getTime() - now.getTime())}`;
            if (t.warn_at && new Date(t.warn_at) <= now) tone = 'warn';
          } else {
            state = 'Running';
          }
          return (
            <li key={t.metric} className="text-ui">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink font-medium">{METRIC_LABEL[t.metric]}</span>
                <span className={cn('pill', `pill-${tone}`)}>{state}</span>
              </div>
              <p className="text-xs text-ink-3 mt-0.5">
                Target {formatMinutes(t.target_minutes)}
                {t.business_hours ? ' of business time' : ''}
                {due && t.status !== 'met' && ` · ${fullTime(t.due_at!)}`}
                {t.status === 'met' && t.met_at && ` · at ${fullTime(t.met_at)}`}
              </p>
            </li>
          );
        })}
      </ul>
      {ticket.status === 'pending' || ticket.status === 'on_hold' ? <p className="text-xs text-ink-3 mt-2">The clock is paused while the ticket is {ticket.status === 'pending' ? 'Pending' : 'On-hold'}.</p> : null}
    </section>
  );
}

function Properties({
  detail,
  agents,
  groups,
  disabled,
  readOnlyReason,
  onUpdate,
}: {
  detail: Detail;
  agents: Teammate[];
  groups: (TicketGroup & { member_ids?: string[] })[];
  disabled: boolean;
  readOnlyReason?: string | null;
  onUpdate: (patch: TicketPatch) => Promise<void>;
}) {
  const { ticket } = detail;
  const [tag, setTag] = useState('');
  const assignees = assigneeOptions(agents, groups, ticket.group_id, ticket.assignee_id);
  const row = (label: string, control: React.ReactNode) => (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-ink-3 shrink-0">{label}</span>
      <div className={cn('min-w-0', disabled && 'pointer-events-none opacity-60')}>{control}</div>
    </div>
  );
  const statusOptions = (ticket.status === 'new' ? (['new', ...SETTABLE_STATUSES] as TicketStatus[]) : [...SETTABLE_STATUSES]).map((s) => ({
    value: s,
    label: STATUS_LABEL[s],
  }));

  return (
    <section className="p-4 border-b border-line">
      <h3 className="text-2xs font-bold uppercase tracking-wide text-ink-3 mb-2">Properties</h3>
      {readOnlyReason && <p className="text-xs text-ink-3 mb-2">{readOnlyReason}</p>}
      {row(
        'Status',
        <Menu<TicketStatus> value={ticket.status} label="Status" onChange={(status) => status !== 'new' && onUpdate({ status })} options={statusOptions} />
      )}
      {row(
        'Priority',
        <Menu<TicketPriority>
          value={ticket.priority}
          label="Priority"
          onChange={(priority) => onUpdate({ priority })}
          options={TICKET_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
        />
      )}
      {row(
        'Type',
        <Menu<TicketType>
          value={ticket.type}
          label="Type"
          onChange={(type) => onUpdate({ type })}
          options={TICKET_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
        />
      )}
      {row(
        'Assignee',
        <Menu<string>
          value={ticket.assignee_id ?? '__none'}
          label="Assignee"
          onChange={(v) => onUpdate({ assignee_id: v === '__none' ? null : v })}
          options={[{ value: '__none', label: 'Unassigned' }, ...assignees]}
        />
      )}
      {row(
        'Group',
        <Menu<string>
          value={ticket.group_id ?? '__none'}
          label="Group"
          onChange={(v) => onUpdate({ group_id: v === '__none' ? null : v })}
          options={[{ value: '__none', label: 'No group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
        />
      )}
      <div className="py-1.5">
        <span className="text-xs text-ink-3">Tags</span>
        <div className="flex flex-wrap gap-1 mt-1.5">
          {ticket.tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 pl-2 pr-1 h-6 rounded-md bg-surface-3 text-xs text-ink-2">
              {t}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  className="rounded hover:bg-line p-0.5"
                  onClick={() => onUpdate({ tags: ticket.tags.filter((x) => x !== t) })}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
          {!disabled && (
            <form
              className="inline-flex"
              onSubmit={(e) => {
                e.preventDefault();
                const clean = normalizeTag(tag);
                if (clean && !ticket.tags.includes(clean)) onUpdate({ tags: [...ticket.tags, clean] });
                setTag('');
              }}
            >
              <input
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="Add tag"
                aria-label="Add tag"
                className="h-6 w-24 px-2 rounded-md border border-dashed border-line-2 bg-transparent text-xs focus:outline-none focus:border-accent"
              />
              <button type="submit" className="sr-only">
                <Plus /> Add
              </button>
            </form>
          )}
        </div>
      </div>
      <dl className="mt-3 pt-3 border-t border-line grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {(
          [
            ['Created', ticket.created_at],
            ['Updated', ticket.updated_at],
            ['Solved', ticket.solved_at],
            ['Closed', ticket.closed_at],
          ] as const
        )
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-ink-3">{k}</dt>
              <dd className="text-ink-2 text-right" title={v || ''}>
                {fullTime(v)}
              </dd>
            </React.Fragment>
          ))}
      </dl>
      {(ticket.csat_rating || ticket.status === 'solved' || ticket.status === 'closed') && (
        <div className="mt-3 pt-3 border-t border-line">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-2xs font-bold uppercase tracking-wide text-ink-3">Customer satisfaction</span>
            <CsatBadge ticket={ticket} />
          </div>
          {ticket.csat_comment && (
            <div className="p-2.5 rounded-lg bg-surface-2 border border-line text-xs text-ink italic mt-2">
              “{ticket.csat_comment}”
            </div>
          )}
          {ticket.csat_rated_at && (
            <div className="text-2xs text-ink-3 mt-1.5">
              Rated {timeAgo(ticket.csat_rated_at)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Requester({ detail, onOpenTicket }: { detail: Detail; onOpenTicket: (id: string) => void }) {
  const r = detail.requester;
  const history = detail.requesterPageHistory || [];
  const location = r?.location || [r?.ip_location_city, r?.ip_location_country].filter(Boolean).join(', ');
  const online = isVisitorOnline(r);
  const currentPage = r?.current_page_url ? formatPageDisplay(r.current_page_url, r.current_page_title) : null;
  const timeOnPage = r ? (r.time_on_page_seconds ?? calculateTimeOnPage(r.current_page_entered_at)) : 0;

  return (
    <>
      <section className="p-4 border-b border-line">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-2xs font-bold uppercase tracking-wide text-ink-3">Requester</h3>
          {r && (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-medium',
                online ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-surface-2 text-ink-3'
              )}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full', online ? 'bg-emerald-500 animate-pulse' : 'bg-ink-4')} />
              {online ? 'Online now' : 'Offline'}
            </span>
          )}
        </div>
        {r ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              <Avatar name={r.name || r.email || '?'} seed={r.id} size="md" />
              <div className="min-w-0">
                <div className="font-semibold text-ui text-ink truncate">{r.name || 'Unnamed visitor'}</div>
                {r.email && (
                  <a href={`mailto:${r.email}`} className="text-xs text-accent truncate block">
                    {r.email}
                  </a>
                )}
              </div>
            </div>
            <ul className="text-xs text-ink-2 space-y-1">
              {location && (
                <li className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-ink-3" /> {location}
                </li>
              )}
              {(r.browser || r.os || r.device) && (
                <li className="flex items-center gap-1.5">
                  <Monitor className="w-3.5 h-3.5 text-ink-3" /> {[r.browser, r.os, r.device].filter(Boolean).join(' · ')}
                </li>
              )}
              {r.language && <li className="text-ink-3">Language: {r.language}</li>}
              {r.timezone && <li className="text-ink-3">Time zone: {r.timezone}</li>}
              {r.last_seen_at && <li className="text-ink-3">Last seen {timeAgo(r.last_seen_at)}</li>}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-ink-3">No requester on this ticket.</p>
        )}
      </section>

      {/* Live / Current Page */}
      {r && (
        <section className="p-4 border-b border-line">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-2xs font-bold uppercase tracking-wide text-ink-3">Current Page</h3>
            {online && <span className="text-2xs text-emerald-600 dark:text-emerald-400 font-medium">Active</span>}
          </div>
          {currentPage ? (
            <div className="space-y-2">
              <div className="bg-surface-2/60 border border-line rounded-lg p-2.5 text-xs">
                <div className="font-medium text-ink truncate flex items-center gap-1.5 mb-1" title={currentPage.title}>
                  <Globe className="w-3.5 h-3.5 text-accent shrink-0" />
                  <span className="truncate">{currentPage.title}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-ink-3 text-2xs">
                  <a
                    href={currentPage.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate hover:text-accent flex items-center gap-1 group"
                    title={currentPage.url}
                  >
                    <span className="truncate">{currentPage.path}</span>
                    <ExternalLink className="w-3 h-3 opacity-60 group-hover:opacity-100 shrink-0" />
                  </a>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-2xs">
                <div className="bg-surface-2/40 border border-line/60 rounded px-2 py-1.5">
                  <span className="text-ink-3 block">Time on page</span>
                  <span className="font-semibold text-ink flex items-center gap-1 mt-0.5">
                    <Clock className="w-3 h-3 text-ink-3" />
                    {formatTimeOnPage(timeOnPage)}
                  </span>
                </div>
                <div className="bg-surface-2/40 border border-line/60 rounded px-2 py-1.5">
                  <span className="text-ink-3 block">Referrer</span>
                  <span className="text-ink truncate block mt-0.5" title={r.referrer_source || 'Direct'}>
                    {r.referrer_source || 'Direct'}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-ink-3">No page recorded yet.</p>
          )}
        </section>
      )}

      {/* Recent Page History */}
      {r && (
        <section className="p-4 border-b border-line">
          <h3 className="text-2xs font-bold uppercase tracking-wide text-ink-3 mb-2 flex items-center gap-1.5">
            <History className="w-3.5 h-3.5 text-ink-3" />
            <span>Recent Page History ({history.length})</span>
          </h3>
          {history.length === 0 ? (
            <p className="text-xs text-ink-3">No previous pages recorded this session.</p>
          ) : (
            <ul className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              {history.map((h) => {
                const page = formatPageDisplay(h.url, h.title);
                return (
                  <li key={h.id} className="text-xs bg-surface-2/40 border border-line/50 rounded-lg p-2 hover:bg-surface-2 transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <a
                        href={page.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-ink hover:text-accent truncate flex items-center gap-1"
                        title={page.title}
                      >
                        <span className="truncate">{page.title}</span>
                        <ExternalLink className="w-2.5 h-2.5 opacity-50 shrink-0" />
                      </a>
                      <span className="text-2xs text-ink-3 shrink-0 tabular-nums">
                        {timeAgo(h.visited_at)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-2xs text-ink-3 mt-1 pt-1 border-t border-line/40">
                      <span className="truncate font-mono">{page.path}</span>
                      {h.duration_seconds !== undefined && h.duration_seconds !== null && h.duration_seconds > 0 ? (
                        <span className="shrink-0 flex items-center gap-0.5 font-medium text-ink-2">
                          <Clock className="w-2.5 h-2.5 text-ink-3" />
                          {formatTimeOnPage(h.duration_seconds)}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="p-4">
        <h3 className="text-2xs font-bold uppercase tracking-wide text-ink-3 mb-2">
          Previous tickets ({detail.previousTickets.length})
        </h3>
        {detail.previousTickets.length === 0 ? (
          <p className="text-xs text-ink-3">This is their first ticket.</p>
        ) : (
          <ul className="space-y-1">
            {detail.previousTickets.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => onOpenTicket(t.id)}
                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 -mx-2 rounded-lg hover:bg-surface-2"
                >
                  <span className="text-xs text-ink-3 tabular-nums">#{t.number}</span>
                  <span className="text-xs text-ink truncate flex-1">{t.subject || '(no subject)'}</span>
                  <StatusBadge status={t.status} className="scale-90 origin-right" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * Who a ticket can be assigned to: active agents (not light agents), only the
 * group's members when the ticket has a group, with their status and load so
 * the choice is informed. The current assignee stays listed even if they no
 * longer qualify, so the control shows the truth.
 */
export function assigneeOptions(
  agents: Teammate[],
  groups: { id: string; member_ids?: string[] }[],
  groupId: string | null,
  currentId: string | null
): { value: string; label: string; description?: string }[] {
  const members = groupId ? groups.find((g) => g.id === groupId)?.member_ids : undefined;
  return agents
    .filter((a) => a.id === currentId || (a.is_active !== false && a.role !== 'light_agent' && (!members || members.includes(a.id))))
    .map((a) => {
      const open = a.open_tickets;
      const parts = [
        a.is_active === false ? 'Deactivated' : a.status ? a.status[0].toUpperCase() + a.status.slice(1) : null,
        open !== undefined ? `${open}${a.max_open_tickets ? `/${a.max_open_tickets}` : ''} open` : null,
      ].filter(Boolean);
      return { value: a.id, label: a.name, description: parts.join(' · ') || undefined };
    });
}
