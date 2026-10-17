'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  Mail,
  RefreshCw,
  ShieldCheck,
  KeyRound,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { AuthAside, AuthShell } from '@/components/marketing/AuthShell';
import { GoogleButton } from '@/components/marketing/GoogleButton';
import { isProviderEnabled, useProviderEnabled } from '@/lib/auth/providers';
import {
  sendSignupVerificationCodeAction,
  verifySignupCodeAction,
  resendSignupVerificationCodeAction,
} from '@/app/actions/auth-verification';
import { errorMessage } from '@/lib/errors/user-error';

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  // Phase: 'form' (Details) -> 'verify_code' (Enter 6-digit OTP) -> 'verified' (Success redirect)
  const [phase, setPhase] = useState<'form' | 'verify_code' | 'verified'>('form');

  // Form Inputs - initialize email from query param if available
  const [name, setName] = useState('');
  const [email, setEmail] = useState(() => searchParams.get('email') || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [termsError, setTermsError] = useState(false);

  // OTP 6-digit code state
  const [otp, setOtp] = useState<string[]>(['', '', '', '', '', '']);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [deliveryWarning, setDeliveryWarning] = useState<string | null>(null);
  const [fallbackCode, setFallbackCode] = useState<string | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

  // undefined while we ask Supabase which providers are switched on.
  const googleEnabled = useProviderEnabled('google');
  const [errorMsg, setErrorMsg] = useState<string | null>(() => {
    return searchParams.get('error_description') || searchParams.get('error') || null;
  });

  const [resendTimer, setResendTimer] = useState<number>(30);

  // Resend countdown timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (phase === 'verify_code' && resendTimer > 0) {
      interval = setInterval(() => {
        setResendTimer((prev) => prev - 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [phase, resendTimer]);

  // Password rules validation
  const ruleLength = password.length >= 8;
  const ruleNumberOrSpecial = /[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
  const ruleCase = /[a-z]/.test(password) && /[A-Z]/.test(password);
  const allPasswordRulesMet = ruleLength && ruleNumberOrSpecial && ruleCase;

  // Google OAuth Signup
  const handleGoogleSignup = async () => {
    setGoogleLoading(true);
    setErrorMsg(null);

    if (!(await isProviderEnabled('google'))) {
      setGoogleLoading(false);
      setErrorMsg('Google sign-up is not enabled yet — use email below for now.');
      return;
    }

    try {
      const origin =
        typeof window !== 'undefined'
          ? window.location.origin
          : (process.env.NEXT_PUBLIC_APP_URL || '');

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${origin}/auth/callback?next=/onboarding`,
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
            'Google Sign-Up is not enabled yet in your Supabase project. Please register with work email below.'
          );
        } else {
          setErrorMsg(error.message);
        }
        setGoogleLoading(false);
      }
    } catch (err: any) {
      console.error('Google signup error:', err);
      setErrorMsg(errorMessage(err, 'Failed to initiate Google sign-up.'));
      setGoogleLoading(false);
    }
  };

  // Submit Account Registration (Sends 6-digit OTP from ZenTry)
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setTermsError(false);

    if (!name.trim() || !email.trim() || !password) {
      setErrorMsg('Please fill in all required fields.');
      return;
    }

    if (!allPasswordRulesMet) {
      setErrorMsg('Please ensure your password meets all the security requirements below.');
      return;
    }

    if (!agreedToTerms) {
      setTermsError(true);
      setErrorMsg('Please agree to the Terms of Service and Privacy Policy to continue.');
      return;
    }

    setLoading(true);

    try {
      const res = await sendSignupVerificationCodeAction({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        password,
      });

      if (!res.success) {
        setErrorMsg(res.error || 'Failed to initiate account registration.');
        return;
      }

      if (res.warning) {
        setDeliveryWarning(res.warning);
      } else {
        setDeliveryWarning(null);
      }

      if (res.code) {
        setFallbackCode(res.code);
      } else {
        setFallbackCode(null);
      }

      setPhase('verify_code');
      setResendTimer(30);
      setResendSuccess(false);
      setOtp(['', '', '', '', '', '']);
      setTimeout(() => {
        inputRefs.current[0]?.focus();
      }, 150);
    } catch (err: any) {
      console.error('Registration error:', err);
      setErrorMsg(errorMessage(err, 'Failed to initiate account registration.'));
    } finally {
      setLoading(false);
    }
  };

  // Handle OTP paste
  const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;

    const newOtp = ['', '', '', '', '', ''];
    for (let i = 0; i < 6; i++) {
      newOtp[i] = pasted[i] || '';
    }
    setOtp(newOtp);

    const nextIdx = Math.min(pasted.length, 5);
    inputRefs.current[nextIdx]?.focus();

    if (pasted.length === 6) {
      handleVerifyOtp(pasted);
    }
  };

  // Handle single digit input
  const handleOtpChange = (index: number, value: string) => {
    const clean = value.replace(/\D/g, '');
    if (!clean) {
      const newOtp = [...otp];
      newOtp[index] = '';
      setOtp(newOtp);
      return;
    }

    const digit = clean[clean.length - 1];
    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);

    if (index < 5 && digit) {
      inputRefs.current[index + 1]?.focus();
    }

    const combined = newOtp.join('');
    if (combined.length === 6) {
      handleVerifyOtp(combined);
    }
  };

  // Handle backspace navigation
  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  // Verify OTP Code
  const handleVerifyOtp = async (codeToVerify?: string) => {
    const fullCode = (codeToVerify || otp.join('')).replace(/\D/g, '').trim();
    if (fullCode.length !== 6) {
      setErrorMsg('Please enter the complete 6-digit verification code.');
      return;
    }

    setVerifyingCode(true);
    setErrorMsg(null);

    try {
      const res = await verifySignupCodeAction({
        email: email.trim().toLowerCase(),
        code: fullCode,
      });

      if (!res.success) {
        setErrorMsg(res.error || 'Invalid or expired verification code.');
        setVerifyingCode(false);
        return;
      }

      // Automatically sign in with credentials
      if (password) {
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });

        if (signInErr) {
          console.warn('Sign-in after verification:', signInErr.message);
        }
      }

      setPhase('verified');
      setTimeout(() => {
        router.push('/onboarding');
        router.refresh();
      }, 1200);
    } catch (err: any) {
      console.error('Verification error:', err);
      setErrorMsg(errorMessage(err, 'Failed to verify code.'));
    } finally {
      setVerifyingCode(false);
    }
  };

  // Resend OTP Code
  const handleResendCode = async () => {
    if (resendTimer > 0 || resending) return;
    setResending(true);
    setErrorMsg(null);
    setResendSuccess(false);

    try {
      const res = await resendSignupVerificationCodeAction({
        email: email.trim().toLowerCase(),
        name: name.trim(),
      });

      if (!res.success) {
        setErrorMsg(res.error || 'Failed to resend code.');
      } else {
        setResendSuccess(true);
        setResendTimer(30);
        if (res.warning) {
          setDeliveryWarning(res.warning);
        } else {
          setDeliveryWarning(null);
        }
        if (res.code) {
          setFallbackCode(res.code);
        } else {
          setFallbackCode(null);
        }
        setOtp(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
      }
    } catch (err: any) {
      setErrorMsg(errorMessage(err, 'Failed to resend code.'));
    } finally {
      setResending(false);
    }
  };


  /* ---------------------------------------------------------------- render */

  if (phase === 'verified') {
    return (
      <div className="text-center animate-pop">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-success-soft border border-success-line text-success flex items-center justify-center">
          <CheckCircle2 className="w-7 h-7" />
        </div>
        <h1 className="mt-6 text-2xl font-semibold">Email verified!</h1>
        <p className="mt-2 text-sm text-ink-2">
          Setting up your workspace…
        </p>
        <div className="mt-6 mx-auto w-32 h-1 rounded-full bg-surface-3 overflow-hidden">
          <div className="h-full w-1/3 rounded-full bg-accent animate-breathe" />
        </div>
      </div>
    );
  }

  if (phase === 'verify_code') {
    return (
      <div className="animate-rise">
        <button
          type="button"
          onClick={() => {
            setPhase('form');
            setErrorMsg(null);
          }}
          className="inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink transition-colors mb-6 cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Edit email or details
        </button>

        <div className="w-12 h-12 rounded-2xl bg-accent/15 border border-accent/20 text-accent flex items-center justify-center shadow-xs">
          <KeyRound className="w-6 h-6 stroke-[1.8]" />
        </div>

        <h1 className="mt-5 text-3xl leading-tight font-semibold">
          Enter verification code
        </h1>
        <p className="mt-2 text-sm text-ink-2 leading-relaxed">
          We sent a 6-digit code from <strong className="text-ink">ZenTry</strong> to{' '}
          <span className="font-semibold text-ink">{email}</span>. Enter or paste the code below to verify your email.
        </p>

        {errorMsg && (
          <div
            role="alert"
            className="mt-5 flex items-start gap-2.5 rounded-xl border border-danger-line bg-danger-soft px-3.5 py-3 text-xs text-danger animate-pop"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
            <span>{errorMsg}</span>
          </div>
        )}

        {resendSuccess && (
          <div
            role="status"
            className="mt-5 flex items-center gap-2 rounded-xl border border-success-line bg-success-soft px-3.5 py-3 text-xs text-success animate-pop"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>A fresh verification code has been dispatched to your email.</span>
          </div>
        )}

        {deliveryWarning && (
          <div
            role="alert"
            className="mt-5 p-4 rounded-xl border border-warn/30 bg-warn/10 text-warn text-xs space-y-2 animate-pop"
          >
            <div className="font-bold flex items-center gap-1.5 text-warn">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>Email Delivery Notice:</span>
            </div>
            <p className="leading-relaxed">{deliveryWarning}</p>
            {fallbackCode && (
              <div className="pt-2 border-t border-warn/20 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-ink-2 font-medium">Verification Code:</span>
                  <span className="font-mono font-bold text-sm bg-surface px-2.5 py-1 rounded-lg border border-line text-ink">
                    {fallbackCode}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const digits = fallbackCode.split('');
                    setOtp(digits);
                    handleVerifyOtp(fallbackCode);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-accent text-accent-ink font-bold text-xs hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
                >
                  Auto-fill &amp; Verify Now &rarr;
                </button>
              </div>
            )}
          </div>
        )}

        {/* 6-box OTP Input */}
        <div className="mt-7 space-y-6">
          <div className="flex items-center justify-between gap-2 sm:gap-3">
            {otp.map((digit, idx) => (
              <input
                key={idx}
                ref={(el) => { inputRefs.current[idx] = el; }}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={1}
                value={digit}
                autoFocus={idx === 0}
                onChange={(e) => handleOtpChange(idx, e.target.value)}
                onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                onPaste={handleOtpPaste}
                className="w-11 h-14 sm:w-12 sm:h-14 text-center font-mono text-2xl font-bold rounded-xl border-2 border-line bg-surface text-ink focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all outline-hidden shadow-xs"
              />
            ))}
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={() => handleVerifyOtp()}
              disabled={verifyingCode || otp.join('').replace(/\D/g, '').length !== 6}
              className="btn btn-lg btn-primary w-full"
            >
              {verifyingCode ? (
                <>
                  <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin-slow" />
                  Verifying code…
                </>
              ) : (
                <>
                  Verify &amp; Create Workspace
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            <div className="panel p-3 text-center text-xs text-ink-3">
              💡 Tip: You can copy the 6 digits from your email and paste them directly into the first box.
            </div>
          </div>
        </div>

        <div className="mt-6 text-center text-xs text-ink-3">
          Didn&apos;t receive the email?{' '}
          <button
            type="button"
            onClick={handleResendCode}
            disabled={resendTimer > 0 || resending}
            className="inline-flex items-center gap-1.5 font-medium text-accent disabled:text-ink-3 disabled:cursor-not-allowed hover:underline underline-offset-4 disabled:no-underline cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 ${resending ? 'animate-spin' : ''}`} />
            {resendTimer > 0 ? `Resend in ${resendTimer}s` : 'Resend code'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-7">
        <h1 className="text-3xl leading-tight font-semibold">
          Create your workspace
        </h1>
        <p className="mt-2 text-sm text-ink-2">
          Start your free trial. No credit card required.
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
            onClick={handleGoogleSignup}
            loading={googleLoading}
            disabled={loading}
            text="Sign up with Google"
          />

          <div className="relative my-6 text-center text-xs text-ink-3">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-line-2" />
            </div>
            <span className="relative bg-surface px-3 text-ink-3">
              or register with work email
            </span>
          </div>
        </>
      )}

      <form onSubmit={handleRegister} className="space-y-4">
        <div>
          <label htmlFor="name" className="field-label">
            Full name
          </label>
          <input
            id="name"
            type="text"
            required
            autoComplete="name"
            placeholder="Alex Morgan"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
        </div>

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
              autoComplete="new-password"
              placeholder="Create a strong password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input pr-11"
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-0.5 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-8 sm:h-8 sm:right-1.5 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors cursor-pointer"
            >
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>

          {/* Password rules checklist under the field */}
          <div className="mt-2.5 rounded-xl border border-line-2 bg-surface-2/60 p-3 space-y-1.5 text-xs">
            <span className="font-medium text-ink-2 block mb-1">
              Password requirements:
            </span>
            <div className="space-y-1">
              <div
                className={`flex items-center gap-2 transition-colors ${
                  ruleLength ? 'text-success font-medium' : 'text-ink-3'
                }`}
              >
                <div
                  className={`w-3.5 h-3.5 rounded-full flex items-center justify-center ${
                    ruleLength
                      ? 'bg-success text-white'
                      : 'border border-line-2 bg-surface'
                  }`}
                >
                  {ruleLength && <Check className="w-2.5 h-2.5 stroke-[2.5]" />}
                </div>
                <span>At least 8 characters</span>
              </div>

              <div
                className={`flex items-center gap-2 transition-colors ${
                  ruleCase ? 'text-success font-medium' : 'text-ink-3'
                }`}
              >
                <div
                  className={`w-3.5 h-3.5 rounded-full flex items-center justify-center ${
                    ruleCase
                      ? 'bg-success text-white'
                      : 'border border-line-2 bg-surface'
                  }`}
                >
                  {ruleCase && <Check className="w-2.5 h-2.5 stroke-[2.5]" />}
                </div>
                <span>Uppercase & lowercase letters</span>
              </div>

              <div
                className={`flex items-center gap-2 transition-colors ${
                  ruleNumberOrSpecial ? 'text-success font-medium' : 'text-ink-3'
                }`}
              >
                <div
                  className={`w-3.5 h-3.5 rounded-full flex items-center justify-center ${
                    ruleNumberOrSpecial
                      ? 'bg-success text-white'
                      : 'border border-line-2 bg-surface'
                  }`}
                >
                  {ruleNumberOrSpecial && (
                    <Check className="w-2.5 h-2.5 stroke-[2.5]" />
                  )}
                </div>
                <span>At least 1 number or special character</span>
              </div>
            </div>
          </div>
        </div>

        {/* Checkbox with links to Terms and Privacy Policy */}
        <div className="pt-1">
          <label className="flex items-start gap-2.5 min-h-11 cursor-pointer select-none">
            <input
              type="checkbox"
              id="terms"
              checked={agreedToTerms}
              onChange={(e) => {
                setAgreedToTerms(e.target.checked);
                if (e.target.checked) setTermsError(false);
              }}
              className={`mt-0.5 w-4 h-4 rounded border ${
                termsError ? 'border-danger ring-1 ring-danger' : 'border-line-2'
              } text-accent focus:ring-accent bg-surface transition-all cursor-pointer`}
            />
            <span className="text-xs text-ink-2 leading-snug">
              I agree to the{' '}
              <Link
                href="/terms"
                target="_blank"
                className="py-[14px] font-medium text-ink underline underline-offset-4 hover:text-accent transition-colors"
              >
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link
                href="/privacy"
                target="_blank"
                className="py-[14px] font-medium text-ink underline underline-offset-4 hover:text-accent transition-colors"
              >
                Privacy Policy
              </Link>
            </span>
          </label>
        </div>

        <button
          type="submit"
          disabled={loading || googleLoading}
          className="btn btn-lg btn-primary w-full !mt-5 cursor-pointer"
        >
          {loading ? (
            <>
              <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin-slow" />
              Creating account…
            </>
          ) : (
            <>
              Create account
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      <p className="mt-5 text-center text-xs text-ink-3">
        Already have an account?{' '}
        <Link
          href="/login"
          className="py-[14px] font-medium text-ink hover:underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}

export default function SignupPage() {
  return (
    <AuthShell
      aside={
        <AuthAside
          eyebrow="Get started"
          headline={
            <>
              Two minutes from
              <br />
              sign-up to live chat.
            </>
          }
          points={[
            {
              title: 'Create the workspace',
              body: 'Your business, your branding, your agent profile — provisioned instantly.',
            },
            {
              title: 'Paste one script tag',
              body: 'Works on WordPress, Shopify, Webflow, Next.js and plain HTML alike.',
            },
            {
              title: 'Start answering',
              body: 'Visitors appear in your inbox the moment they open the messenger.',
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
        <SignupForm />
      </Suspense>
    </AuthShell>
  );
}
