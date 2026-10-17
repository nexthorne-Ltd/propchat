'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Monitor } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { getAuditLogAction, type AuditEntry } from '@/app/actions/settings';
import { describeAuditEntry } from '@/lib/settings/validation';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Field, Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ErrorState } from '@/components/ui/States';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { FormSkeleton, SettingsCard } from './parts';
import { errorMessage } from '@/lib/errors/user-error';

function formatWhen(iso?: string | null) {
  if (!iso) return 'Unknown';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Settings → Security → Sessions. */
export function SessionsPanel() {
  const toast = useToast();
  const [info, setInfo] = useState<{ email: string | null; lastSignIn: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    createClient()
      .auth.getUser()
      .then(({ data, error: err }: { data: { user: { email?: string; last_sign_in_at?: string } | null }; error: { message: string } | null }) => {
        if (!live) return;
        if (err || !data.user) return setError(err?.message || 'You are not signed in.');
        setInfo({ email: data.user.email ?? null, lastSignIn: data.user.last_sign_in_at ?? null });
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  async function signOutOthers() {
    setBusy(true);
    const { error: err } = await createClient().auth.signOut({ scope: 'others' });
    setBusy(false);
    setConfirm(false);
    if (err) toast.error(err.message || 'Could not sign out other sessions.');
    else toast.success('Signed out everywhere else.');
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load your session"
        message={error}
        onRetry={() => {
          setError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (!info) return <FormSkeleton rows={2} />;

  return (
    <div className="space-y-6">
      <SettingsCard title="This device" description="The session you are using right now.">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-surface-2 border border-line flex items-center justify-center text-ink-2">
            <Monitor className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-ui font-medium text-ink truncate">{info.email}</div>
            <div className="text-xs text-ink-3">Signed in {formatWhen(info.lastSignIn)}</div>
          </div>
          <Badge tone="success" dot>
            Current
          </Badge>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Other sessions"
        description="Sign out every other browser and device. You will stay signed in here. Use this if you lost a device or used a shared computer."
      >
        <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>
          Sign out other sessions
        </Button>
      </SettingsCard>

      {confirm && (
        <Modal
          title="Sign out other sessions?"
          description="Anyone using your account on another device will have to sign in again."
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button variant="danger" loading={busy} onClick={signOutOthers}>
                Sign out others
              </Button>
            </>
          }
        >
          <p className="text-ui text-ink-2">This cannot be undone, but you can sign in again at any time.</p>
        </Modal>
      )}
    </div>
  );
}

interface Enrollment {
  factorId: string;
  qr: string;
  secret: string;
}

/** Settings → Security → Two-factor authentication (an authenticator app, TOTP). */
export function TwoFactorPanel() {
  const toast = useToast();
  const [factors, setFactors] = useState<{ id: string; status: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);
  const reload = () => setAttempt((n) => n + 1);

  useEffect(() => {
    let live = true;
    createClient()
      .auth.mfa.listFactors()
      .then(({ data, error: err }: { data: { totp?: { id: string; status: string }[] } | null; error: { message: string } | null }) => {
        if (!live) return;
        if (err) return setError(err.message);
        setFactors((data?.totp ?? []).map((f) => ({ id: f.id, status: f.status })));
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  async function start() {
    setBusy(true);
    setCodeError(null);
    // An abandoned, unverified enrolment blocks a new one with the same name.
    for (const f of factors ?? []) if (f.status !== 'verified') await createClient().auth.mfa.unenroll({ factorId: f.id });
    const { data, error: err } = await createClient().auth.mfa.enroll({ factorType: 'totp', friendlyName: `Zentry ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (err || !data) return toast.error(err?.message || 'Could not start setup. Two-factor may be switched off for this project.');
    setEnrolling({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    setCode('');
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!enrolling) return;
    if (!/^\d{6}$/.test(code)) return setCodeError('Enter the 6-digit code from your app.');
    setBusy(true);
    const { error: err } = await createClient().auth.mfa.challengeAndVerify({ factorId: enrolling.factorId, code });
    setBusy(false);
    if (err) return setCodeError(err.message || 'That code did not match. Try the next one.');
    setEnrolling(null);
    toast.success('Two-factor authentication is on.');
    reload();
  }

  async function remove(id: string) {
    setBusy(true);
    const { error: err } = await createClient().auth.mfa.unenroll({ factorId: id });
    setBusy(false);
    setRemoving(null);
    if (err) return toast.error(err.message || 'Could not turn off two-factor. Sign in again and retry.');
    toast.success('Two-factor authentication is off.');
    reload();
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load two-factor settings"
        message={error}
        onRetry={() => {
          setError(null);
          reload();
        }}
      />
    );
  }
  if (!factors) return <FormSkeleton rows={2} />;

  const active = factors.find((f) => f.status === 'verified');

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Authenticator app"
        description="After your password, you enter a 6-digit code from an app such as Google Authenticator, 1Password or Authy."
      >
        <div className="flex flex-wrap items-center gap-3">
          <ShieldCheck className={active ? 'w-5 h-5 text-success' : 'w-5 h-5 text-ink-3'} aria-hidden="true" />
          <span className="text-ui font-medium text-ink flex-1">{active ? 'Two-factor authentication is on' : 'Two-factor authentication is off'}</span>
          <Badge tone={active ? 'success' : 'neutral'}>{active ? 'On' : 'Off'}</Badge>
          {active ? (
            <Button variant="danger" size="sm" onClick={() => setRemoving(active.id)}>
              Turn off
            </Button>
          ) : (
            <Button variant="primary" size="sm" loading={busy && !enrolling} onClick={start}>
              Set up
            </Button>
          )}
        </div>
      </SettingsCard>

      {enrolling && (
        <Modal title="Set up two-factor authentication" description="Scan the code with your authenticator app, then enter the code it shows." onClose={() => setEnrolling(null)}>
          <form onSubmit={verify} className="space-y-4">
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enrolling.qr} alt="QR code for your authenticator app" className="w-44 h-44 rounded-lg bg-white p-2 border border-line" />
            </div>
            <p className="text-xs text-ink-3 text-center">
              Can’t scan? Enter this key instead: <code className="font-mono text-ink break-all">{enrolling.secret}</code>
            </p>
            <Field label="6-digit code" error={codeError}>
              <Input inputSize="md" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} data-autofocus />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEnrolling(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                Verify and turn on
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {removing && (
        <Modal
          title="Turn off two-factor authentication?"
          description="Your account will be protected by your password alone."
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                Keep it on
              </Button>
              <Button variant="danger" loading={busy} onClick={() => remove(removing)}>
                Turn off
              </Button>
            </>
          }
        >
          <p className="text-ui text-ink-2">You can set it up again at any time.</p>
        </Modal>
      )}
    </div>
  );
}

/** Settings → Security → Audit log. Owners and admins. */
export function AuditLogPanel({ workspaceId }: { workspaceId: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [attempt, setAttempt] = useState(0);

  const apply = useCallback((res: Awaited<ReturnType<typeof getAuditLogAction>>, append: boolean) => {
    if (!res.success) return setError(res.error);
    setEntries((prev) => (append && prev ? [...prev, ...res.entries] : res.entries));
    setHasMore(res.hasMore);
  }, []);

  useEffect(() => {
    let live = true;
    getAuditLogAction(workspaceId)
      .then((res) => live && apply(res, false))
      .catch((e) => live && setError(errorMessage(e) || 'Could not load the audit log.'));
    return () => {
      live = false;
    };
  }, [workspaceId, attempt, apply]);

  if (error) {
    return (
      <ErrorState title="Could not load the audit log" message={error} onRetry={() => {
          setError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (!entries) return <FormSkeleton rows={4} />;
  if (entries.length === 0) {
    return (
      <EmptyState
        type="custom"
        title="No changes recorded yet"
        description="When someone changes workspace settings or a teammate’s role, it shows up here with who did it and when."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ul className="card divide-y divide-line">
        {entries.map((e) => (
          <li key={e.id} className="px-4 py-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-ui text-ink flex-1 min-w-[12rem]">{describeAuditEntry(e)}</span>
            <span className="text-xs text-ink-2">{e.actor_name || 'Someone'}</span>
            <time className="text-xs text-ink-3" dateTime={e.created_at}>
              {formatWhen(e.created_at)}
            </time>
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button
          size="sm"
          loading={loadingMore}
          onClick={async () => {
            setLoadingMore(true);
            try {
              apply(await getAuditLogAction(workspaceId, entries[entries.length - 1].created_at), true);
            } catch (e) {
              setError(errorMessage(e) || 'Could not load older entries.');
            }
            setLoadingMore(false);
          }}
        >
          Load older entries
        </Button>
      )}
    </div>
  );
}
