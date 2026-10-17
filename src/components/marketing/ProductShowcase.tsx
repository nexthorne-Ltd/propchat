import React from 'react';
import {
  ArrowUpRight,
  CheckCheck,
  Inbox,
  Radio,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react';

/**
 * A static, pixel-faithful rendering of the real inbox — built from the same
 * design tokens as the product so it can never drift from what ships.
 * Purely presentational: no state, no data fetching.
 */

const THREADS = [
  {
    initial: 'M',
    name: 'Maya Chandra',
    snippet: 'Will the Ridgeline 2P tent reach Toronto by Saturday?',
    time: '2m',
    tint: 'var(--ds-accent)',
    live: true,
    unread: 2,
    active: true,
  },
  {
    initial: 'J',
    name: 'Jonas Weber',
    snippet: 'You: Your exchange for the size 10 boots ships today.',
    time: '14m',
    tint: '#7c5cff',
    live: true,
    unread: 0,
    active: false,
  },
  {
    initial: 'A',
    name: 'Amara Osei',
    snippet: 'Perfect, the tracking link works now. Thank you! 🙏',
    time: '1h',
    tint: '#0f9d76',
    live: false,
    unread: 0,
    active: false,
  },
  {
    initial: 'T',
    name: 'Tomás Rivera',
    snippet: 'Is the Summit 30L pack carry-on size for most airlines?',
    time: '3h',
    tint: '#d97706',
    live: false,
    unread: 0,
    active: false,
  },
];

const NAV = [
  { Icon: Inbox, label: 'Inbox', count: '12', active: true },
  { Icon: Radio, label: 'Live visitors', count: '38', active: false },
  { Icon: Sparkles, label: 'Reports', count: '', active: false },
  { Icon: Settings2, label: 'Settings', count: '', active: false },
];

function Bubble({
  side,
  children,
  meta,
}: {
  side: 'in' | 'out';
  children: React.ReactNode;
  meta?: React.ReactNode;
}) {
  const out = side === 'out';
  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[78%]">
        <div
          className={
            out
              ? 'rounded-2xl rounded-br-md bg-bubble-out text-bubble-out-ink px-3.5 py-2.5 text-xs leading-relaxed shadow-sm'
              : 'rounded-2xl rounded-bl-md bg-surface-2 border border-line px-3.5 py-2.5 text-xs leading-relaxed text-ink'
          }
        >
          {children}
        </div>
        {meta ? (
          <div
            className={`mt-1 flex items-center gap-1 text-2xs text-ink-3 ${
              out ? 'justify-end' : ''
            }`}
          >
            {meta}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ProductShowcase() {
  return (
    <div className="relative">
      {/* Window chrome */}
      <div className="rounded-2xl border border-line bg-surface shadow-xl overflow-hidden">
        <div className="h-10 flex items-center gap-2 px-4 border-b border-line bg-surface-2">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-line-3" />
            <span className="w-2.5 h-2.5 rounded-full bg-line-3" />
            <span className="w-2.5 h-2.5 rounded-full bg-line-3" />
          </div>
          <div className="flex-1 flex justify-center">
            <div className="px-3 py-1 rounded-md bg-surface border border-line text-2xs text-ink-3 font-mono">
              zen-try.site/dashboard
            </div>
          </div>
          <div className="w-14" />
        </div>

        <div className="flex h-[420px] text-left">
          {/* Rail */}
          <div className="hidden sm:flex w-[172px] flex-col border-r border-line bg-surface-2 p-3 gap-4">
            <div className="flex items-center gap-2 px-1">
              <div className="w-6 h-6 rounded-lg bg-ink text-ink-inv flex items-center justify-center text-2xs font-bold">
                L
              </div>
              <div className="min-w-0">
                <div className="text-2xs font-semibold text-ink truncate">
                  Lumen Outdoor Co.
                </div>
                <div className="text-2xs text-ink-3 truncate">
                  lumenoutdoor.com
                </div>
              </div>
            </div>

            <div className="space-y-0.5">
              {NAV.map(({ Icon, label, count, active }) => (
                <div
                  key={label}
                  className={`flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-medium ${
                    active
                      ? 'bg-surface text-ink shadow-xs border border-line'
                      : 'text-ink-2'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </span>
                  {count ? (
                    <span className="text-2xs text-ink-3">{count}</span>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-auto rounded-xl border border-line bg-surface p-2.5">
              <div className="flex items-center gap-1.5 text-2xs font-semibold text-success">
                <span className="live-dot" />
                38 online now
              </div>
              <div className="mt-1.5 flex items-end gap-[3px] h-6">
                {[40, 62, 48, 78, 56, 88, 70, 96].map((h, i) => (
                  <span
                    key={i}
                    className="flex-1 rounded-sm bg-accent/25"
                    style={{ height: `${h}%` }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Thread list */}
          <div className="w-[196px] shrink-0 border-r border-line flex flex-col">
            <div className="p-2.5 border-b border-line">
              <div className="flex items-center gap-1.5 h-7 px-2 rounded-lg bg-surface-2 border border-line text-2xs text-ink-3">
                <Search className="w-3 h-3" />
                Search conversations
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              {THREADS.map((t) => (
                <div
                  key={t.name}
                  className={`px-2.5 py-2.5 flex gap-2.5 border-b border-line/60 ${
                    t.active ? 'bg-accent-soft' : ''
                  }`}
                >
                  <div className="relative shrink-0">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-2xs font-semibold text-white"
                      style={{ background: t.tint }}
                    >
                      {t.initial}
                    </div>
                    {t.live && (
                      <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success ring-2 ring-surface" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="text-xs font-semibold text-ink truncate">
                        {t.name}
                      </span>
                      <span className="text-2xs text-ink-3 shrink-0">
                        {t.time}
                      </span>
                    </div>
                    <p className="text-2xs text-ink-2 truncate mt-0.5">
                      {t.snippet}
                    </p>
                  </div>
                  {t.unread > 0 && (
                    <span className="self-center shrink-0 min-w-[16px] h-4 px-1 rounded-full bg-accent text-white text-2xs font-bold flex items-center justify-center">
                      {t.unread}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Conversation */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="h-12 px-4 flex items-center justify-between border-b border-line">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-7 h-7 rounded-full bg-accent text-white flex items-center justify-center text-2xs font-semibold">
                  M
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-ink leading-tight">
                    Maya Chandra
                  </div>
                  <div className="text-2xs text-ink-3 flex items-center gap-1 truncate">
                    <span className="live-dot" />
                    Viewing /products/ridgeline-2p-tent
                  </div>
                </div>
              </div>
              <div className="hidden md:flex items-center gap-1.5">
                <span className="pill pill-warn">High</span>
                <span className="pill pill-success">Open</span>
              </div>
            </div>

            <div className="flex-1 p-4 space-y-3 overflow-hidden bg-canvas">
              <div className="flex justify-center">
                <span className="pill pill-neutral">Today · 09:14</span>
              </div>
              <Bubble side="in">
                Hi! If I order the Ridgeline 2P tent today, will it reach
                Toronto before Saturday?
              </Bubble>
              <Bubble
                side="out"
                meta={
                  <>
                    <span>09:15</span>
                    <CheckCheck className="w-3 h-3 text-accent" />
                  </>
                }
              >
                Yes — order before 3pm ET and pick{' '}
                <span className="font-semibold">Express</span> at checkout.
                It ships today and arrives Thursday.
              </Bubble>
              <Bubble side="in">Perfect, ordering now. Thank you! 🎉</Bubble>
              <div className="flex items-center gap-1.5 text-ink-3 pl-1">
                <span className="typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="text-2xs">Maya is typing…</span>
              </div>
            </div>

            <div className="p-3 border-t border-line">
              <div className="flex items-center gap-2 h-9 px-3 rounded-xl border border-line bg-surface-2 text-2xs text-ink-3">
                <span className="flex-1">Reply to Maya…</span>
                <span className="kbd">Enter</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Floating stat card — depth without a fake screenshot */}
      <div className="hidden lg:block absolute -left-8 bottom-14 card p-3.5 shadow-xl w-[186px] animate-rise delay-3">
        <div className="eyebrow mb-2">Median first reply</div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold tracking-tight text-ink">
            18s
          </span>
          <span className="inline-flex items-center gap-0.5 text-2xs font-semibold text-success">
            <ArrowUpRight className="w-3 h-3" />
            41%
          </span>
        </div>
        <div className="mt-2.5 flex items-end gap-[3px] h-8">
          {[30, 44, 38, 58, 50, 72, 66, 84, 78, 94].map((h, i) => (
            <span
              key={i}
              className="flex-1 rounded-sm"
              style={{
                height: `${h}%`,
                background:
                  i > 6 ? 'var(--ds-accent)' : 'var(--ds-line-3)',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
