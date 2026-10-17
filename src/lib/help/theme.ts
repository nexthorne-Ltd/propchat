/**
 * The public help center's look, as the workspace owner designs it in
 * Settings → Help Center → Design.
 *
 * Stored as `workspaces.help_center_theme` (JSONB) and read by the public
 * pages through `fn_help_center_theme`. Everything here is pure so the same
 * code resolves the theme on the help center, in the settings preview and in
 * tests.
 *
 * A theme is a preset plus overrides. Whatever was saved, `resolveHelpTheme`
 * returns a complete theme: unknown keys are dropped, colours that are not
 * #rrggbb fall back, and text colours are chosen for contrast so an owner
 * cannot make the hero or a button unreadable by picking a pale colour.
 */

export type HelpPresetId =
  | 'midnight'
  | 'daylight'
  | 'brand'
  | 'ocean'
  | 'aurora'
  | 'sunset'
  | 'forest'
  | 'graphite'
  | 'paper';

export type HelpFontId = 'inter' | 'jakarta' | 'dm' | 'manrope' | 'poppins' | 'lora' | 'system';
export type HelpHeroStyle = 'solid' | 'gradient' | 'image';
export type HelpRadius = 'sharp' | 'soft' | 'round';
export type HelpCardStyle = 'bordered' | 'elevated' | 'flat';
export type HelpBodyMode = 'light' | 'dark';

/** What the owner can set. Every field is optional in storage. */
export interface HelpTheme {
  preset: HelpPresetId;
  /** Buttons, links, highlights. Empty = the workspace brand colour. */
  accent: string;
  header_bg: string;
  hero_style: HelpHeroStyle;
  hero_from: string;
  hero_to: string;
  hero_image_url: string;
  /** Darkening over a hero image, 0–90 (%). */
  hero_overlay: number;
  hero_align: 'left' | 'center';
  body_mode: HelpBodyMode;
  page_bg: string;
  card_bg: string;
  font: HelpFontId;
  heading_font: HelpFontId;
  radius: HelpRadius;
  card_style: HelpCardStyle;

  hero_heading: string;
  hero_subheading: string;
  search_placeholder: string;

  show_popular: boolean;
  popular_title: string;
  show_layout_switcher: boolean;
  show_collection_numbers: boolean;
  show_article_counts: boolean;
  show_contact: boolean;
  contact_heading: string;
  contact_text: string;
  contact_button: string;

  show_author: boolean;
  show_reading_time: boolean;
  show_updated: boolean;
  show_toc: boolean;
  show_feedback: boolean;
  show_related: boolean;
  show_article_nav: boolean;

  custom_css: string;
}

export interface HelpPreset {
  id: HelpPresetId;
  name: string;
  description: string;
  theme: Partial<HelpTheme>;
}

const BASE: HelpTheme = {
  preset: 'midnight',
  accent: '',
  header_bg: '#0b0b0f',
  hero_style: 'solid',
  hero_from: '#0b0b0f',
  hero_to: '#1e1b4b',
  hero_image_url: '',
  hero_overlay: 55,
  hero_align: 'left',
  body_mode: 'light',
  page_bg: '',
  card_bg: '',
  font: 'inter',
  heading_font: 'inter',
  radius: 'round',
  card_style: 'bordered',

  hero_heading: '',
  hero_subheading: '',
  search_placeholder: '',

  show_popular: true,
  popular_title: 'Most viewed articles',
  show_layout_switcher: true,
  show_collection_numbers: false,
  show_article_counts: true,
  show_contact: true,
  contact_heading: 'Still need help?',
  contact_text: "Can't find what you're looking for? Our team usually replies within minutes.",
  contact_button: 'Chat with us',

  show_author: true,
  show_reading_time: true,
  show_updated: true,
  show_toc: true,
  show_feedback: true,
  show_related: true,
  show_article_nav: true,

  custom_css: '',
};

