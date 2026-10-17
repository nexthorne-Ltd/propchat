'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Database, Globe, KeyRound, MailWarning, PlugZap, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Input';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { errorMessage } from '@/lib/errors/user-error';
import { cn } from '@/lib/utils';
import { SaveBar, SettingsCard, useReportDirty } from './parts';
import {
  getTraderDataSettingsAction,
  saveTraderDataSettingsAction,
  testTraderDataAction,
  type TraderDataSettings as Settings,
} from '@/app/actions/trader-data';
import type { TraderDataKind } from '@/lib/ai/trader-data/client';

/**
 * Settings → AI bot → Trader data. Connects the firm's backend so the lookup
 * specialists (Account status, KYC status, Order lookup, Affiliate stats,
 * Coupon check) answer from the trader's own record. Every firm runs the same
 * prop-firm backend on its own Supabase project, so the usual connection is
 * that project's URL and service_role key; a firm on another backend can give
 * an HTTPS endpoint instead. Runtime: src/lib/ai/trader-data/; contract:
 * docs/TRADER_DATA.md.
 */

const REQUEST_EXAMPLE = `{
  "version": 1,
  "action": "account_status",   // kyc_status | order_status | affiliate_stats | coupon_check | test
  "workspace_id": "…",
  "conversation_id": "…",
  "email": "trader@example.com", // verified with a code in the chat (null for coupon_check and test)
  "email_verified": true,
  "account_login": "50012345",   // hints the trader typed: check they belong to the email
  "order_id": null,
  "coupon_code": null,
  "question": "mera account breach kyun hua?"
}`;

const RESPONSE_EXAMPLE = `{
  "found": true,
  "record": { "accounts": [{ "login": "50012345", "phase": "Phase 1",
              "status": "Failed", "breach_reason": "Daily loss limit" }] }
}
// Nothing for this email: { "found": false } (or HTTP 404)`;

const KINDS: { value: TraderDataKind; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'supabase', label: 'Prop-firm backend (Supabase)', hint: 'Your firm runs our prop-firm backend: paste its Supabase project URL and service_role key.', icon: Database },
  { value: 'http', label: 'Own endpoint', hint: 'Another backend: Zentry POSTs each lookup to an HTTPS endpoint you build.', icon: Globe },
];

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

