'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Link2, Mail, MessageCircle, Phone, Send, Settings2, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Field, Input, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Tabs } from '@/components/ui/Tabs';
import { ErrorState, SkeletonBlock } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { timeAgo } from '@/components/tickets/TicketBits';
import { EmailChannelPanel } from './EmailChannelPanel';
import { CopyRow } from './CopyRow';
import { SocialChannelCard } from './SocialChannelCard';
import {
  completeWhatsAppSignupAction,
  connectInstagramManualAction,
  listTestRecipientsAction,
  startInstagramConnectAction,
  type TestRecipient,
  connectWhatsAppManualAction,
  disconnectChannelAction,
  getChannelsOverviewAction,
  listChannelTemplatesAction,
  sendChannelTestMessageAction,
  type ChannelCard,
  type ChannelsOverview,
} from '@/app/actions/channels';
import type { MessageTemplate } from '@/lib/channels/types';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

// Instagram's own words for these screens, kept in one place.
const IG_PROFESSIONAL_HELP = 'Instagram only allows messaging for professional accounts (Business or Creator).';

/**
 * Settings → Channels. One card per channel: whether it is connected, the
 * last error, and the actions that make sense in that state (connect, send a
 * test, disconnect). Connecting WhatsApp is a guided flow: Meta's Embedded
 * Signup when the platform app is configured, or step-by-step manual setup
 * with the customer's own Meta app.
 */

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  whatsapp: Phone,
  instagram: Camera,
  email: Mail,
  messenger: MessageCircle,
};

const CHANNEL_NAMES: Record<string, string> = { instagram: 'Instagram', x: 'X', threads: 'Threads', linkedin: 'LinkedIn', tiktok: 'TikTok' };
const channelLabel = (id: string) => CHANNEL_NAMES[id] || 'The channel';

type CardState = 'not_connected' | 'connected' | 'needs_attention';

function stateOf(card: ChannelCard): CardState {
  const s = card.connection?.status;
  if (s === 'connected') return 'connected';
  if (s === 'needs_attention') return 'needs_attention';
  return 'not_connected';
}

const STATE_BADGE: Record<CardState, { tone: BadgeTone; label: string }> = {
  not_connected: { tone: 'neutral', label: 'Not connected' },
  connected: { tone: 'success', label: 'Connected' },
  needs_attention: { tone: 'warn', label: 'Needs attention' },
};

