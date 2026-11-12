'use client';

import React from 'react';
import { AlertCircle, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';

/** Shared frame for /admin/login and /admin/signup. */
export function AdminAuthCard({
  title,
  subtitle,
  error,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  error?: string | null;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="min-h-screen w-full flex flex-col items-center justify-center px-4 py-10 bg-canvas text-ink">
      <div className="w-full max-w-md bg-surface border border-line rounded-2xl p-6 sm:p-8 shadow-md space-y-6">
        <div className="text-center space-y-2">
          <div className="flex justify-center mb-1">
            <Logo size="md" />
          </div>
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-2xs font-semibold bg-accent/10 text-accent border border-accent/20">
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden />
            <span>Platform admin</span>
          </div>
          <h1 className="text-xl font-bold text-ink tracking-tight">{title}</h1>
          <p className="text-xs text-ink-3">{subtitle}</p>
        </div>

        {error && (
          <div role="alert" className="p-3.5 rounded-xl border border-danger/30 bg-danger/5 text-xs text-danger flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1 font-medium">{error}</div>
          </div>
        )}

        {children}

        {footer && <div className="pt-4 border-t border-line text-center text-xs text-ink-3">{footer}</div>}
      </div>
    </main>
  );
}

export function AdminAuthField({
  id,
  label,
  icon: Icon,
  hint,
  trailing,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  icon: LucideIcon;
  hint?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-2xs font-semibold text-ink uppercase tracking-wider block">
        {label}
      </label>
      <div className="relative">
        <Icon className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
        <input
          id={id}
          {...input}
          className="w-full h-10 pl-9 pr-9 rounded-lg border border-line bg-surface text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors disabled:opacity-60"
        />
        {trailing && <div className="absolute right-3 top-1/2 -translate-y-1/2">{trailing}</div>}
      </div>
      {hint && <p className="text-2xs text-ink-3">{hint}</p>}
    </div>
  );
}
