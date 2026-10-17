'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Search,
  BookOpen,
  ArrowLeft,
  MessageCircle,
  FileText,
  ChevronRight,
  X,
  CornerDownLeft,
  LayoutGrid,
  Grid3X3,
  Columns4,
  Rows3,
  Clock,
  Sparkles,
  Globe,
  TrendingUp,
} from 'lucide-react';
import { HelpSection, Workspace } from '@/types/database';
import type { HelpListArticle, HelpSite } from '@/lib/help/data';
import { createClient } from '@/lib/supabase/client';
import { isPlatformHost } from '@/lib/domain';
import type { ResolvedHelpTheme } from '@/lib/help/theme';
import { HelpHeader, HelpFooter, HelpWidget, helpTitleOf, openChat, formatDate } from '@/components/help/HelpChrome';
import { HelpThemeRoot, useHelpTheme } from '@/components/help/HelpTheme';

/** Articles with no section still have to be reachable. */
const UNSORTED = '__unsorted__';

type ListArticle = HelpListArticle;
type Layout = 'grid-2' | 'grid-3' | 'grid-4' | 'list';

const LAYOUTS: Layout[] = ['grid-2', 'grid-3', 'grid-4', 'list'];
const NO_SECTIONS: HelpSection[] = [];
const NO_ARTICLES: ListArticle[] = [];

