'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Calendar,
  Clock,
  ThumbsUp,
  ThumbsDown,
  MessageCircle,
  Check,
  Link2,
  BookOpen,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  List,
  ChevronRight,
  FileText,
} from 'lucide-react';
import { Article, Workspace } from '@/types/database';
import type { HelpArticlePage, HelpSibling } from '@/lib/help/data';
import { Avatar } from '@/components/ui/Avatar';
import {
  MarkdownArticleContent,
  extractHeadings,
} from '@/components/dashboard/MarkdownArticleContent';
import { getWorkspaceHelpCenterUrl, isPlatformHost } from '@/lib/domain';
import {
  HelpHeader,
  HelpFooter,
  HelpWidget,
  openChat,
  copyText,
  readingTime,
  formatDate,
} from '@/components/help/HelpChrome';
import { HelpThemeRoot, useHelpTheme } from '@/components/help/HelpTheme';

type SiblingArticle = HelpSibling;

export interface HelpArticleInitial {
  workspace: Workspace;
  theme: Record<string, unknown>;
  page: HelpArticlePage | null;
}

/**
 * One help article. The server sends the workspace, design, article and its
 * collection with the page (src/lib/help/data.ts), cached, so the article is
 * in the HTML instead of appearing after a chain of browser queries.
 */
