import React from 'react';
import Link from 'next/link';
import { Home, LogIn, HelpCircle, ArrowRight, Compass } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

export const metadata = {
  title: '404 - Page Not Found | Zen-try',
  description: 'The requested page could not be found.',
};

export default function NotFound() {
  return (
    <div className="min-h-screen bg-canvas text-ink flex flex-col justify-between selection:bg-accent/20">
      {/* Header */}
      <header className="border-b border-line bg-surface sticky top-0 z-40">
        <div className="u-container h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Logo size={32} />
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/login"
              className="btn btn-sm btn-ghost text-ink-2 hover:text-ink font-medium"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      {/* Main 404 Content */}
      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-16 sm:py-24">
        <div className="max-w-xl w-full text-center space-y-8 animate-rise">
          {/* Badge & Icon */}
          <div className="relative inline-flex items-center justify-center">
            <div className="w-20 h-20 rounded-3xl bg-accent/10 border border-accent/20 text-accent flex items-center justify-center shadow-xs">
              <Compass className="w-10 h-10 stroke-[1.75] animate-pulse" />
            </div>
            <span className="absolute -bottom-2.5 px-3 py-0.5 rounded-full text-2xs font-bold tracking-wider uppercase bg-surface border border-line shadow-xs text-accent">
              Error 404
            </span>
          </div>

          <div className="space-y-3">
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-ink">
              Page not found
            </h1>
            <p className="text-md sm:text-base text-ink-2 max-w-md mx-auto leading-relaxed">
              The page you are looking for doesn&apos;t exist, has been moved, or is temporarily unavailable.
            </p>
          </div>

          {/* Action Links: Home, Login, Help */}
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3 max-w-md mx-auto">
            <Link
              href="/"
              className="btn btn-lg btn-primary w-full sm:w-auto justify-center shadow-xs"
            >
              <Home className="w-4 h-4" />
              <span>Back to Home</span>
              <ArrowRight className="w-4 h-4" />
            </Link>

            <Link
              href="/login"
              className="btn btn-lg btn-secondary w-full sm:w-auto justify-center"
            >
              <LogIn className="w-4 h-4 text-ink-2" />
              <span>Sign In</span>
            </Link>

            <Link
              href="/help"
              className="btn btn-lg btn-ghost w-full sm:w-auto justify-center text-ink-2 hover:text-ink border border-line"
            >
              <HelpCircle className="w-4 h-4 text-accent" />
              <span>Help Center</span>
            </Link>
          </div>

          {/* Helpful Navigation Card */}
          <div className="card p-5 text-left max-w-md mx-auto space-y-2.5">
            <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider block">
              Quick links
            </span>
            <div className="grid grid-cols-2 gap-2 text-ui">
              <Link
                href="/#product"
                className="text-ink-2 hover:text-accent transition-colors flex items-center gap-1.5"
              >
                <span>&bull; Product Features</span>
              </Link>
              <Link
                href="/#install"
                className="text-ink-2 hover:text-accent transition-colors flex items-center gap-1.5"
              >
                <span>&bull; Installation Guide</span>
              </Link>
              <Link
                href="/demo.html"
                target="_blank"
                className="text-ink-2 hover:text-accent transition-colors flex items-center gap-1.5"
              >
                <span>&bull; Live Widget Demo</span>
              </Link>
              <Link
                href="/signup"
                className="text-ink-2 hover:text-accent transition-colors flex items-center gap-1.5"
              >
                <span>&bull; Create Workspace</span>
              </Link>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-line py-6 text-center text-xs text-ink-3">
        <div className="u-container flex flex-col sm:flex-row items-center justify-between gap-3">
          <span>&copy; {new Date().getFullYear()} Zen-try Inc. All rights reserved.</span>
          <div className="flex items-center gap-4">
            <Link href="/" className="hover:text-ink transition-colors">
              Home
            </Link>
            <Link href="/login" className="hover:text-ink transition-colors">
              Sign In
            </Link>
            <Link href="/help" className="hover:text-ink transition-colors">
              Help Center
            </Link>
            <Link href="/privacy" className="hover:text-ink transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-ink transition-colors">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