export const HELP_PRESETS: HelpPreset[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Dark header and hero, light pages',
    theme: { header_bg: '#0b0b0f', hero_style: 'solid', hero_from: '#0b0b0f', body_mode: 'light' },
  },
  {
    id: 'daylight',
    name: 'Daylight',
    description: 'All light, soft tinted hero',
    theme: { header_bg: '#ffffff', hero_style: 'gradient', hero_from: '#eef2ff', hero_to: '#ffffff', body_mode: 'light' },
  },
  {
    id: 'brand',
    name: 'Brand',
    description: 'Your brand colour across the top',
    // Empty colours here mean "use the accent" (see resolveHelpTheme).
    theme: { header_bg: '', hero_style: 'gradient', hero_from: '', hero_to: '', body_mode: 'light' },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Deep blue gradient',
    theme: { header_bg: '#0c1a33', hero_style: 'gradient', hero_from: '#0c1a33', hero_to: '#0e7490', body_mode: 'light' },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Violet to pink',
    theme: { header_bg: '#1e1b4b', hero_style: 'gradient', hero_from: '#312e81', hero_to: '#be185d', body_mode: 'light' },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm orange glow',
    theme: { header_bg: '#431407', hero_style: 'gradient', hero_from: '#9a3412', hero_to: '#db2777', body_mode: 'light' },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Calm greens',
    theme: { header_bg: '#052e16', hero_style: 'gradient', hero_from: '#14532d', hero_to: '#0f766e', body_mode: 'light' },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Fully dark',
    theme: { header_bg: '#0a0a0b', hero_style: 'solid', hero_from: '#0a0a0b', body_mode: 'dark' },
  },
  {
    id: 'paper',
    name: 'Paper',
    description: 'Minimal, editorial serif',
    theme: {
      header_bg: '#fbfaf7',
      hero_style: 'solid',
      hero_from: '#fbfaf7',
      body_mode: 'light',
      page_bg: '#fbfaf7',
      heading_font: 'lora',
      card_style: 'flat',
      radius: 'soft',
    },
  },
];

