'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCheck, Clock, ExternalLink, FileText, Globe, Image as ImageIcon, Lock, RotateCcw, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Input';
import { SkeletonBlock } from '@/components/ui/States';
import { listChannelTemplatesAction } from '@/app/actions/channels';
import type { ReplyOutcome, TicketChannelState } from '@/app/actions/tickets';
import { renderTemplate } from '@/lib/channels/templates';
import type { MessageTemplate } from '@/lib/channels/types';
import { formatRemaining, serviceWindow } from '@/lib/channels/window';
import type { ChannelMessageStatus } from '@/types/database';
import { cn } from '@/lib/utils';
import { timeAgo } from './TicketBits';
import { errorMessage } from '@/lib/errors/user-error';

/**
 * The ticket screen's channel pieces: the 24-hour window banner, the
 * template composer used once that window has closed, and the delivery
 * status under each outgoing message.
 */

/** Re-renders every minute so the window countdown stays honest. */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * The window an agent replies in: the channel's own, or the longer Human
 * Agent window when the connection has that feature (Instagram).
 */
export function useServiceWindow(state: TicketChannelState | null) {
  const now = useMinuteClock();
  return useMemo(
    () => (state ? serviceWindow(state.lastInboundAt, state.humanAgentHours ?? state.windowHours, now) : null),
    [state, now]
  );
}

function hoursText(hours: number): string {
  return hours % 24 === 0 && hours > 24 ? `${hours / 24} days` : `${hours} hours`;
}

export function ChannelBanner({ state, window: win }: { state: TicketChannelState; window: ReturnType<typeof serviceWindow> | null }) {
  if (state.connectionStatus === 'disconnected') {
    return (
      <div role="alert" className="mb-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-xs text-ink">
        <span className="font-semibold text-danger">{state.label} is not connected.</span> Replies cannot be sent until an admin reconnects it in
        Settings → Channels.
      </div>
    );
  }
  return (
    <>
      {state.connectionStatus === 'needs_attention' && (
        <div role="alert" className="mb-2 rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-ink">
          <span className="font-semibold text-warn">{state.label} needs attention.</span> Sending may fail; an admin can check the error in Settings →
          Channels.
        </div>
      )}
      {win && state.windowHours !== null && win.open && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-2">
          <Clock className="w-3.5 h-3.5 text-ink-3" aria-hidden="true" />
          {state.humanAgentHours && !serviceWindow(state.lastInboundAt, state.windowHours).open
            ? `Past ${state.windowHours} hours: your reply goes out as a human agent · ${formatRemaining(win.remainingMs)} left`
            : `Customer service window open · ${formatRemaining(win.remainingMs)} left to reply freely`}
        </p>
      )}
      {win && state.windowHours !== null && !win.open && (
        <div role="status" className="mb-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink">
          <p className="font-semibold flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-ink-3" aria-hidden="true" />
            {state.templates
              ? `The ${state.windowHours}-hour window has closed`
              : `Replies are closed: ${state.label} allows them for ${hoursText(state.humanAgentHours ?? state.windowHours)}`}
          </p>
          <p className="mt-0.5 text-ink-2">
            {state.lastInboundAt ? `The customer last wrote ${timeAgo(state.lastInboundAt)}. ` : 'The customer has not written on this channel. '}
            {state.templates
              ? `${state.label} only lets a business send pre-approved templates until the customer writes again. Their next message reopens the window.`
              : `${state.label} only lets a business answer within ${hoursText(state.windowHours)} of the customer's last message${
                  state.humanAgentHours ? ` (${hoursText(state.humanAgentHours)} for a person, as a human agent)` : ''
                }, and has no templates to start again. Internal notes still work; their next message reopens the conversation.`}
          </p>
        </div>
      )}
    </>
  );
}

const PUBLIC_KIND: Record<'mention' | 'reply' | 'comment', string> = { mention: 'mention', reply: 'reply', comment: 'comment' };

/**
 * Shown above the reply box on a ticket about a public post, reply or comment.
 * It says, in words and with an icon (never colour alone), that what the agent
 * types will be posted where everyone can read it, and under what.
 * `length` counts toward the platform's limit.
 */
