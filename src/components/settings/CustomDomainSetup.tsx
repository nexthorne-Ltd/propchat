'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Circle, Copy, ExternalLink, Globe, Loader2, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';
import type { Workspace } from '@/types/database';
import { connectCustomDomainAction, removeWorkspaceDomainAction } from '@/app/actions/domain';
import { getCustomDomainSetupAction, type CustomDomainSetup as Setup } from '@/app/actions/custom-domain';

type Rec = Setup['records'][number];

/** Copies `text` and briefly shows "Copied". */
function CopyButton({ text, label, children }: { text: string; label: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-2xs font-medium text-ink-2 hover:bg-surface-2 shrink-0"
      aria-label={`Copy ${label}`}
    >
      {copied ? <CheckCircle2 className="w-3 h-3 text-success" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />}
      {copied ? 'Copied' : children || 'Copy'}
    </button>
  );
}

function StatusChip({ r }: { r: Rec }) {
  if (r.status === 'ok') return <Badge tone="success">✓ Found</Badge>;
  if (r.status === 'wrong') return <Badge tone="danger">Wrong value</Badge>;
  return <Badge tone="warn">Not added yet</Badge>;
}

const PURPOSE: Record<Rec['role'], string> = {
  route: 'Sends visitors of this address to your help center.',
  verify: 'Proves to our hosting that this domain is yours.',
};

/** Plain-text instructions, to paste to whoever manages the DNS. */
function instructionsText(s: Setup): string {
  const lines = [
    `Please add these DNS records for ${s.rootDomain} (help center at https://${s.domain}):`,
    '',
    ...s.records.map((r, i) => `${i + 1}. Type: ${r.type}   Name/Host: ${r.host}   Value: ${r.value}`),
    '',
    'In the Name/Host box type only what is shown above; the DNS panel adds the domain itself.',
  ];
  if (s.provider.isCloudflare) lines.push('Cloudflare: set Proxy status to "DNS only" (grey cloud).');
  return lines.join('\n');
}

/**
 * Settings → Help center → Custom domain. Two steps: type the domain, then
 * add the records shown (each with its own live tick). Checks itself every
 * 15 seconds until the domain is live on HTTPS.
 */
