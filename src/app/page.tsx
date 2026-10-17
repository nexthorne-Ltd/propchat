import Link from 'next/link';
import {
  ArrowRight,
  Blocks,
  Bot,
  Check,
  Code2,
  Fingerprint,
  Gauge,
  Layers,
  MousePointerClick,
  Palette,
  Radio,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';
import { ProductShowcase } from '@/components/marketing/ProductShowcase';
import { LandingNav } from '@/components/marketing/LandingNav';
import { MarketingFooter } from '@/components/marketing/MarketingFooter';
import { FaqSection } from '@/components/marketing/FaqSection';
import { PRODUCTION_APP_ORIGIN } from '@/lib/domain';

const PLATFORMS = [
  'WordPress',
  'Shopify',
  'Webflow',
  'Next.js',
  'Framer',
  'Squarespace',
  'Laravel',
  'Wix',
];

const STEPS = [
  {
    n: '01',
    title: 'Create your workspace',
    body: 'Name your business, add your site, pick a brand colour. Your agent profile is provisioned automatically.',
    detail: (
      <div className="space-y-1.5 font-mono text-2xs">
        <div className="flex justify-between">
          <span className="text-ink-3">workspace</span>
          <span className="text-ink">Lumen Outdoor Co.</span>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-3">owner</span>
          <span className="text-ink">priya@lumenoutdoor.com</span>
        </div>
      </div>
    ),
  },
  {
    n: '02',
    title: 'Make it look like you',
    body: 'Brand colour, greeting, reply-time promise and launcher position — all previewed live before you publish.',
    detail: (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-2xs">
          <span className="text-ink-3">Brand</span>
          <span className="flex items-center gap-1.5 font-mono text-ink">
            <span className="w-2.5 h-2.5 rounded-full bg-accent" />
            #2E5BFF
          </span>
        </div>
        <div className="flex items-center justify-between text-2xs">
          <span className="text-ink-3">Greeting</span>
          <span className="text-ink">Hi there 👋</span>
        </div>
      </div>
    ),
  },
  {
    n: '03',
    title: 'Paste one line, go live',
    body: 'Drop the script tag anywhere in your site. The launcher appears for every visitor, instantly.',
    detail: (
      <div className="font-mono text-2xs text-ink-2 truncate">
        &lt;script src=&quot;{PRODUCTION_APP_ORIGIN}/widget.js&quot; …&gt;
      </div>
    ),
  },
];

const FACTS = [
  { value: '1', label: 'line of code to install' },
  { value: '<1s', label: 'realtime message delivery' },
  { value: '100%', label: 'CSS-isolated via Shadow DOM' },
  { value: '24/7', label: 'AI answers from your help center' },
];

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      {/* ───────────────────────── Navigation ───────────────────────── */}
      <LandingNav />

      <main className="flex-1">
        {/* ───────────────────────── Hero ───────────────────────── */}
        <section className="relative aurora overflow-hidden">
          <div className="absolute inset-0 grid-lines pointer-events-none" />

          <div className="u-container relative pt-20 pb-16 sm:pt-28 sm:pb-20">
            {/* Side padding keeps the fixed chat launcher clear of the copy on tablet widths. */}
            <div className="max-w-3xl mx-auto text-center sm:px-14 lg:px-0">
              <a
                href="#product"
                className="animate-rise relative before:absolute before:inset-x-0 before:-inset-y-2 before:content-[''] inline-flex items-center gap-2 h-7 pl-1.5 pr-3 rounded-full border border-line bg-surface hover:border-accent shadow-xs text-xs font-medium text-ink-2 transition-all hover:scale-102"
              >
                <span className="inline-flex items-center h-5 px-2 rounded-full bg-accent text-white text-2xs font-bold tracking-wide">
                  NEW
                </span>
                Live visitor radar & AI Autopilot are live →
              </a>

              <h1 className="animate-rise delay-1 mt-7 text-[clamp(1.85rem,8.2vw,2.6rem)] leading-[1.08] sm:text-6xl sm:leading-[1.03] font-semibold text-ink text-balance">
                Live chat your customers
                <br className="hidden sm:block" />{' '}
                <span className="text-gradient whitespace-nowrap">actually want to use.</span>
              </h1>

              <p className="animate-rise delay-2 mt-6 mx-auto max-w-xl text-base leading-relaxed text-ink-2">
                See who&apos;s on your site right now, talk to them in one shared
                inbox, and answer before they leave. Add it to any website with a
                single line of code.
              </p>

              <div className="animate-rise delay-3 mt-9 mx-auto max-w-md">
                <form
                  action="/signup"
                  method="GET"
                  className="flex items-center gap-1.5 p-1.5 rounded-2xl border border-line-2 bg-surface shadow-md focus-within:border-accent focus-within:shadow-lg transition-all"
                >
                  <input
                    type="email"
                    name="email"
                    required
                    placeholder="you@company.com"
                    aria-label="Work email"
                    className="flex-1 min-w-0 h-11 bg-transparent px-3 text-base sm:text-sm text-ink placeholder:text-ink-3 focus:outline-none"
                  />
                  <button type="submit" className="btn btn-primary shrink-0 max-sm:h-11">
                    Start free
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </form>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-ink-3">
                  {['Free trial', 'No credit card', 'Live in 2 minutes'].map(
                    (t) => (
                      <span key={t} className="inline-flex items-center gap-1.5">
                        <Check className="w-3.5 h-3.5 text-success" />
                        {t}
                      </span>
                    )
                  )}
                </div>
              </div>
            </div>

            {/* Product visual */}
            <div className="animate-rise delay-4 mt-16 sm:mt-20 max-w-5xl mx-auto">
              <ProductShowcase />
            </div>
          </div>
        </section>

        {/* ───────────────────────── Platform strip ───────────────────────── */}
        <section className="border-y border-line bg-canvas-alt py-7 overflow-hidden">
          <p className="text-center eyebrow mb-5">
            Drops into any stack — no plugin required
          </p>
          <div
            className="relative flex overflow-hidden"
            style={{
              maskImage:
                'linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)',
              WebkitMaskImage:
                'linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)',
            }}
          >
            <div className="marquee-track flex shrink-0 items-center gap-12 pr-12">
              {[...PLATFORMS, ...PLATFORMS].map((p, i) => (
                <span
                  key={`${p}-${i}`}
                  className="text-lg font-semibold tracking-tight text-ink-3 whitespace-nowrap"
                >
                  {p}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ───────────────────────── Features (bento) ───────────────────────── */}
        <section id="product" className="u-container py-20 sm:py-28">
          <div className="max-w-2xl">
            <span className="eyebrow">The product</span>
            <h2 className="mt-3 text-3xl sm:text-5xl leading-[1.1] font-semibold">
              Everything a support team needs.
              <br />
              <span className="text-ink-3">Nothing it doesn&apos;t.</span>
            </h2>
          </div>

          <div className="mt-12 grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Hero cell: live visitors */}
            <div className="lg:col-span-2 card card-hover p-7 flex flex-col">
              <div className="flex items-start justify-between gap-4">
                <div className="max-w-md">
                  <div className="w-9 h-9 rounded-xl bg-accent-soft border border-accent-line text-accent flex items-center justify-center mb-4">
                    <Radio className="w-4.5 h-4.5" />
                  </div>
                  <h3 className="text-lg font-semibold">
                    Watch your site breathe
                  </h3>
                  <p className="mt-2 text-ui leading-relaxed text-ink-2">
                    Every visitor, live: the exact page they&apos;re reading, how
                    long they&apos;ve been there, their device and location.
                    Start the conversation before they bounce.
                  </p>
                </div>
                <span className="pill pill-success shrink-0">
                  <span className="live-dot" />
                  Realtime
                </span>
              </div>

              <div className="mt-6 grid sm:grid-cols-2 gap-2.5">
                {[
                  {
                    n: 'Maya C.',
                    url: '/products/summit-30l',
                    meta: 'Berlin · Chrome · 4m 12s',
                    live: true,
                  },
                  {
                    n: 'Anonymous',
                    url: '/checkout',
                    meta: 'Lahore · Safari · 47s',
                    live: true,
                  },
                ].map((v) => (
                  <div
                    key={v.url}
                    className="panel p-3 flex items-center gap-3"
                  >
                    <div className="w-8 h-8 rounded-full bg-surface border border-line flex items-center justify-center text-2xs font-semibold text-ink-2">
                      {v.n.charAt(0)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold truncate">
                          {v.n}
                        </span>
                        {v.live && <span className="live-dot" />}
                      </div>
                      <div className="text-2xs text-ink-3 truncate font-mono">
                        {v.url}
                      </div>
                    </div>
                    <span className="text-2xs text-ink-3 shrink-0 hidden sm:block">
                      {v.meta.split(' · ')[2]}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Widget preview cell */}
            <div className="card card-hover p-7 flex flex-col overflow-hidden">
              <div className="w-9 h-9 rounded-xl bg-accent-soft border border-accent-line text-accent flex items-center justify-center mb-4">
                <Palette className="w-4.5 h-4.5" />
              </div>
              <h3 className="text-lg font-semibold">Yours, not ours</h3>
              <p className="mt-2 text-ui leading-relaxed text-ink-2">
                Colour, copy, avatar and position — the messenger inherits your
                brand, not a vendor&apos;s.
              </p>

              <div className="mt-6 -mb-14 mx-auto w-[236px] rounded-2xl border border-line bg-surface shadow-lg overflow-hidden">
                <div className="px-4 pt-4 pb-5 bg-invert text-invert-ink">
                  <div className="w-7 h-7 rounded-full bg-white/15 flex items-center justify-center text-2xs font-bold mb-3">
                    L
                  </div>
                  <div className="text-md font-semibold">Hi there 👋</div>
                  <div className="text-2xs opacity-70 mt-0.5">
                    How can we help today?
                  </div>
                </div>
                <div className="p-3 space-y-2">
                  <div className="rounded-xl border border-line bg-surface-2 p-2.5">
                    <div className="text-xs font-semibold">
                      Send us a message
                    </div>
                    <div className="text-2xs text-ink-3 mt-0.5">
                      Typically replies in 5m
                    </div>
                  </div>
                  <div className="h-8 rounded-xl border border-line bg-surface-2 flex items-center px-2.5 text-2xs text-ink-3">
                    Search for help…
                  </div>
                </div>
              </div>
            </div>

            {/* Small cells */}
            <div className="card card-hover p-6 flex flex-col justify-between">
              <div>
                <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 text-accent flex items-center justify-center mb-4">
                  <Bot className="w-4.5 h-4.5" />
                </div>
                <h3 className="text-md font-semibold text-ink">AI Autopilot & Copilot</h3>
                <p className="mt-1.5 text-ui leading-relaxed text-ink-2">
                  Answer routine questions 24/7, draft contextual responses for agents, and summarize threads with one click.
                </p>
              </div>
              <div className="mt-4 pt-3 border-t border-line/60 flex items-center gap-1.5 text-2xs font-semibold text-accent">
                <Sparkles className="w-3 h-3" />
                <span>AI auto-reply & suggestions</span>
              </div>
            </div>

            {[
              {
                Icon: Zap,
                title: 'Sub-second delivery',
                body: 'Postgres change streams over WebSockets. Typing indicators and read receipts included.',
              },
              {
                Icon: ShieldCheck,
                title: 'Isolated & Secure',
                body: 'Row-level security scopes every conversation, and Shadow DOM prevents style collisions.',
              },
            ].map(({ Icon, title, body }) => (
              <div key={title} className="card card-hover p-6">
                <div className="w-9 h-9 rounded-xl bg-surface-2 border border-line text-ink-2 flex items-center justify-center mb-4">
                  <Icon className="w-4.5 h-4.5" />
                </div>
                <h3 className="text-md font-semibold">{title}</h3>
                <p className="mt-1.5 text-ui leading-relaxed text-ink-2">
                  {body}
                </p>
              </div>
            ))}

            {/* Wide cell: agent tooling */}
            <div className="lg:col-span-3 card card-hover p-7">
              <div className="grid lg:grid-cols-[1fr_auto] gap-8 items-center">
                <div className="max-w-lg">
                  <div className="w-9 h-9 rounded-xl bg-surface-2 border border-line text-ink-2 flex items-center justify-center mb-4">
                    <Blocks className="w-4.5 h-4.5" />
                  </div>
                  <h3 className="text-lg font-semibold">
                    Built for the person doing the replying
                  </h3>
                  <p className="mt-2 text-ui leading-relaxed text-ink-2">
                    Saved replies behind a <span className="kbd">/</span>{' '}
                    shortcut, private team notes the customer never sees,
                    priority and tags, assignment, and a CSAT rating collected
                    the moment you resolve.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 lg:justify-end">
                  {[
                    { l: 'Saved replies', I: Sparkles },
                    { l: 'Internal notes', I: Fingerprint },
                    { l: 'Priority & tags', I: MousePointerClick },
                    { l: 'CSAT ratings', I: Gauge },
                  ].map(({ l, I }) => (
                    <span
                      key={l}
                      className="inline-flex items-center gap-2 h-9 px-3.5 rounded-xl border border-line bg-surface-2 text-xs font-medium text-ink-2"
                    >
                      <I className="w-3.5 h-3.5 text-accent" />
                      {l}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ───────────────────────── How it works ───────────────────────── */}
        <section id="how" className="border-y border-line bg-canvas-alt">
          <div className="u-container py-20 sm:py-28">
            <div className="max-w-2xl">
              <span className="eyebrow">Setup</span>
              <h2 className="mt-3 text-3xl sm:text-5xl leading-[1.1] font-semibold">
                Three steps. About two minutes.
              </h2>
            </div>

            <div className="mt-12 grid md:grid-cols-3 gap-4">
              {STEPS.map((s) => (
                <div key={s.n} className="card p-6 flex flex-col min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-2xs font-semibold text-accent">
                      {s.n}
                    </span>
                    <span className="flex-1 hairline" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
                  <p className="mt-2 text-ui leading-relaxed text-ink-2 flex-1">
                    {s.body}
                  </p>
                  <div className="mt-5 panel p-3">{s.detail}</div>
                </div>
              ))}
            </div>

            <div className="mt-10">
              <Link href="/signup" className="btn btn-lg btn-primary">
                Create your workspace
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </section>

        {/* ───────────────────────── Install ───────────────────────── */}
        <section id="install" className="u-container py-20 sm:py-28">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <div>
              <span className="eyebrow">Install</span>
              <h2 className="mt-3 text-3xl sm:text-5xl leading-[1.1] font-semibold">
                One tag. Every page.
              </h2>
              <p className="mt-5 text-md leading-relaxed text-ink-2 max-w-md">
                No build step, no npm install, no framework lock-in. Paste it
                once before <code className="font-mono text-ui text-ink">&lt;/body&gt;</code>{' '}
                and the launcher is live for every visitor on the site.
              </p>

              <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-5 max-w-md">
                {FACTS.map((f) => (
                  <div key={f.label}>
                    <div className="text-2xl font-semibold tracking-tight text-ink">
                      {f.value}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-3 leading-snug">
                      {f.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="card overflow-hidden shadow-lg">
                <div className="h-11 px-4 flex items-center justify-between border-b border-line bg-surface-2">
                  <span className="font-mono text-xs text-ink-3">
                    index.html
                  </span>
                  <span className="pill pill-accent">
                    <Code2 className="w-3 h-3" />
                    Zero dependencies
                  </span>
                </div>
                <pre className="code-block rounded-none">{`<!-- Zen-try live chat -->
<script
  src="${PRODUCTION_APP_ORIGIN}/widget.js"
  data-workspace-id="YOUR_WORKSPACE_ID"
  defer
></script>`}</pre>
              </div>

              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                {['HTML', 'WordPress', 'Shopify', 'React'].map((p) => (
                  <div
                    key={p}
                    className="h-10 rounded-xl border border-line bg-surface-2 flex items-center justify-center text-xs font-medium text-ink-2"
                  >
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ───────────────────────── FAQ ───────────────────────── */}
        <FaqSection />

        {/* ───────────────────────── CTA ───────────────────────── */}
        <section className="u-container pb-24">
          <div className="relative overflow-hidden rounded-2xl bg-invert text-invert-ink px-8 py-16 sm:px-16 sm:py-20 text-center">
            <div
              className="absolute inset-0 opacity-[0.14] pointer-events-none"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 20% 0%, #2E5BFF, transparent 45%), radial-gradient(circle at 85% 100%, #7c5cff, transparent 45%)',
              }}
            />
            <div className="relative">
              <h2 className="text-3xl sm:text-5xl leading-[1.08] font-semibold text-invert-ink">
                Your next customer is
                <br className="hidden sm:block" /> on the site right now.
              </h2>
              <p className="mt-5 mx-auto max-w-md text-md leading-relaxed opacity-70">
                Set up a workspace, paste one line, and start the conversation
                before they close the tab.
              </p>
              <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link
                  href="/signup"
                  className="btn btn-lg bg-white text-[#0b0b0f] hover:bg-white/90 w-full sm:w-auto"
                >
                  Get started free
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <a
                  href="/demo.html"
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-lg bg-white/10 text-white hover:bg-white/[0.16] border-white/15 w-full sm:w-auto"
                >
                  Try the live demo
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