export const HELP_FONTS: Record<HelpFontId, { label: string; stack: string; google?: string }> = {
  inter: { label: 'Inter', stack: "'Inter', ui-sans-serif, system-ui, sans-serif", google: 'Inter:wght@400;500;600;700' },
  jakarta: {
    label: 'Plus Jakarta Sans',
    stack: "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif",
    google: 'Plus+Jakarta+Sans:wght@400;500;600;700',
  },
  dm: { label: 'DM Sans', stack: "'DM Sans', ui-sans-serif, system-ui, sans-serif", google: 'DM+Sans:wght@400;500;600;700' },
  manrope: { label: 'Manrope', stack: "'Manrope', ui-sans-serif, system-ui, sans-serif", google: 'Manrope:wght@400;500;600;700' },
  poppins: { label: 'Poppins', stack: "'Poppins', ui-sans-serif, system-ui, sans-serif", google: 'Poppins:wght@400;500;600;700' },
  lora: { label: 'Lora (serif)', stack: "'Lora', ui-serif, Georgia, serif", google: 'Lora:wght@400;500;600;700' },
  system: { label: 'System default', stack: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif' },
};

const PRESET_IDS = HELP_PRESETS.map((p) => p.id);
const FONT_IDS = Object.keys(HELP_FONTS) as HelpFontId[];

/* ── Colour helpers ─────────────────────────────────────────────────────── */

/** #abc / #aabbcc → #aabbcc (lower case), anything else → ''. */
export function normalizeHex(value: unknown): string {
  if (typeof value !== 'string') return '';
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return '';
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black-ish or white text, whichever reads better on `bg`. */
export function readableOn(bg: string): string {
  return contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#0b0b0f') ? '#ffffff' : '#0b0b0f';
}

/** Mixes `hex` toward `toward` by `amount` (0–1). */
export function mix(hex: string, toward: string, amount: number): string {
  const a = rgb(hex);
  const b = rgb(toward);
  return toHex([a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount]);
}

/**
 * The accent as used for links and buttons on the page background: darkened
 * (light pages) or lightened (dark pages) until it reaches 4.5:1, so a pale
 * brand colour still gives readable links.
 */
export function accentForText(accent: string, pageBg: string): string {
  let c = accent;
  const toward = luminance(pageBg) > 0.4 ? '#000000' : '#ffffff';
  for (let i = 0; i < 12 && contrastRatio(c, pageBg) < 4.5; i++) c = mix(c, toward, 0.12);
  return c;
}

/* ── Sanitising ─────────────────────────────────────────────────────────── */

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Only https images (or a site-relative path) may be a hero background. */
export function safeImageUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (/^https:\/\/[^\s"'()<>\\]+$/i.test(v) || /^\/[^\s"'()<>\\]*$/.test(v)) return v.slice(0, 500);
  return '';
}

/**
 * Owner CSS is placed in a <style> element. It cannot run script, but a
 * literal "</style" would end the element and let HTML through, so angle
 * brackets go; @import is dropped so the page does not load third-party
 * stylesheets the owner did not mean to.
 */
export function sanitizeCustomCss(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[<>]/g, '')
    .replace(/@import[^;]*;?/gi, '')
    .slice(0, 8000);
}

/**
 * What gets stored: the saved theme cleaned to known keys and valid values.
 * Used by the save action, so nothing unexpected reaches the database.
 */
export function cleanHelpTheme(raw: unknown): Partial<HelpTheme> {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Partial<HelpTheme> = {
    preset: oneOf(r.preset, PRESET_IDS, 'midnight'),
    accent: normalizeHex(r.accent),
    header_bg: normalizeHex(r.header_bg),
    hero_style: oneOf(r.hero_style, ['solid', 'gradient', 'image'] as const, BASE.hero_style),
    hero_from: normalizeHex(r.hero_from),
    hero_to: normalizeHex(r.hero_to),
    hero_image_url: safeImageUrl(r.hero_image_url),
    hero_overlay:
      typeof r.hero_overlay === 'number' && Number.isFinite(r.hero_overlay)
        ? Math.round(Math.max(0, Math.min(90, r.hero_overlay)))
        : BASE.hero_overlay,
    hero_align: oneOf(r.hero_align, ['left', 'center'] as const, BASE.hero_align),
    body_mode: oneOf(r.body_mode, ['light', 'dark'] as const, BASE.body_mode),
    page_bg: normalizeHex(r.page_bg),
    card_bg: normalizeHex(r.card_bg),
    font: oneOf(r.font, FONT_IDS, BASE.font),
    heading_font: oneOf(r.heading_font, FONT_IDS, BASE.heading_font),
    radius: oneOf(r.radius, ['sharp', 'soft', 'round'] as const, BASE.radius),
    card_style: oneOf(r.card_style, ['bordered', 'elevated', 'flat'] as const, BASE.card_style),

    hero_heading: text(r.hero_heading, 120),
    hero_subheading: text(r.hero_subheading, 240),
    search_placeholder: text(r.search_placeholder, 80),

    show_popular: bool(r.show_popular, BASE.show_popular),
    popular_title: text(r.popular_title, 60) || BASE.popular_title,
    show_layout_switcher: bool(r.show_layout_switcher, BASE.show_layout_switcher),
    show_collection_numbers: bool(r.show_collection_numbers, BASE.show_collection_numbers),
    show_article_counts: bool(r.show_article_counts, BASE.show_article_counts),
    show_contact: bool(r.show_contact, BASE.show_contact),
    contact_heading: text(r.contact_heading, 80) || BASE.contact_heading,
    contact_text: text(r.contact_text, 240) || BASE.contact_text,
    contact_button: text(r.contact_button, 40) || BASE.contact_button,

    show_author: bool(r.show_author, BASE.show_author),
    show_reading_time: bool(r.show_reading_time, BASE.show_reading_time),
    show_updated: bool(r.show_updated, BASE.show_updated),
    show_toc: bool(r.show_toc, BASE.show_toc),
    show_feedback: bool(r.show_feedback, BASE.show_feedback),
    show_related: bool(r.show_related, BASE.show_related),
    show_article_nav: bool(r.show_article_nav, BASE.show_article_nav),

    custom_css: sanitizeCustomCss(r.custom_css),
  };
  // Keys that were never saved stay unset, so the preset's value shows
  // through instead of the base default.
  for (const key of Object.keys(out) as (keyof HelpTheme)[]) {
    if (!(key in r)) delete out[key];
  }
  if (!('preset' in r)) out.preset = 'midnight';
  return out;
}

/** The starting point for a preset: what the designer shows after a click. */
export function presetTheme(id: HelpPresetId): HelpTheme {
  const preset = HELP_PRESETS.find((p) => p.id === id) ?? HELP_PRESETS[0];
  return { ...BASE, ...preset.theme, preset: preset.id };
}

/* ── Resolving ──────────────────────────────────────────────────────────── */

export interface ResolvedHelpTheme extends HelpTheme {
  /** Every colour the page uses, contrast-checked. */
  colors: {
    accent: string;
    accentText: string;
    onAccent: string;
    headerBg: string;
    headerFg: string;
    heroFg: string;
    heroFrom: string;
    heroTo: string;
    page: string;
    card: string;
    ink: string;
    ink2: string;
    ink3: string;
    line: string;
    hover: string;
  };
  /** CSS `background` for the hero. */
  heroBackground: string;
}

/**
 * The theme a page renders: preset defaults, then whatever the owner saved,
 * with colours filled in and made readable.
 */
export function resolveHelpTheme(saved: unknown, brandColor?: string | null): ResolvedHelpTheme {
  const cleaned = cleanHelpTheme(saved);
  const preset = HELP_PRESETS.find((p) => p.id === cleaned.preset) ?? HELP_PRESETS[0];
  // Saved empty strings mean "not set": they must not hide the preset value.
  const overrides = Object.fromEntries(Object.entries(cleaned).filter(([, v]) => v !== '')) as Partial<HelpTheme>;
  const t: HelpTheme = { ...BASE, ...preset.theme, ...overrides };

  const accent = normalizeHex(t.accent) || normalizeHex(brandColor) || '#2e5bff';
  const dark = t.body_mode === 'dark';

  const page = normalizeHex(t.page_bg) || (dark ? '#0d0d10' : '#f7f7f8');
  const card = normalizeHex(t.card_bg) || (dark ? mix(page, '#ffffff', 0.05) : '#ffffff');
  const pageDark = luminance(page) < 0.2;
  const ink = pageDark ? '#f4f4f5' : '#111114';
  const ink2 = pageDark ? '#c4c4cc' : '#3f3f46';
  const ink3 = pageDark ? '#9a9aa5' : '#6b6b76';
  const line = pageDark ? mix(page, '#ffffff', 0.12) : mix(page, '#000000', 0.09);
  const hover = pageDark ? mix(card, '#ffffff', 0.05) : mix(card, '#000000', 0.03);

  const headerBg = normalizeHex(t.header_bg) || accent;
  const heroFrom = normalizeHex(t.hero_from) || accent;
  const heroTo = normalizeHex(t.hero_to) || mix(heroFrom, '#000000', 0.35);

  let heroBackground: string;
  let heroFg: string;
  if (t.hero_style === 'image' && t.hero_image_url) {
    const a = (t.hero_overlay / 100).toFixed(2);
    heroBackground = `linear-gradient(rgba(0,0,0,${a}), rgba(0,0,0,${a})), url("${t.hero_image_url}") center / cover no-repeat, ${heroFrom}`;
    // An image under a light overlay can be anything; white text with a
    // shadow (see HELP_CSS) is the only safe choice.
    heroFg = '#ffffff';
  } else if (t.hero_style === 'gradient') {
    heroBackground = `linear-gradient(135deg, ${heroFrom} 0%, ${heroTo} 100%)`;
    // Text must read on both ends of the gradient.
    const midpoint = mix(heroFrom, heroTo, 0.5);
    heroFg = readableOn(midpoint);
  } else {
    heroBackground = heroFrom;
    heroFg = readableOn(heroFrom);
  }

  return {
    ...t,
    accent,
    colors: {
      accent,
      accentText: accentForText(accent, card),
      onAccent: readableOn(accent),
      headerBg,
      headerFg: readableOn(headerBg),
      heroFg,
      heroFrom,
      heroTo,
      page,
      card,
      ink,
      ink2,
      ink3,
      line,
      hover,
    },
    heroBackground,
  };
}

const RADII: Record<HelpRadius, [string, string]> = {
  sharp: ['4px', '3px'],
  soft: ['10px', '7px'],
  round: ['18px', '12px'],
};

/** CSS custom properties for the page root. */
export function helpThemeVars(t: ResolvedHelpTheme): Record<string, string> {
  const c = t.colors;
  const [radius, radiusSm] = RADII[t.radius];
  return {
    '--hc-accent': c.accent,
    '--hc-accent-text': c.accentText,
    '--hc-on-accent': c.onAccent,
    '--hc-header-bg': c.headerBg,
    '--hc-header-fg': c.headerFg,
    '--hc-hero-bg': t.heroBackground,
    '--hc-hero-fg': c.heroFg,
    '--hc-page': c.page,
    '--hc-card': c.card,
    '--hc-ink': c.ink,
    '--hc-ink-2': c.ink2,
    '--hc-ink-3': c.ink3,
    '--hc-line': c.line,
    '--hc-hover': c.hover,
    '--hc-radius': radius,
    '--hc-radius-sm': radiusSm,
    '--hc-font': HELP_FONTS[t.font].stack,
    '--hc-heading-font': HELP_FONTS[t.heading_font].stack,
    '--hc-card-shadow':
      t.card_style === 'elevated' ? '0 1px 2px rgba(0,0,0,.04), 0 8px 24px -12px rgba(0,0,0,.18)' : 'none',
    '--hc-card-border': t.card_style === 'flat' ? 'transparent' : c.line,
  };
}

/** One Google Fonts stylesheet for the body and heading fonts, if needed. */
export function helpFontsHref(t: Pick<HelpTheme, 'font' | 'heading_font'>): string | null {
  const families = Array.from(new Set([t.font, t.heading_font]))
    .map((f) => HELP_FONTS[f].google)
    .filter(Boolean);
  if (!families.length) return null;
  return `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join('&')}&display=swap`;
}
