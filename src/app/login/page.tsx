'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { AuthAside, AuthShell } from '@/components/marketing/AuthShell';
import { GoogleButton } from '@/components/marketing/GoogleButton';
import { isProviderEnabled, useProviderEnabled } from '@/lib/auth/providers';
import { errorMessage } from '@/lib/errors/user-error';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Set when the account has an authenticator app and the session is not yet
  // upgraded with a code (see Settings → Security → Two-factor authentication).
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  // Where to land after signing in. Only same-site paths are honoured.
  const redirectParam = searchParams.get('redirect');
  const redirectTo =
    redirectParam && redirectParam.startsWith('/') && !redirectParam.startsWith('//')
      ? redirectParam
      : '/dashboard';

  // undefined while we ask Supabase which providers are switched on.
  const googleEnabled = useProviderEnabled('google');

  // Check for error parameters in URL (e.g. from OAuth redirect)
  useEffect(() => {
    const err = searchParams.get('error');
    const desc = searchParams.get('error_description');
    if (err || desc) {
      setErrorMsg(desc || err);
    }
  }, [searchParams]);

  // The middleware sends a half-signed-in user back here with ?mfa=1.
  useEffect(() => {
    if (searchParams.get('mfa') !== '1') return;
    startMfaIfRequired();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  /** Returns true when a code is needed (and shows the code step). */
  async function startMfaIfRequired(): Promise<boolean> {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel !== 'aal2' || aal.currentLevel === 'aal2') return false;
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp?.[0];
    if (!factor) return false;
    setMfaFactorId(factor.id);
    return true;
  }

  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaFactorId) return;
    setLoading(true);
    setErrorMsg(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: mfaFactorId, code: mfaCode.trim() });
    if (error) {
      setErrorMsg(error.message || 'That code did not work. Check your authenticator app and try again.');
      setLoading(false);
      return;
    }
    router.push(redirectTo);
    router.refresh();
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('Please enter both email and password.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setErrorMsg(error.message);
      setLoading(false);
      return;
    }

    if (data.session) {
      // Check if user is an agent whose workspace is suspended or deleted (super admins exempt)
      const { data: agentData } = await supabase
        .from('agents')
        .select('workspace_id, is_super_admin')
        .eq('id', data.session.user.id)
        .maybeSingle();

      if (agentData && !agentData.is_super_admin && agentData.workspace_id) {
        const { data: ws } = await supabase
          .from('workspaces')
          .select('is_suspended, suspension_reason, deleted_at')
          .eq('id', agentData.workspace_id)
          .maybeSingle();

        if (ws?.is_suspended) {
          await supabase.auth.signOut();
          setErrorMsg(
            ws.suspension_reason
              ? `Workspace suspended: ${ws.suspension_reason}`
              : 'This workspace is currently suspended. Please contact your platform administrator.'
          );
          setLoading(false);
          return;
        }

        if (ws?.deleted_at) {
          await supabase.auth.signOut();
          setErrorMsg('This workspace has been deactivated/deleted. Please contact support.');
          setLoading(false);
          return;
        }
      }

      if (await startMfaIfRequired()) {
        setLoading(false);
        return;
      }

      let destination = redirectTo;
      if (redirectTo === '/dashboard') {
        if (agentData?.is_super_admin && !agentData.workspace_id) {
          destination = '/admin';
        } else {
          const { data: access } = await supabase
            .from('platform_access')
            .select('role')
            .eq('user_id', data.session.user.id)
            .maybeSingle();

          if (access && !agentData?.workspace_id) {
            destination = '/admin';
          }
        }
      }

      router.push(destination);
      router.refresh();
    }
  };

  const handleGoogleLogin = async () => {
    setGoogleLoading(true);
    setErrorMsg(null);

    if (!(await isProviderEnabled('google'))) {
      setGoogleLoading(false);
      setErrorMsg('Google sign-in is not enabled yet — use email below for now.');
      return;
    }

    setErrorMsg(null);

    try {
      const origin =
        typeof window !== 'undefined'
          ? window.location.origin
          : (process.env.NEXT_PUBLIC_APP_URL || '');

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${origin}/auth/callback?next=${redirectTo === '/dashboard' ? '/dashboard' : encodeURIComponent(redirectTo)}`,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });

      if (error) {
        if (
          error.message.toLowerCase().includes('not enabled') ||
          error.message.toLowerCase().includes('unsupported provider')
        ) {
          setErrorMsg(
            'Google Sign-In is not enabled yet in your Supabase project. Please enable Google in Supabase Dashboard > Authentication > Providers > Google, or sign in with email below.'
          );
        } else {
          setErrorMsg(error.message);
        }
        setGoogleLoading(false);
      }
    } catch (err: any) {
      console.error('Google login error:', err);
      setErrorMsg(errorMessage(err, 'Failed to initiate Google sign-in.'));
      setGoogleLoading(false);
    }
  };

  if (mfaFactorId) {
    return (
      <div>
        <div className="mb-7">
          <h1 className="text-3xl leading-tight font-semibold">Two-factor code</h1>
          <p className="mt-2 text-sm text-ink-2">Enter the 6-digit code from your authenticator app.</p>
        </div>
        {errorMsg && (
          <div
            role="alert"
            className="mb-5 flex items-start gap-2.5 rounded-xl border border-danger-line bg-danger-soft px-3.5 py-3 text-xs text-danger animate-pop"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
            <span>{errorMsg}</span>
          </div>
        )}
        <form onSubmit={handleVerifyMfa} className="space-y-4">
          <div>
            <label htmlFor="mfa-code" className="field-label">
              Authentication code
            </label>
            <input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
              className="input"
            />
          </div>
          <button type="submit" disabled={loading || mfaCode.length !== 6} className="btn btn-primary w-full">
            {loading ? 'Verifying…' : 'Verify and continue'}
          </button>
          <button
            type="button"
            className="btn btn-ghost w-full"
            onClick={async () => {
              await supabase.auth.signOut();
              setMfaFactorId(null);
              setMfaCode('');
              setErrorMsg(null);
            }}
          >
            Use a different account
          </button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-7">
        <h1 className="text-3xl leading-tight font-semibold">
          Welcome back
        </h1>
        <p className="mt-2 text-sm text-ink-2">
          Sign in to your support inbox.
        </p>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2.5 rounded-xl border border-danger-line bg-danger-soft px-3.5 py-3 text-xs text-danger animate-pop"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
          <span>{errorMsg}</span>
        </div>
      )}

      {googleEnabled && (
        <>
          <GoogleButton
            onClick={handleGoogleLogin}
            loading={googleLoading}
            disabled={loading}
            text="Continue with Google"
          />

          <div className="relative my-6 text-center text-xs text-ink-3">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-line-2" />
            </div>
            <span className="relative bg-surface px-3 text-ink-3">
              or continue with email
            </span>
          </div>
        </>
      )}

      <form onSubmit={handleLogin} className="space-y-4">
        <div>
          <label htmlFor="email" className="field-label">
            Work email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </div>

        <div>
          <label htmlFor="password" className="field-label">
            Password
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="current-password"
              placeholder="••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input pr-11"
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-0.5 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-8 sm:h-8 sm:right-1.5 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors"
            >
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || googleLoading}
          className="btn btn-lg btn-primary w-full !mt-6"
        >
          {loading ? (
            <>
              <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin-slow" />
              Signing in…
            </>
          ) : (
            <>
              Sign in
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      <div className="mt-6 hairline" />

      {/* A shared demo password on a production login page is a known password. The live demo is /demo.html. */}
      <div className="mt-5 flex items-center justify-end text-xs">
        <span className="text-ink-3">
          No account?{' '}
          <Link
            href="/signup"
            className="inline-flex items-center min-h-11 font-medium text-ink hover:underline underline-offset-4"
          >
            Sign up
          </Link>
        </span>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <AuthShell
      aside={
        <AuthAside
          eyebrow="Agent workspace"
          headline={
            <>
              One inbox for every
              <br />
              conversation on your site.
            </>
          }
          points={[
            {
              title: 'Live visitor radar',
              body: 'See who is browsing, which page they are on, and how long they have been there.',
            },
            {
              title: 'Sub-second delivery',
              body: 'Messages, typing indicators and read receipts stream over WebSockets.',
            },
            {
              title: 'Private team notes',
              body: 'Leave context for a teammate inside the thread. The customer never sees it.',
            },
          ]}
        />
      }
    >
      <Suspense
        fallback={
          <div className="space-y-4 animate-pulse">
            <div className="h-8 w-2/3 rounded-lg bg-surface-3" />
            <div className="h-11 w-full rounded-xl bg-surface-3" />
            <div className="h-11 w-full rounded-xl bg-surface-3" />
            <div className="h-11 w-full rounded-xl bg-surface-3" />
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
