'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ExternalLink,
  ImageUp,
  Monitor,
  Palette,
  RotateCcw,
  Smartphone,
  Type,
  LayoutTemplate,
  FileText,
  Code2,
  Sparkles,
} from 'lucide-react';
import type { Workspace } from '@/types/database';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';
import { uploadChatImage } from '@/lib/image-upload';
import { updateHelpCenterThemeAction } from '@/app/actions/admin';
import { PREVIEW_FRAME_NAME, PREVIEW_MESSAGE, PREVIEW_READY } from '@/components/help/HelpTheme';
import {
  HELP_FONTS,
  HELP_PRESETS,
  cleanHelpTheme,
  normalizeHex,
  presetTheme,
  resolveHelpTheme,
  type HelpFontId,
  type HelpPresetId,
  type HelpTheme,
} from '@/lib/help/theme';

/**
 * Settings → Help Center → Design: the help center's look, with the real
 * help center beside it as a live preview.
 *
 * The preview is the public page itself in an iframe (same origin, platform
 * path), so what the owner sees is exactly what visitors get. Unsaved changes
 * are posted into it (HelpTheme.tsx); nothing is stored until Save.
 */

type Section = 'theme' | 'colors' | 'hero' | 'type' | 'content' | 'article' | 'css';

/** Fields a preset sets. Choosing one keeps the owner's texts and toggles. */
const VISUAL_KEYS: (keyof HelpTheme)[] = [
  'header_bg',
  'hero_style',
  'hero_from',
  'hero_to',
  'body_mode',
  'page_bg',
  'card_bg',
  'font',
  'heading_font',
  'radius',
  'card_style',
];

function initialTheme(saved: unknown): HelpTheme {
  const cleaned = cleanHelpTheme(saved);
  const base = presetTheme(cleaned.preset ?? 'midnight');
  return { ...base, ...cleaned } as HelpTheme;
}

