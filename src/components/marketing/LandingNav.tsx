'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Menu, X } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

export function LandingNav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    // data-zentry-no-nav: this nav already links the Help Center and FAQ, so
    // the embedded widget must not add its own link here.
    <header className="sticky top-0 z-50 border-b border-line bg-surface" data-zentry-no-nav="">
      <div className="u-container h-16 flex items-center justify-between gap-4 sm:gap-6 flex-nowrap">
        <Link href="/" className="flex items-center min-h-11 shrink-0 whitespace-nowrap">
          <Logo size={34} />
        </Link>

        {/* Desktop Navigation Links: visible at >= 1024px, never wrap to two lines */}
        <nav className="hidden lg:flex items-center gap-1 text-ui font-medium shrink-0 whitespace-nowrap">
          {[
            ['Product', '/#product'],
            ['Pricing', '/pricing'],
            ['How it works', '/#how'],
            ['Install', '/#install'],
            ['FAQ', '/#faq'],
          ].map(([label, href]) => (
            <Link
              key={href}
              href={href}
              className="px-3 py-1.5 rounded-lg text-ink-2 hover:text-ink hover:bg-surface-3 transition-colors shrink-0 whitespace-nowrap"
            >
              {label}
            </Link>
          ))}
          <Link
            href="/help"
            className="px-3 py-1.5 rounded-lg text-ink-2 hover:text-ink hover:bg-surface-3 transition-colors shrink-0 whitespace-nowrap"
          >
            Help Center
          </Link>
          <a
            href="/demo.html"
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1.5 rounded-lg text-ink-2 hover:text-ink hover:bg-surface-3 transition-colors inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap"
          >
            <span>Live demo</span>
            <span className="live-dot" />
          </a>
        </nav>

        {/* Right CTA Actions: never wrap to two lines */}
        <div className="flex items-center gap-2 sm:gap-2.5 shrink-0 whitespace-nowrap flex-nowrap">
          <ThemeToggle className="hidden sm:inline-flex shrink-0" />
          <Link
            href="/login"
            className="hidden sm:inline-flex btn btn-sm btn-ghost font-semibold text-ink-2 hover:text-ink shrink-0 whitespace-nowrap"
          >
            Sign in
          </Link>
          <Link href="/signup" className="btn btn-sm btn-primary shadow-xs shrink-0 whitespace-nowrap max-sm:h-11 max-sm:px-4">
            <span>Get started</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>

          {/* Mobile/Tablet menu trigger below 1024px */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-label="Toggle navigation menu"
            className="lg:hidden w-11 h-11 flex items-center justify-center rounded-xl text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors border border-line shrink-0"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile/Tablet Menu Dropdown Drawer (below 1024px) */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-b border-line bg-surface px-5 py-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-150 shadow-lg">
          <nav className="flex flex-col space-y-1 text-sm font-medium">
            <Link
              href="/#product"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 min-h-11 flex items-center rounded-lg text-ink hover:bg-surface-2 transition-colors whitespace-nowrap"
            >
              Product
            </Link>
            <Link
              href="/pricing"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 min-h-11 flex items-center rounded-lg text-ink hover:bg-surface-2 transition-colors whitespace-nowrap"
            >
              Pricing
            </Link>
            <Link
              href="/#how"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 min-h-11 flex items-center rounded-lg text-ink hover:bg-surface-2 transition-colors whitespace-nowrap"
            >
              How it works
            </Link>
            <Link
              href="/#install"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 min-h-11 flex items-center rounded-lg text-ink hover:bg-surface-2 transition-colors whitespace-nowrap"
            >
              Installation
            </Link>
            <Link
              href="/#faq"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 min-h-11 flex items-center rounded-lg text-ink hover:bg-surface-2 transition-colors whitespace-nowrap"
            >
              FAQ
            </Link>
            <Link
              href="/help"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 min-h-11 flex items-center rounded-lg text-ink hover:bg-surface-2 transition-colors flex items-center justify-between whitespace-nowrap"
            >
              <span>Help Center</span>
            </Link>
            <a
              href="/demo.html"
              target="_blank"
              rel="noreferrer"
              onClick={() => setMobileMenuOpen(false)}
              className="px-3 py-2 min-h-11 rounded-lg text-accent font-semibold hover:bg-accent/10 transition-colors flex items-center justify-between whitespace-nowrap"
            >
              <span>Live demo</span>
              <span className="live-dot" />
            </a>
          </nav>

          <div className="pt-3 border-t border-line flex items-center justify-between gap-3">
            <ThemeToggle />
            <Link
              href="/login"
              onClick={() => setMobileMenuOpen(false)}
              className="btn btn-sm btn-secondary flex-1 justify-center whitespace-nowrap max-sm:h-11"
            >
              Sign in
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
