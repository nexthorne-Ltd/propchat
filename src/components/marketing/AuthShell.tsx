import React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { Logo } from '@/components/ui/Logo';

/**
 * Split-screen frame shared by sign-in and sign-up: the form on the left,
 * an editorial panel on the right that disappears below `lg`.
 */
export function AuthShell({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside: React.ReactNode;
}) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] bg-canvas">
      {/* Form column */}
      <div className="flex flex-col px-6 py-8 sm:px-10">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center min-h-11 group"
            aria-label="Zen-try home"
          >
            <Logo size={32} />
          </Link>
          <ThemeToggle />
        </div>

        <div className="flex-1 flex items-center justify-center py-12">
          <div className="w-full max-w-[380px] animate-rise">{children}</div>
        </div>

        <Link
          href="/"
          className="inline-flex items-center gap-1.5 min-h-11 text-xs text-ink-3 hover:text-ink transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to home
        </Link>
      </div>

      {/* Editorial column */}
      <div className="hidden lg:flex relative overflow-hidden bg-invert text-invert-ink">
        <div
          className="absolute inset-0 opacity-[0.16] pointer-events-none"
          style={{
            backgroundImage:
              'radial-gradient(circle at 15% 15%, #2E5BFF, transparent 45%), radial-gradient(circle at 85% 85%, #7c5cff, transparent 45%)',
          }}
        />
        <div className="relative flex flex-col justify-center p-14 xl:p-20 w-full">
          {aside}
        </div>
      </div>
    </div>
  );
}

/** Quote-style panel used on the sign-in page. */
export function AuthAside({
  eyebrow,
  headline,
  points,
}: {
  eyebrow: string;
  headline: React.ReactNode;
  points: { title: string; body: string }[];
}) {
  return (
    <div className="max-w-md">
      <span className="text-2xs font-bold uppercase tracking-[0.1em] opacity-50">
        {eyebrow}
      </span>
      <h2 className="mt-4 text-4xl leading-[1.12] font-semibold text-invert-ink">
        {headline}
      </h2>

      <ul className="mt-10 space-y-6">
        {points.map((p) => (
          <li key={p.title} className="flex gap-4">
            <span className="mt-1.5 w-1 h-1 rounded-full bg-white/40 shrink-0" />
            <div>
              <div className="text-sm font-semibold">{p.title}</div>
              <p className="mt-1 text-ui leading-relaxed opacity-60">
                {p.body}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
