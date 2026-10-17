'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, Mail, Send } from 'lucide-react';
import {
  checkEmailSetupAction,
  enableEmailChannelAction,
  getEmailChannelAction,
  removeSuppressionAction,
  saveEmailSettingsAction,
  sendForwardingTestAction,
  sendTestReplyAction,
  startSenderDomainAction,
  type EmailChannelOverview,
} from '@/app/actions/email-channel';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Textarea } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ErrorState, SkeletonBlock } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { timeAgo } from '@/components/tickets/TicketBits';
import { DEFAULT_SIGNATURE, validateEmailSettings, type EmailSettingsErrors } from '@/lib/channels/email/settings';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

const OUTCOME: Record<string, { label: string; tone: BadgeTone }> = {
  ticket_created: { label: 'New ticket', tone: 'success' },
  ticket_updated: { label: 'Added to ticket', tone: 'success' },
  duplicate: { label: 'Duplicate', tone: 'neutral' },
  ignored_auto_reply: { label: 'Auto-reply ignored', tone: 'neutral' },
  ignored_bounce: { label: 'Bounce', tone: 'warn' },
  ignored_loop: { label: 'Loop stopped', tone: 'warn' },
  ignored_invalid: { label: 'Ignored', tone: 'neutral' },
  forwarding_verified: { label: 'Forwarding works', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="min-w-0">
      <p className="text-2xs font-medium text-ink-3">{label}</p>
      <div className="mt-1 flex items-center gap-2 min-w-0">
        <code className="flex-1 min-w-0 truncate rounded-sm bg-surface-2 border border-line px-2 py-1 font-mono text-xs text-ink">{value}</code>
        <Button
          size="xs"
          iconOnly
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() =>
            navigator.clipboard
              .writeText(value)
              .then(() => toast.success(`${label} copied`))
              .catch(() => toast.error('Could not copy; select the text instead.'))
          }
        >
          <Copy className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Settings → Channels → Email: enable it, sender details, your own address, and what arrived. */
export function EmailChannelPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const toast = useToast();
  const [overview, setOverview] = useState<EmailChannelOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [form, setForm] = useState({ from_name: '', signature: '', custom_address: '' });
  const [errors, setErrors] = useState<EmailSettingsErrors>({});

  const adopt = useCallback((o: EmailChannelOverview) => {
    setOverview(o);
    setForm({ from_name: o.settings.from_name, signature: o.settings.signature, custom_address: o.settings.custom_address });
  }, []);

  useEffect(() => {
    let live = true;
    getEmailChannelAction(workspaceId)
      .then((res) => {
        if (!live) return;
        if (res.success) adopt(res.overview);
        else setLoadError(res.error);
      })
      .catch((e: Error) => live && setLoadError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, attempt, adopt]);

  async function run(key: string, work: () => Promise<{ success: true; overview: EmailChannelOverview } | { success: false; error: string; fieldErrors?: EmailSettingsErrors }>, ok?: string) {
    setBusy(key);
    setActionError(null);
    try {
      const res = await work();
      if (res.success) {
        adopt(res.overview);
        if (ok) toast.success(ok);
      } else {
        setActionError(res.error);
        if (res.fieldErrors) setErrors(res.fieldErrors);
      }
    } catch (e) {
      setActionError(errorMessage(e) || 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const dirty = overview ? form.from_name !== overview.settings.from_name || form.signature !== overview.settings.signature || form.custom_address !== overview.settings.custom_address : false;

  function save() {
    if (!overview) return;
    const found = validateEmailSettings(form, { inboundDomain: overview.forwardingAddress?.split('@')[1] ?? null, forwardingAddress: overview.forwardingAddress || '' });
    setErrors(found);
    if (Object.keys(found).length) return;
    run('save', () => saveEmailSettingsAction(workspaceId, form), 'Email settings saved.');
  }

  async function testReply() {
    setBusy('test');
    setActionError(null);
    const res = await sendTestReplyAction(workspaceId).catch((e: Error) => ({ success: false as const, error: errorMessage(e) }));
    setBusy(null);
    if (res.success) toast.success(`A test reply was sent to ${res.sentTo}.`);
    else setActionError(res.error);
  }

  return (
    <Modal title="Email" description="Let customers reach you by email, and answer from your own address." size="lg" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {loadError ? (
        <ErrorState
          title="The email channel could not be loaded"
          message={loadError}
          onRetry={() => {
            setLoadError(null);
            setAttempt((n) => n + 1);
          }}
        />
      ) : !overview ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading email settings">
          <SkeletonBlock className="h-5 w-48 rounded-sm" />
          <SkeletonBlock className="h-9 w-full rounded-md" />
          <SkeletonBlock className="h-24 w-full rounded-md" />
        </div>
      ) : (
        <div className="space-y-8">
          {overview.problems.length > 0 && (
            <div role="alert" className="rounded-lg border border-warn-line bg-warn-soft p-4 text-ui text-ink">
              <p className="font-semibold text-warn">Email is not fully set up on the server</p>
              <ul className="mt-2 list-disc pl-5 space-y-1 text-ink-2">
                {overview.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {actionError && (
            <p role="alert" className="rounded-lg border border-danger-line bg-danger-soft p-3 text-ui text-danger font-medium">
              {actionError}
            </p>
          )}

          {!overview.enabled ? (
            <EmptyState
              type="custom"
              title="Turn on email support"
              description="You get a support address. Emails sent to it become tickets, replies from your team go back as branded emails, and customers are told when their request is received and solved."
              actionLabel={busy === 'enable' ? 'Turning on…' : 'Turn on email'}
              onAction={() => run('enable', () => enableEmailChannelAction(workspaceId), 'Email is on.')}
            />
          ) : (
            <>
              <section aria-labelledby="email-address" className="space-y-3">
                <h3 id="email-address" className="text-md font-semibold text-ink">
                  Your support address
                </h3>
                <p className="text-ui text-ink-2">Every email sent to this address becomes a ticket. Share it, or forward your own address to it (below).</p>
                <CopyField label="Support address" value={overview.forwardingAddress!} />
                <p className="text-xs text-ink-3">
                  {overview.lastInboundAt ? `Last email received ${timeAgo(overview.lastInboundAt)}.` : 'No email received yet.'}
                  {overview.lastError ? ` Last error: ${overview.lastError}` : ''}
                </p>
              </section>

              <section aria-labelledby="email-sender" className="space-y-4">
                <h3 id="email-sender" className="text-md font-semibold text-ink">
                  Sender and signature
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Sender name" hint="Shown as the name customers see." error={errors.from_name}>
                    <Input inputSize="md" value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} />
                  </Field>
                  <Field label="Your own support address (optional)" hint="For example help@yourcompany.com." error={errors.custom_address}>
                    <Input inputSize="md" type="email" inputMode="email" value={form.custom_address} onChange={(e) => setForm({ ...form, custom_address: e.target.value })} />
                  </Field>
                </div>
                <Field label="Signature" hint="Added under every reply. Use {{agent.name}} and {{workspace.name}}." error={errors.signature}>
                  <Textarea rows={3} value={form.signature} placeholder={DEFAULT_SIGNATURE} onChange={(e) => setForm({ ...form, signature: e.target.value })} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" loading={busy === 'save'} disabled={!dirty} onClick={save}>
                    Save
                  </Button>
                  <Button size="sm" loading={busy === 'test'} disabled={dirty} onClick={testReply}>
                    <Send className="w-3.5 h-3.5" aria-hidden="true" /> Send me a test reply
                  </Button>
                </div>
              </section>

              {overview.settings.custom_address && !dirty && (
                <section aria-labelledby="email-own" className="space-y-5">
                  <div>
                    <h3 id="email-own" className="text-md font-semibold text-ink">
                      Use {overview.settings.custom_address}
                    </h3>
                    <p className="text-ui text-ink-2 mt-0.5">Two steps: receive mail sent to your address, then send replies from it.</p>
                  </div>

                  <div className="card p-4 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-semibold text-ink">1. Forward your address to Zentry</h4>
                      <Badge tone={overview.settings.forwarding_verified ? 'success' : overview.settings.forwarding_check_sent_at ? 'warn' : 'neutral'} dot>
                        {overview.settings.forwarding_verified ? 'Working' : overview.settings.forwarding_check_sent_at ? 'Waiting for the test' : 'Not checked'}
                      </Badge>
                    </div>
                    <p className="text-ui text-ink-2">
                      In your mail provider, forward everything sent to <strong className="text-ink">{overview.settings.custom_address}</strong> to <strong className="text-ink break-all">{overview.forwardingAddress}</strong>. Keep a copy in the mailbox if you like.
                    </p>
                    <details className="text-xs text-ink-2">
                      <summary className="cursor-pointer font-medium text-ink">Where do I find forwarding?</summary>
                      <ul className="mt-2 list-disc pl-5 space-y-1">
                        <li>
                          <strong>Google Workspace:</strong> Admin console → Apps → Google Workspace → Gmail → Routing, add a recipient address map; or the mailbox’s Settings → Forwarding.
                        </li>
                        <li>
                          <strong>Microsoft 365:</strong> Exchange admin center → Recipients → Mailboxes → the mailbox → Manage mail flow settings → Email forwarding.
                        </li>
                        <li>
                          <strong>cPanel and most hosts:</strong> Email → Forwarders → Add Forwarder.
                        </li>
                        <li>
                          <strong>Shared mailbox or group:</strong> add {overview.forwardingAddress} as a member or external recipient.
                        </li>
                      </ul>
                    </details>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" loading={busy === 'fwd'} onClick={() => run('fwd', () => sendForwardingTestAction(workspaceId), 'Test email sent. It can take a minute to come back.')}>
                        <Mail className="w-3.5 h-3.5" aria-hidden="true" /> Send a forwarding test
                      </Button>
                      <Button size="sm" variant="ghost" loading={busy === 'check'} onClick={() => run('check', () => checkEmailSetupAction(workspaceId))}>
                        Check again
                      </Button>
                    </div>
                  </div>

                  <div className="card p-4 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-semibold text-ink">2. Send replies from your address</h4>
                      <Badge tone={overview.settings.domain_verified ? 'success' : 'neutral'} dot>
                        {overview.settings.domain_verified ? 'Verified' : 'Not verified'}
                      </Badge>
                    </div>
                    <p className="text-ui text-ink-2">
                      {overview.settings.domain_verified ? (
                        <>
                          Replies are sent from <strong className="text-ink">{overview.settings.custom_address}</strong>.
                        </>
                      ) : (
                        <>
                          Until this is verified, replies are sent from <strong className="text-ink break-all">{overview.forwardingAddress}</strong> with your sender name. Customers can still reply to them.
                        </>
                      )}
                    </p>
                    {!overview.settings.domain_verified && !overview.provider.canAuthenticateDomains && (
                      <p className="text-xs text-ink-3">Domain verification is not available on this server. Replies will keep using the support address above.</p>
                    )}
                    {!overview.settings.domain_verified && overview.provider.canAuthenticateDomains && overview.settings.domain_records.length === 0 && (
                      <Button size="sm" loading={busy === 'domain'} onClick={() => run('domain', () => startSenderDomainAction(workspaceId))}>
                        Show the DNS records to add
                      </Button>
                    )}
                    {overview.settings.domain_records.length > 0 && (
                      <>
                        <p className="text-ui text-ink-2">
                          Add these records where the DNS for <strong className="text-ink">{overview.settings.domain}</strong> is managed (your domain registrar or DNS host). Changes can take up to an hour to be seen.
                        </p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs min-w-[34rem]">
                            <thead>
                              <tr className="text-left text-2xs uppercase tracking-wider text-ink-3">
                                <th className="py-1.5 pr-3 font-medium">Type</th>
                                <th className="py-1.5 pr-3 font-medium">Name / host</th>
                                <th className="py-1.5 pr-3 font-medium">Value</th>
                                <th className="py-1.5 font-medium">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {overview.settings.domain_records.map((r) => (
                                <tr key={`${r.type}-${r.host}`} className="border-t border-line align-top">
                                  <td className="py-2 pr-3 font-mono text-ink">{r.type}</td>
                                  <td className="py-2 pr-3 min-w-[9rem]">
                                    <CopyField label="Host" value={r.host} />
                                  </td>
                                  <td className="py-2 pr-3 min-w-[12rem]">
                                    <CopyField label="Value" value={r.value} />
                                    <p className="mt-1 text-ink-3">{r.purpose}</p>
                                  </td>
                                  <td className="py-2">
                                    <Badge tone={r.verified ? 'success' : 'warn'}>{r.verified ? 'Found' : 'Not found yet'}</Badge>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {!overview.settings.domain_verified && (
                          <Button size="sm" variant="primary" loading={busy === 'check'} onClick={() => run('check', () => checkEmailSetupAction(workspaceId), 'Records checked.')}>
                            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Check the records
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </section>
              )}

              <section aria-labelledby="email-log" className="space-y-3">
                <h3 id="email-log" className="text-md font-semibold text-ink">
                  Recent email
                </h3>
                {overview.log.length === 0 ? (
                  <div className="card p-2">
                    <EmptyState type="custom" title="Nothing received yet" description="Send an email to your support address. It shows up here, and as a ticket in your inbox." />
                  </div>
                ) : (
                  <ul className="card divide-y divide-line">
                    {overview.log.map((row) => {
                      const o = OUTCOME[row.outcome] || { label: row.outcome, tone: 'neutral' as BadgeTone };
                      return (
                        <li key={row.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Badge tone={o.tone}>{o.label}</Badge>
                          <span className="min-w-0 flex-1 basis-48 text-ui text-ink truncate">{row.subject || '(no subject)'}</span>
                          <span className="text-xs text-ink-3 truncate max-w-[14rem]">{row.from_email}</span>
                          <time className={cn('text-xs text-ink-3')} dateTime={row.created_at}>
                            {timeAgo(row.created_at)}
                          </time>
                          {row.detail && <p className="basis-full text-xs text-ink-2">{row.detail}</p>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {overview.suppressions.length > 0 && (
                <section aria-labelledby="email-blocked" className="space-y-3">
                  <h3 id="email-blocked" className="text-md font-semibold text-ink">
                    Blocked addresses
                  </h3>
                  <p className="text-ui text-ink-2">An earlier email to these addresses bounced, so we stopped sending to them. Unblock one once the address is fixed.</p>
                  <ul className="card divide-y divide-line">
                    {overview.suppressions.map((s) => (
                      <li key={s.email} className="px-4 py-2.5 flex flex-wrap items-center gap-3">
                        <span className="text-ui text-ink font-medium break-all">{s.email}</span>
                        <span className="flex-1 min-w-[10rem] text-xs text-ink-3 truncate">{s.reason}</span>
                        <Button size="xs" loading={busy === `unblock-${s.email}`} onClick={() => run(`unblock-${s.email}`, () => removeSuppressionAction(workspaceId, s.email), 'Address unblocked.')}>
                          Unblock
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
