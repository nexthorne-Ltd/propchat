'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { formatTimeAgo } from '@/lib/utils';
import { SettingsCard } from './parts';
import { createApiKeyAction, listApiKeysAction, revokeApiKeyAction, type ApiKeyRow } from '@/app/actions/api-keys';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked; the text is selectable */
        }
      }}
      aria-label={label}
    >
      {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

export function ApiKeysPanel({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await listApiKeysAction(workspaceId);
      return res.success ? { keys: res.keys, error: null } : { keys: null, error: res.error };
    } catch (err) {
      return { keys: null, error: (err as Error)?.message || 'Could not load API keys.' };
    }
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    fetchKeys().then((r) => {
      if (cancelled) return;
      setKeys(r.keys);
      setLoadError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchKeys]);

  const load = async () => {
    setLoadError(null);
    setKeys(null);
    const r = await fetchKeys();
    setKeys(r.keys);
    setLoadError(r.error);
  };

  const create = async () => {
    setSaving(true);
    setCreateError(null);
    try {
      const res = await createApiKeyAction(workspaceId, name);
      if (!res.success) {
        setCreateError(res.error);
        return;
      }
      setKeys((prev) => [res.row, ...(prev || [])]);
      setNewKey(res.key);
      setCreating(false);
      setName('');
    } catch (err) {
      setCreateError((err as Error)?.message || 'Could not create the key.');
    } finally {
      setSaving(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      const res = await revokeApiKeyAction(workspaceId, revoking.id);
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      setKeys((prev) => (prev || []).map((k) => (k.id === revoking.id ? { ...k, revoked_at: new Date().toISOString() } : k)));
      toast.success(`Revoked "${revoking.name}". Requests with it now fail.`);
      setRevoking(null);
    } catch (err) {
      toast.error((err as Error)?.message || 'Could not revoke the key.');
    } finally {
      setRevokeBusy(false);
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://zen-try.site';
  const example = `curl -X POST ${origin}/api/v1/conversations \\
  -H "Authorization: Bearer zk_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"visitor":{"external_id":"user-42","name":"Sara"},"message":"How do I reset my password?"}'`;

  return (
    <div className="space-y-5">
      <SettingsCard
        title="API keys"
        description="Let your own systems (an app, a CRM, a backend) start chats and send messages. The bot answers them the same way it answers the widget, and your team sees them in the inbox."
      >
        <div className="flex justify-end mb-3">
          <Button size="sm" onClick={() => { setCreating(true); setCreateError(null); }}>
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            Create key
          </Button>
        </div>

        {loadError ? (
          <ErrorState title="Could not load API keys" message={loadError} onRetry={load} />
        ) : keys === null ? (
          <LoadingState label="Loading API keys…" />
        ) : keys.length === 0 ? (
          <div className="flex flex-col items-center text-center gap-2 py-8 text-ink-2">
            <KeyRound className="w-6 h-6 text-ink-3" aria-hidden="true" />
            <p className="text-ui font-medium text-ink">No API keys yet</p>
            <p className="text-xs max-w-sm">Create one for each system that should connect, so you can revoke one without breaking the others.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line border border-line rounded-xl">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-ui font-medium text-ink truncate">{k.name}</p>
                  <p className="text-2xs text-ink-3 font-mono">
                    {k.key_prefix}… · created {formatTimeAgo(k.created_at)} · {k.last_used_at ? `last used ${formatTimeAgo(k.last_used_at)}` : 'never used'}
                  </p>
                </div>
                {k.revoked_at ? (
                  <Badge tone="neutral">Revoked</Badge>
                ) : (
                  <>
                    <Badge tone="success">Active</Badge>
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                      Revoke
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard title="Quick start" description="Send the key from your server only. A key in a web page or a mobile app can be read by anyone.">
        <pre className="text-2xs bg-surface-2 border border-line rounded-lg p-3 overflow-x-auto whitespace-pre text-ink">{example}</pre>
        <ul className="mt-3 text-xs text-ink-2 space-y-1 list-disc pl-5">
          <li><code>POST /api/v1/conversations</code> starts a chat; the bot&apos;s reply comes back in <code>replies</code>.</li>
          <li><code>POST /api/v1/conversations/&#123;id&#125;/messages</code> sends the next message.</li>
          <li><code>GET /api/v1/conversations/&#123;id&#125;/messages?after=&#123;message_id&#125;</code> fetches agent replies that arrive later.</li>
        </ul>
      </SettingsCard>

      {creating && (
        <Modal
          title="Create an API key"
          description="Name it after the system that will use it."
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
              <Button onClick={create} loading={saving} disabled={!name.trim()}>Create key</Button>
            </>
          }
        >
          <Field label="Name" error={createError}>
            <Input
              value={name}
              maxLength={80}
              placeholder="e.g. Mobile app backend"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) create();
              }}
              autoFocus
            />
          </Field>
        </Modal>
      )}

      {newKey && (
        <Modal
          title="Copy your API key now"
          description="This is the only time it is shown. If you lose it, revoke it and create another."
          onClose={() => setNewKey(null)}
          footer={<Button onClick={() => setNewKey(null)}>I have copied it</Button>}
        >
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all text-xs font-mono bg-surface-2 border border-line rounded-lg p-2 text-ink select-all">{newKey}</code>
            <CopyButton text={newKey} label="Copy API key" />
          </div>
        </Modal>
      )}

      {revoking && (
        <Modal
          title={`Revoke "${revoking.name}"?`}
          description="Every system using this key stops working at once. This cannot be undone."
          onClose={() => setRevoking(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRevoking(null)}>Cancel</Button>
              <Button variant="danger" onClick={revoke} loading={revokeBusy}>Revoke key</Button>
            </>
          }
        >
          <p className="text-ui text-ink-2">Conversations it started stay in your inbox.</p>
        </Modal>
      )}
    </div>
  );
}
