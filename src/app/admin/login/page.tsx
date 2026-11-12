'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Eye, EyeOff, Lock, Mail } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { AdminAuthCard, AdminAuthField } from '@/components/admin/AdminAuthCard';
import { checkAdminAccessAction } from '@/app/actions/admin-auth';
import { errorMessage } from '@/lib/errors/user-error';

function AdminLoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const supabase = createClient();
  // Only same-site admin paths, so the link can't bounce anyone elsewhere.
  const requested = params.get('redirect') || '';
  const redirectTo = requested.startsWith('/admin') && !requested.startsWith('//') ? requested : '/admin';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(params.get('error'));
  const notice = params.get('message');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInErr) {
        setError(signInErr.message === 'Invalid login credentials' ? 'Wrong email or password.' : signInErr.message);
        setSubmitting(false);
        return;
      }
      const { isAdmin } = await checkAdminAccessAction();
      if (!isAdmin) {
        // Signed in, but not an admin: don't leave a half-open session behind.
        await supabase.auth.signOut();
        setError('This account does not have admin access. Create an admin account with the setup key, or ask the platform owner for an invite.');
        setSubmitting(false);
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not sign in. Try again.'));
      setSubmitting(false);
    }
  };

  return (
    <AdminAuthCard
      title="Admin sign in"
      subtitle="Sign in to manage workspaces, plans and platform settings."
      error={error}
      footer={
        <>
          No admin account?{' '}
          <Link href="/admin/signup" className="text-accent font-semibold hover:underline">
            Create one
          </Link>
          <span className="mx-2" aria-hidden>·</span>
          <Link href="/login" className="hover:text-ink">Workspace login</Link>
        </>
      }
    >
      {notice && (
        <p role="status" className="p-3 rounded-xl border border-success-line bg-success-soft text-xs text-success">
          {notice}
        </p>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <AdminAuthField
          id="admin-email"
          label="Email"
          icon={Mail}
          type="email"
          autoComplete="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          disabled={submitting}
        />
        <AdminAuthField
          id="admin-password"
          label="Password"
          icon={Lock}
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your password"
          disabled={submitting}
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="text-ink-3 hover:text-ink"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          }
        />
        <Button type="submit" variant="primary" size="md" className="w-full h-10 text-xs font-semibold" loading={submitting}>
          <span>Sign in to admin</span>
          <ArrowRight className="w-4 h-4 ml-1.5" />
        </Button>
      </form>
    </AdminAuthCard>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas" />}>
      <AdminLoginForm />
    </Suspense>
  );
}