export function ChannelsSettings({ workspaceId }: { workspaceId: string }) {
  const [overview, setOverview] = useState<ChannelsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<ChannelCard | null>(null);
  const [testing, setTesting] = useState<ChannelCard | null>(null);
  const [disconnecting, setDisconnecting] = useState<ChannelCard | null>(null);

  const [attempt, setAttempt] = useState(0);
  // Instagram sends the admin back to the dashboard with the outcome in the URL.
  const [returned, setReturned] = useState<{ ok: boolean; channel: string; message: string } | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const result = params.get('channel_result');
    if (!result) return null;
    const channel = params.get('channel') || 'instagram';
    return {
      ok: result === 'connected',
      channel,
      message: params.get('channel_message') || (result === 'connected' ? (channel === 'instagram' ? 'If you used manual setup, add the webhook details shown on the card in Meta.' : 'New items arrive as tickets.') : ''),
    };
  });

  // The outcome is shown once; take it out of the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('channel_result')) return;
    for (const k of ['settings', 'channel', 'channel_result', 'channel_message']) params.delete(k);
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getChannelsOverviewAction(workspaceId)
      .catch((e: Error) => ({ success: false as const, error: errorMessage(e) }))
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setOverview(res.overview);
          setError(null);
        } else {
          setError(res.error);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, attempt]);

  const load = useCallback(() => {
    setLoading(true);
    setAttempt((n) => n + 1);
  }, []);

  if (loading && !overview) {
    return (
      <div className="grid gap-4 md:grid-cols-2" aria-busy="true" aria-label="Loading channels">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card p-5 space-y-3">
            <div className="flex items-center gap-3">
              <SkeletonBlock className="w-10 h-10 rounded-lg" />
              <div className="flex-1 space-y-2">
                <SkeletonBlock className="h-4 w-32 rounded-sm" />
                <SkeletonBlock className="h-3 w-48 rounded-sm" />
              </div>
            </div>
            <SkeletonBlock className="h-8 w-full rounded-md" />
          </div>
        ))}
      </div>
    );
  }

  if (error || !overview) {
    return <ErrorState title="Channels could not be loaded" message={error} onRetry={load} />;
  }

  return (
    <section className="space-y-5" aria-labelledby="channels-heading">
      <div>
        <h3 id="channels-heading" className="text-md font-semibold text-ink">
          Channels
        </h3>
        <p className="text-ui text-ink-2 mt-0.5">
          Messages from every connected channel arrive as tickets in your inbox, and replies go back the way they came.
        </p>
      </div>

      {returned && (
        <div
          role={returned.ok ? 'status' : 'alert'}
          className={cn(
            'rounded-lg border p-4 text-ui text-ink flex items-start justify-between gap-3',
            returned.ok ? 'border-success-line bg-success-soft' : 'border-danger-line bg-danger-soft'
          )}
        >
          <p>
            <span className={cn('font-semibold', returned.ok ? 'text-success' : 'text-danger')}>
              {returned.ok ? `${channelLabel(returned.channel)} connected.` : `${channelLabel(returned.channel)} was not connected.`}
            </span>{' '}
            {returned.message}
          </p>
          <Button size="xs" variant="ghost" onClick={() => setReturned(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {overview.setupProblems.length > 0 && (
        <div role="alert" className="rounded-lg border border-warn-line bg-warn-soft p-4 text-ui text-ink">
          <p className="font-semibold flex items-center gap-2 text-warn">
            <AlertTriangle className="w-4 h-4" aria-hidden="true" /> The server needs setting up before channels can connect
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1 text-ink-2">
            {overview.setupProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {overview.cards.map((card) =>
          card.social ? (
            <SocialChannelCard key={card.id} workspaceId={workspaceId} card={card} onChanged={load} onDisconnect={() => setDisconnecting(card)} />
          ) : (
            <ChannelCardView
              key={card.id}
              card={card}
              onConnect={() => setConnecting(card)}
              onTest={() => setTesting(card)}
              onDisconnect={() => setDisconnecting(card)}
            />
          )
        )}
      </div>

      {connecting && connecting.id === 'email' && (
        <EmailChannelPanel
          workspaceId={workspaceId}
          onClose={() => {
            setConnecting(null);
            load();
          }}
        />
      )}
      {connecting && connecting.id === 'instagram' && (
        <ConnectInstagramModal
          workspaceId={workspaceId}
          overview={overview}
          card={connecting}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setConnecting(null);
            load();
          }}
        />
      )}
      {connecting && connecting.id === 'whatsapp' && (
        <ConnectWhatsAppModal
          workspaceId={workspaceId}
          overview={overview}
          card={connecting}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setConnecting(null);
            load();
          }}
        />
      )}
      {testing && testing.id === 'instagram' ? (
        <InstagramTestModal workspaceId={workspaceId} card={testing} onClose={() => setTesting(null)} onDone={load} />
      ) : (
        testing && <TestMessageModal workspaceId={workspaceId} card={testing} onClose={() => setTesting(null)} onDone={load} />
      )}
      {disconnecting && (
        <DisconnectModal
          workspaceId={workspaceId}
          card={disconnecting}
          onClose={() => setDisconnecting(null)}
          onDone={() => {
            setDisconnecting(null);
            load();
          }}
        />
      )}
    </section>
  );
}

function ChannelCardView({
  card,
  onConnect,
  onTest,
  onDisconnect,
}: {
  card: ChannelCard;
  onConnect: () => void;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  const Icon = ICONS[card.id] || MessageCircle;
  const state = stateOf(card);
  const badge = STATE_BADGE[state];
  const c = card.connection;
  const live = state !== 'not_connected';

  return (
    <article className={cn('card p-5 flex flex-col gap-4 min-w-0', !card.available && 'opacity-80')} aria-label={`${card.label} channel`}>
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-10 h-10 rounded-lg bg-surface-2 border border-line flex items-center justify-center text-ink-2 shrink-0">
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-ink">{card.label}</h4>
            {card.available ? <Badge tone={badge.tone} dot>{badge.label}</Badge> : <Badge>Coming soon</Badge>}
          </div>
          <p className="text-xs text-ink-2 mt-1">{live && c?.display_name ? c.display_name : card.description}</p>
        </div>
      </div>

      {live && c && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div className="min-w-0">
            <dt className="text-ink-3">Last message in</dt>
            <dd className="text-ink truncate">{c.last_inbound_at ? timeAgo(c.last_inbound_at) : 'None yet'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-3">Last message out</dt>
            <dd className="text-ink truncate">{c.last_outbound_at ? timeAgo(c.last_outbound_at) : 'None yet'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-3">Setup</dt>
            <dd className="text-ink truncate">
              {card.id === 'email' ? 'Platform support address' : c.setup_method === 'embedded_signup' ? (card.id === 'instagram' ? 'Signed in with Instagram' : 'Signed up with Meta') : 'Manual (your Meta app)'}
            </dd>
          </div>
          {card.id === 'whatsapp' && (
            <div className="min-w-0">
              <dt className="text-ink-3">Quality rating</dt>
              <dd className="text-ink truncate">{String(c.settings?.quality_rating ?? 'Unknown').toLowerCase()}</dd>
            </div>
          )}
          {card.id === 'instagram' && (
            <div className="min-w-0">
              <dt className="text-ink-3">Token valid until</dt>
              <dd className="text-ink truncate">
                {c.settings?.token_expires_at ? new Date(String(c.settings.token_expires_at)).toLocaleDateString() : 'Unknown'}
              </dd>
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

      {live && card.manualWebhook && (
        <WebhookDetails url={card.manualWebhook.url} verifyToken={card.manualWebhook.verifyToken} verifiedAt={c?.settings?.webhook_verified_at as string | null | undefined} />
      )}

      {card.available && (
        <div className="flex flex-wrap gap-2 mt-auto">
          {!live && (
            <Button variant="primary" size="sm" onClick={onConnect}>
              <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> {card.id === 'email' ? 'Set up email' : `Connect ${card.label}`}
            </Button>
          )}
          {live && (
            <>
              {card.id === 'email' ? (
                <Button size="sm" variant="primary" onClick={onConnect}>
                  <Settings2 className="w-3.5 h-3.5" aria-hidden="true" /> Manage email
                </Button>
              ) : (
                <Button size="sm" onClick={onTest}>
                  <Send className="w-3.5 h-3.5" aria-hidden="true" /> Send test message
                </Button>
              )}
              {state === 'needs_attention' && (
                <Button size="sm" variant="primary" onClick={onConnect}>
                  Reconnect
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onDisconnect}>
                <Unplug className="w-3.5 h-3.5" aria-hidden="true" /> Disconnect
              </Button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function WebhookDetails({ url, verifyToken, verifiedAt }: { url: string; verifyToken: string; verifiedAt?: string | null }) {
  return (
    <div className="rounded-md border border-line bg-surface-2 p-3 space-y-2">
      <p className="text-xs text-ink-2 flex items-center gap-1.5">
        {verifiedAt ? (
          <>
            <CheckCircle2 className="w-3.5 h-3.5 text-success" aria-hidden="true" /> Meta verified this webhook {timeAgo(verifiedAt)}.
          </>
        ) : (
          <>
            <AlertTriangle className="w-3.5 h-3.5 text-warn" aria-hidden="true" /> Waiting for Meta to verify the webhook. Add these in your app under
            WhatsApp → Configuration, then subscribe to the messages field.
          </>
        )}
      </p>
      <CopyRow label="Callback URL" value={url} />
      <CopyRow label="Verify token" value={verifyToken} />
    </div>
  );
}

/* ── Connect ──────────────────────────────────────────────────────────── */

interface FacebookSDK {
  init: (opts: Record<string, unknown>) => void;
  login: (cb: (res: { authResponse?: { code?: string } | null }) => void, opts: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    FB?: FacebookSDK;
    fbAsyncInit?: () => void;
  }
}

function loadFacebookSdk(appId: string, version: string): Promise<FacebookSDK> {
  if (window.FB) return Promise.resolve(window.FB);
  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => reject(new Error('Could not load Facebook’s sign-in. Check that nothing is blocking connect.facebook.net.'));
    document.body.appendChild(script);
  });
}

function ConnectWhatsAppModal({
  workspaceId,
  overview,
  card,
  onClose,
  onConnected,
}: {
  workspaceId: string;
  overview: ChannelsOverview;
  card: ChannelCard;
  onClose: () => void;
  onConnected: () => void;
}) {
  const toast = useToast();
  const embedded = overview.embeddedSignup;
  const [mode, setMode] = useState<'embedded' | 'manual'>(embedded ? 'embedded' : 'manual');
  const [form, setForm] = useState({ phoneNumberId: '', wabaId: '', accessToken: '', appSecret: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await connectWhatsAppManualAction(workspaceId, form).catch((err: Error) => ({ success: false as const, error: errorMessage(err) }));
    setBusy(false);
    if (!res.success) return setError(res.error);
    toast.success('WhatsApp connected. Add the webhook in Meta to start receiving messages.');
    onConnected();
  }

  async function startEmbedded() {
    if (!embedded) return;
    setBusy(true);
    setError(null);
    try {
      const FB = await loadFacebookSdk(embedded.appId, embedded.graphVersion);
      // Meta posts the chosen account and number to this window while the
      // popup is open; the code arrives in the login callback.
      let session: { phoneNumberId?: string; wabaId?: string } = {};
      const onMessage = (event: MessageEvent) => {
        if (!/(^|\.)facebook\.com$/.test(new URL(event.origin).hostname)) return;
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (data?.type === 'WA_EMBEDDED_SIGNUP' && data.data) {
            session = { phoneNumberId: data.data.phone_number_id, wabaId: data.data.waba_id };
          }
        } catch {
          /* Other Facebook frames post non-JSON messages; not ours. */
        }
      };
      window.addEventListener('message', onMessage);
      const code = await new Promise<string | null>((resolve) =>
        FB.login((res) => resolve(res.authResponse?.code || null), {
          config_id: embedded.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, sessionInfoVersion: '3' },
        })
      );
      window.removeEventListener('message', onMessage);
      if (!code) throw new Error('Signup was cancelled before it finished.');
      if (!session.phoneNumberId || !session.wabaId) throw new Error('Meta did not say which number you chose. Try again, or use manual setup.');
      const res = await completeWhatsAppSignupAction(workspaceId, { code, phoneNumberId: session.phoneNumberId, wabaId: session.wabaId });
      if (!res.success) throw new Error(res.error);
      toast.success('WhatsApp connected.');
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Connect ${card.label}`} description="Uses Meta’s official WhatsApp Business Cloud API." onClose={onClose} size="lg">
      <div className="space-y-5">
        {embedded && (
          <Tabs
            label="Setup method"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
            items={[
              { id: 'embedded', label: 'Sign up with Meta' },
              { id: 'manual', label: 'Manual setup' },
            ]}
          />
        )}

        {error && (
          <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-ui text-ink">
            {error}
          </div>
        )}

        {mode === 'embedded' && embedded ? (
          <div className="space-y-4">
            <ol className="list-decimal pl-5 space-y-1.5 text-ui text-ink-2">
              <li>Log in with the Facebook account that manages your business.</li>
              <li>Pick or create your WhatsApp Business Account and phone number, and verify the number by SMS or call.</li>
              <li>Come back here; the connection finishes on its own.</li>
            </ol>
            <p className="text-xs text-ink-3">
              Webhooks arrive at <code className="font-mono">{overview.platformWebhookUrl || '/api/channels/whatsapp/webhook'}</code>, already set up on
              our Meta app.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={startEmbedded}>
                Continue with Facebook
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submitManual} className="space-y-4">
            <ol className="list-decimal pl-5 space-y-1.5 text-ui text-ink-2">
              <li>In Meta for Developers, create a Business app and add the WhatsApp product.</li>
              <li>Under WhatsApp → API Setup, copy the phone number ID and WhatsApp Business Account ID.</li>
              <li>
                In Business Settings → System users, generate a permanent token with <code className="font-mono">whatsapp_business_messaging</code> and{' '}
                <code className="font-mono">whatsapp_business_management</code>.
              </li>
              <li>Copy the app secret from App settings → Basic.</li>
              <li>After connecting, paste the callback URL and verify token shown on the card into WhatsApp → Configuration.</li>
            </ol>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone number ID">
                <Input value={form.phoneNumberId} onChange={set('phoneNumberId')} inputMode="numeric" autoComplete="off" required />
              </Field>
              <Field label="WhatsApp Business Account ID">
                <Input value={form.wabaId} onChange={set('wabaId')} inputMode="numeric" autoComplete="off" required />
              </Field>
            </div>
            <Field label="Permanent access token" hint="Stored encrypted; nobody can read it back, including you.">
              <Input type="password" value={form.accessToken} onChange={set('accessToken')} autoComplete="off" required />
            </Field>
            <Field label="App secret" hint="Used only to check that webhooks really come from Meta.">
              <Input type="password" value={form.appSecret} onChange={set('appSecret')} autoComplete="off" required />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" type="submit" loading={busy}>
                Connect WhatsApp
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

/* ── Instagram ────────────────────────────────────────────────────────── */

function ConnectInstagramModal({
  workspaceId,
  overview,
  card,
  onClose,
  onConnected,
}: {
  workspaceId: string;
  overview: ChannelsOverview;
  card: ChannelCard;
  onClose: () => void;
  onConnected: () => void;
}) {
  const toast = useToast();
  const login = overview.instagramLogin;
  const [mode, setMode] = useState<'login' | 'manual'>(login ? 'login' : 'manual');
  const [form, setForm] = useState({ accessToken: '', appSecret: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function startLogin() {
    setBusy(true);
    setError(null);
    const res = await startInstagramConnectAction(workspaceId).catch((err: Error) => ({ success: false as const, error: errorMessage(err) }));
    if (!res.success) {
      setBusy(false);
      return setError(res.error);
    }
    // Instagram takes over; it sends the admin back to the dashboard when done.
    window.location.assign(res.url);
  }

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await connectInstagramManualAction(workspaceId, form).catch((err: Error) => ({ success: false as const, error: errorMessage(err) }));
    setBusy(false);
    if (!res.success) return setError(res.error);
    toast.success('Instagram connected. Add the webhook in Meta to start receiving messages.');
    onConnected();
  }

  return (
    <Modal title={`Connect ${card.label}`} description="Uses Meta’s official Instagram API with Instagram Login." onClose={onClose} size="lg">
      <div className="space-y-5">
        <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
          <p className="font-semibold text-ink">Before you start</p>
          <ul className="mt-1 list-disc pl-4 space-y-0.5">
            <li>{IG_PROFESSIONAL_HELP} A personal account cannot be connected.</li>
            <li>
              In the Instagram app: Settings → Messages and story replies → Message controls → Connected tools → turn on “Allow access to messages”.
              Without it no messages arrive and Instagram gives no error.
            </li>
            <li>You can reply for 24 hours after a customer’s last message.</li>
          </ul>
        </div>

        {login && (
          <Tabs
            label="Setup method"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
            items={[
              { id: 'login', label: 'Sign in with Instagram' },
              { id: 'manual', label: 'Manual setup' },
            ]}
          />
        )}

        {error && (
          <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-ui text-ink">
            {error}
          </div>
        )}

        {mode === 'login' && login ? (
          <div className="space-y-4">
            <ol className="list-decimal pl-5 space-y-1.5 text-ui text-ink-2">
              <li>Sign in with the Instagram account that customers message.</li>
              <li>Allow access to its profile and messages.</li>
              <li>You come back here and the connection finishes on its own.</li>
            </ol>
            <p className="text-xs text-ink-3">
              Webhooks arrive at <code className="font-mono">{login.webhookUrl}</code>, already set up on our Meta app.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={startLogin}>
                Continue with Instagram
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submitManual} className="space-y-4">
            <ol className="list-decimal pl-5 space-y-1.5 text-ui text-ink-2">
              <li>In Meta for Developers, create a Business app and add the “Instagram” product with Instagram login.</li>
              <li>Under API setup with Instagram login, add your Instagram professional account and generate its access token.</li>
              <li>Copy the Instagram app secret from the same page.</li>
              <li>After connecting, paste the callback URL and verify token shown on the card into the webhook settings, and subscribe to “messages”.</li>
            </ol>
            <Field label="Instagram access token" hint="Stored encrypted; nobody can read it back, including you.">
              <Input type="password" value={form.accessToken} onChange={set('accessToken')} autoComplete="off" required />
            </Field>
            <Field label="Instagram app secret" hint="Used only to check that webhooks really come from Meta.">
              <Input type="password" value={form.appSecret} onChange={set('appSecret')} autoComplete="off" required />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" type="submit" loading={busy}>
                Connect Instagram
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

/** Instagram only allows replying, so the test goes to someone who wrote in the last 24 hours. */
function InstagramTestModal({ workspaceId, card, onClose, onDone }: { workspaceId: string; card: ChannelCard; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [people, setPeople] = useState<TestRecipient[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTestRecipientsAction(workspaceId, card.id)
      .catch((e: Error) => ({ success: false as const, error: errorMessage(e) }))
      .then((res) => {
        if (cancelled) return;
        if (!res.success) return setLoadError(res.error);
        setPeople(res.recipients);
        setTo(res.recipients[0]?.id || '');
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, card.id, attempt]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await sendChannelTestMessageAction(workspaceId, card.id, { to, templateName: '', language: '' }).catch((err: Error) => ({
      success: false as const,
      error: errorMessage(err),
    }));
    setBusy(false);
    onDone();
    if (!res.success) return setError(res.error);
    toast.success('Test message sent.');
    onClose();
  }

  return (
    <Modal
      title="Send a test message"
      description="Instagram only lets a business reply to people who messaged it in the last 24 hours, so the test goes to one of them."
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-ui text-ink">
            {error}
          </div>
        )}
        {loadError ? (
          <div role="alert" className="text-ui text-ink-2 flex flex-wrap items-center gap-2">
            <span>Recent conversations could not be loaded: {loadError}</span>
            <Button
              size="xs"
              onClick={() => {
                setLoadError(null);
                setPeople(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : people === null ? (
          <SkeletonBlock className="h-9 w-full rounded-sm" />
        ) : people.length === 0 ? (
          <div className="rounded-md border border-line bg-surface-2 px-3 py-3 text-ui text-ink-2">
            <p className="font-semibold text-ink">Nobody has messaged you in the last 24 hours</p>
            <p className="mt-1">
              From another Instagram account, send a message to {card.connection?.display_name || 'your account'}, then come back. It will appear here
              within a few seconds.
            </p>
          </div>
        ) : (
          <Field label="Send to">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · wrote {timeAgo(p.lastInboundAt)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!to}>
            <Send className="w-3.5 h-3.5" aria-hidden="true" /> Send test
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Test message ─────────────────────────────────────────────────────── */

function TestMessageModal({ workspaceId, card, onClose, onDone }: { workspaceId: string; card: ChannelCard; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [choice, setChoice] = useState('hello_world|en_US');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listChannelTemplatesAction(workspaceId, card.id)
      .catch((e: Error) => ({ success: false as const, error: errorMessage(e) }))
      .then((res) => {
        if (cancelled) return;
        if (!res.success) return setLoadError(res.error);
        // A test has no values to fill placeholders with: offer the ones without.
        const usable = res.templates.filter((t) => t.paramCount === 0);
        setTemplates(usable);
        if (usable.length && !usable.some((t) => `${t.name}|${t.language}` === 'hello_world|en_US')) {
          setChoice(`${usable[0].name}|${usable[0].language}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, card.id, attempt]);

  const loadTemplates = () => {
    setLoadError(null);
    setTemplates(null);
    setAttempt((n) => n + 1);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const [templateName, language] = choice.split('|');
    setBusy(true);
    setError(null);
    const res = await sendChannelTestMessageAction(workspaceId, card.id, { to, templateName, language }).catch((err: Error) => ({
      success: false as const,
      error: errorMessage(err),
    }));
    setBusy(false);
    onDone();
    if (!res.success) return setError(res.error);
    toast.success('Test message sent. It should arrive on that phone within a few seconds.');
    onClose();
  }

  return (
    <Modal
      title="Send a test message"
      description="WhatsApp only lets a business message someone first with an approved template, so the test uses one."
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-ui text-ink">
            {error}
          </div>
        )}
        <Field label="Send to" hint="Your own WhatsApp number, with country code. On a test number, add it as a recipient in Meta first.">
          <Input type="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder="+1 650 555 1234" autoComplete="tel" required />
        </Field>
        {loadError ? (
          <div role="alert" className="text-ui text-ink-2 flex flex-wrap items-center gap-2">
            <span>Templates could not be loaded: {loadError}</span>
            <Button size="xs" onClick={loadTemplates}>
              Try again
            </Button>
          </div>
        ) : templates === null ? (
          <SkeletonBlock className="h-9 w-full rounded-sm" />
        ) : (
          <Field
            label="Template"
            hint={templates.length ? 'Only approved templates without placeholders are listed.' : 'No approved templates without placeholders; trying hello_world.'}
          >
            <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {templates.length === 0 && <option value="hello_world|en_US">hello_world (en_US)</option>}
              {templates.map((t) => (
                <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
                  {t.name} ({t.language})
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={busy}>
            <Send className="w-3.5 h-3.5" aria-hidden="true" /> Send test
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Disconnect ───────────────────────────────────────────────────────── */

function DisconnectModal({ workspaceId, card, onClose, onDone }: { workspaceId: string; card: ChannelCard; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = await disconnectChannelAction(workspaceId, card.id).catch((err: Error) => ({ success: false as const, error: errorMessage(err) }));
    setBusy(false);
    if (!res.success) return setError(res.error);
    toast.success(`${card.label} disconnected.`);
    onDone();
  }

  return (
    <Modal
      title={`Disconnect ${card.label}?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={confirm}>
            Disconnect
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-ui text-ink-2">
        <p>
          New {card.label} messages stop arriving and replies on {card.label} tickets can no longer be sent. Existing tickets and their history stay.
        </p>
        <p>
          {card.id === 'email'
            ? 'Your support address stays reserved for you. Turn email on again at any time to start receiving mail.'
            : 'The stored access token is deleted. To reconnect later you will need to sign in or paste a token again.'}
        </p>
        {error && (
          <p role="alert" className="text-danger font-medium">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
