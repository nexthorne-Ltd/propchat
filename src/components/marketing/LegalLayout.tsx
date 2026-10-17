import React from 'react';
import Link from 'next/link';
import { LandingNav } from '@/components/marketing/LandingNav';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';

export interface LegalSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

/**
 * Privacy, terms and any later policy page: the site's own header and footer,
 * a readable column, and an "On this page" list that stays in view on wide
 * screens.
 */
export function LegalLayout({
  eyebrow,
  title,
  updated,
  intro,
  sections,
  related,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  intro: React.ReactNode;
  sections: LegalSection[];
  related: { label: string; href: string };
}) {
  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <LandingNav />

      <main className="flex-1">
        <header className="border-b border-line bg-canvas-alt">
          <div className="u-container py-14 sm:py-20 max-w-4xl">
            <span className="eyebrow">{eyebrow}</span>
            <h1 className="mt-3 text-4xl sm:text-5xl font-semibold leading-[1.1]">{title}</h1>
            <p className="mt-4 text-sm text-ink-3">Last updated {updated}</p>
            <div className="mt-6 max-w-2xl text-md leading-relaxed text-ink-2">{intro}</div>
          </div>
        </header>

        <div className="u-container py-12 sm:py-16 grid gap-12 lg:grid-cols-[14rem_minmax(0,1fr)] max-w-5xl">
          <nav aria-label="On this page" className="hidden lg:block">
            <div className="sticky top-24">
              <h2 className="eyebrow">On this page</h2>
              <ol className="mt-4 space-y-2 border-l border-line">
                {sections.map((s, i) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`} className="block -ml-px pl-4 border-l border-transparent text-ui text-ink-2 hover:text-ink hover:border-line-3 transition-colors">
                      {i + 1}. {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </nav>

          <article className="min-w-0 max-w-2xl space-y-10">
            {sections.map((s, i) => (
              <section key={s.id} id={s.id} className="scroll-mt-24">
                <h2 className="text-xl font-semibold text-ink">
                  {i + 1}. {s.title}
                </h2>
                <div className="mt-3 space-y-3 text-base leading-relaxed text-ink-2 [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2">
                  {s.body}
                </div>
              </section>
            ))}

            <p className="pt-8 border-t border-line text-ui text-ink-3">
              See also our{' '}
              <Link href={related.href} className="text-accent hover:underline">
                {related.label}
              </Link>
              .
            </p>
          </article>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
