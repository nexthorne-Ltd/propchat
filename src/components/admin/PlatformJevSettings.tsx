'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, PlugZap, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Input';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';
import type { JevMode } from '@/lib/ai/jev';
import { SaveBar, SettingsCard } from '@/components/settings/parts';
import {
  getJevSettingsAction,
  saveJevSettingsAction,
  testJevAction,
  type JevSettingsView,
  type JevSummary,
} from '@/app/actions/jev';

const MODES: { id: JevMode; title: string; text: string }[] = [
  { id: 'off', title: 'Off', text: 'DeepSeek makes every decision, as today.' },
  {
    id: 'shadow',
    title: 'Test quietly',
    text: 'Jev runs next to DeepSeek and only records what it would have decided. Customers see no change. Start here.',
  },
  {
    id: 'live',
    title: 'Live',
    text: 'Jev makes the decisions it is sure about. When it is unsure or fails, DeepSeek decides, exactly as before.',
  },
];

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
        checked ? 'bg-accent border-accent' : 'bg-surface-3 border-line'
      )}
    >
      <span className={cn('inline-block h-4 w-4 rounded-full bg-surface shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '–');

/**
 * Super admin → Platform AI → Jev. Set once for every workspace, next to the
 * platform's DeepSeek key. DeepSeek keeps writing every reply; Jev (TypeSafe)
 * makes two fast decisions around it: what the visitor wants, and whether a
 * drafted answer is backed by the help center. See src/lib/ai/jev.ts.
 */
export function PlatformJevSettings() {
  const [saved, setSaved] = useState<JevSettingsView | null>(null);
  const [summary, setSummary] = useState<JevSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<JevMode>('off');
  const [intent, setIntent] = useState(true);
  const [grounding, setGrounding] = useState(true);
  const [minConfidence, setMinConfidence] = useState(0.75);
  const [minGrounding, setMinGrounding] = useState(0.35);
  const [router, setRouter] = useState(true);
  const [minRouteConfidence, setMinRouteConfidence] = useState(0.6);
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (s: JevSettingsView, sum?: JevSummary) => {
    setSaved(s);
    if (sum) setSummary(sum);
    setMode(s.mode);
    setIntent(s.intent);
    setGrounding(s.grounding);
    setMinConfidence(s.minConfidence);
    setMinGrounding(s.minGrounding);
    setRouter(s.router);
    setMinRouteConfidence(s.minRouteConfidence);
    setApiKey('');
    setRemoveKey(false);
  };

  const fetchSettings = useCallback(async () => {
    try {
      const res = await getJevSettingsAction();
      return res.success ? { res, error: null } : { res: null, error: res.error };
    } catch (err) {
      return { res: null, error: errorMessage(err, 'Could not load the Jev settings.') };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSettings().then((r) => {
      if (cancelled) return;
      if (r.res) apply(r.res.settings, r.res.summary);
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
    if (r.res) apply(r.res.settings, r.res.summary);
    setLoadError(r.error);
  };

  const dirty =
    saved !== null &&
    (mode !== saved.mode ||
      intent !== saved.intent ||
      grounding !== saved.grounding ||
      minConfidence !== saved.minConfidence ||
      minGrounding !== saved.minGrounding ||
      router !== saved.router ||
      minRouteConfidence !== saved.minRouteConfidence ||
      apiKey.trim() !== '' ||
      removeKey);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveJevSettingsAction({
        mode,
        intent,
        grounding,
        minConfidence,
        minGrounding,
        router,
        minRouteConfidence,
        apiKey: removeKey ? null : apiKey.trim() ? apiKey : undefined,
      });
      if (!res.success) {
        setSaveError(res.error);
        return;
      }
      apply(res.settings, res.summary);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (err) {
      setSaveError(errorMessage(err, 'Could not save.'));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const res = await testJevAction(removeKey ? undefined : apiKey.trim() || undefined);
      setTest(
        res.success
          ? {
              ok: true,
              text: `Connected. Jev answered in ${res.latencyMs} ms: "${res.intent.replace(/_/g, ' ')}" (${Math.round(res.confidence * 100)}% sure) for a Roman Urdu order question.`,
            }
          : { ok: false, text: res.error }
      );
    } catch (err) {
      setTest({ ok: false, text: errorMessage(err, 'The test could not be run.') });
    } finally {
      setTesting(false);
    }
  };

  if (loadError) return <ErrorState title="Could not load the Jev settings" message={loadError} onRetry={reload} />;
  if (!saved) return <LoadingState label="Loading Jev settings…" />;

  const keyReady = (saved.hasApiKey && !removeKey) || apiKey.trim() !== '' || saved.envKey;
  const s = summary;

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Jev (TypeSafe) with the platform model"
        description="Applies to every workspace's bot. The model above (DeepSeek) keeps writing every reply. Jev only makes quick pick-one and yes/no decisions around it, in a fraction of a second: what the customer wants, and whether the bot's answer is really in that workspace's help center."
      >
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {saved.mode === 'live' ? (
            <Badge tone="success">Live: Jev decides when it is sure</Badge>
          ) : saved.mode === 'shadow' ? (
            <Badge tone="warn">Testing quietly: customers see no change</Badge>
          ) : (
            <Badge tone="neutral">Off: DeepSeek decides everything</Badge>
          )}
        </div>

        <div className="space-y-5">
          <Field
            label="TypeSafe API key"
            hint={
              removeKey
                ? 'The saved key will be removed when you save.'
                : saved.hasApiKey
                ? `A key ending in ${saved.keyLast4} is saved. Type a new one to replace it.`
                : saved.envKey
                ? 'Optional: TYPESAFE_API_KEY from the server environment is used until you save one here.'
                : 'From console.typesafe.ai. Kept on the server only; it is never shown again.'
            }
          >
            <Input
              type="password"
              value={apiKey}
              placeholder={saved.hasApiKey && !removeKey ? '•••••••• (saved)' : 'Paste your TypeSafe API key'}
              onChange={(e) => {
                setApiKey(e.target.value);
                setRemoveKey(false);
              }}
              autoComplete="new-password"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" onClick={runTest} loading={testing} disabled={!keyReady}>
              <PlugZap className="w-3.5 h-3.5" aria-hidden="true" />
              Test connection
            </Button>
            {saved.hasApiKey && !removeKey && (
              <Button size="xs" variant="ghost" onClick={() => { setRemoveKey(true); setApiKey(''); }}>
                Remove saved key
              </Button>
            )}
            {test && (
              <p role="status" className={cn('flex items-start gap-1.5 text-xs', test.ok ? 'text-success' : 'text-danger')}>
                {test.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> : <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />}
                <span className="break-words">{test.text}</span>
              </p>
            )}
          </div>

          <fieldset>
            <legend className="text-ui font-medium text-ink mb-2">Mode</legend>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    'text-left rounded-xl border p-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
                    mode === m.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                  )}
                >
                  <span className="block text-ui font-semibold text-ink">{m.title}</span>
                  <span className="block text-xs text-ink-2 mt-0.5">{m.text}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className={cn('space-y-4', mode === 'off' && 'opacity-60')}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-ui font-medium text-ink">Understand the customer</p>
                <p className="text-xs text-ink-2">
                  Jev decides whether a message is a help-center question, about their own order or account, small talk, off-topic, or a request for a person.
                </p>
              </div>
              <Switch checked={intent} onChange={setIntent} label="Understand the customer" />
            </div>
            {mode === 'live' && intent && (
              <Field label={`Let Jev decide when it is at least ${Math.round(minConfidence * 100)}% sure`} hint="Below this, DeepSeek decides as before. Higher is safer.">
                <input
                  type="range"
                  min={0.5}
                  max={0.95}
                  step={0.05}
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(Number(e.target.value))}
                  className="w-full accent-[var(--ds-accent)]"
                  aria-label="Minimum confidence"
                />
              </Field>
            )}

            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-ui font-medium text-ink">Check answers before sending</p>
                <p className="text-xs text-ink-2">
                  Jev checks that every fact in the bot&apos;s answer is written in your articles. An answer that is not goes to your team instead of the customer.
                </p>
              </div>
              <Switch checked={grounding} onChange={setGrounding} label="Check answers before sending" />
            </div>
            {mode === 'live' && grounding && (
              <Field
                label={`Stop answers that score below ${Math.round(minGrounding * 100)}%`}
                hint="Higher stops more answers (safer, more handovers). Lower lets more through."
              >
                <input
                  type="range"
                  min={0.1}
                  max={0.8}
                  step={0.05}
                  value={minGrounding}
                  onChange={(e) => setMinGrounding(Number(e.target.value))}
                  className="w-full accent-[var(--ds-accent)]"
                  aria-label="Answer check threshold"
                />
              </Field>
            )}

            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-ui font-medium text-ink">Pick the specialist when the rules are unsure</p>
                <p className="text-xs text-ink-2">
                  When a message matches two topics, or none, Jev chooses which sub-agent answers. Clear messages never wait for it. Without Jev the bot&apos;s model chooses.
                </p>
              </div>
              <Switch checked={router} onChange={setRouter} label="Pick the specialist when the rules are unsure" />
            </div>
            {mode === 'live' && router && (
              <Field
                label={`Let Jev choose at ${Math.round(minRouteConfidence * 100)}% confidence or more`}
                hint="Below this the bot's model chooses instead."
              >
                <input
                  type="range"
                  min={0.3}
                  max={0.95}
                  step={0.05}
                  value={minRouteConfidence}
                  onChange={(e) => setMinRouteConfidence(Number(e.target.value))}
                  className="w-full accent-[var(--ds-accent)]"
                  aria-label="Routing confidence"
                />
              </Field>
            )}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title={`How Jev did (last ${s?.days ?? 14} days)`}
        description="All workspaces, from the bot's own decision log; no message text is stored. Use Test quietly for a few days and turn on Live when Jev agrees with DeepSeek most of the time."
      >
        {!s || (s.intent.total === 0 && s.grounding.total === 0 && s.routing.total === 0) ? (
          <p className="text-ui text-ink-2">No Jev decisions yet. Choose Test quietly (or Live) and save; numbers appear as customers write in.</p>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Intent decisions" value={String(s.intent.total)} sub={s.intent.decided ? `${s.intent.decided} decided by Jev` : 'compared only'} />
            <Stat label="Agreed with DeepSeek" value={pct(s.intent.agreed, s.intent.compared)} sub={`${s.intent.agreed} of ${s.intent.compared} compared`} />
            <Stat
              label="Answers flagged"
              value={String(s.grounding.flagged)}
              sub={s.grounding.blocked ? `${s.grounding.blocked} sent to the team` : `of ${s.grounding.total} checked`}
            />
            <Stat
              label="Specialist picks"
              value={String(s.routing.total)}
              sub={s.routing.total ? `${s.routing.changed} differed from the rules${s.routing.decided ? `, ${s.routing.decided} decided by Jev` : ''}` : 'none yet'}
            />
            <Stat
              label="Jev speed"
              value={s.intent.avgLatencyMs !== null ? `${s.intent.avgLatencyMs} ms` : '–'}
              sub={s.intent.errors + s.grounding.errors ? `${s.intent.errors + s.grounding.errors} failed (DeepSeek took over)` : 'no failures'}
            />
          </dl>
        )}
      </SettingsCard>

      <SaveBar dirty={dirty} saving={saving} saved={justSaved} error={saveError} onSave={save} onDiscard={() => saved && apply(saved)} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3">
      <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="text-md font-semibold text-ink mt-0.5">{value}</dd>
      <dd className="text-xs text-ink-2">{sub}</dd>
    </div>
  );
}
