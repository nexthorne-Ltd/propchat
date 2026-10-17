'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Eye, EyeOff, Users } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { AuthAside, AuthShell } from '@/components/marketing/AuthShell';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { acceptInvitationAction, getInvitationAction, type InvitationView } from '@/app/actions/invite';
import { errorMessage } from '@/lib/errors/user-error';

const MIN_PASSWORD = 8;

/**
 * /invite/<token>. New people choose a name and password; someone whose email
 * already has an account signs in first and then joins with one click.
 */
export function InviteAccept({ token }: { token: string }) {
  const router = useRouter();
  const [view, setView] = useState<InvitationView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    getInvitationAction(token)
      .then((v) => {
        if (!alive) return;
        setView(v);
        setName(v.name || '');
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(errorMessage(err, 'Could not open this invitation.'));
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const signInHref = `/login?redirect=${encodeURIComponent(`/invite/${token}`)}`;
  const joiningAsSelf = Boolean(view?.signedInAs && view.signedInAs === view.email);
  const signedInElsewhere = Boolean(view?.signedInAs && view.signedInAs !== view.email);

  /**
   * The person opening the link is signed in as someone else (often the
   * inviter, testing the link in their own browser). Signing out here only
   * ends this browser's session, then the invitation shows its normal form.
   */
  async function switchAccount() {
    setBusy(true);
    setError(null);
    try {
      await createClient().auth.signOut({ scope: 'local' });
      const fresh = await getInvitationAction(token);
      setView(fresh);
      setName(fresh.name || '');
    } catch (err) {
      setError(errorMessage(err, 'Could not sign out. Sign out from the dashboard, then open this link again.'));
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!joiningAsSelf) {
      if (password.length < MIN_PASSWORD) return setError(`Choose a password of at least ${MIN_PASSWORD} characters.`);
      if (password !== confirm) return setError('The two passwords do not match.');
    }
    setBusy(true);
    try {
      let res: { success: boolean; error?: string; code?: string; email?: string; needsSignIn?: boolean };
      try {
        const apiRes = await fetch('/api/invite/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, name, password: joiningAsSelf ? undefined : password }),
        });
        res = await apiRes.json();
      } catch {
        res = await acceptInvitationAction({ token, name, password: joiningAsSelf ? undefined : password });
      }

      if (!res.success) {
        setError(res.error || 'Could not accept this invitation.');
        if (res.code === 'account_exists') setNeedsSignIn(true);
        setBusy(false);
        return;
      }
      setDone(true);
      if (res.needsSignIn && res.email) {
        const { error: signInError } = await createClient().auth.signInWithPassword({ email: res.email, password });
        if (signInError) {
          router.push(`/login?redirect=/dashboard`);
          return;
        }
      }
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err, 'Something went wrong. Try again.'));
      setBusy(false);
    }
  }

  return (
    <AuthShell
      aside={
        <AuthAside
          eyebrow="Team invitation"
          headline={<>Your team is waiting in the inbox.</>}
          points={[
            { title: 'One inbox for every channel', body: 'Chat, email and social messages from customers, in one shared view.' },
            { title: 'Know who is on it', body: 'See when a teammate is already replying, so nobody answers twice.' },
            { title: 'The bot takes the first line', body: 'It answers from your help center and hands over when a person is needed.' },
          ]}
        />
      }
    >
      <div>
        {!view && !loadError && <LoadingState label="Opening your invitation…" />}

        {loadError && <ErrorState title="Could not open this invitation" message={loadError} onRetry={() => location.reload()} />}

        {view && !view.ok && (
          <div className="space-y-4 text-center">
            <ErrorState
              title={view.problem === 'used' ? 'Already accepted' : view.problem === 'expired' ? 'Invitation expired' : 'Invitation not valid'}
              message={view.message}
            />
            <Link href={view.problem === 'used' ? '/login?redirect=/dashboard' : '/login'} className="btn btn-sm btn-secondary">
              Go to sign in
            </Link>
          </div>
        )}

        {view?.ok && done && (
          <div className="space-y-3 text-center" role="status">
            <CheckCircle2 className="w-10 h-10 text-success mx-auto" aria-hidden="true" />
            <h1 className="text-md font-semibold text-ink">You have joined {view.workspaceName}</h1>
            <LoadingState label="Opening your inbox…" />
          </div>
        )}

        {view?.ok && !done && (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 shrink-0 rounded-xl bg-accent-soft text-accent grid place-items-center">
                <Users className="w-5 h-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h1 className="text-md font-semibold text-ink">Join {view.workspaceName}</h1>
                <p className="text-ui text-ink-2 mt-0.5">
                  You were invited as {view.roleLabel?.toLowerCase()}. You will sign in with{' '}
                  <span className="font-medium text-ink break-all">{view.email}</span>.
                </p>
              </div>
            </div>

            {signedInElsewhere ? (
              <div role="alert" className="rounded-lg border border-warn-line bg-warn-soft p-3 text-ui text-ink space-y-3">
                <p>
                  This browser is signed in as <span className="font-medium break-all">{view.signedInAs}</span>. To join as{' '}
                  <span className="font-medium break-all">{view.email}</span>, sign out here first (other devices stay signed in).
                </p>
                <Button type="button" variant="secondary" size="sm" onClick={() => void switchAccount()} disabled={busy}>
                  {busy ? 'Signing out…' : `Sign out and continue as ${view.email}`}
                </Button>
                {error && <p className="text-xs text-danger">{error}</p>}
              </div>
            ) : (
              <>
                <Field label="Your name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" autoFocus />
                </Field>

                {!joiningAsSelf && !needsSignIn && (
                  <>
                    <Field label="Choose a password" hint={`At least ${MIN_PASSWORD} characters.`}>
                      <div className="relative">
                        <Input
                          type={show ? 'text' : 'password'}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          autoComplete="new-password"
                          className="pr-10"
                        />
                        <button
                          type="button"
                          className="absolute right-1 top-1/2 -translate-y-1/2 btn btn-ghost btn-icon"
                          onClick={() => setShow((v) => !v)}
                          aria-label={show ? 'Hide password' : 'Show password'}
                        >
                          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </Field>
                    <Field label="Confirm password">
                      <Input type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                    </Field>
                  </>
                )}
              </>
            )}

            {error && (
              <p role="alert" className="text-xs font-medium text-danger">
                {error}
              </p>
            )}

            {needsSignIn ? (
              <Link href={signInHref} className="btn btn-primary w-full justify-center">
                Sign in to join
              </Link>
            ) : (
              !signedInElsewhere && (
                <Button type="submit" variant="primary" size="md" loading={busy} className="w-full justify-center">
                  {joiningAsSelf ? `Join ${view.workspaceName}` : 'Accept and create my account'}
                </Button>
              )
            )}

            {!view.signedInAs && !needsSignIn && (
              <p className="text-xs text-ink-3 text-center">
                Already have an account with this email? <Link href={signInHref} className="text-accent hover:underline">Sign in</Link>
              </p>
            )}
          </form>
        )}
      </div>
    </AuthShell>
  );
}