function plural(n: number, word: string) {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function PublicHelpCenterContent({ initial, workspaceKey }: { initial: HelpSite | null; workspaceKey: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workspaceId = initial?.workspace.id ?? workspaceKey;

  // Everything below comes from the server, cached (src/lib/help/data.ts):
  // the page draws at once instead of after a chain of browser queries.
  const workspace: Workspace | null = initial?.workspace ?? null;
  const sections: HelpSection[] = initial?.sections ?? NO_SECTIONS;
  const articles: ListArticle[] = initial?.articles ?? NO_ARTICLES;
  /** id → body text, fetched when a visitor first searches, so search can look inside articles. */
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const bodiesRequested = useRef(false);

  // An article page's search button lands here with ?q=.
  const [query, setQuery] = useState(() => searchParams?.get('q') || '');
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const changeQuery = useCallback((value: string) => {
    setQuery(value);
    setActiveIndex(0);
  }, []);

  const supabase = useMemo(() => createClient(), []);
  const { theme } = useHelpTheme(workspace, initial?.theme);

  // The open collection lives in the URL. Keeping it in component state alone
  // meant a collection could not be linked to and the browser's Back button
  // walked out of the help centre instead of back to the collection list.
  const openCollection = searchParams?.get('c') || null;

  const setOpenCollection = useCallback(
    (slug: string | null) => {
      const next = new URLSearchParams(Array.from(searchParams?.entries() || []));
      next.delete('q');
      if (slug) next.set('c', slug);
      else next.delete('c');
      const qs = next.toString();
      changeQuery('');
      router.push(qs ? `?${qs}` : '?', { scroll: true });
    },
    [router, searchParams, changeQuery]
  );

  // The owner's default layout, unless this visitor picked another one
  // (and the owner lets visitors choose).
  const [visitorLayout, setVisitorLayout] = useState<Layout | null>(() => {
    try {
      const saved = localStorage.getItem(`help_layout_${workspaceId}`) as Layout | null;
      return saved && LAYOUTS.includes(saved) ? saved : null;
    } catch {
      return null; // storage blocked (or server render): the owner's default
    }
  });
  const layout: Layout =
    (theme.show_layout_switcher && visitorLayout) || (workspace?.help_center_layout as Layout | null) || 'grid-3';

  const handleSetLayout = useCallback(
    (nextLayout: Layout) => {
      setVisitorLayout(nextLayout);
      try {
        localStorage.setItem(`help_layout_${workspaceId}`, nextLayout);
      } catch {
        /* not remembered, still applied */
      }
    },
    [workspaceId]
  );

  // Article bodies are only needed to search inside articles, so they are
  // fetched when someone first types, not with the page.
  useEffect(() => {
    if (!query.trim() || bodiesRequested.current || !workspace) return;
    bodiesRequested.current = true;
    supabase
      .from('articles')
      .select('id, content')
      .eq('workspace_id', workspace.id)
      .eq('status', 'published')
      .then(({ data, error }: { data: { id: string; content: string | null }[] | null; error: { message: string } | null }) => {
        if (error) {
          console.warn('[Help Center] search bodies:', error.message);
          bodiesRequested.current = false;
          return;
        }
        const map: Record<string, string> = {};
        for (const row of data ?? []) map[row.id] = (row.content || '').toLowerCase();
        setBodies(map);
      });
  }, [query, workspace, supabase]);

  const byCollection = useMemo(() => {
    const map: Record<string, ListArticle[]> = {};
    for (const a of articles) {
      const key = a.section_id || UNSORTED;
      (map[key] ||= []).push(a);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => {
        const ao = a.order_index ?? 0;
        const bo = b.order_index ?? 0;
        if (ao !== bo) return ao - bo;
        return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
      });
    }
    return map;
  }, [articles]);

  /**
   * Collections shown to visitors. Empty ones are hidden — an owner's
   * work-in-progress category reads as a broken link to a customer — and
   * articles that were never filed get a collection of their own instead of
   * silently disappearing from the site.
   */
  const collections = useMemo(() => {
    const sorted = [...sections].sort((a, b) => {
      const ao = a.order_index ?? 0;
      const bo = b.order_index ?? 0;
      if (ao !== bo) return ao - bo;
      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    });

    const list: Collection[] = sorted
      .filter((s) => (byCollection[s.id]?.length || 0) > 0)
      .map((s, idx) => ({
        key: s.id,
        slug: s.slug || s.id,
        name: s.name,
        description: s.description,
        icon: s.icon || '📘',
        number: String(idx + 1).padStart(2, '0'),
        articles: byCollection[s.id] || [],
      }));

    const unsorted = byCollection[UNSORTED] || [];
    if (unsorted.length) {
      list.push({
        key: UNSORTED,
        slug: UNSORTED,
        name: 'Other articles',
        description: null,
        icon: '📄',
        number: String(list.length + 1).padStart(2, '0'),
        articles: unsorted,
      });
    }
    return list;
  }, [sections, byCollection]);

  const collectionOf = useMemo(() => {
    const map: Record<string, Collection> = {};
    for (const c of collections) for (const a of c.articles) map[a.id] = c;
    return map;
  }, [collections]);

  const activeCollection = useMemo(
    () => collections.find((c) => c.slug === openCollection) || null,
    [collections, openCollection]
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored = articles
      .map((a) => {
        const title = a.title.toLowerCase();
        const summary = (a.summary || '').toLowerCase();
        // Title beats summary beats body, so the obvious answer comes first
        // instead of whichever article happened to be created last.
        let score = 0;
        if (title.startsWith(q)) score = 100;
        else if (title.includes(q)) score = 80;
        else if (summary.includes(q)) score = 50;
        else if (bodies[a.id]?.includes(q)) score = 20;
        return { article: a, score };
      })
      .filter((r) => r.score > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.map((r) => r.article);
  }, [articles, bodies, query]);


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

  const goToArticle = useCallback((a: { id: string; slug?: string | null }) => router.push(articleHref(a)), [articleHref, router]);

  // "/" focuses search from anywhere, Escape clears it, arrows walk results.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore the shortcut while typing, including inside the widget's
      // shadow root (composedPath sees through it).
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const typing = path.some((node) => {
        if (!(node instanceof Element)) return false;
        const tag = node.tagName.toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        return (node as HTMLElement).isContentEditable;
      });

      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (!query) return;
      if (e.key === 'Escape') {
        changeQuery('');
        searchRef.current?.blur();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && results[activeIndex]) {
        e.preventDefault();
        goToArticle(results[activeIndex]);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [query, results, activeIndex, goToArticle, changeQuery]);

  // Arrived from an article's search button: put the cursor in the box.
  useEffect(() => {
    if (searchParams?.get('focus') === 'search') searchRef.current?.focus();
  }, [searchParams]);

  const popularArticles = useMemo(() => {
    if (articles.length < 4) return [];
    return [...articles].sort((a, b) => (b.views_count || 0) - (a.views_count || 0)).slice(0, 6);
  }, [articles]);

  if (!workspace) {
    return (
      <div className="min-h-screen bg-canvas flex flex-col items-center justify-center p-6 text-center gap-3">
        <BookOpen className="w-10 h-10 text-ink-3" />
        <h1 className="text-xl font-semibold text-ink">Help Center not found</h1>
        <p className="text-sm text-ink-3 max-w-sm">This address doesn&apos;t match a published help centre.</p>
      </div>
    );
  }

  const title = helpTitleOf(workspace);
  const totalPublished = articles.length;
  const heading =
    theme.hero_heading || (workspace.help_center_title ? `Welcome to ${workspace.help_center_title}` : 'How can we help?');
  const subheading =
    theme.hero_subheading ||
    workspace.help_center_subtitle ||
    (totalPublished > 0
      ? `Search ${plural(totalPublished, 'article')} or browse the collections below.`
      : `Answers and resources from the ${title} team are on their way.`);
  const centered = theme.hero_align === 'center';

  return (
    <HelpThemeRoot theme={theme}>
      <HelpHeader workspace={workspace} onHome={() => setOpenCollection(null)} />

      {/* Inside a collection the hero shrinks to the search box, so the articles are in view. */}
      <section
        className={`hc-hero px-4 sm:px-6 ${activeCollection ? 'pt-8 pb-8' : 'pt-12 pb-14 sm:pt-16 sm:pb-20'}`}
        data-style={theme.hero_style}
      >
        <div className={`mx-auto max-w-3xl space-y-6 ${centered ? 'text-center' : ''}`}>
          {!activeCollection && (
            <div className="space-y-2.5">
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-tight">{heading}</h1>
              <p className="hc-hero-muted text-md leading-relaxed">{subheading}</p>
            </div>
          )}

          {totalPublished > 0 && (
            <div className="hc-search relative flex items-center text-left">
              <Search className="w-5 h-5 hc-muted absolute left-4 pointer-events-none" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => changeQuery(e.target.value)}
                placeholder={theme.search_placeholder || 'Search for articles...'}
                aria-label="Search help articles"
                className="w-full h-14 pl-12 pr-14 bg-transparent text-md outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => changeQuery('')}
                  aria-label="Clear search"
                  className="hc-row absolute right-3 w-8 h-8 grid place-items-center hc-muted cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              ) : (
                <kbd className="hc-chip absolute right-4 hidden sm:inline-flex font-mono text-2xs">/</kbd>
              )}
            </div>
          )}

          {totalPublished > 0 && !query && !activeCollection && popularArticles.length > 0 && (
            <div className={`flex flex-wrap items-center gap-2 text-ui ${centered ? 'justify-center' : ''}`}>
              <span className="hc-hero-muted">Popular:</span>
              {popularArticles.slice(0, 3).map((a) => (
                <a
                  key={a.id}
                  href={articleHref(a)}
                  onClick={(e) => {
                    e.preventDefault();
                    goToArticle(a);
                  }}
                  className="rounded-full px-3 py-1 font-medium transition-colors"
                  style={{
                    background: 'color-mix(in srgb, var(--hc-hero-fg) 12%, transparent)',
                    color: 'var(--hc-hero-fg)',
                  }}
                >
                  {a.title.length > 42 ? `${a.title.slice(0, 40)}…` : a.title}
                </a>
              ))}
            </div>
          )}
        </div>
      </section>

      <main className="flex-1 w-full mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-12">
        {totalPublished === 0 ? (
          <ComingSoon title={title} websiteUrl={workspace.website_url} />
        ) : query.trim() ? (
          <SearchResults
            query={query}
            results={results}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onSelect={goToArticle}
            href={articleHref}
            collectionOf={collectionOf}
          />
        ) : activeCollection ? (
          <CollectionView
            collection={activeCollection}
            collections={collections}
            theme={theme}
            onBack={() => setOpenCollection(null)}
            onOpen={setOpenCollection}
            onSelect={goToArticle}
            href={articleHref}
          />
        ) : (
          <div className="space-y-12">
            <CollectionGrid
              collections={collections}
              theme={theme}
              layout={layout}
              onSetLayout={handleSetLayout}
              onOpen={setOpenCollection}
              onSelect={goToArticle}
              href={articleHref}
            />

            {theme.show_popular && popularArticles.length > 0 && (
              <section className="space-y-4">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <TrendingUp className="w-5 h-5 hc-accent" />
                  {theme.popular_title}
                </h2>
                <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {popularArticles.map((a) => (
                    <li key={a.id}>
                      <a
                        href={articleHref(a)}
                        onClick={(e) => {
                          e.preventDefault();
                          goToArticle(a);
                        }}
                        className="hc-card hc-card-link group flex items-center gap-3 p-4"
                      >
                        <span className="hc-icon w-9 h-9">
                          <FileText className="w-4 h-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-ui font-semibold truncate">{a.title}</span>
                          {collectionOf[a.id] && (
                            <span className="block text-xs hc-muted truncate">{collectionOf[a.id].name}</span>
                          )}
                        </span>
                        <ChevronRight className="w-4 h-4 hc-muted shrink-0 transition-transform group-hover:translate-x-0.5" />
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {!query.trim() && theme.show_contact && totalPublished > 0 && <ContactCard theme={theme} />}
      </main>

      <HelpFooter workspace={workspace} />
      <HelpWidget workspace={workspace} color={theme.colors.accent} />
    </HelpThemeRoot>
  );
}

function HelpCenterLoadingSkeleton() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="h-16 bg-surface-2" />
      <div className="bg-surface-2/60 px-4 sm:px-6 pb-16 pt-14">
        <div className="mx-auto max-w-3xl space-y-5">
          <div className="h-9 w-2/3 rounded-lg bg-surface-3 animate-pulse" />
          <div className="h-5 w-1/2 rounded bg-surface-3 animate-pulse" />
          <div className="h-14 w-full rounded-xl bg-surface animate-pulse" />
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-40 rounded-2xl border border-line bg-surface animate-pulse" />
        ))}
      </div>
    </div>
  );
}