export function CustomDomainSetup({
  workspace,
  onWorkspaceUpdated,
}: {
  workspace: Workspace;
  onWorkspaceUpdated?: (w: Workspace) => void;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(workspace.custom_domain));
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Latest props for the poll, without restarting it on every render.
  const wsRef = useRef(workspace);
  const onUpdatedRef = useRef(onWorkspaceUpdated);
  useEffect(() => {
    wsRef.current = workspace;
    onUpdatedRef.current = onWorkspaceUpdated;
  });

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await getCustomDomainSetupAction(workspace.id);
      if (!res.success) {
        setError(res.error);
        return;
      }
      setError(null);
      setSuggestion(res.suggestion);
      setSetup(res.setup);
      const ws = wsRef.current;
      if (res.setup?.steps.live && ws.custom_domain_status !== 'live') {
        onUpdatedRef.current?.({ ...ws, custom_domain_status: 'live', custom_domain_verified_at: new Date().toISOString() });
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not check the domain right now.'));
    } finally {
      setChecking(false);
      setLoading(false);
    }
  }, [workspace.id]);

  // First load, then every 15 s while the domain is not live and the tab is visible.
  const live = setup?.steps.live ?? false;
  const hasDomain = Boolean(workspace.custom_domain);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState !== 'hidden') await check();
      if (alive && hasDomain && !live) timer = setTimeout(tick, 15_000);
    };
    timer = setTimeout(tick, 0);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [check, hasDomain, live]);

  const connect = async (value: string) => {
    setConnecting(true);
    setError(null);
    try {
      const res = await connectCustomDomainAction(workspace.id, value);
      if (!res.success || !res.data) {
        setError(res.error || 'Could not connect this domain.');
        return;
      }
      onWorkspaceUpdated?.(res.data.workspace);
      setLoading(true);
      await check();
    } catch (err) {
      setError(errorMessage(err, 'Could not connect this domain.'));
    } finally {
      setConnecting(false);
    }
  };

  const remove = async () => {
    if (!confirm('Remove this domain? Your help center goes back to its platform address right away.')) return;
    setRemoving(true);
    try {
      const res = await removeWorkspaceDomainAction(workspace.id);
      if (!res.success) {
        setError(res.error || 'Could not remove the domain.');
        return;
      }
      setSetup(null);
      setInput('');
      onWorkspaceUpdated?.({
        ...workspace,
        custom_domain: null,
        custom_domain_status: null,
        custom_domain_verified_at: null,
        custom_domain_connected_at: null,
        custom_domain_last_checked_at: null,
        custom_domain_notification_sent: null,
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not remove the domain.'));
    } finally {
      setRemoving(false);
    }
  };

  /* ── No domain yet: step 1 ─────────────────────────────────────────── */
  if (!hasDomain) {
    return (
      <section className="card p-6 space-y-4" aria-labelledby="cd-title">
        <div>
          <h3 id="cd-title" className="text-md font-semibold text-ink flex items-center gap-2">
            <Globe className="w-4 h-4 text-accent" aria-hidden="true" /> Use your own domain
          </h3>
          <p className="text-xs text-ink-3 mt-1">
            Show your help center on an address like <span className="font-mono text-ink">{suggestion || 'help.yourcompany.com'}</span>. It takes two steps and
            HTTPS is set up for you.
          </p>
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) void connect(input.trim());
          }}
        >
          <Field label="Step 1 · Your help-center address" hint="Use a subdomain such as help.yourcompany.com. Do not include https://.">
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={suggestion || 'help.yourcompany.com'} autoComplete="off" inputMode="url" />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" loading={connecting} disabled={!input.trim()}>
              Continue
            </Button>
            {suggestion && !input && (
              <button type="button" onClick={() => setInput(suggestion)} className="text-xs text-accent hover:underline">
                Use {suggestion}
              </button>
            )}
          </div>
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        </form>
      </section>
    );
  }

  /* ── Domain set: records, progress, live ────────────────────────────── */
  return (
    <DomainSetupView
      domain={setup?.domain || workspace.custom_domain || ''}
      setup={setup}
      loading={loading}
      checking={checking}
      removing={removing}
      error={error}
      onCheck={() => void check()}
      onRemove={() => void remove()}
    />
  );
}


/**
 * The setup screen once a domain is entered: progress, the records with a
 * live status each, and the live state. Presentational, so it can be tested
 * and previewed with fixture data.
 */
