'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Eye, EyeOff, KeyRound, Lock, Mail, User } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { AdminAuthCard, AdminAuthField } from '@/components/admin/AdminAuthCard';
import { adminSignupAction, isAdminSignupEnabledAction } from '@/app/actions/admin-auth';
import { errorMessage } from '@/lib/errors/user-error';

export default function AdminSignupPage() {
  const router = useRouter();
  const supabase = createClient();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [setupKey, setSetupKey] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    isAdminSignupEnabledAction()
      .then(setEnabled)
      .catch(() => setEnabled(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await adminSignupAction({ setupKey, name, email, password });
      if (!res.success) {
        setError(res.error || 'Could not create the admin account.');
        setSubmitting(false);
        return;
      }
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInErr) {
        router.push(`/admin/login?message=${encodeURIComponent('Admin account ready. Please sign in.')}`);
        return;
      }
      router.push('/admin');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not create the admin account.'));
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      Already an admin?{' '}
      <Link href="/admin/login" className="text-accent font-semibold hover:underline">
        Sign in
      </Link>
    </>
  );

  if (enabled === null) {
    return (
      <AdminAuthCard title="Create admin account" subtitle="Checking whether sign-up is available…" footer={footer}>
        <div className="space-y-3" aria-busy="true">
          <div className="skeleton h-10 rounded-lg" />
          <div className="skeleton h-10 rounded-lg" />
          <div className="skeleton h-10 rounded-lg" />
        </div>
      </AdminAuthCard>
    );
  }

  if (!enabled) {
    return (
      <AdminAuthCard
        title="Admin sign-up is off"
        subtitle="New admins join through an invite from the platform owner."
        footer={footer}
      >
        <p className="p-3 rounded-xl bg-surface-2 border border-line text-2xs text-ink-3">
          To allow sign-up with a setup key, set <code className="font-mono text-ink">ADMIN_SIGNUP_KEY</code> (at least 16
          characters) in the server environment and redeploy.
        </p>
      </AdminAuthCard>
    );
  }

  const eye = (
    <button
      type="button"
      onClick={() => setShowPassword((v) => !v)}
      className="text-ink-3 hover:text-ink"
      aria-label={showPassword ? 'Hide password' : 'Show password'}
    >
      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
    </button>
  );

  return (
    <AdminAuthCard
      title="Create admin account"
      subtitle="Admins can open every workspace, change plans and manage the platform."
      error={error}
      footer={footer}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AdminAuthField
          id="setup-key"
          label="Setup key"
          icon={KeyRound}
          type="password"
          autoComplete="off"
          required
          autoFocus
          value={setupKey}
          onChange={(e) => setSetupKey(e.target.value)}
          placeholder="ADMIN_SIGNUP_KEY from the server"
          hint="The secret set as ADMIN_SIGNUP_KEY in the server environment."
          disabled={submitting}
        />
        <AdminAuthField
          id="admin-name"
          label="Full name"
          icon={User}
          type="text"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
          disabled={submitting}
        />
        <AdminAuthField
          id="admin-email"
          label="Email"
          icon={Mail}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          hint="Already have a Zentry login? Use it with its current password and it becomes an admin too."
          disabled={submitting}
        />
        <AdminAuthField
          id="admin-password"
          label="Password"
          icon={Lock}
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          disabled={submitting}
          trailing={eye}
        />
        <AdminAuthField
          id="admin-password-confirm"
          label="Confirm password"
          icon={Lock}
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Re-enter your password"
          disabled={submitting}
        />
        <Button type="submit" variant="primary" size="md" className="w-full h-10 text-xs font-semibold" loading={submitting}>
          <span>Create admin account</span>
          <ArrowRight className="w-4 h-4 ml-1.5" />
        </Button>
      </form>
    </AdminAuthCard>
  );
}
