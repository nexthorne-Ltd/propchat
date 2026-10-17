'use client';

import React, { useState } from 'react';
import { ChevronDown, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const FAQS = [
  {
    q: 'How do I install Zen-try on my website?',
    a: 'Simply paste a single `<script>` tag right before the closing `</body>` tag of your site. Zen-try works on WordPress, Shopify, Webflow, Squarespace, Framer, Next.js, and custom HTML.',
  },
  {
    q: 'How does AI Autopilot work?',
    a: 'AI Autopilot reads customer inquiries, checks previous resolution patterns and context, and drafts or sends automated high-quality responses 24/7. When a human agent steps in, the AI automatically yields control.',
  },
  {
    q: 'Will the chat widget slow down my website?',
    a: 'Not at all. The Zen-try widget is ultra-lightweight (<30KB), loads asynchronously, and runs inside an isolated Shadow DOM so it never blocks page rendering or conflicts with your site’s CSS.',
  },
  {
    q: 'Can multiple agents collaborate on the same inbox?',
    a: 'Yes. Your whole team works in one shared inbox, with collision detection so two people never answer the same customer, and round-robin assignment. How many seats you get depends on your plan; see the pricing page.',
  },
  {
    q: 'Can I customize the widget to match my brand?',
    a: 'Absolutely. You can customize your brand colors, workspace logo, custom greeting message, reply-time commitments, and launcher position directly from the settings dashboard.',
  },
  {
    q: 'Is there a free trial?',
    a: 'Yes. Every plan starts with a free trial and no credit card. When it ends, pick the plan that fits; your conversations, articles and settings stay where they are.',
  },
];

export function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="u-container py-20 sm:py-28 border-t border-line">
      <div className="max-w-2xl mx-auto text-center">
        <span className="eyebrow">Got Questions?</span>
        <h2 className="mt-3 text-3xl sm:text-5xl leading-[1.1] font-semibold text-ink">
          Frequently asked questions
        </h2>
        <p className="mt-4 text-md text-ink-2">
          Everything you need to know about setting up and running Zen-try.
        </p>
      </div>

      <div className="mt-12 max-w-2xl mx-auto space-y-3">
        {FAQS.map((faq, i) => {
          const isOpen = openIndex === i;
          return (
            <div
              key={faq.q}
              className={cn(
                'rounded-2xl border transition-all duration-150 overflow-hidden',
                isOpen
                  ? 'bg-surface border-line-2 shadow-xs'
                  : 'bg-surface/60 border-line hover:border-line-2'
              )}
            >
              <button
                type="button"
                onClick={() => setOpenIndex(isOpen ? null : i)}
                className="w-full p-5 text-left flex items-center justify-between gap-4 font-semibold text-md text-ink cursor-pointer"
              >
                <span className="flex items-center gap-2.5">
                  <HelpCircle className="w-4 h-4 text-accent shrink-0" />
                  {faq.q}
                </span>
                <ChevronDown
                  className={cn(
                    'w-4 h-4 text-ink-3 transition-transform duration-200 shrink-0',
                    isOpen && 'rotate-180 text-accent'
                  )}
                />
              </button>

              {isOpen && (
                <div className="px-5 pb-5 pt-1 text-ui leading-relaxed text-ink-2 border-t border-line/40 animate-in fade-in duration-150">
                  {faq.a}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