export function HelpArticle({ initial, workspaceKey }: { initial: HelpArticleInitial | null; workspaceKey: string }) {
  const router = useRouter();
  const workspaceId = initial?.workspace.id ?? workspaceKey;
  const workspace: Workspace | null = initial?.workspace ?? null;
  const article: Article | null = initial?.page?.article ?? null;
  const siblings: SiblingArticle[] = initial?.page?.siblings ?? [];
  const movedFrom = initial?.page?.movedFrom ?? null;

  const [vote, setVote] = useState<'helpful' | 'unhelpful' | null>(null);
  const [voteState, setVoteState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [copied, setCopied] = useState(false);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const bodyRef = useRef<HTMLDivElement>(null);
  const { theme, preview } = useHelpTheme(workspace, initial?.theme);

  // Found by an old slug or a near match: show the article's current address.
  useEffect(() => {
    if (movedFrom && workspace && article) window.history.replaceState(null, '', getWorkspaceHelpCenterUrl(workspace, article));
  }, [movedFrom, workspace, article]);

  // One view per article opened. The owner clicking around the settings
  // preview is not a reader.
  const articleIdForView = article?.id;
  useEffect(() => {
    if (!articleIdForView || preview) return;
    fetch('/api/help/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId: articleIdForView }),
    }).catch(() => {});
  }, [articleIdForView, preview]);

  const headings = useMemo(
    () => extractHeadings(article?.content || '').filter((h) => h.level <= 2),
    [article?.content]
  );
  const showToc = theme.show_toc && headings.length > 2;

  // Reading progress and the active outline entry, from one scroll listener.
  useEffect(() => {
    if (!article) return;

    function onScroll() {
      const el = bodyRef.current;
      if (!el) return;

      const start = el.offsetTop;
      const span = Math.max(1, el.offsetHeight - window.innerHeight * 0.4);
      const seen = window.scrollY - start;
      setProgress(Math.min(1, Math.max(0, seen / span)));

      let current: string | null = null;
      for (const h of headings) {
        const node = document.getElementById(h.id);
        if (node && node.getBoundingClientRect().top <= 120) current = h.id;
      }
      setActiveHeading(current);
    }

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [article, headings]);

  const homeHref = useCallback(() => {
    if (typeof window !== 'undefined') {
      const host = window.location.host.toLowerCase().split(':')[0];
      if (!isPlatformHost(host)) return '/';
    }
    return `/help/${workspace?.slug || workspaceId}`;
  }, [workspace, workspaceId]);

  const articleHref = useCallback(
    (a: { id: string; slug?: string | null }) => {
      const path = a.slug || a.id;
      if (typeof window !== 'undefined') {
        const host = window.location.host.toLowerCase().split(':')[0];
        if (!isPlatformHost(host)) return `/${path}`;
      }
      return `/help/${workspace?.slug || workspaceId}/${path}`;
    },
    [workspace, workspaceId]
  );

  const goHome = useCallback(() => router.push(homeHref()), [router, homeHref]);
  const goSearch = useCallback(() => router.push(`${homeHref()}?focus=search`), [router, homeHref]);

  const collectionHref = useMemo(() => {
    const slug = article?.section?.slug || article?.section_id;
    return slug ? `${homeHref()}?c=${encodeURIComponent(slug)}` : homeHref();
  }, [homeHref, article]);

  const handleShare = async () => {
    const ok = await copyText(getWorkspaceHelpCenterUrl(workspace, article));
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  const submitVote = async (isHelpful: boolean) => {
    if (!article || !workspace || voteState === 'sending') return;
    setVote(isHelpful ? 'helpful' : 'unhelpful');
    setVoteState('sending');
    if (preview) {
      // The owner trying the design out is not a reader's vote.
      setVoteState('done');
      return;
    }

    let visitorId = 'anon';
    try {
      visitorId = localStorage.getItem('zentry_vid') || localStorage.getItem('chatify_vid') || 'anon';
    } catch {
      /* storage blocked; an anonymous vote still counts */
    }

    try {
      const res = await fetch('/api/help/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          articleId: article.id,
          workspaceId: workspace.id,
          visitorId,
          isHelpful,
        }),
      });
      // Saying "thanks for your feedback" for a vote that never saved is worse
      // than admitting it failed — the reader would never think to try again.
      setVoteState(res.ok ? 'done' : 'error');
    } catch {
      setVoteState('error');
    }
  };

  if (!article || !workspace) {
    return (
      <div className="min-h-screen bg-canvas flex flex-col items-center justify-center p-6 text-center gap-3">
        <BookOpen className="w-10 h-10 text-ink-3" />
        <h1 className="text-xl font-semibold text-ink">Article not found</h1>
        <p className="text-sm text-ink-3 max-w-sm">It may have been moved, unpublished, or the link is out of date.</p>
        <button
          type="button"
          onClick={goHome}
          className="mt-1 h-9 px-4 rounded-lg border border-line bg-surface text-ui font-medium text-ink hover:bg-surface-2 transition-colors"
        >
          Back to Help Center
        </button>
      </div>
    );
  }

  const at = siblings.findIndex((s) => s.id === article.id);
  const prev = at > 0 ? siblings[at - 1] : null;
  const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : null;
  const related = siblings.filter((s) => s.id !== article.id).slice(0, 4);
  const showCollectionNav = siblings.length > 1;
  const meta = theme.show_author || theme.show_updated || theme.show_reading_time;

  const link = (a: SiblingArticle) => ({
    href: articleHref(a),
    onClick: (e: React.MouseEvent) => {
      e.preventDefault();
      router.push(articleHref(a));
    },
  });

  return (
    <HelpThemeRoot theme={theme}>
      <HelpHeader
        workspace={workspace}
        onHome={goHome}
        onSearch={goSearch}
        leading={
          <button
            type="button"
            onClick={goHome}
            aria-label="Back to Help Center"
            className="hc-header-link w-9 h-9 -ml-1.5 grid place-items-center shrink-0 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        }
        trailing={
          <button
            type="button"
            onClick={handleShare}
            className="hc-header-link inline-flex items-center gap-1.5 h-9 px-2.5 text-ui font-medium cursor-pointer"
          >
            {copied ? <Check className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
            <span className="hidden md:inline">{copied ? 'Link copied' : 'Share'}</span>
          </button>
        }
      />

      {/* How far through the article the reader is. */}
      <div
        className="hc-progress sticky top-16 z-30 h-0.5 origin-left transition-transform duration-75"
        style={{ transform: `scaleX(${progress})` }}
        aria-hidden
      />

      <div className="flex-1 w-full mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-10 flex gap-10">
        {/* The rest of this collection, so readers can move along a topic. */}
        {showCollectionNav && (
          <aside className="hidden lg:block w-60 shrink-0">
            <nav className="sticky top-24 space-y-1 max-h-[calc(100vh-8rem)] overflow-y-auto pr-1" aria-label={article.section?.name || 'Collection'}>
              <a
                href={collectionHref}
                onClick={(e) => {
                  e.preventDefault();
                  router.push(collectionHref);
                }}
                className="flex items-center gap-2 px-3 pb-2 text-2xs font-semibold uppercase tracking-wider hc-muted hover:underline"
              >
                <span className="normal-case text-sm">{article.section?.icon}</span>
                <span className="truncate">{article.section?.name || 'In this collection'}</span>
              </a>
              {siblings.map((s) => (
                <a
                  key={s.id}
                  {...link(s)}
                  data-active={s.id === article.id}
                  aria-current={s.id === article.id ? 'page' : undefined}
                  className="hc-row hc-nav-item block px-3 py-2 text-ui leading-snug hc-ink2"
                >
                  {s.title}
                </a>
              ))}
            </nav>
          </aside>
        )}

        <main className={`min-w-0 flex-1 max-w-3xl ${showCollectionNav || showToc ? '' : 'mx-auto'}`}>
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs hc-muted flex-wrap">
            <button type="button" onClick={goHome} className="hover:underline cursor-pointer font-medium">
              Help Center
            </button>
            {article.section && (
              <>
                <ChevronRight className="w-3 h-3 opacity-60" />
                <a
                  href={collectionHref}
                  onClick={(e) => {
                    e.preventDefault();
                    router.push(collectionHref);
                  }}
                  className="hover:underline font-medium"
                >
                  {article.section.name}
                </a>
              </>
            )}
          </nav>

          <header className="mt-4 pb-6 border-b hc-line space-y-3">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-[1.15]">{article.title}</h1>

            {article.summary && <p className="text-md hc-ink2 leading-relaxed">{article.summary}</p>}

            {meta && (
              <div className="flex items-center gap-x-4 gap-y-1.5 pt-1 text-xs hc-muted flex-wrap">
                {theme.show_author && (
                  <span className="flex items-center gap-2 min-w-0">
                    {article.author ? (
                      <>
                        <Avatar name={article.author.name} seed={article.author.id} size="sm" className="w-6 h-6 shrink-0 text-2xs" />
                        <span className="hc-ink2 font-medium">{article.author.name}</span>
                      </>
                    ) : (
                      <>
                        {/* shrink-0: without it the flex row squeezes the badge
                            under the name and the two render on top of each other. */}
                        <span className="hc-btn w-6 h-6 shrink-0 text-2xs" style={{ borderRadius: 999 }}>{workspace.name.slice(0, 1).toUpperCase()}</span>
                        <span className="hc-ink2 font-medium">{workspace.name} team</span>
                      </>
                    )}
                  </span>
                )}
                {theme.show_updated && (
                  <span className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    Updated {formatDate(article.updated_at || article.created_at)}
                  </span>
                )}
                {theme.show_reading_time && (
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" />
                    {readingTime(article.content)}
                  </span>
                )}
              </div>
            )}
          </header>

          {/* Outline on narrow screens, where the sidebar is hidden. */}
          {showToc && (
            <details className="xl:hidden mt-6 hc-card overflow-hidden">
              <summary className="px-4 py-3 text-ui font-medium cursor-pointer flex items-center gap-2 select-none">
                <List className="w-3.5 h-3.5 hc-muted" />
                On this page
              </summary>
              <ul className="px-4 pb-3 space-y-1.5">
                {headings.map((h) => (
                  <li key={h.id} className={h.level === 2 ? 'pl-3' : ''}>
                    <a href={`#${h.id}`} className="text-ui hc-ink2 hover:underline">
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div ref={bodyRef} className="hc-article-body mt-7 text-md leading-[1.75]">
            <MarkdownArticleContent content={article.content} />
          </div>

          {theme.show_feedback && (
            <section className="hc-card mt-12 p-6 text-center">
              {voteState === 'done' ? (
                <p className="flex items-center justify-center gap-2 text-ui font-medium text-success">
                  <CheckCircle2 className="w-4 h-4" />
                  {vote === 'helpful' ? 'Thanks — glad this helped.' : "Thanks — we'll make this clearer."}
                </p>
              ) : voteState === 'error' ? (
                <div className="space-y-2">
                  <p className="flex items-center justify-center gap-2 text-ui font-medium text-warn">
                    <AlertCircle className="w-4 h-4" />
                    We couldn&apos;t record that just now.
                  </p>
                  <button
                    type="button"
                    onClick={() => submitVote(vote === 'helpful')}
                    className="text-ui font-medium underline underline-offset-2 hover:no-underline cursor-pointer"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-sm font-semibold">Did this answer your question?</p>
                  <div className="mt-3.5 flex items-center justify-center gap-2.5">
                    <button
                      type="button"
                      disabled={voteState === 'sending'}
                      onClick={() => submitVote(true)}
                      className="hc-btn-ghost h-10 px-5 text-ui disabled:opacity-60 cursor-pointer"
                    >
                      <ThumbsUp className="w-4 h-4 text-success" />
                      Yes
                    </button>
                    <button
                      type="button"
                      disabled={voteState === 'sending'}
                      onClick={() => submitVote(false)}
                      className="hc-btn-ghost h-10 px-5 text-ui disabled:opacity-60 cursor-pointer"
                    >
                      <ThumbsDown className="w-4 h-4 text-danger" />
                      No
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {theme.show_article_nav && (prev || next) && (
            <nav className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3" aria-label="Previous and next article">
              {prev ? (
                <a {...link(prev)} className="hc-card hc-card-link group p-4">
                  <span className="flex items-center gap-1.5 text-xs hc-muted">
                    <ArrowLeft className="w-3 h-3 transition-transform group-hover:-translate-x-0.5" />
                    Previous
                  </span>
                  <span className="mt-1 block text-ui font-semibold line-clamp-2">{prev.title}</span>
                </a>
              ) : (
                <span className="hidden sm:block" />
              )}
              {next && (
                <a {...link(next)} className="hc-card hc-card-link group p-4 sm:text-right">
                  <span className="flex items-center gap-1.5 text-xs hc-muted sm:justify-end">
                    Next
                    <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-1 block text-ui font-semibold line-clamp-2">{next.title}</span>
                </a>
              )}
            </nav>
          )}

          {theme.show_related && related.length > 0 && (
            <section className="mt-10 pt-8 border-t hc-line">
              <h2 className="text-md font-semibold">Related articles</h2>
              <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {related.map((r) => (
                  <li key={r.id}>
                    <a {...link(r)} className="hc-card hc-card-link group flex items-start gap-3 p-4">
                      <FileText className="w-4 h-4 hc-muted shrink-0 mt-0.5" />
                      <span className="min-w-0">
                        <span className="block text-ui font-semibold line-clamp-1">{r.title}</span>
                        {r.summary && <span className="mt-0.5 block text-xs hc-muted line-clamp-1">{r.summary}</span>}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {theme.show_contact && (
            <section className="hc-card mt-10 p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <span className="hc-icon w-10 h-10">
                <MessageCircle className="w-5 h-5" />
              </span>
              <div className="flex-1 min-w-0">
                <h2 className="text-md font-semibold">{theme.contact_heading}</h2>
                <p className="mt-0.5 text-ui hc-muted">{theme.contact_text}</p>
              </div>
              <button type="button" onClick={openChat} className="hc-btn h-10 px-5 text-ui shrink-0 cursor-pointer">
                {theme.contact_button}
              </button>
            </section>
          )}
        </main>

        {showToc && (
          <aside className="hidden xl:block w-56 shrink-0">
            <nav className="hc-toc sticky top-24" aria-label="On this page">
              <p className="text-2xs font-semibold uppercase tracking-wider hc-muted">On this page</p>
              <ul className="mt-3 space-y-1 border-l hc-line">
                {headings.map((h) => (
                  <li key={h.id}>
                    <a
                      href={`#${h.id}`}
                      data-active={activeHeading === h.id}
                      className={`block border-l-2 border-transparent -ml-px py-1 text-xs leading-snug hc-muted hover:text-[var(--hc-ink)] transition-colors ${
                        h.level === 2 ? 'pl-6' : 'pl-3'
                      }`}
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        )}
      </div>

      <HelpFooter workspace={workspace} />
      <HelpWidget workspace={workspace} color={theme.colors.accent} />
    </HelpThemeRoot>
  );
}
