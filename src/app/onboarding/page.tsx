'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Send,
  Sparkles,
  BookOpen,
  Mail,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { createWorkspaceAction } from '@/app/actions/admin';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { Logo } from '@/components/ui/Logo';
import { cleanDomain, getDefaultSubdomain } from '@/lib/domain';
import { formatWorkspaceSlug } from '@/lib/slug';
import { INDUSTRY_PRESETS, getIndustryPreset } from '@/lib/onboarding-presets';
import { errorMessage } from '@/lib/errors/user-error';

const PRESET_COLORS = [
  { name: 'Electric Blue', hex: '#2e5bff' },
  { name: 'Deep Ink', hex: '#0b0b0f' },
  { name: 'Jade', hex: '#0f9d76' },
  { name: 'Violet', hex: '#7c5cff' },
  { name: 'Rose', hex: '#e11d48' },
  { name: 'Amber', hex: '#d97706' },
  ];

const STEP_LABELS = ['Business', 'Branding', 'Install'] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Form State
  const [businessName, setBusinessName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [industry, setIndustry] = useState<string>('generic');
  const [brandColor, setBrandColor] = useState('#2e5bff');
  const [greetingTitle, setGreetingTitle] = useState('Support Team');
  const [greetingMessage, setGreetingMessage] = useState(
    'We typically reply in under 5 minutes'
  );

  const handleSelectIndustry = (indId: string) => {
    setIndustry(indId);
    const preset = getIndustryPreset(indId);
    if (
      !greetingMessage ||
      greetingMessage === 'We typically reply in under 5 minutes' ||
      Object.values(INDUSTRY_PRESETS).some((p) => p.greetingPlaceholder === greetingMessage)
    ) {
      setGreetingMessage(preset.greetingPlaceholder);
    }
  };

  // Created Workspace State
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(null);

  // Email verification check
  const [emailUnconfirmed, setEmailUnconfirmed] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (resendCooldown > 0) {
      timer = setInterval(() => setResendCooldown((c) => c - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const verifyUserSession = async () => {
    setRefreshing(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      router.replace('/login');
      return;
    }
    setUserEmail(user.email || '');

    // Platform admins with no workspace belong in /admin, not workspace onboarding
    const { data: agentData } = await supabase
      .from('agents')
      .select('is_super_admin, workspace_id')
      .eq('id', user.id)
      .maybeSingle();

    if (agentData?.is_super_admin && !agentData.workspace_id) {
      router.replace('/admin');
      return;
    }

    const isConfirmed = Boolean(user.email_confirmed_at || (user as any).confirmed_at);
    setEmailUnconfirmed(!isConfirmed);
    setRefreshing(false);
  };

  // Check auth session
  useEffect(() => {
    verifyUserSession();
  }, [supabase, router]);

  const handleResendConfirmation = async () => {
    if (resendCooldown > 0 || resending || !userEmail) return;
    setResending(true);
    setResendSuccess(false);
    try {
      const origin =
        typeof window !== 'undefined'
          ? window.location.origin
          : (process.env.NEXT_PUBLIC_APP_URL || '');
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: userEmail,
        options: {
          emailRedirectTo: `${origin}/auth/callback?next=/onboarding`,
        },
      });
      if (error) throw error;
      setResendSuccess(true);
      setResendCooldown(30);
    } catch (err: any) {
      console.error('Error resending confirmation:', err);
      alert(errorMessage(err, 'Failed to resend confirmation email.'));
    } finally {
      setResending(false);
    }
  };

  const handleCreateWorkspace = async () => {
    if (emailUnconfirmed) {
      alert('Email verification required: Please verify your email before activating your workspace. Check your inbox for the verification link.');
      return;
    }

    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/login');
        return;
      }

      // Generate clean workspace slug (uniqueness enforced by server action)
      const slug = formatWorkspaceSlug(businessName || 'workspace') || 'workspace';
      const suggested = getDefaultSubdomain(websiteUrl);
      let customDomain =
        suggested && !suggested.includes('localhost') && !suggested.endsWith('.test')
          ? suggested
          : null;

      if (customDomain) {
        // public_workspaces: RLS hides other tenants' rows from `workspaces`.
        const { data: taken } = await supabase
          .from('public_workspaces')
          .select('id')
          .ilike('custom_domain', customDomain)
          .maybeSingle();
        if (taken) customDomain = null;
      }

      const verificationToken = `zentry_tok_${Math.random().toString(36).substring(2, 10)}`;

      // Create Workspace & Link Agent via Server Action
      const result = await createWorkspaceAction({
        businessName: businessName.trim() || 'My Workspace',
        websiteUrl: websiteUrl?.trim() || null,
        brandColor,
        greetingTitle,
        greetingMessage,
        slug,
        industry,
        customDomain,
        verificationToken,
      });

      if (!result.success || !result.workspace) {
        throw new Error('Failed to create workspace');
      }

      setCreatedWorkspaceId(result.workspace.id);
      setStep(3);
    } catch (err: any) {
      console.error('Error creating workspace:', err);
      alert(errorMessage(err, 'Failed to create workspace. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  const getEmbedSnippet = () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_APP_URL || '');
    return `<!-- Zen-try Live Chat Support -->
<script
  src="${origin}/widget.js"
  data-workspace-id="${createdWorkspaceId || 'YOUR_WORKSPACE_ID'}"
  defer>
</script>`;
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(getEmbedSnippet());
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <header className="border-b border-line">
        <div className="u-container h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center">
            <Logo size={32} />
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-6 py-12 sm:py-16">
        <div className="w-full max-w-3xl">
          {/* Stepper */}
          <div className="flex items-center gap-2 mb-10">
            {STEP_LABELS.map((label, i) => {
              const n = (i + 1) as 1 | 2 | 3;
              const done = step > n;
              const current = step === n;
              return (
                <React.Fragment key={label}>
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-2xs font-semibold transition-colors ${
                        done
                          ? 'bg-success text-ink-inv'
                          : current
                          ? 'bg-ink text-ink-inv'
                          : 'bg-surface-3 text-ink-3'
                      }`}
                    >
                      {done ? <Check className="w-3.5 h-3.5" /> : n}
                    </span>
                    <span
                      className={`text-ui font-medium ${
                        current ? 'text-ink' : 'text-ink-3'
                      }`}
                    >
                      {label}
                    </span>
                  </div>
                  {i < STEP_LABELS.length - 1 && (
                    <span
                      className={`flex-1 h-px ${
                        step > n ? 'bg-success' : 'bg-line-2'
                      }`}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Email verification requirement banner */}
          {emailUnconfirmed && (
            <div className="mb-6 rounded-2xl border border-warn/30 bg-warn/10 p-4 sm:p-5 text-ink animate-pop">
              <div className="flex items-start gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-warn/20 text-warn flex items-center justify-center shrink-0 mt-0.5">
                  <Mail className="w-5 h-5" />
                </div>
                <div className="space-y-1.5 flex-1 min-w-0">
                  <h2 className="text-md font-semibold text-ink flex items-center gap-2">
                    <span>Email verification required</span>
                    <span className="px-2 py-0.5 rounded-full text-2xs font-bold bg-warn/20 text-warn">
                      Pending
                    </span>
                  </h2>
                  <p className="text-ui text-ink-2 leading-relaxed">
                    Please confirm your email address <span className="font-semibold text-ink">{userEmail || 'in your inbox'}</span> before your workspace can become active.
                  </p>
                  <div className="pt-2 flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={handleResendConfirmation}
                      disabled={resendCooldown > 0 || resending}
                      className="btn btn-sm btn-secondary font-medium"
                    >
                      {resending ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          Sending…
                        </>
                      ) : resendCooldown > 0 ? (
                        `Resend in ${resendCooldown}s`
                      ) : (
                        'Resend confirmation email'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={verifyUserSession}
                      disabled={refreshing}
                      className="btn btn-sm btn-ghost text-ink-2 hover:text-ink font-medium"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                      Check status
                    </button>
                    {resendSuccess && (
                      <span className="text-xs text-success font-medium animate-fade-in">
                        Verification email sent!
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 1: Business Info */}
          {step === 1 && (
            <div className="animate-rise">
              <h1 className="text-3xl leading-tight font-semibold">
                Tell us about your business
              </h1>
              <p className="mt-2 text-sm text-ink-2">
                We&apos;ll provision a dedicated, isolated workspace for your
                conversations.
              </p>

              <div className="mt-8 card p-7 space-y-5">
                <div>
                  <label htmlFor="biz" className="field-label">
                    Company name <span className="text-danger">*</span>
                  </label>
                  <input
                    id="biz"
                    type="text"
                    required
                    placeholder="Lumen Outdoor Co."
                    value={businessName}
                    onChange={(e) => {
                      setBusinessName(e.target.value);
                      if (!greetingTitle || greetingTitle === 'Support Team') {
                        setGreetingTitle(`${e.target.value} Support`);
                      }
                    }}
                    className="input"
                  />
                </div>

                {/* Industry Selection */}
                <div>
                  <label className="field-label flex items-center justify-between">
                    <span>Industry &amp; Use Case</span>
                    <span className="text-2xs font-normal text-ink-3">Default: General</span>
                  </label>
                  <p className="text-xs text-ink-3 mb-3">
                    Tailors your help center blueprints, section icon presets, and conversation placeholders.
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                    {Object.values(INDUSTRY_PRESETS).map((p) => {
                      const isSelected = industry === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handleSelectIndustry(p.id)}
                          className={`flex items-center gap-2.5 p-3 rounded-xl border text-left transition-all ${
                            isSelected
                              ? 'border-accent bg-accent/10 text-accent font-semibold shadow-xs ring-1 ring-accent/30'
                              : 'border-line bg-surface hover:bg-surface-2 text-ink-2 hover:text-ink'
                          }`}
                        >
                          <span className="text-xl shrink-0 leading-none">{p.icon}</span>
                          <div className="min-w-0 flex-1">
                            <span className="text-ui block truncate">{p.label}</span>
                          </div>
                          {isSelected && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label htmlFor="site" className="field-label">
                    Website URL
                  </label>
                  <input
                    id="site"
                    type="url"
                    placeholder="https://lumenoutdoor.com"
                    value={websiteUrl}
                    onChange={(e) => setWebsiteUrl(e.target.value)}
                    className="input"
                  />
                  <p className="mt-1.5 text-xs text-ink-3">
                    Where the chat widget will live. You can change this later.
                  </p>

                  {websiteUrl && cleanDomain(websiteUrl) && (
                    <div className="mt-3.5 p-3.5 rounded-xl bg-accent-soft/40 border border-accent-line/60 flex items-center justify-between text-xs animate-in fade-in">
                      <div className="flex items-center gap-2.5">
                        <BookOpen className="w-4 h-4 text-accent shrink-0" />
                        <div>
                          <span className="text-2xs font-bold text-accent uppercase tracking-wider block">
                            Public Help Center Domain
                          </span>
                          <span className="font-mono text-xs text-ink font-semibold">
                            https://{getDefaultSubdomain(websiteUrl)}
                          </span>
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-2xs font-bold bg-accent/15 text-accent whitespace-nowrap">
                        Workspace Scoped
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  disabled={!businessName.trim()}
                  onClick={() => setStep(2)}
                  className="btn btn-lg btn-primary"
                >
                  Continue
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: Branding */}
          {step === 2 && (
            <div className="animate-rise">
              <h1 className="text-3xl leading-tight font-semibold">
                Make it look like you
              </h1>
              <p className="mt-2 text-sm text-ink-2">
                Everything below updates the preview in real time.
              </p>

              <div className="mt-8 grid md:grid-cols-[1fr_280px] gap-6 items-start">
                <div className="card p-7 space-y-6">
                  <div>
                    <span className="field-label">Brand colour</span>
                    <div className="flex items-center gap-2.5 flex-wrap">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c.hex}
                          type="button"
                          onClick={() => setBrandColor(c.hex)}
                          title={c.name}
                          aria-label={c.name}
                          aria-pressed={brandColor === c.hex}
                          className={`w-8 h-8 rounded-full flex items-center justify-center transition-transform duration-150 ${
                            brandColor === c.hex
                              ? 'ring-2 ring-offset-2 ring-ink ring-offset-[var(--ds-surface)]'
                              : 'hover:scale-110'
                          }`}
                          style={{ backgroundColor: c.hex }}
                        >
                          {brandColor === c.hex && (
                            <Check className="w-3.5 h-3.5 text-white" />
                          )}
                        </button>
                      ))}

                      <label className="flex items-center gap-2 h-9 px-2.5 rounded-lg border border-line-2 bg-surface-2 cursor-pointer">
                        <input
                          type="color"
                          value={brandColor}
                          onChange={(e) => setBrandColor(e.target.value)}
                          className="w-5 h-5 bg-transparent border-0 cursor-pointer rounded p-0"
                          aria-label="Custom brand colour"
                        />
                        <span className="font-mono text-xs text-ink-2 uppercase">
                          {brandColor}
                        </span>
                      </label>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="gt" className="field-label">
                      Messenger title
                    </label>
                    <input
                      id="gt"
                      type="text"
                      value={greetingTitle}
                      onChange={(e) => setGreetingTitle(e.target.value)}
                      className="input"
                    />
                  </div>

                  <div>
                    <label htmlFor="gm" className="field-label">
                      Subtitle
                    </label>
                    <input
                      id="gm"
                      type="text"
                      placeholder={getIndustryPreset(industry).greetingPlaceholder}
                      value={greetingMessage}
                      onChange={(e) => setGreetingMessage(e.target.value)}
                      className="input"
                    />
                  </div>
                </div>

                {/* Live preview */}
                <div className="panel p-4">
                  <div className="eyebrow mb-3 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3" />
                    Live preview
                  </div>

                  <div className="rounded-2xl border border-line bg-surface shadow-lg overflow-hidden">
                    <div
                      className="px-4 pt-4 pb-5 text-white"
                      style={{ backgroundColor: brandColor }}
                    >
                      <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold mb-2.5">
                        {greetingTitle.charAt(0) || 'S'}
                      </div>
                      <div className="text-sm font-semibold leading-tight truncate">
                        {greetingTitle || 'Support Team'}
                      </div>
                      <div className="text-2xs opacity-80 mt-0.5 line-clamp-2">
                        {greetingMessage}
                      </div>
                    </div>

                    <div className="p-3 space-y-2 min-h-[128px] flex flex-col justify-end">
                      <div className="self-start max-w-[85%] rounded-2xl rounded-bl-md bg-surface-2 border border-line px-3 py-2 text-xs leading-relaxed">
                        Hi! How can we help today?
                      </div>
                      <div
                        className="self-end max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 text-xs leading-relaxed text-white"
                        style={{ backgroundColor: brandColor }}
                      >
                        A question about your plans!
                      </div>
                    </div>

                    <div className="p-2.5 border-t border-line flex items-center gap-2">
                      <div className="flex-1 h-8 rounded-lg border border-line bg-surface-2 flex items-center px-2.5 text-2xs text-ink-3">
                        Type a message…
                      </div>
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0"
                        style={{ backgroundColor: brandColor }}
                      >
                        <Send className="w-3.5 h-3.5" />
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-xs text-ink-3">Launcher</span>
                    <div
                      className="w-12 h-12 rounded-full flex items-center justify-center p-2.5 shadow-lg transition-transform hover:scale-105"
                      style={{ backgroundColor: brandColor }}
                    >
                      <img
                        src="/chat-icon-white.png"
                        alt="Chat"
                        className="w-full h-full object-contain filter drop-shadow-sm"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="btn btn-ghost"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleCreateWorkspace}
                  className="btn btn-lg btn-primary"
                >
                  {loading ? (
                    <>
                      <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin-slow" />
                      Creating workspace…
                    </>
                  ) : (
                    <>
                      Create workspace
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: Install */}
          {step === 3 && (
            <div className="animate-rise">
              <div className="w-11 h-11 rounded-xl bg-success-soft border border-success-line text-success flex items-center justify-center">
                <Check className="w-5 h-5" />
              </div>
              <h1 className="mt-5 text-3xl leading-tight font-semibold">
                {businessName} is ready
              </h1>
              <p className="mt-2 text-sm text-ink-2 max-w-lg">
                Paste this snippet on your site — anywhere before the closing{' '}
                <code className="font-mono text-ui text-ink">
                  &lt;/body&gt;
                </code>{' '}
                tag — and live chat is on.
              </p>

              <div className="mt-8 card overflow-hidden">
                <div className="h-11 px-4 flex items-center justify-between border-b border-line bg-surface-2">
                  <span className="font-mono text-xs text-ink-3">
                    Embed code
                  </span>
                  <button
                    onClick={copyToClipboard}
                    className="btn btn-sm btn-secondary"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-success" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy
                      </>
                    )}
                  </button>
                </div>
                <pre className="code-block rounded-none border-0">
                  {getEmbedSnippet()}
                </pre>
              </div>

              <div className="mt-4 grid sm:grid-cols-3 gap-3">
                {[
                  {
                    h: 'WordPress',
                    b: 'Use any "Insert Headers and Footers" plugin, or your child theme\'s footer.php.',
                  },
                  {
                    h: 'Shopify',
                    b: 'Online Store → Themes → Edit code → paste before </body> in theme.liquid.',
                  },
                  {
                    h: 'Next.js / React',
                    b: 'Add a <Script src="…" /> tag inside your root layout.tsx.',
                  },
                ].map((c) => (
                  <div key={c.h} className="panel p-4">
                    <div className="text-ui font-semibold">{c.h}</div>
                    <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
                      {c.b}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-8 pt-6 border-t border-line flex flex-col sm:flex-row items-center justify-between gap-3">
                <a
                  href={`/demo.html?workspaceId=${createdWorkspaceId || ''}&name=${encodeURIComponent(businessName)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-secondary w-full sm:w-auto gap-2"
                >
                  <Sparkles className="w-4 h-4 text-accent" />
                  Send yourself a test chat
                </a>

                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="btn btn-lg btn-primary w-full sm:w-auto"
                >
                  Go to inbox
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
