'use client';

import React, { useState } from 'react';
import { AlertTriangle, AtSign, Briefcase, Check, CheckCircle2, ExternalLink, Globe, Link2, ListChecks, MessagesSquare, Minus, Music2, RefreshCw, Unplug, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { timeAgo } from '@/components/tickets/TicketBits';
import { checkChannelNowAction, connectTikTokAction, setXDmPollingAction, startSocialConnectAction, type ChannelCard } from '@/app/actions/channels';
import { SOCIAL_CHANNELS, SOCIAL_CHECKED, isSocialChannel, type Support } from '@/lib/channels/social-info';
import { cn } from '@/lib/utils';
import { CopyRow } from './CopyRow';
import { errorMessage } from '@/lib/errors/user-error';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = { x: AtSign, threads: MessagesSquare, linkedin: Briefcase, tiktok: Music2 };

const SUPPORT: Record<Support, { icon: React.ComponentType<{ className?: string }>; label: string; tone: string }> = {
  yes: { icon: Check, label: 'Works', tone: 'text-success' },
  limited: { icon: Minus, label: 'Limited', tone: 'text-warn' },
  no: { icon: X, label: 'Not available', tone: 'text-ink-3' },
};

type Status = { tone: BadgeTone; label: string };

/** Where this card stands, in one honest word. */
function statusOf(card: ChannelCard): Status {
  const c = card.connection;
  if (c?.status === 'connected') return { tone: 'success', label: 'Connected' };
  if (c?.status === 'needs_attention') return { tone: 'warn', label: 'Needs attention' };
  const access = card.social!.access.state;
  if (access === 'requires_approval') return { tone: 'info', label: 'Requires approval' };
  if (access === 'server_setup') return { tone: 'neutral', label: 'Server setup needed' };
  return { tone: 'neutral', label: 'Ready to connect' };
}

/**
 * One card for X, Threads, LinkedIn or TikTok on Settings → Channels. It says
 * what the channel can and cannot do, what it costs or needs, and where it
 * stands today, before offering a way in. A channel that needs approval the
 * workspace does not have yet shows the steps to get it instead of a Connect
 * button that would fail.
 */
export function SocialChannelCard({
  workspaceId,
  card,
  onChanged,
  onDisconnect,
}: {
  workspaceId: string;
  card: ChannelCard;
  onChanged: () => void;
  onDisconnect: () => void;
}) {
  const toast = useToast();
  const info = isSocialChannel(card.id) ? SOCIAL_CHANNELS[card.id] : null;
  const social = card.social;
  const [guide, setGuide] = useState(false);
  const [connect, setConnect] = useState(false);
  const [checking, setChecking] = useState(false);
  const [togglingDms, setTogglingDms] = useState(false);
  if (!info || !social) return null;

  const Icon = ICONS[card.id] || Globe;
  const status = statusOf(card);
  const c = card.connection;
  const live = c && c.status !== 'disconnected';
  const access = social.access;
  const canConnect = access.state === 'ready';
  const pollDms = c?.settings?.poll_dms === true;

  async function checkNow() {
    setChecking(true);
    const res = await checkChannelNowAction(workspaceId, card.id).catch((e: Error) => ({ success: false as const, error: errorMessage(e) }));
    setChecking(false);
    if (!res.success) return toast.error(res.error);
    toast.success(res.message);
    onChanged();
  }

  async function toggleDms() {
    setTogglingDms(true);
    const res = await setXDmPollingAction(workspaceId, !pollDms).catch((e: Error) => ({ success: false as const, error: errorMessage(e) }));
    setTogglingDms(false);
    if (!res.success) return toast.error(res.error);
    onChanged();
  }

  return (
    <article className="card p-5 flex flex-col gap-4 min-w-0 md:col-span-2" aria-label={`${card.label} channel`}>
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-10 h-10 rounded-lg bg-surface-2 border border-line flex items-center justify-center text-ink-2 shrink-0">
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-ink">{card.label}</h4>
            <Badge tone={status.tone} dot>
              {status.label}
            </Badge>
          </div>
          <p className="text-xs text-ink-2 mt-1">{live && c?.display_name ? c.display_name : info.summary}</p>
        </div>
      </div>

      {live && c && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
          <div className="min-w-0">
            <dt className="text-ink-3">Last item in</dt>
            <dd className="text-ink truncate">{c.last_inbound_at ? timeAgo(c.last_inbound_at) : 'None yet'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-3">Last reply out</dt>
            <dd className="text-ink truncate">{c.last_outbound_at ? timeAgo(c.last_outbound_at) : 'None yet'}</dd>
          </div>
          {social.pollEveryMinutes !== null && (
            <div className="min-w-0">
              <dt className="text-ink-3">Checked</dt>
              <dd className="text-ink truncate">
                {typeof c.settings?.last_polled_at === 'string' ? timeAgo(c.settings.last_polled_at) : 'Not yet'} · every {social.pollEveryMinutes} min
              </dd>
            </div>
          )}
          {typeof c.settings?.token_expires_at === 'string' && (
            <div className="min-w-0">
              <dt className="text-ink-3">Sign-in valid until</dt>
              <dd className="text-ink truncate">{new Date(c.settings.token_expires_at).toLocaleDateString()}</dd>
            </div>
          )}
        </dl>
      )}

      {live && c?.last_error && (
        <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-xs text-ink">
          <p className="font-semibold text-danger">Last error {c.last_error_at ? `· ${timeAgo(c.last_error_at)}` : ''}</p>
          <p className="mt-0.5 break-words">{c.last_error}</p>
        </div>
      )}

      <section aria-label={`What ${card.label} can do`}>
        <h5 className="text-2xs font-bold uppercase tracking-wide text-ink-3 mb-1.5">What it can do</h5>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {info.capabilities.map((row) => {
            const s = SUPPORT[row.support];
            const RowIcon = s.icon;
            return (
              <li key={row.label} className="flex items-start gap-2 text-xs min-w-0">
                <RowIcon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', s.tone)} aria-hidden="true" />
                <span className="min-w-0">
                  <span className="font-semibold text-ink">{row.label}</span>
                  <span className="sr-only"> ({s.label})</span>
                  {row.note && <span className="block text-ink-2">{row.note}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label={`What ${card.label} needs`}>
        <h5 className="text-2xs font-bold uppercase tracking-wide text-ink-3 mb-1.5">What it needs</h5>
        <ul className="space-y-1 text-xs text-ink-2 list-disc pl-4">
          {info.requirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>

      {!live && access.state === 'requires_approval' && (
        <p role="status" className="rounded-md border border-info-line bg-info-soft px-3 py-2 text-xs text-ink">
          <span className="font-semibold text-info">{card.label} has to approve your app first.</span> Nothing can be connected before that. Follow the steps to apply; once it is approved, set{' '}
          <code className="font-mono">{access.missing.join(', ')}</code> on the server and this card turns into a Connect button.
        </p>
      )}
      {!live && access.state === 'server_setup' && (
        <p role="status" className="rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-ink">
          <span className="font-semibold text-warn">The server needs setting up.</span> Missing: <code className="font-mono">{access.missing.join(', ')}</code>. The steps show where to get them.
        </p>
      )}

      {live && card.id === 'x' && (
        <label className="flex items-start gap-2 text-xs text-ink-2">
          <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[var(--ds-accent)]" checked={pollDms} disabled={togglingDms} onChange={toggleDms} />
          <span>
            <span className="font-semibold text-ink">Also check direct messages by polling.</span> X bills for every event a check returns, so this costs credits even when nobody wrote (about one event every 15 minutes while idle). Webhooks avoid that if your plan includes them.
          </span>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-auto">
        {!live && canConnect && (
          <Button variant="primary" size="sm" onClick={() => setConnect(true)}>
            <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> Connect {card.label}
          </Button>
        )}
        {live && (
          <>
            {social.pollEveryMinutes !== null && (
              <Button size="sm" loading={checking} onClick={checkNow}>
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Check now
              </Button>
            )}
            {c?.status === 'needs_attention' && canConnect && (
              <Button size="sm" variant="primary" onClick={() => setConnect(true)}>
                Reconnect
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onDisconnect}>
              <Unplug className="w-3.5 h-3.5" aria-hidden="true" /> Disconnect
            </Button>
          </>
        )}
        <Button size="sm" variant={canConnect || live ? 'ghost' : 'secondary'} onClick={() => setGuide(true)}>
          <ListChecks className="w-3.5 h-3.5" aria-hidden="true" /> {access.state === 'requires_approval' ? 'How to get approved' : 'Setup steps'}
        </Button>
      </div>

      {guide && <SocialGuideModal card={card} onClose={() => setGuide(false)} />}
      {connect && (
        <ConnectSocialModal
          workspaceId={workspaceId}
          card={card}
          onClose={() => setConnect(false)}
          onConnected={() => {
            setConnect(false);
            onChanged();
          }}
        />
      )}
    </article>
  );
}

function SocialGuideModal({ card, onClose }: { card: ChannelCard; onClose: () => void }) {
  const info = SOCIAL_CHANNELS[card.id as keyof typeof SOCIAL_CHANNELS];
  const social = card.social!;
  return (
    <Modal title={`${card.label}: setup steps`} description={`What the platform requires, in order. Rules checked ${SOCIAL_CHECKED}; platforms change them, so the linked pages are the authority.`} size="lg" onClose={onClose}>
      <div className="space-y-5">
        <ol className="space-y-2.5 list-decimal pl-5 text-ui text-ink">
          {info.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>

        {(social.redirectUri || social.webhookUrl) && (
          <div className="rounded-md border border-line bg-surface-2 p-3 space-y-2">
            <p className="text-xs font-semibold text-ink">Addresses to give the platform</p>
            {social.redirectUri && <CopyRow label="Redirect (callback) URL" value={social.redirectUri} />}
            {social.webhookUrl && <CopyRow label="Webhook URL" value={social.webhookUrl} />}
          </div>
        )}

        <div>
          <p className="text-xs font-semibold text-ink mb-1">Server settings</p>
          <ul className="text-xs text-ink-2 space-y-0.5">
            {[...info.env, ...(info.approvalFlag ? [info.approvalFlag] : [])].map((k) => (
              <li key={k}>
                <code className="font-mono text-ink">{k}</code>
                {social.access.missing.includes(k) && <span className="text-warn"> · not set</span>}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-xs font-semibold text-ink mb-1">Official documentation</p>
          <ul className="space-y-1 text-xs">
            {info.docs.map((d) => (
              <li key={d.url}>
                <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent underline underline-offset-2">
                  {d.label} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

function ConnectSocialModal({
  workspaceId,
  card,
  onClose,
  onConnected,
}: {
  workspaceId: string;
  card: ChannelCard;
  onClose: () => void;
  onConnected: () => void;
}) {
  const toast = useToast();
  const info = SOCIAL_CHANNELS[card.id as keyof typeof SOCIAL_CHANNELS];
  const [pageId, setPageId] = useState('');
  const [businessId, setBusinessId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await startSocialConnectAction(workspaceId, card.id, { pageId }).catch((err: Error) => ({ success: false as const, error: errorMessage(err) }));
    if (!res.success) {
      setBusy(false);
      return setError(res.error);
    }
    // The platform takes over and sends the admin back to the dashboard when done.
    window.location.assign(res.url);
  }

  async function submitToken(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await connectTikTokAction(workspaceId, { businessId, accessToken }).catch((err: Error) => ({ success: false as const, error: errorMessage(err) }));
    setBusy(false);
    if (!res.success) return setError(res.error);
    toast.success('TikTok connected. Add the webhook URL to your TikTok app to start receiving comments.');
    onConnected();
  }

  return (
    <Modal title={`Connect ${card.label}`} description={info.summary} size="md" onClose={onClose}>
      <form onSubmit={info.connect === 'token' ? submitToken : signIn} className="space-y-4">
        <div className="rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-2 space-y-1">
          <p className="font-semibold text-ink flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-success" aria-hidden="true" /> What you are agreeing to
          </p>
          <p>
            Zentry will read {card.id === 'x' ? 'mentions, replies and direct messages' : card.id === 'threads' ? 'replies and mentions' : 'comments'} and post replies{' '}
            <strong className="text-ink">in public, as {card.label === 'LinkedIn' ? 'your Page' : 'your account'}</strong>
            {card.id === 'x' ? ' (direct messages are answered privately)' : ''}, only when a teammate sends one.
          </p>
        </div>

        {info.connect === 'oauth_page' && (
          <Field label="Your LinkedIn Page id" hint="The number in your Page’s admin address: linkedin.com/company/<number>/admin. You must be an administrator of that Page.">
            <Input inputMode="numeric" value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="12345678" data-autofocus />
          </Field>
        )}
        {info.connect === 'token' && (
          <>
            <Field label="Business Account id (open_id)" hint="Returned with your access token when TikTok approved the app.">
              <Input value={businessId} onChange={(e) => setBusinessId(e.target.value)} data-autofocus />
            </Field>
            <Field label="Access token" hint="Stored encrypted. Used only to read and reply to comments.">
              <Input type="password" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
            </Field>
          </>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-ui text-danger font-medium">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" /> {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {info.connect === 'token' ? `Connect ${card.label}` : `Continue to ${card.label}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
