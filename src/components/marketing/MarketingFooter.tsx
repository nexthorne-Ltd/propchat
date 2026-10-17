import React from 'react';
import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

/**
 * The one footer on every public page (landing, pricing, legal). Each page
 * used to carry its own copy, and they had drifted: different links, no legal
 * links at all, and an "All systems operational" badge nothing measured.
 */
const COLUMNS: { heading: string; links: [string, string][] }[] = [
  {
    heading: 'Product',
    links: [
      ['Features', '/#product'],
      ['Pricing', '/pricing'],
      ['How it works', '/#how'],
      ['Install', '/#install'],
      ['Live demo', '/demo.html'],
    ],
  },
  {
    heading: 'Resources',
    links: [
      ['Help Center', '/help'],
      ['FAQ', '/#faq'],
      ['Create workspace', '/signup'],
      ['Agent sign in', '/login'],
    ],
  },
  {
    heading: 'Legal',
    links: [
      ['Privacy Policy', '/privacy'],
      ['Terms of Service', '/terms'],
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-line bg-canvas-alt">
      <div className="u-container py-14">
        <div className="grid gap-10 grid-cols-2 lg:grid-cols-5">
          <div className="col-span-2 max-w-xs">
            <Link href="/" aria-label="Zen-try home" className="inline-flex">
              <Logo size={32} />
            </Link>
            <p className="mt-4 text-ui leading-relaxed text-ink-2">
              Live chat, a shared inbox, an AI assistant and a help center, for teams that want to talk to their
              customers while they are still on the site.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <nav key={col.heading} aria-label={col.heading}>
              <h2 className="eyebrow">{col.heading}</h2>
              <ul className="mt-4 space-y-2.5">
                {col.links.map(([label, href]) => (
                  <li key={href}>
                    <Link href={href} className="text-ui text-ink-2 hover:text-ink transition-colors">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 pt-6 border-t border-line flex flex-col-reverse sm:flex-row items-center justify-between gap-4 text-xs text-ink-3">
          <span>© {new Date().getFullYear()} Zen-try. All rights reserved.</span>
          <ThemeToggle />
        </div>
      </div>
    </footer>
  );
}
