'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Eye, EyeOff, Plus, RotateCw, Send, Trash2, Webhook } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { cn, formatTimeAgo } from '@/lib/utils';
import { SettingsCard } from './parts';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS, type WebhookEvent } from '@/lib/webhooks';
import {
  createWebhookAction,
  deleteWebhookAction,
  listWebhooksAction,
  rotateWebhookSecretAction,
  testWebhookAction,
  updateWebhookAction,
  type WorkspaceWebhook,
} from '@/app/actions/webhooks';
import { errorMessage } from '@/lib/errors/user-error';

interface Draft {
  id: string | null;
  name: string;
  url: string;
  events: WebhookEvent[];
}

/**
 * Settings → API & webhooks → Webhooks: endpoints that receive ticket and
 * message events as signed JSON (X-Zentry-Signature, HMAC-SHA256). Failed
 * deliveries are retried with backoff.
 */
export function WebhooksSettings({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [hooks, setHooks] = useState<WorkspaceWebhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceWebhook | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setHooks(await listWebhooksAction(workspaceId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    let alive = true;
    listWebhooksAction(workspaceId)
      .then((h) => alive && setHooks(h))
      .catch((e: Error) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const replace = (h: WorkspaceWebhook) => setHooks((all) => (all || []).map((x) => (x.id === h.id ? h : x)));

  async function save() {
    if (!draft) return;
    setBusy('save');
    setFormError(null);
    try {
      if (draft.id) {
        replace(await updateWebhookAction(workspaceId, draft.id, draft));
      } else {
        const created = await createWebhookAction(workspaceId, draft);
        setHooks((all) => [...(all || []), created]);
      }
      toast.success(draft.id ? 'Webhook updated.' : 'Webhook added. Send a test to check it.');
      setDraft(null);
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function run(id: string, work: () => Promise<void>) {
    setBusy(id);
    try {
      await work();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsCard
      title="Webhooks"
      description="Send ticket and message events to your own server as they happen. Each request is signed so you can check it came from us."
    >
      {error && !hooks && <ErrorState title="Could not load webhooks" message={error} onRetry={() => void load()} />}
      {!hooks && !error && <div className="skeleton h-24 rounded-xl" role="status" aria-label="Loading webhooks" />}

      {hooks && hooks.length === 0 && (
        <EmptyState
          type="custom"
          title="No webhooks yet"
          description="Add an https endpoint to receive events like a new ticket or a customer message."
          actionLabel="Add webhook"
          onAction={() => setDraft({ id: null, name: '', url: '', events: [...WEBHOOK_EVENTS] })}
        />
      )}

      {hooks && hooks.length > 0 && (
        <div className="space-y-3">
          {hooks.map((h) => (
            <div key={h.id} className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <div className="flex flex-wrap items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-surface-2 border border-line grid place-items-center shrink-0 text-ink-3">
                  <Webhook className="w-4 h-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ui font-semibold text-ink">{h.name || 'Webhook'}</span>
                    {!h.is_active ? (
                      <Badge tone="neutral">Paused</Badge>
                    ) : h.last_status === 'failed' ? (
                      <Badge tone="danger" dot>
                        Last delivery failed
                      </Badge>
                    ) : h.last_status === 'sent' ? (
                      <Badge tone="success" dot>
                        Delivering
                      </Badge>
                    ) : (
                      <Badge tone="info">No deliveries yet</Badge>
                    )}
                  </div>
                  <div className="text-xs font-mono text-ink-2 break-all mt-0.5">{h.url}</div>
                  <div className="text-xs text-ink-3 mt-1">
                    {h.events.join(', ')}
                    {h.last_delivery_at ? ` · last delivery ${formatTimeAgo(h.last_delivery_at)}` : ''}
                  </div>
                  {h.last_status === 'failed' && h.last_error && <div className="text-xs text-danger mt-1 break-words">{h.last_error}</div>}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-ink-3">Signing secret</span>
                <code className="font-mono px-2 py-1 rounded bg-surface-2 border border-line text-ink-2 break-all">
                  {revealed === h.id ? h.secret : '•'.repeat(24)}
                </code>
                <Button variant="ghost" size="xs" onClick={() => setRevealed(revealed === h.id ? null : h.id)} aria-label={revealed === h.id ? 'Hide secret' : 'Show secret'}>
                  {revealed === h.id ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void navigator.clipboard.writeText(h.secret).then(() => toast.success('Secret copied.'), () => undefined)}
                  aria-label="Copy secret"
                >
                  <Copy className="w-3.5 h-3.5" />
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="xs"
                  loading={busy === `test:${h.id}`}
                  onClick={() =>
                    void run(`test:${h.id}`, async () => {
                      const res = await testWebhookAction(workspaceId, h.id);
                      if (res.ok) toast.success(res.message);
                      else toast.error(res.message);
                      await load();
                    })
                  }
                >
                  <Send className="w-3.5 h-3.5" aria-hidden="true" /> Send test
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setDraft({ id: h.id, name: h.name, url: h.url, events: h.events })}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  loading={busy === `toggle:${h.id}`}
                  onClick={() => void run(`toggle:${h.id}`, async () => replace(await updateWebhookAction(workspaceId, h.id, { is_active: !h.is_active })))}
                >
                  {h.is_active ? 'Pause' : 'Resume'}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  loading={busy === `rotate:${h.id}`}
                  onClick={() =>
                    void run(`rotate:${h.id}`, async () => {
                      replace(await rotateWebhookSecretAction(workspaceId, h.id));
                      setRevealed(h.id);
                      toast.success('New secret created. Update it on your server.');
                    })
                  }
                >
                  <RotateCw className="w-3.5 h-3.5" aria-hidden="true" /> New secret
                </Button>
                <Button variant="ghost" size="xs" className="text-danger" onClick={() => setDeleting(h)}>
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Delete
                </Button>
              </div>
            </div>
          ))}
          <Button variant="secondary" size="sm" onClick={() => setDraft({ id: null, name: '', url: '', events: [...WEBHOOK_EVENTS] })}>
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Add webhook
          </Button>
        </div>
      )}

      <p className="text-xs text-ink-3">
        Each request is a JSON POST with <code className="font-mono">X-Zentry-Event</code> and{' '}
        <code className="font-mono">X-Zentry-Signature: sha256=…</code>, the HMAC-SHA256 of the raw body keyed with the signing secret. Answer with any
        2xx status; other answers are retried up to five times, with growing gaps.
      </p>

      <Modal
        open={draft !== null}
        title={draft?.id ? 'Edit webhook' : 'Add webhook'}
        onClose={() => (busy ? undefined : setDraft(null))}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={busy === 'save'} onClick={() => void save()}>
              {draft?.id ? 'Save' : 'Add webhook'}
            </Button>
          </>
        }
      >
        {draft && (
          <>
            <Field label="Name" hint="Only for you, e.g. “CRM sync”.">
              <Input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Endpoint URL" hint="A public https address." error={formError}>
              <Input value={draft.url} placeholder="https://example.com/zentry-events" autoFocus onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            </Field>
            <fieldset className="space-y-2">
              <legend className="field-label">Events</legend>
              {WEBHOOK_EVENTS.map((ev) => {
                const on = draft.events.includes(ev);
                return (
                  <label key={ev} className={cn('flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer', on ? 'border-accent-line bg-accent-soft' : 'border-line')}>
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[var(--ds-accent)]"
                      checked={on}
                      onChange={() => setDraft({ ...draft, events: on ? draft.events.filter((x) => x !== ev) : [...draft.events, ev] })}
                    />
                    <span>
                      <span className="block text-ui font-mono text-ink">{ev}</span>
                      <span className="block text-xs text-ink-3">{WEBHOOK_EVENT_LABELS[ev]}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          </>
        )}
      </Modal>

      <Modal
        open={deleting !== null}
        size="sm"
        title="Delete this webhook?"
        description={deleting?.url}
        onClose={() => (busy ? undefined : setDeleting(null))}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busy === 'delete'}
              onClick={() =>
                deleting &&
                void run('delete', async () => {
                  await deleteWebhookAction(workspaceId, deleting.id);
                  setHooks((all) => (all || []).filter((x) => x.id !== deleting.id));
                  setDeleting(null);
                  toast.success('Webhook deleted.');
                })
              }
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-ui text-ink-2">Events stop being sent to it right away. Deliveries already queued are dropped when they fail.</p>
      </Modal>
    </SettingsCard>
  );
}