export function TraderDataSettings({ workspaceId }: { workspaceId: string }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [kind, setKind] = useState<TraderDataKind>('supabase');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [requireCode, setRequireCode] = useState(false);

  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (s: Settings) => {
    setSaved(s);
    setEnabled(s.enabled);
    setKind(s.kind);
    setUrl(s.url);
    setSecret('');
    setRemoveKey(false);
    setRequireCode(s.requireCode);
  };

  const fetchSettings = useCallback(async () => {
    try {
      const res = await getTraderDataSettingsAction(workspaceId);
      return res.success ? { settings: res.settings, error: null } : { settings: null, error: res.error };
    } catch (err) {
      return { settings: null, error: errorMessage(err) };
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
    (enabled !== saved.enabled || kind !== saved.kind || url.trim() !== saved.url || secret.trim() !== '' || removeKey || requireCode !== saved.requireCode);
  useReportDirty(dirty);

  const secretInput = removeKey ? null : secret.trim() ? secret : undefined;
  // A saved key is used only for the URL it was saved with.
  const savedKeyApplies = Boolean(saved?.hasSecret && !saved.secretUnreadable && !removeKey && kind === saved.kind && url.trim() === saved.url);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveTraderDataSettingsAction(workspaceId, { enabled, kind, url, secret: secretInput, requireCode });
      if (!res.success) {
        setSaveError(res.error);
        return;
      }
      apply(res.settings);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const res = await testTraderDataAction(workspaceId, { kind, url, secret: secretInput });
      setTest(res.success ? { ok: true, text: `Connected: answered in ${res.latencyMs} ms.` } : { ok: false, text: res.error });
    } catch (err) {
      setTest({ ok: false, text: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  if (loadError) return <ErrorState title="Could not load the trader data settings" message={loadError} onRetry={reload} />;
  if (!saved) return <LoadingState label="Loading trader data settings…" />;

  const isSupabase = kind === 'supabase';
  const keyHint = removeKey
    ? 'The saved key will be removed when you save.'
    : saved.secretUnreadable
    ? 'The saved key can no longer be read (the server key changed). Paste it again.'
    : savedKeyApplies
    ? 'A key is saved. Type a new one to replace it.'
    : saved.hasSecret
    ? 'You changed the URL: paste the key again. A saved key is only used for the URL it was saved with.'
    : isSupabase
    ? 'Supabase → Project Settings → API → service_role (secret). Stored encrypted, never shown again, used only for read-only lookups.'
    : 'Sent as "Authorization: Bearer …". Check it on every request: the endpoint returns personal data.';

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Trader data"
        description="Let the bot read your firm's records, so Account status, KYC status, Order lookup, Affiliate stats and Coupon check answer from the trader's own data instead of handing over. If the lookup fails or takes longer than 6 seconds, the bot answers without it and brings in your team when needed."
      >
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {saved.enabled ? <Badge tone="success">Looking up records</Badge> : <Badge tone="neutral">Off: lookups go to your team</Badge>}
        </div>

        {requireCode && !saved.canSendCodes && (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
            <MailWarning className="w-4 h-4 shrink-0 text-warn" aria-hidden="true" />
            <span>
              No email sending is set up, so the bot cannot send traders a verification code and will not look up their records (coupon checks still work). Set up SMTP in Settings → Channels → SMTP, or ask the platform owner to set up platform email.
            </span>
          </div>
        )}
        {!saved.canStoreKeys && (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
            <KeyRound className="w-4 h-4 shrink-0 text-warn" aria-hidden="true" />
            <span>The server cannot encrypt keys yet (CHANNEL_ENCRYPTION_KEY is not set), so a key cannot be saved. Ask the platform owner to set it.</span>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-ui font-medium text-ink">Look up trader records</p>
              <p className="text-xs text-ink-2">Off: the lookup specialists explain the usual cause and hand over, as before.</p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} label="Look up trader records" />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-ui font-medium text-ink">Verify the email with a code</p>
              <p className="text-xs text-ink-2">
                {requireCode
                  ? 'The bot emails a 6-digit code and reads the record only after the trader types it.'
                  : "Off: the bot reads the record straight from the email the trader types (or gave on the pre-chat form). Anyone who knows a trader's email can then see that trader's accounts in the chat."}
              </p>
            </div>
            <Switch checked={requireCode} onChange={setRequireCode} label="Verify the email with a code" />
          </div>

          <fieldset>
            <legend className="text-xs font-semibold text-ink-2 mb-1.5">Your backend</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {KINDS.map((k) => {
                const active = kind === k.value;
                const Icon = k.icon;
                return (
                  <button
                    key={k.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setKind(k.value);
                      setTest(null);
                    }}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
                      active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                    )}
                  >
                    <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', active ? 'text-accent' : 'text-ink-3')} aria-hidden="true" />
                    <span>
                      <span className="block text-ui font-medium text-ink">{k.label}</span>
                      <span className="block text-xs text-ink-2">{k.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <Field
            label={isSupabase ? 'Supabase project URL' : 'Endpoint URL'}
            hint={isSupabase ? 'Supabase → Project Settings → API → Project URL.' : 'Must be https:// on the public internet. Zentry POSTs one request per lookup here.'}
          >
            <Input
              value={url}
              placeholder={isSupabase ? 'https://abcdefghijklmnop.supabase.co' : 'https://api.yourfirm.com/zentry/lookup'}
              onChange={(e) => setUrl(e.target.value)}
              inputMode="url"
              autoComplete="off"
            />
          </Field>

          <Field label={isSupabase ? 'service_role key' : 'API key'} hint={keyHint}>
            <Input
              type="password"
              value={secret}
              placeholder={savedKeyApplies ? '•••••••• (saved)' : isSupabase ? 'eyJhbGciOi… or sb_secret_…' : 'Paste a secret your endpoint checks'}
              onChange={(e) => {
                setSecret(e.target.value);
                setRemoveKey(false);
              }}
              autoComplete="new-password"
            />
          </Field>
          {saved.hasSecret && !removeKey && (
            <Button size="xs" variant="ghost" onClick={() => { setRemoveKey(true); setSecret(''); }}>
              Remove saved key
            </Button>
          )}

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

      {isSupabase ? (
        <SettingsCard title="What the bot reads" description="Only these, only for the trader who proved their email, a few rows at most. It never writes and never reads passwords, KYC documents or payout details.">
          <ul className="list-disc pl-5 space-y-1 text-ui text-ink-2">
            <li><span className="text-ink">Account status</span>: trading_accounts (login, phase, status, balance, equity, P/L, target, credentials delivered or not, breach reason).</li>
            <li><span className="text-ink">KYC status</span>: kyc (method, status, rejection reason).</li>
            <li><span className="text-ink">Order lookup</span>: orders with their plan and whether the account was delivered.</li>
            <li><span className="text-ink">Affiliate stats</span>: affiliates and referrals (code, rate, commission pending / approved / paid).</li>
            <li><span className="text-ink">Coupon check</span>: coupons (discount, status, expiry). No email needed.</li>
          </ul>
        </SettingsCard>
      ) : (
        <SettingsCard title="What your endpoint receives and returns" description="Return only the records of the email you receive. If an account login or order id does not belong to that email, ignore it.">
          <p className="text-xs font-semibold text-ink-2 mb-1">Request (POST, JSON)</p>
          <pre className="text-2xs bg-surface-2 border border-line rounded-lg p-3 overflow-x-auto whitespace-pre text-ink">{REQUEST_EXAMPLE}</pre>
          <p className="text-xs font-semibold text-ink-2 mt-4 mb-1">Response (JSON, within 6 seconds)</p>
          <pre className="text-2xs bg-surface-2 border border-line rounded-lg p-3 overflow-x-auto whitespace-pre text-ink">{RESPONSE_EXAMPLE}</pre>
          <p className="mt-3 text-xs text-ink-2">The record is given to the bot as written (up to 4,000 characters), so leave out staff notes and anything the trader should not see.</p>
        </SettingsCard>
      )}

      <SettingsCard
        title="How the bot finds the trader"
        description={requireCode ? 'With the code on, no record is shown until the trader proves the email.' : 'With the code off, the email is taken as given.'}
      >
        {requireCode ? (
          <ol className="list-decimal pl-5 space-y-1 text-ui text-ink-2">
            <li>The trader asks something only their record can answer, such as &ldquo;why was my account breached?&rdquo;.</li>
            <li>The bot asks for the email on their account and sends a 6-digit code to it (valid 10 minutes, 5 tries, at most 3 codes per chat).</li>
            <li>The trader types the code in the chat. Only then is their record read, for that verified email.</li>
            <li>The bot answers their original question from the record. The verification lasts 12 hours in that conversation.</li>
          </ol>
        ) : (
          <ol className="list-decimal pl-5 space-y-1 text-ui text-ink-2">
            <li>The trader asks something only their record can answer, such as &ldquo;how many accounts do I have?&rdquo;.</li>
            <li>The bot uses the email from the pre-chat form, or asks for the email on their account.</li>
            <li>It reads that email&apos;s record at once and answers: accounts per status, each failed account&apos;s reason, orders without an account.</li>
            <li>The email is remembered for 12 hours in that conversation; a different email typed later replaces it.</li>
          </ol>
        )}
        <p className="mt-3 text-xs text-ink-2">Coupon checks need no email: only the code is looked up.</p>
      </SettingsCard>

      <SaveBar dirty={dirty} saving={saving} saved={justSaved} error={saveError} onSave={save} onDiscard={() => saved && apply(saved)} />
    </div>
  );
}