/** The help center home. useSearchParams needs a Suspense boundary. */
export function HelpHome({ initial, workspaceKey }: { initial: HelpSite | null; workspaceKey: string }) {
  return (
    <Suspense fallback={<HelpCenterLoadingSkeleton />}>
      <PublicHelpCenterContent initial={initial} workspaceKey={workspaceKey} />
    </Suspense>
  );
}

/* ── Blocks ───────────────────────────────────────────────────────────── */

interface Collection {
  key: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string;
  number: string;
  articles: ListArticle[];
}

function ComingSoon({ title, websiteUrl }: { title: string; websiteUrl?: string | null }) {
  return (
    <div className="max-w-xl mx-auto py-12 sm:py-16 text-center space-y-6">
      <span className="hc-icon w-16 h-16 mx-auto">
        <Sparkles className="w-8 h-8" />
      </span>
      <div className="space-y-2">
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Help Center coming soon</h2>
        <p className="text-sm hc-muted max-w-md mx-auto leading-relaxed">
          We&apos;re preparing guides, FAQs and step-by-step tutorials for {title}. Check back shortly.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={openChat} className="hc-btn h-10 px-5 text-ui cursor-pointer">
          <MessageCircle className="w-4 h-4" />
          Chat with our team
        </button>
        {websiteUrl && (
          <a
            href={websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`}
            target="_blank"
            rel="noreferrer"
            className="hc-btn-ghost h-10 px-5 text-ui"
          >
            <Globe className="w-4 h-4 hc-muted" />
            Visit website
          </a>
        )}
      </div>
      <p className="hc-chip text-xs mx-auto">
        <Clock className="w-3.5 h-3.5 hc-accent" />
        Articles go live here as soon as they are published.
      </p>
    </div>
  );
}

function ContactCard({ theme }: { theme: ResolvedHelpTheme }) {
  return (
    <section className="hc-card mt-14 p-8 sm:p-10 flex flex-col sm:flex-row items-start sm:items-center gap-5">
      <span className="hc-icon w-12 h-12">
        <MessageCircle className="w-6 h-6" />
      </span>
      <div className="flex-1 min-w-0">
        <h2 className="text-xl font-bold tracking-tight">{theme.contact_heading}</h2>
        <p className="mt-1 text-sm hc-muted leading-relaxed max-w-xl">{theme.contact_text}</p>
      </div>
      <button type="button" onClick={openChat} className="hc-btn h-11 px-6 text-sm shrink-0 cursor-pointer">
        <MessageCircle className="w-4 h-4" />
        {theme.contact_button}
      </button>
    </section>
  );
}

/** An emoji, or an image when the icon is a URL. */
function CollectionIcon({ icon, size = 'md' }: { icon?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'w-16 h-16 text-3xl' : size === 'sm' ? 'w-9 h-9 text-lg' : 'w-12 h-12 text-2xl';
  const img = size === 'lg' ? 'w-9 h-9' : size === 'sm' ? 'w-5 h-5' : 'w-7 h-7';
  const isImg = icon && /^(https?:\/\/|\/|data:image\/)/.test(icon);
  return (
    <span aria-hidden className={`hc-icon overflow-hidden select-none ${box}`}>
      {isImg ? <img src={icon} alt="" className={`object-contain ${img}`} /> : <span className="leading-none">{icon?.trim() || '📚'}</span>}
    </span>
  );
}

function LayoutSwitcher({ layout, onSetLayout }: { layout: Layout; onSetLayout: (l: Layout) => void }) {
  const options: [Layout, React.ElementType, string][] = [
    ['list', Rows3, 'List'],
    ['grid-2', LayoutGrid, '2 columns'],
    ['grid-3', Grid3X3, '3 columns'],
    ['grid-4', Columns4, '4 columns'],
  ];
  return (
    <div className="hc-card hidden sm:flex items-center gap-0.5 p-1" role="group" aria-label="Layout">
      {options.map(([id, Icon, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onSetLayout(id)}
          title={label}
          aria-label={label}
          aria-pressed={layout === id}
          data-active={layout === id}
          className="hc-row hc-nav-item p-1.5 hc-muted cursor-pointer"
        >
          <Icon className="w-4 h-4" />
        </button>
      ))}
    </div>
  );
}

function CollectionGrid({
  collections,
  theme,
  layout,
  onSetLayout,
  onOpen,
  onSelect,
  href,
}: {
  collections: Collection[];
  theme: ResolvedHelpTheme;
  layout: Layout;
  onSetLayout: (l: Layout) => void;
  onOpen: (slug: string) => void;
  onSelect: (a: ListArticle) => void;
  href: (a: ListArticle) => string;
}) {
  const grid =
    layout === 'list'
      ? 'grid-cols-1'
      : layout === 'grid-2'
      ? 'grid-cols-1 sm:grid-cols-2'
      : layout === 'grid-4'
      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
      : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
  const preview = layout === 'grid-4' ? 0 : layout === 'grid-3' ? 3 : 4;

  return (
    <section className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Browse by topic</h2>
          <p className="text-ui hc-muted">{plural(collections.length, 'collection')}</p>
        </div>
        {theme.show_layout_switcher && <LayoutSwitcher layout={layout} onSetLayout={onSetLayout} />}
      </div>

      <div className={`grid gap-4 ${grid}`}>
        {collections.map((c) => (
          <article key={c.key} className="hc-card hc-card-link hc-collection group flex flex-col overflow-hidden">
            <button
              type="button"
              onClick={() => onOpen(c.slug)}
              className={`w-full text-left p-5 sm:p-6 flex gap-4 cursor-pointer ${
                layout === 'list' ? 'items-center' : 'flex-col items-start'
              }`}
            >
              <CollectionIcon icon={c.icon} size={layout === 'grid-4' ? 'sm' : 'md'} />
              <span className="min-w-0 flex-1 block">
                <span className="flex items-center gap-2">
                  {theme.show_collection_numbers && <span className="hc-chip font-mono text-2xs">{c.number}</span>}
                  <span className="text-md font-semibold truncate">{c.name}</span>
                </span>
                {c.description && (
                  <span className={`mt-1 block text-ui hc-muted leading-relaxed ${layout === 'list' ? 'line-clamp-1' : 'line-clamp-2'}`}>
                    {c.description}
                  </span>
                )}
                {theme.show_article_counts && <span className="mt-2 block text-xs hc-muted">{plural(c.articles.length, 'article')}</span>}
              </span>
              {layout === 'list' && <ChevronRight className="w-5 h-5 hc-muted shrink-0 transition-transform group-hover:translate-x-1" />}
            </button>

            {preview > 0 && layout !== 'list' && (
              <ul className="border-t hc-line px-2 py-2">
                {c.articles.slice(0, preview).map((a) => (
                  <li key={a.id}>
                    <a
                      href={href(a)}
                      onClick={(e) => {
                        e.preventDefault();
                        onSelect(a);
                      }}
                      className="hc-row flex items-center gap-2.5 px-3 py-2 text-ui hc-ink2"
                    >
                      <FileText className="w-3.5 h-3.5 hc-muted shrink-0" />
                      <span className="truncate">{a.title}</span>
                    </a>
                  </li>
                ))}
                {c.articles.length > preview && (
                  <li>
                    <button
                      type="button"
                      onClick={() => onOpen(c.slug)}
                      className="hc-row w-full text-left px-3 py-2 text-ui font-medium hc-accent cursor-pointer"
                    >
                      View all {c.articles.length} →
                    </button>
                  </li>
                )}
              </ul>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function CollectionView({
  collection,
  collections,
  theme,
  onBack,
  onOpen,
  onSelect,
  href,
}: {
  collection: Collection;
  collections: Collection[];
  theme: ResolvedHelpTheme;
  onBack: () => void;
  onOpen: (slug: string) => void;
  onSelect: (a: ListArticle) => void;
  href: (a: ListArticle) => string;
}) {
  return (
    <div className="flex gap-10">
      {/* Every collection, so a reader can move sideways without going back. */}
      <aside className="hidden lg:block w-60 shrink-0">
        <nav className="sticky top-24 space-y-1" aria-label="Collections">
          <p className="px-3 pb-2 text-2xs font-semibold uppercase tracking-wider hc-muted">Collections</p>
          {collections.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => onOpen(c.slug)}
              data-active={c.key === collection.key}
              aria-current={c.key === collection.key ? 'page' : undefined}
              className="hc-row hc-nav-item w-full flex items-center gap-2.5 px-3 py-2 text-ui text-left hc-ink2 cursor-pointer"
            >
              <span className="w-5 text-center shrink-0">{/^(https?:|\/|data:)/.test(c.icon) ? '•' : c.icon}</span>
              <span className="truncate flex-1">{c.name}</span>
              {theme.show_article_counts && <span className="text-xs hc-muted">{c.articles.length}</span>}
            </button>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1 space-y-6">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-ui hc-muted">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 font-medium hc-accent hover:underline cursor-pointer">
            <ArrowLeft className="w-3.5 h-3.5" />
            All collections
          </button>
          <ChevronRight className="w-3.5 h-3.5 opacity-60" />
          <span className="font-medium hc-ink2 truncate">{collection.name}</span>
        </nav>

        <header className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <CollectionIcon icon={collection.icon} size="lg" />
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{collection.name}</h1>
            {collection.description && <p className="mt-1.5 text-md hc-ink2 leading-relaxed max-w-2xl">{collection.description}</p>}
            {theme.show_article_counts && <p className="mt-2 text-xs hc-muted">{plural(collection.articles.length, 'article')}</p>}
          </div>
        </header>

        <ol className="hc-card hc-divide overflow-hidden">
          {collection.articles.map((a, i) => (
            <li key={a.id}>
              <a
                href={href(a)}
                onClick={(e) => {
                  e.preventDefault();
                  onSelect(a);
                }}
                className="hc-article group flex items-start gap-4 p-5 transition-colors hover:bg-[var(--hc-hover)]"
              >
                <span className="hc-chip font-mono text-2xs mt-0.5 shrink-0">{String(i + 1).padStart(2, '0')}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-md font-semibold group-hover:underline decoration-[var(--hc-accent)] underline-offset-4">
                    {a.title}
                  </span>
                  {a.summary && <span className="mt-1 block text-ui hc-muted line-clamp-2 leading-relaxed">{a.summary}</span>}
                  {theme.show_updated && (
                    <span className="mt-2 block text-xs hc-muted">Updated {formatDate(a.updated_at || a.created_at)}</span>
                  )}
                </span>
                <ChevronRight className="w-4 h-4 hc-muted shrink-0 mt-1 transition-transform group-hover:translate-x-0.5" />
              </a>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* ── Search ───────────────────────────────────────────────────────────── */

function SearchResults({
  query,
  results,
  activeIndex,
  onHover,
  onSelect,
  href,
  collectionOf,
}: {
  query: string;
  results: ListArticle[];
  activeIndex: number;
  onHover: (i: number) => void;
  onSelect: (a: ListArticle) => void;
  href: (a: ListArticle) => string;
  collectionOf: Record<string, Collection>;
}) {
  if (results.length === 0) {
    return (
      <div className="hc-card max-w-2xl mx-auto p-12 text-center space-y-3">
        <span className="hc-icon w-12 h-12 mx-auto">
          <Search className="w-6 h-6" />
        </span>
        <h2 className="text-md font-semibold">No results for “{query}”</h2>
        <p className="text-ui hc-muted max-w-sm mx-auto">Try a shorter or different word, or ask our team directly.</p>
        <button type="button" onClick={openChat} className="hc-btn h-10 px-5 text-ui cursor-pointer">
          <MessageCircle className="w-4 h-4" />
          Ask our team
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-ui hc-muted">
          {plural(results.length, 'result')} for <span className="font-medium hc-ink2">“{query}”</span>
        </p>
        <p className="hidden sm:flex items-center gap-1.5 text-xs hc-muted">
          <CornerDownLeft className="w-3 h-3" /> to open
        </p>
      </div>

      <ul className="hc-card hc-divide overflow-hidden">
        {results.map((a, i) => (
          <li key={a.id}>
            <a
              href={href(a)}
              onMouseEnter={() => onHover(i)}
              onClick={(e) => {
                e.preventDefault();
                onSelect(a);
              }}
              data-active={i === activeIndex}
              className="flex items-start gap-3 p-4 sm:px-5 transition-colors hover:bg-[var(--hc-hover)] data-[active=true]:bg-[var(--hc-hover)]"
            >
              <FileText className="w-4 h-4 hc-muted shrink-0 mt-1" />
              <div className="min-w-0 flex-1">
                {collectionOf[a.id] && <p className="text-xs hc-muted mb-0.5">{collectionOf[a.id].name}</p>}
                <h3 className="text-sm font-semibold">
                  <Highlight text={a.title} query={query} />
                </h3>
                {a.summary && (
                  <p className="mt-0.5 text-ui hc-muted line-clamp-2">
                    <Highlight text={a.summary} query={query} />
                  </p>
                )}
              </div>
              <ChevronRight className="w-4 h-4 hc-muted shrink-0 mt-1" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Marks the matched span so it is obvious why a result was returned. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;

  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at === -1) return <>{text}</>;

  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold underline decoration-2 decoration-[var(--hc-accent)] underline-offset-2" style={{ color: 'inherit' }}>
        {text.slice(at, at + q.length)}
      </mark>
      {text.slice(at + q.length)}
    </>
  );
}
