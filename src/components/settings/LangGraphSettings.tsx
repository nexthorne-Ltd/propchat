'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, PlugZap, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { SaveBar, SettingsCard, useReportDirty } from './parts';
import {
  getExternalAgentSettingsAction,
  saveExternalAgentSettingsAction,
  testExternalAgentAction,
  type ExternalAgentSettings,
} from '@/app/actions/external-agent';

const REQUEST_EXAMPLE = `{
  "event": "message",
  "version": 1,
  "conversation_id": "…",
  "workspace_id": "…",
  "channel": "web",
  "visitor": { "name": "Sara" },
  "current_message": "What is the daily loss limit?",
  "history": [{ "role": "user", "content": "hi" }, { "role": "assistant", "content": "Hello!" }],
  "context": "[CHUNK 1] Article: Daily drawdown …",
  "sources": [{ "id": "…", "title": "Daily drawdown", "url": "https://…" }],
  "system_prompt": "…",
  "language": "en",
  "human_context": null
}`;

const RESPONSE_EXAMPLE = `{
  "response": "The daily loss limit is 4% on Step 1 and Step 2.",
  "action": "reply",            // or "escalate" to hand over to your team
  "priority": "high",           // optional, for escalations
  "internal_note": "…"          // optional, only your team sees it
}`;

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${checked ? 'bg-accent border-accent' : 'bg-surface-3 border-line'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-surface shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

export function LangGraphSettings({ workspaceId }: { workspaceId: string }) {
  const [saved, setSaved] = useState<ExternalAgentSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [autoPilot, setAutoPilot] = useState(true);
  const [url, setUrl] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  // undefined: keep the saved key; '' with removeKey: delete it.
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (s: ExternalAgentSettings) => {
    setSaved(s);
    setEnabled(s.enabled);
    setAutoPilot(s.autoPilot);
    setUrl(s.url);
    setSystemPrompt(s.systemPrompt);
    setApiKey('');
    setRemoveKey(false);
  };

  const fetchSettings = useCallback(async () => {
    try {
      const res = await getExternalAgentSettingsAction(workspaceId);
      return res.success ? { settings: res.settings, error: null } : { settings: null, error: res.error };
    } catch (err) {
      return { settings: null, error: (err as Error)?.message || 'Could not load the agent settings.' };
    }
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    fetchSettings().then((r) => {
      if (cancelled) return;
      if (r.settings) apply(r.settings);
      setLoadError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchSettings]);

  const reload = async () => {
    setLoadError(null);
    setSaved(null);
    const r = await fetchSettings();
    if (r.settings) apply(r.settings);
    setLoadError(r.error);
  };

  const dirty =
    saved !== null &&
    (enabled !== saved.enabled ||
      autoPilot !== saved.autoPilot ||
      url.trim() !== saved.url ||
      systemPrompt.trim() !== saved.systemPrompt ||
      apiKey.trim() !== '' ||
      removeKey);
  useReportDirty(dirty);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveExternalAgentSettingsAction(workspaceId, {
        enabled,
        autoPilot,
        url,
        systemPrompt,
        apiKey: removeKey ? null : apiKey.trim() ? apiKey : undefined,
      });
      if (!res.success) {
        setSaveError(res.error);
        return;
      }
      apply(res.settings);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (err) {
      setSaveError((err as Error)?.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const res = await testExternalAgentAction(workspaceId, {
        url,
        apiKey: removeKey ? null : apiKey.trim() ? apiKey : undefined,
      });
      setTest(
        res.success
          ? { ok: true, text: `Answered in ${res.latencyMs} ms${res.action === 'escalate' ? ' (escalated)' : ''}: “${(res.reply || '').slice(0, 200)}”` }
          : { ok: false, text: res.error }
      );
    } catch (err) {
      setTest({ ok: false, text: (err as Error)?.message || 'The test could not be run.' });
    } finally {
      setTesting(false);
    }
  };

  if (loadError) return <ErrorState title="Could not load the agent settings" message={loadError} onRetry={reload} />;
  if (!saved) return <LoadingState label="Loading agent settings…" />;

  const active = saved.enabled && saved.autoPilot;

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Your own agent (LangGraph)"
        description="Send every customer message to your own agent (LangGraph or any HTTPS endpoint) and use its answer. If it fails or takes longer than 15 seconds, the built-in bot answers instead, so customers are never left waiting."
      >
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {active ? <Badge tone="success">Answering customers</Badge> : saved.enabled ? <Badge tone="warn">Connected, not answering</Badge> : <Badge tone="neutral">Off — the built-in bot answers</Badge>}
        </div>

        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-ui font-medium text-ink">Use my agent</p>
              <p className="text-xs text-ink-2">Off: the built-in bot answers every message.</p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} label="Use my agent" />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-ui font-medium text-ink">Let it reply to customers</p>
              <p className="text-xs text-ink-2">Off: your agent only writes drafts that your team reviews (the AI draft button in the inbox).</p>
            </div>
            <Switch checked={autoPilot} onChange={setAutoPilot} label="Let it reply to customers" />
          </div>

          <Field label="Agent URL" hint="Must be https:// on the public internet. Zentry POSTs each customer message here.">
            <Input value={url} placeholder="https://my-agent.example.com/zentry" onChange={(e) => setUrl(e.target.value)} inputMode="url" autoComplete="off" />
          </Field>

          <Field
            label="API key (optional)"
            hint={removeKey ? 'The saved key will be removed when you save.' : saved.hasApiKey ? 'A key is saved. Type a new one to replace it.' : 'Sent as "Authorization: Bearer …" so your endpoint can check the request came from Zentry.'}
          >
            <Input
              type="password"
              value={apiKey}
              placeholder={saved.hasApiKey && !removeKey ? '•••••••• (saved)' : 'Paste a secret your endpoint checks'}
              onChange={(e) => {
                setApiKey(e.target.value);
                setRemoveKey(false);
              }}
              autoComplete="new-password"
            />
          </Field>
          {saved.hasApiKey && !removeKey && (
            <Button size="xs" variant="ghost" onClick={() => { setRemoveKey(true); setApiKey(''); }}>
              Remove saved key
            </Button>
          )}

          <Field label="System prompt (optional)" hint="Sent to your agent as system_prompt. Empty: the built-in bot's instructions are sent.">
            <Textarea rows={4} value={systemPrompt} maxLength={4000} onChange={(e) => setSystemPrompt(e.target.value)} />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" onClick={runTest} loading={testing} disabled={!url.trim()}>
              <PlugZap className="w-3.5 h-3.5" aria-hidden="true" />
              Test connection
            </Button>
            {test && (
              <p role="status" className={`flex items-start gap-1.5 text-xs ${test.ok ? 'text-success' : 'text-danger'}`}>
                {test.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> : <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />}
                <span className="break-words">{test.text}</span>
              </p>
            )}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="What your endpoint receives and returns" description="A request for a person, or a failure, always goes through the built-in handover, so your team is reached even when your agent is down.">
        <p className="text-xs font-semibold text-ink-2 mb-1">Request (POST, JSON)</p>
        <pre className="text-2xs bg-surface-2 border border-line rounded-lg p-3 overflow-x-auto whitespace-pre text-ink">{REQUEST_EXAMPLE}</pre>
        <p className="text-xs font-semibold text-ink-2 mt-4 mb-1">Response (JSON, within 15 seconds)</p>
        <pre className="text-2xs bg-surface-2 border border-line rounded-lg p-3 overflow-x-auto whitespace-pre text-ink">{RESPONSE_EXAMPLE}</pre>
        <p className="mt-3 text-xs text-ink-2">
          <code>context</code> holds the help center passages Zentry found for this question; answer from them to stay accurate. The reply is shown to the customer as written.
        </p>
      </SettingsCard>

      <SaveBar
        dirty={dirty}
        saving={saving}
        saved={justSaved}
        error={saveError}
        onSave={save}
        onDiscard={() => saved && apply(saved)}
      />
    </div>
  );
}