export function DomainSetupView({
  domain,
  setup,
  loading,
  checking,
  removing,
  error,
  onCheck,
  onRemove,
}: {
  domain: string;
  setup: Setup | null;
  loading: boolean;
  checking: boolean;
  removing: boolean;
  error: string | null;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const live = setup?.steps.live ?? false;
  const steps = setup?.steps;

  return (
    <section className="card p-6 space-y-5" aria-labelledby="cd-title">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="cd-title" className="text-md font-semibold text-ink flex items-center gap-2 flex-wrap">
            <Globe className="w-4 h-4 text-accent" aria-hidden="true" />
            <span className="font-mono break-all">{domain}</span>
            {live ? <Badge tone="success">Live</Badge> : <Badge tone="warn">Setting up</Badge>}
          </h3>
          {live && (
            <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer" className="text-xs text-accent inline-flex items-center gap-1 mt-1 hover:underline">
              Open https://{domain} <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!live && (
            <Button variant="secondary" size="sm" onClick={onCheck} loading={checking}>
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Check now
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onRemove} loading={removing} className="text-danger">
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Remove
          </Button>
        </div>
      </div>

      {/* Progress */}
      <ol className="grid gap-2 sm:grid-cols-3" aria-label="Progress">
        {[
          { done: steps?.dns, label: 'DNS records added' },
          { done: steps?.verified, label: 'Domain verified' },
          { done: steps?.live, label: 'Live with HTTPS' },
        ].map((s, i) => (
          <li
            key={s.label}
            className={cn(
              'flex items-center gap-2 rounded-xl border px-3 py-2 text-xs',
              s.done ? 'border-success-line bg-success-soft text-ink' : 'border-line bg-surface-2 text-ink-2'
            )}
          >
            {s.done ? (
              <CheckCircle2 className="w-4 h-4 text-success shrink-0" aria-hidden="true" />
            ) : loading || checking ? (
              <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
            ) : (
              <Circle className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span>
              {i + 1}. {s.label}
            </span>
          </li>
        ))}
      </ol>

      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {setup?.hostingError && (
        <p role="alert" className="rounded-lg border border-danger-line bg-danger-soft p-3 text-xs text-ink">
          {setup.hostingError} Our team has to fix this on the hosting side; your DNS records can stay as they are.
        </p>
      )}

      {loading && !setup ? (
        <div className="skeleton h-32 rounded-xl" />
      ) : setup && !live ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-ui font-medium text-ink">
              Step 2 · Add {setup.records.length === 1 ? 'this record' : `these ${setup.records.length} records`}
              {setup.provider.id !== 'other' ? ` in ${setup.provider.name}` : ' where you manage your domain'}
            </p>
            <div className="flex items-center gap-2">
              {setup.provider.panelUrl && (
                <a
                  href={setup.provider.panelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  Open {setup.provider.name} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
              )}
              <CopyButton text={instructionsText(setup)} label="all records as text">
                Copy all for your developer
              </CopyButton>
            </div>
          </div>

          <ul className="space-y-2">
            {setup.records.map((r) => (
              <li
                key={`${r.type}:${r.fqdn}:${r.value}`}
                className={cn('rounded-xl border p-3 space-y-2', r.status === 'ok' ? 'border-success-line bg-success-soft' : 'border-line bg-surface')}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-ink-2">
                    <span className="pill pill-neutral font-mono mr-2">{r.type}</span>
                    {PURPOSE[r.role]}
                  </span>
                  <StatusChip r={r} />
                </div>
                <dl className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                  <div className="space-y-1 min-w-0">
                    <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-3">Name / Host</dt>
                    <dd className="flex items-center gap-2 min-w-0">
                      <code className="font-mono text-ui text-ink break-all">{r.host}</code>
                      <CopyButton text={r.host} label="name" />
                    </dd>
                  </div>
                  <div className="space-y-1 min-w-0">
                    <dt className="text-2xs font-semibold uppercase tracking-wide text-ink-3">{r.type === 'TXT' ? 'Value' : 'Value / Points to'}</dt>
                    <dd className="flex items-center gap-2 min-w-0">
                      <code className="font-mono text-ui text-ink break-all">{r.value}</code>
                      <CopyButton text={r.value} label="value" />
                    </dd>
                  </div>
                </dl>
                {r.status === 'wrong' && (
                  <p className="text-xs text-danger flex items-start gap-1.5">
                    <XCircle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                    <span className="break-words">
                      {r.type === 'TXT'
                        ? `A ${r.host} record exists but with another value. Add a new one with the value above (old ones can be deleted).`
                        : `Right now it points to ${r.found.join(', ')}. Change it to ${r.value}.`}
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ul>

          <ul className="text-xs text-ink-3 space-y-1 list-disc pl-5">
            <li>
              In the <strong>Name / Host</strong> box type only what is shown (for example <code className="font-mono">{setup.records[0]?.host}</code>), not the whole
              address; {setup.provider.id !== 'other' ? setup.provider.name : 'your DNS panel'} adds <code className="font-mono">{setup.rootDomain}</code> itself.
            </li>
            {setup.provider.isCloudflare && (
              <li className="text-warn">Cloudflare: set Proxy status to &quot;DNS only&quot; (grey cloud), or the certificate cannot be issued.</li>
            )}
            <li>Leave TTL as it is. Changes usually show up within minutes; this page checks every 15 seconds by itself.</li>
          </ul>
        </div>
      ) : live ? (
        <p className="text-ui text-ink-2">
          Your help center is live at{' '}
          <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            https://{domain}
          </a>{' '}
          with HTTPS. Keep the DNS records in place.
        </p>
      ) : null}
    </section>
  );
}
