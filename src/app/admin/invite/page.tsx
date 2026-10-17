'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  Shield,
  ShieldCheck,
  Lock,
  Mail,
  User,
  CheckCircle2,
  AlertCircle,
  Clock,
  Eye,
  EyeOff,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { useToast } from '@/components/ui/Toast';
import {
  validateAdminInviteTokenAction,
  acceptAdminInviteAction,
} from '@/app/actions/platform';
import { PlatformAccessRole } from '@/types/database';
import { errorMessage as messageOf } from '@/lib/errors/user-error';

function InviteAcceptForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const supabase = createClient();

  const token = searchParams.get('token') || '';

  const [verifying, setVerifying] = useState(true);
  const [valid, setValid] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Invited details returned from server
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PlatformAccessRole>('admin');

  // Form inputs
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    async function verifyToken() {
      if (!token) {
        setVerifying(false);
        setValid(false);
        setErrorCode('missing');
        setErrorMessage('No invitation token was provided. Please click the complete link in your email.');
        return;
      }

      try {
        const res = await validateAdminInviteTokenAction(token);
        setVerifying(false);
        if (!res.valid) {
          setValid(false);
          setErrorCode(res.code || 'invalid');
          setErrorMessage(res.error || 'This invitation link is not valid.');
        } else {
          setValid(true);
          setEmail(res.email || '');
          setRole(res.role || 'admin');
        }
      } catch (err: unknown) {
        setVerifying(false);
        setValid(false);
        setErrorCode('error');
        setErrorMessage(
          messageOf(err, 'Failed to verify invitation link.')
        );
      }
    }

    verifyToken();
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const cleanName = name.trim();
    if (!cleanName || cleanName.length < 2) {
      setFormError('Please enter your full name.');
      return;
    }

    if (!password || password.length < 8) {
      setFormError('Password must be at least 8 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setFormError('Passwords do not match. Please re-enter.');
      return;
    }

    setSubmitting(true);

    try {
      const res = await acceptAdminInviteAction({
        token,
        name: cleanName,
        password,
      });

      if (!res.success) {
        setFormError(res.error || 'Failed to activate admin account.');
        setSubmitting(false);
        return;
      }

      toast.success('Admin account created! Signing you in…');

      // Sign in client-side to establish browser session
      const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInErr || !signInData.session) {
        // If signIn fails for any reason, send user to login
        router.push(`/login?redirect=/admin&message=${encodeURIComponent('Account created successfully. Please sign in.')}`);
      } else {
        // Immediate redirect to admin panel
        router.push('/admin');
        router.refresh();
      }
    } catch (err: unknown) {
      setFormError(
        messageOf(err, 'An unexpected error occurred.')
      );
      setSubmitting(false);
    }
  };

  // 1. Loading / verifying state
  if (verifying) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center p-6 bg-canvas text-ink">
        <div className="w-full max-w-md bg-surface border border-line rounded-2xl p-8 shadow-md text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent mx-auto animate-pulse">
            <RefreshCw className="w-6 h-6 animate-spin" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-bold text-ink">Verifying Invitation</h2>
            <p className="text-xs text-ink-3">
              Checking your secure platform access credentials…
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 2. Error / Expired / Revoked state
  if (!valid) {
    const isExpired = errorCode === 'expired';
    const isRevoked = errorCode === 'revoked';
    const isAccepted = errorCode === 'already_accepted';

    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center p-6 bg-canvas text-ink">
        <div className="w-full max-w-md bg-surface border border-line rounded-2xl p-8 shadow-md space-y-6 text-center">
          <div className="flex justify-center">
            <Logo size="md" />
          </div>

          <div className="space-y-3">
            <div
              className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto ${
                isExpired
                  ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                  : isRevoked
                  ? 'bg-danger/10 text-danger border border-danger/20'
                  : isAccepted
                  ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                  : 'bg-danger/10 text-danger border border-danger/20'
              }`}
            >
              {isExpired ? (
                <Clock className="w-7 h-7" />
              ) : isRevoked ? (
                <AlertCircle className="w-7 h-7" />
              ) : isAccepted ? (
                <CheckCircle2 className="w-7 h-7" />
              ) : (
                <AlertCircle className="w-7 h-7" />
              )}
            </div>

            <div className="space-y-1.5">
              <h1 className="text-lg font-bold text-ink tracking-tight">
                {isExpired
                  ? 'Invitation Link Expired'
                  : isRevoked
                  ? 'Invitation Link Revoked'
                  : isAccepted
                  ? 'Invitation Already Used'
                  : 'Invalid Invitation Link'}
              </h1>
              <p className="text-xs text-ink-3 leading-relaxed">
                {errorMessage}
              </p>
            </div>
          </div>

          <div className="pt-2 border-t border-line space-y-2.5">
            {isAccepted ? (
              <Button
                variant="primary"
                size="md"
                className="w-full"
                onClick={() => router.push('/login?redirect=/admin')}
              >
                <span>Go to Admin Login</span>
                <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
            ) : (
              <p className="text-2xs text-ink-3">
                Please contact the platform owner to request a new invitation link.
              </p>
            )}

            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => router.push('/login')}
            >
              <span>Back to Login</span>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // 3. Valid invitation acceptance form
  const roleName = role === 'owner' ? 'Platform Owner' : 'Platform Administrator';

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-6 bg-canvas text-ink">
      <div className="w-full max-w-md bg-surface border border-line rounded-2xl p-8 shadow-md space-y-6">
        {/* Brand header */}
        <div className="text-center space-y-2">
          <div className="flex justify-center mb-1">
            <Logo size="md" />
          </div>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-2xs font-semibold bg-accent/10 text-accent border border-accent/20">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{roleName} Invitation</span>
          </div>
          <h1 className="text-xl font-bold text-ink tracking-tight">
            Complete Your Admin Setup
          </h1>
          <p className="text-xs text-ink-3">
            Set your name and choose a secure password to activate your platform administrator account.
          </p>
        </div>

        {formError && (
          <div className="p-3.5 rounded-xl border border-danger/30 bg-danger/5 text-xs text-danger flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1 font-medium">{formError}</div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Read-only email tied to token */}
          <div className="space-y-1.5">
            <label className="text-2xs font-semibold text-ink uppercase tracking-wider flex items-center justify-between">
              <span>Invited Email</span>
              <span className="text-2xs text-ink-3 font-normal normal-case flex items-center gap-1">
                <Lock className="w-3 h-3 text-ink-3" />
                Verified & Locked
              </span>
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="email"
                value={email}
                disabled
                className="w-full h-10 pl-9 pr-3 rounded-lg border border-line bg-surface-2 text-xs font-mono text-ink-2 select-all cursor-not-allowed opacity-90"
              />
            </div>
            <p className="text-2xs text-ink-3">
              This admin account is permanently tied to this invitation email address.
            </p>
          </div>

          {/* Full Name */}
          <div className="space-y-1.5">
            <label className="text-2xs font-semibold text-ink uppercase tracking-wider block">
              Full Name
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                disabled={submitting}
                className="w-full h-10 pl-9 pr-3 rounded-lg border border-line bg-surface text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
                autoFocus
              />
            </div>
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <label className="text-2xs font-semibold text-ink uppercase tracking-wider block">
              Choose Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                disabled={submitting}
                className="w-full h-10 pl-9 pr-9 rounded-lg border border-line bg-surface text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink transition-colors"
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* Confirm Password */}
          <div className="space-y-1.5">
            <label className="text-2xs font-semibold text-ink uppercase tracking-wider block">
              Confirm Password
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter your password"
                disabled={submitting}
                className="w-full h-10 pl-9 pr-3 rounded-lg border border-line bg-surface text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
              />
            </div>
          </div>

          {/* Notice: No workspace, direct admin access */}
          <div className="p-3 rounded-xl bg-surface-2 border border-line text-2xs text-ink-3 space-y-1">
            <div className="font-semibold text-ink flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-accent" />
              <span>Platform Administrator Account</span>
            </div>
            <p>
              Your account has full administrative access to the ZenTry platform panel. No workspace or subscription is required.
            </p>
          </div>

          <Button
            type="submit"
            variant="primary"
            size="md"
            className="w-full h-10 text-xs font-semibold"
            loading={submitting}
          >
            <span>Activate Account & Open Admin</span>
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </Button>
        </form>

        <div className="text-center pt-2 border-t border-line">
          <Link
            href="/login"
            className="text-2xs text-ink-3 hover:text-ink transition-colors"
          >
            Already have an active account? Sign in here
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function AdminInvitePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen w-full flex items-center justify-center p-6 bg-canvas text-ink">
          <div className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        </div>
      }
    >
      <InviteAcceptForm />
    </Suspense>
  );
}