export function PublicReplyNotice({ state, length }: { state: TicketChannelState; length: number }) {
  const target = state.publicTarget;
  const over = state.maxReplyLength !== null && length > state.maxReplyLength;
  return (
    <div role="note" className="mb-2 rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-ink">
      <p className="font-semibold text-warn flex items-center gap-1.5">
        <Globe className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Public reply on {state.label}: everyone can see it, not just {target?.handle || 'the customer'}
      </p>
      {target ? (
        <p className="mt-1 text-ink-2">
          It will be posted under their {PUBLIC_KIND[target.kind]}
          {target.excerpt ? <>: “{target.excerpt}{target.excerpt.length >= 160 ? '…' : ''}”</> : '.'}{' '}
          {target.permalink && (
            <a href={target.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent underline underline-offset-2">
              View on {state.label} <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
          )}
        </p>
      ) : (
        <p className="mt-1 text-ink-2">There is no public post in this conversation to reply under, so a reply cannot be sent.</p>
      )}
      <p className="mt-1 text-ink-3">To discuss anything private, add an internal note or ask them to contact you another way. Replies are text only.</p>
      {state.maxReplyLength !== null && (
        <p className={over ? 'mt-1 font-semibold text-danger' : 'mt-1 tabular-nums text-ink-3'} aria-live="polite">
          {length} / {state.maxReplyLength} characters{over ? ': too long to post' : ''}
        </p>
      )}
    </div>
  );
}

/** For channels that mix direct messages with public posts: this ticket is the private side. */
export function PrivateReplyNotice({ state }: { state: TicketChannelState }) {
  return (
    <p className="mb-2 flex items-center gap-1.5 text-xs text-ink-2">
      <Lock className="w-3.5 h-3.5 text-ink-3" aria-hidden="true" />
      Private message on {state.label}: only the customer can see your reply.
    </p>
  );
}

interface PublicMeta {
  kind?: 'mention' | 'reply' | 'comment';
  handle?: string;
  permalink?: string;
}

/** On a customer's message: it was said in public, with a link to see it in context. */
export function PublicItemChip({ item, label }: { item: PublicMeta; label: string }) {
  if (!item.kind) return null;
  return (
    <p className="mb-1 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-0.5 text-2xs text-ink-2">
      <Globe className="w-3 h-3 text-ink-3" aria-hidden="true" />
      Public {PUBLIC_KIND[item.kind]} on {label}
      {item.permalink && (
        <a href={item.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-accent underline underline-offset-2">
          View <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </a>
      )}
    </p>
  );
}

/** Under an agent's reply that went out in public. */
export function PostedPublicly() {
  return (
    <p className="mt-0.5 inline-flex items-center gap-1 text-2xs text-ink-3">
      <Globe className="w-3 h-3" aria-hidden="true" /> Posted publicly
    </p>
  );
}

export function TemplateComposer({
  workspaceId,
  channel,
  onSend,
}: {
  workspaceId: string;
  channel: string;
  onSend: (t: { name: string; language: string; body: string; params: string[] }) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [key, setKey] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listChannelTemplatesAction(workspaceId, channel)
      .catch((e: Error) => ({ success: false as const, error: errorMessage(e) }))
      .then((res) => {
        if (cancelled) return;
        if (!res.success) return setLoadError(res.error);
        setTemplates(res.templates);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, channel, attempt]);

  const chosen = templates?.find((t) => `${t.name}|${t.language}` === key) || null;

  async function send() {
    if (!chosen || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend({ name: chosen.name, language: chosen.language, body: chosen.body, params: params.slice(0, chosen.paramCount) });
      setKey('');
      setParams([]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
        <span>Templates could not be loaded: {loadError}</span>
        <Button
          size="xs"
          onClick={() => {
            setLoadError(null);
            setTemplates(null);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!templates) return <SkeletonBlock className="h-9 w-full rounded-sm" />;
  if (!templates.length) {
    return (
      <p className="text-xs text-ink-2">
        No approved templates yet. Create one in WhatsApp Manager (Account tools → Message templates); Meta usually reviews it within a day.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Template">
        <Select
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setParams([]);
          }}
        >
          <option value="">Choose an approved template…</option>
          {templates.map((t) => (
            <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
              {t.name} ({t.language})
            </option>
          ))}
        </Select>
      </Field>
      {chosen && (
        <>
          {chosen.paramCount > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {Array.from({ length: chosen.paramCount }, (_, i) => (
                <Field key={i} label={`Value for {{${i + 1}}}`}>
                  <Input
                    value={params[i] || ''}
                    onChange={(e) =>
                      setParams((p) => {
                        const next = [...p];
                        next[i] = e.target.value;
                        return next;
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          )}
          <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-ui text-ink whitespace-pre-wrap break-words">
            <p className="eyebrow mb-1 flex items-center gap-1">
              <FileText className="w-3 h-3" aria-hidden="true" /> Preview
            </p>
            {renderTemplate(chosen.body, params) || chosen.name}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          loading={sending}
          disabled={!chosen || params.slice(0, chosen.paramCount).filter((p) => p?.trim()).length < chosen.paramCount}
          onClick={send}
        >
          <Send className="w-3.5 h-3.5" aria-hidden="true" /> Send template
        </Button>
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<ChannelMessageStatus, string> = {
  queued: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Not delivered',
};

export function DeliveryStatus({
  status,
  error,
  onRetry,
}: {
  status: ChannelMessageStatus;
  error?: string | null;
  onRetry?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const Icon = status === 'read' || status === 'delivered' ? CheckCheck : status === 'failed' ? AlertTriangle : status === 'queued' ? Clock : Check;
  return (
    <div className={cn('mt-0.5 text-2xs', status === 'failed' ? 'text-danger' : 'text-ink-3')}>
      <div className="flex items-center justify-end gap-1">
        <Icon className={cn('w-3 h-3', status === 'read' && 'text-accent')} aria-hidden="true" />
        <span>{STATUS_TEXT[status]}</span>
        {status === 'failed' && onRetry && (
          <Button
            size="xs"
            variant="ghost"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRetry();
              } finally {
                setBusy(false);
              }
            }}
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> Retry
          </Button>
        )}
      </div>
      {status === 'failed' && error && <p className="text-ink-2 text-right break-words">{error}</p>}
    </div>
  );
}

/** One line for the notice bar after a channel send. */
export function channelNotice(outcome: ReplyOutcome['channel'], label: string): string | null {
  if (!outcome) return null;
  if (outcome.status === 'failed') return `Not sent on ${label}: ${outcome.error}`;
  if (outcome.status === 'queued') return `Saved. ${label} did not accept it yet; it will be retried automatically.`;
  return null;
}

interface StoryMeta {
  kind?: 'reply' | 'mention';
  url?: string;
  media_url?: string;
  media_type?: string;
}

/** What the customer was reacting to: the business's story, or theirs that mentions the business. */
export function StoryContextCard({ story }: { story: StoryMeta }) {
  const href = story.media_url || story.url;
  const isImage = Boolean(story.media_url && (story.media_type || '').startsWith('image/'));
  return (
    <div className="mb-1.5 rounded-lg border border-line bg-surface-2 p-2 text-xs text-ink-2 max-w-xs">
      <p className="font-semibold text-ink flex items-center gap-1.5">
        <ImageIcon className="w-3.5 h-3.5 text-ink-3" aria-hidden="true" />
        {story.kind === 'mention' ? 'Mentioned you in their story' : 'Replied to your story'}
      </p>
      {isImage && href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="mt-1.5 block">
          {/* eslint-disable-next-line @next/next/no-img-element -- a stored copy on Cloudinary, not an app asset */}
          <img src={href} alt="The story" className="max-h-40 rounded-md border border-line object-cover" />
        </a>
      ) : href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-accent underline underline-offset-2">
          Open the story
        </a>
      ) : null}
      {!story.media_url && <p className="mt-1 text-ink-3">Stories expire after 24 hours, after which Instagram no longer shares them.</p>}
    </div>
  );
}