export function HelpCenterDesigner({
  workspace,
  onWorkspaceUpdated,
}: {
  workspace: Workspace;
  onWorkspaceUpdated?: (w: Workspace) => void;
}) {
  const savedTheme = useMemo(() => initialTheme(workspace.help_center_theme), [workspace.help_center_theme]);
  const [theme, setTheme] = useState<HelpTheme>(savedTheme);
  const [section, setSection] = useState<Section>('theme');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // A save (or another tab) changes the stored design: start from it again.
  const [shownSaved, setShownSaved] = useState(savedTheme);
  if (shownSaved !== savedTheme) {
    setShownSaved(savedTheme);
    setTheme(savedTheme);
  }

  const dirty = JSON.stringify(cleanHelpTheme(theme)) !== JSON.stringify(cleanHelpTheme(savedTheme));
  const resolved = useMemo(() => resolveHelpTheme(theme, workspace.brand_color), [theme, workspace.brand_color]);

  const set = useCallback(<K extends keyof HelpTheme>(key: K, value: HelpTheme[K]) => {
    setTheme((t) => ({ ...t, [key]: value }));
  }, []);

  const applyPreset = (id: HelpPresetId) => {
    const p = presetTheme(id);
    setTheme((t) => {
      const next = { ...t, preset: id };
      for (const k of VISUAL_KEYS) (next as Record<string, unknown>)[k] = p[k];
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await updateHelpCenterThemeAction(workspace.id, theme);
      if (res.workspace) onWorkspaceUpdated?.(res.workspace);
      setStatus({ kind: 'ok', text: 'Saved. Your help center now uses this design.' });
    } catch (e) {
      setStatus({ kind: 'error', text: errorMessage(e, 'Could not save the design.') });
    } finally {
      setSaving(false);
    }
  };

  /* ── Live preview ── */
  const frameRef = useRef<HTMLIFrameElement>(null);
  const themeRef = useRef(theme);
  const post = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: PREVIEW_MESSAGE, theme: themeRef.current }, window.location.origin);
  }, []);
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin === window.location.origin && e.source === frameRef.current?.contentWindow && e.data?.type === PREVIEW_READY) post();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [post]);
  useEffect(() => {
    themeRef.current = theme;
    post();
  }, [theme, post]);

  // The preview is always the platform path: a custom domain is another
  // origin, which could not receive the unsaved design.
  // ?hc_preview keeps the URL apart from /help/<id>, which browsers may have
  // cached as a permanent redirect to the custom domain.
  const previewSrc = `/help/${encodeURIComponent(workspace.id)}?hc_preview=1`;

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-5 border-b border-line">
        <div>
          <h3 className="text-md font-semibold text-ink flex items-center gap-2">
            <Palette className="w-4 h-4 text-accent" />
            Design
          </h3>
          <p className="text-xs text-ink-3">Colours, fonts, layout and what your help center shows. The preview updates as you go.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setTheme(savedTheme)}>
            <RotateCcw className="w-3.5 h-3.5" />
            Discard
          </Button>
          <Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={save}>
            {dirty ? 'Save design' : 'Saved'}
          </Button>
        </div>
      </header>

      {status && (
        <p
          role="status"
          className={cn(
            'px-5 py-2.5 text-xs border-b border-line',
            status.kind === 'ok' ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
          )}
        >
          {status.text}
        </p>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* Controls */}
        <div className="border-b xl:border-b-0 xl:border-r border-line">
          <div className="px-3 pt-3 overflow-x-auto">
            <Tabs<Section>
              label="Design sections"
              value={section}
              onChange={setSection}
              items={[
                { id: 'theme', label: 'Theme' },
                { id: 'colors', label: 'Colours' },
                { id: 'hero', label: 'Hero' },
                { id: 'type', label: 'Style' },
                { id: 'content', label: 'Home' },
                { id: 'article', label: 'Articles' },
                { id: 'css', label: 'CSS' },
              ]}
            />
          </div>

          <div className="p-5 space-y-5 max-h-[720px] overflow-y-auto">
            {section === 'theme' && (
              <div className="space-y-3">
                <SectionTitle icon={Sparkles} title="Start from a theme" hint="Pick one, then fine-tune anything. Your texts and options are kept." />
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-2 gap-3">
                  {HELP_PRESETS.map((p) => (
                    <PresetCard
                      key={p.id}
                      id={p.id}
                      name={p.name}
                      description={p.description}
                      brand={theme.accent || workspace.brand_color}
                      selected={theme.preset === p.id}
                      onSelect={() => applyPreset(p.id)}
                    />
                  ))}
                </div>
              </div>
            )}

            {section === 'colors' && (
              <div className="space-y-5">
                <SectionTitle icon={Palette} title="Colours" hint="Text colours are picked for you, so everything stays readable." />
                <ColorField
                  label="Accent (buttons, links)"
                  hint="Empty uses your brand colour."
                  value={theme.accent}
                  fallback={resolved.colors.accent}
                  onChange={(v) => set('accent', v)}
                />
                <ColorField
                  label="Header bar"
                  hint="Auto uses the theme's colour."
                  value={theme.header_bg}
                  fallback={resolved.colors.headerBg}
                  onChange={(v) => set('header_bg', v)}
                />
                <div>
                  <p className="field-label">Page</p>
                  <Segmented
                    value={theme.body_mode}
                    onChange={(v) => setTheme((t) => ({ ...t, body_mode: v, page_bg: '', card_bg: '' }))}
                    options={[
                      ['light', 'Light'],
                      ['dark', 'Dark'],
                    ]}
                  />
                </div>
                <ColorField label="Page background" value={theme.page_bg} fallback={resolved.colors.page} onChange={(v) => set('page_bg', v)} />
                <ColorField label="Cards" value={theme.card_bg} fallback={resolved.colors.card} onChange={(v) => set('card_bg', v)} />
              </div>
            )}

            {section === 'hero' && (
              <div className="space-y-5">
                <SectionTitle icon={LayoutTemplate} title="Hero" hint="The band with the title and the search box." />
                <div>
                  <p className="field-label">Background</p>
                  <Segmented
                    value={theme.hero_style}
                    onChange={(v) => set('hero_style', v)}
                    options={[
                      ['solid', 'Solid'],
                      ['gradient', 'Gradient'],
                      ['image', 'Image'],
                    ]}
                  />
                </div>
                <ColorField
                  label={theme.hero_style === 'gradient' ? 'Gradient start' : 'Colour'}
                  hint="Auto uses the theme's colour."
                  value={theme.hero_from}
                  fallback={resolved.colors.heroFrom}
                  onChange={(v) => set('hero_from', v)}
                />
                {theme.hero_style === 'gradient' && (
                  <ColorField
                    label="Gradient end"
                    hint="Auto uses the theme's colour."
                    value={theme.hero_to}
                    fallback={resolved.colors.heroTo}
                    onChange={(v) => set('hero_to', v)}
                  />
                )}
                {theme.hero_style === 'image' && (
                  <HeroImageField
                    value={theme.hero_image_url}
                    overlay={theme.hero_overlay}
                    onChange={(v) => set('hero_image_url', v)}
                    onOverlay={(v) => set('hero_overlay', v)}
                  />
                )}
                <div>
                  <p className="field-label">Text alignment</p>
                  <Segmented
                    value={theme.hero_align}
                    onChange={(v) => set('hero_align', v)}
                    options={[
                      ['left', 'Left'],
                      ['center', 'Centre'],
                    ]}
                  />
                </div>
                <TextField
                  label="Heading"
                  placeholder={workspace.help_center_title ? `Welcome to ${workspace.help_center_title}` : 'How can we help?'}
                  value={theme.hero_heading}
                  max={120}
                  onChange={(v) => set('hero_heading', v)}
                />
                <TextField
                  label="Subheading"
                  placeholder={workspace.help_center_subtitle || 'Search our articles or browse the collections below.'}
                  value={theme.hero_subheading}
                  max={240}
                  onChange={(v) => set('hero_subheading', v)}
                />
                <TextField
                  label="Search placeholder"
                  placeholder="Search for articles..."
                  value={theme.search_placeholder}
                  max={80}
                  onChange={(v) => set('search_placeholder', v)}
                />
              </div>
            )}

            {section === 'type' && (
              <div className="space-y-5">
                <SectionTitle icon={Type} title="Fonts and shape" />
                <FontField label="Body font" value={theme.font} onChange={(v) => set('font', v)} />
                <FontField label="Heading font" value={theme.heading_font} onChange={(v) => set('heading_font', v)} />
                <div>
                  <p className="field-label">Corners</p>
                  <Segmented
                    value={theme.radius}
                    onChange={(v) => set('radius', v)}
                    options={[
                      ['sharp', 'Sharp'],
                      ['soft', 'Soft'],
                      ['round', 'Round'],
                    ]}
                  />
                </div>
                <div>
                  <p className="field-label">Cards</p>
                  <Segmented
                    value={theme.card_style}
                    onChange={(v) => set('card_style', v)}
                    options={[
                      ['bordered', 'Bordered'],
                      ['elevated', 'Shadow'],
                      ['flat', 'Flat'],
                    ]}
                  />
                </div>
              </div>
            )}

            {section === 'content' && (
              <div className="space-y-4">
                <SectionTitle icon={LayoutTemplate} title="Home page" hint="Collection layout and order are set below and in Help Desk." />
                <Toggle label="Layout buttons for visitors" hint="Let readers switch between list and grid." checked={theme.show_layout_switcher} onChange={(v) => set('show_layout_switcher', v)} />
                <Toggle label="Collection numbers" hint="01, 02, 03 … on each collection." checked={theme.show_collection_numbers} onChange={(v) => set('show_collection_numbers', v)} />
                <Toggle label="Article counts" checked={theme.show_article_counts} onChange={(v) => set('show_article_counts', v)} />
                <Toggle label="Popular articles" hint="Your most viewed articles, under the collections." checked={theme.show_popular} onChange={(v) => set('show_popular', v)} />
                {theme.show_popular && (
                  <TextField label="Popular title" value={theme.popular_title} max={60} onChange={(v) => set('popular_title', v)} />
                )}
                <Toggle label="Contact card" hint="A “still need help?” card that opens the chat." checked={theme.show_contact} onChange={(v) => set('show_contact', v)} />
                {theme.show_contact && (
                  <>
                    <TextField label="Contact heading" value={theme.contact_heading} max={80} onChange={(v) => set('contact_heading', v)} />
                    <TextField label="Contact text" value={theme.contact_text} max={240} onChange={(v) => set('contact_text', v)} />
                    <TextField label="Button" value={theme.contact_button} max={40} onChange={(v) => set('contact_button', v)} />
                  </>
                )}
              </div>
            )}

            {section === 'article' && (
              <div className="space-y-4">
                <SectionTitle icon={FileText} title="Article pages" />
                <Toggle label="Author" checked={theme.show_author} onChange={(v) => set('show_author', v)} />
                <Toggle label="Last updated date" checked={theme.show_updated} onChange={(v) => set('show_updated', v)} />
                <Toggle label="Reading time" checked={theme.show_reading_time} onChange={(v) => set('show_reading_time', v)} />
                <Toggle label="“On this page” outline" hint="For articles with more than two headings." checked={theme.show_toc} onChange={(v) => set('show_toc', v)} />
                <Toggle label="“Did this help?” buttons" checked={theme.show_feedback} onChange={(v) => set('show_feedback', v)} />
                <Toggle label="Previous / next article" checked={theme.show_article_nav} onChange={(v) => set('show_article_nav', v)} />
                <Toggle label="Related articles" checked={theme.show_related} onChange={(v) => set('show_related', v)} />
              </div>
            )}

            {section === 'css' && (
              <div className="space-y-3">
                <SectionTitle
                  icon={Code2}
                  title="Custom CSS"
                  hint="For anything the options above do not cover. Target .hc-header, .hc-hero, .hc-card, .hc-btn, .hc-collection, .hc-article."
                />
                <textarea
                  value={theme.custom_css}
                  onChange={(e) => set('custom_css', e.target.value.slice(0, 8000))}
                  rows={12}
                  spellCheck={false}
                  placeholder={'.hc-hero h1 {\n  letter-spacing: -0.03em;\n}'}
                  aria-label="Custom CSS"
                  className="input textarea font-mono text-xs w-full"
                />
                <p className="text-2xs text-ink-3">{theme.custom_css.length} / 8000. Angle brackets and @import are removed when saved.</p>
              </div>
            )}
          </div>
        </div>

        {/* Preview */}
        <div className="bg-surface-2 p-4 sm:p-5 space-y-3 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <Segmented
              value={device}
              onChange={setDevice}
              options={[
                ['desktop', <span key="d" className="inline-flex items-center gap-1.5"><Monitor className="w-3.5 h-3.5" />Desktop</span>],
                ['mobile', <span key="m" className="inline-flex items-center gap-1.5"><Smartphone className="w-3.5 h-3.5" />Mobile</span>],
              ]}
            />
            <a href={previewSrc} target="_blank" rel="noreferrer" className="btn btn-xs btn-secondary gap-1">
              <ExternalLink className="w-3 h-3" />
              Open
            </a>
          </div>
          <PreviewFrame ref={frameRef} src={previewSrc} device={device} />
          <p className="text-2xs text-ink-3">
            Live preview of your real help center. Click around: collections and articles use the unsaved design too. Chat is off in the preview.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ── Preview frame ─────────────────────────────────────────────────────── */

const DESKTOP_WIDTH = 1280;
const FRAME_HEIGHT = 680;

/**
 * Desktop is rendered at a real desktop width and scaled down to fit, so the
 * layout in the preview is the desktop layout, not a squeezed mobile one.
 */
const PreviewFrame = React.forwardRef<HTMLIFrameElement, { src: string; device: 'desktop' | 'mobile' }>(function PreviewFrame(
  { src, device },
  ref
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const frameWidth = device === 'mobile' ? 390 : DESKTOP_WIDTH;
  const scale = width ? Math.min(1, width / frameWidth) : 1;

  return (
    <div ref={boxRef} className="w-full">
      <div
        className="mx-auto overflow-hidden rounded-xl border border-line bg-surface shadow-sm"
        style={{ width: frameWidth * scale, height: FRAME_HEIGHT }}
      >
        <iframe
          ref={ref}
          name={PREVIEW_FRAME_NAME}
          src={src}
          title="Help center preview"
          style={{
            width: frameWidth,
            height: FRAME_HEIGHT / scale,
            transform: `scale(${scale})`,
            transformOrigin: '0 0',
            border: 0,
            display: 'block',
          }}
        />
      </div>
    </div>
  );
});

/* ── Controls ──────────────────────────────────────────────────────────── */

function SectionTitle({ icon: Icon, title, hint }: { icon: React.ElementType; title: string; hint?: string }) {
  return (
    <div>
      <h4 className="text-ui font-semibold text-ink flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-ink-3" />
        {title}
      </h4>
      {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

function PresetCard({
  id,
  name,
  description,
  brand,
  selected,
  onSelect,
}: {
  id: HelpPresetId;
  name: string;
  description: string;
  brand?: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useMemo(() => resolveHelpTheme(presetTheme(id), brand), [id, brand]);
  const c = t.colors;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group text-left rounded-xl border overflow-hidden transition-all focus-visible:outline-2 focus-visible:outline-accent',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-line-3'
      )}
    >
      {/* A tiny drawing of the help center in this theme. */}
      <span className="block h-24 relative" style={{ background: c.page }} aria-hidden>
        <span className="block h-3.5" style={{ background: c.headerBg }} />
        <span className="flex flex-col justify-center gap-1 h-10 px-2.5" style={{ background: t.heroBackground }}>
          <span className="block h-1.5 w-1/2 rounded-full" style={{ background: c.heroFg, opacity: 0.9 }} />
          <span className="block h-2.5 w-4/5 rounded" style={{ background: c.card }} />
        </span>
        <span className="flex gap-1.5 px-2.5 pt-2">
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex-1 h-6 rounded border" style={{ background: c.card, borderColor: c.line }}>
              <span className="block m-1 w-2 h-2 rounded-sm" style={{ background: c.accent, opacity: 0.8 }} />
            </span>
          ))}
        </span>
        {selected && (
          <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-accent text-accent-ink grid place-items-center">
            <Check className="w-3 h-3" />
          </span>
        )}
      </span>
      <span className="block px-3 py-2 bg-surface">
        <span className="block text-ui font-semibold text-ink">{name}</span>
        <span className="block text-2xs text-ink-3 truncate">{description}</span>
      </span>
    </button>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, React.ReactNode][];
}) {
  return (
    <div className="inline-flex p-0.5 rounded-lg bg-surface-3 border border-line" role="group">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={cn(
            'px-3 h-7 rounded-md text-xs font-medium transition-colors',
            value === id ? 'bg-surface text-ink shadow-xs' : 'text-ink-3 hover:text-ink'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ColorField({
  label,
  hint,
  value,
  fallback,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  /** Shown in the swatch when the field is empty (automatic). */
  fallback: string;
  onChange: (v: string) => void;
}) {
  // Typing may pass through invalid hex; the box keeps it until it is valid.
  const [text, setText] = useState(value);
  const [shownValue, setShownValue] = useState(value);
  if (shownValue !== value) {
    setShownValue(value);
    setText(value);
  }
  const shown = normalizeHex(value) || fallback;
  const id = React.useId();

  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <label className="relative w-9 h-9 rounded-lg border border-line overflow-hidden shrink-0 cursor-pointer" style={{ background: shown }}>
          <span className="sr-only">Pick {label}</span>
          <input
            type="color"
            value={shown}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </label>
        <input
          id={id}
          value={text}
          placeholder={`Auto (${fallback})`}
          onChange={(e) => {
            setText(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex || e.target.value.trim() === '') onChange(hex);
          }}
          className="input input-sm font-mono flex-1 min-w-0"
          spellCheck={false}
        />
        {value && (
          <button type="button" onClick={() => onChange('')} className="text-xs text-ink-3 hover:text-ink shrink-0">
            Auto
          </button>
        )}
      </div>
      {hint && <p className="mt-1 text-2xs text-ink-3">{hint}</p>}
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  max,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  max: number;
  onChange: (v: string) => void;
}) {
  const id = React.useId();
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        value={value}
        maxLength={max}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="input input-sm w-full"
      />
    </div>
  );
}

function FontField({ label, value, onChange }: { label: string; value: HelpFontId; onChange: (v: HelpFontId) => void }) {
  const id = React.useId();
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as HelpFontId)} className="input input-sm select w-full">
        {(Object.keys(HELP_FONTS) as HelpFontId[]).map((f) => (
          <option key={f} value={f}>
            {HELP_FONTS[f].label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-ui font-medium text-ink">{label}</p>
        {hint && <p className="text-2xs text-ink-3">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
          checked ? 'bg-accent border-accent' : 'bg-surface-3 border-line'
        )}
      >
        <span className={cn('inline-block h-4 w-4 rounded-full bg-surface shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
      </button>
    </div>
  );
}

function HeroImageField({
  value,
  overlay,
  onChange,
  onOverlay,
}: {
  value: string;
  overlay: number;
  onChange: (v: string) => void;
  onOverlay: (v: number) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = React.useId();

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      onChange(await uploadChatImage(file));
    } catch (e) {
      setError(errorMessage(e, 'Upload failed.'));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={id} className="field-label">
          Image
        </label>
        <div className="flex items-center gap-2">
          <input
            id={id}
            value={value}
            placeholder="https://…"
            onChange={(e) => onChange(e.target.value.trim())}
            className="input input-sm flex-1 min-w-0"
          />
          <Button size="sm" variant="secondary" loading={uploading} onClick={() => fileRef.current?.click()}>
            <ImageUp className="w-3.5 h-3.5" />
            Upload
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </div>
        {error && <p className="mt-1 text-2xs text-danger">{error}</p>}
        {!error && value && !/^https:\/\//.test(value) && <p className="mt-1 text-2xs text-warn">Use an https:// address.</p>}
      </div>
      <div>
        <label className="field-label" htmlFor={`${id}-overlay`}>
          Darken image: {overlay}%
        </label>
        <input
          id={`${id}-overlay`}
          type="range"
          min={0}
          max={90}
          step={5}
          value={overlay}
          onChange={(e) => onOverlay(Number(e.target.value))}
          className="w-full accent-[var(--ds-accent)]"
        />
      </div>
    </div>
  );
}
