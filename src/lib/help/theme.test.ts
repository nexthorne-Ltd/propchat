/**
 * Help center design: whatever an owner saves, the page gets a complete,
 * readable theme, and nothing unsafe reaches the page.
 */
import { describe, expect, it } from 'vitest';
import {
  HELP_PRESETS,
  cleanHelpTheme,
  contrastRatio,
  helpFontsHref,
  helpThemeVars,
  presetTheme,
  resolveHelpTheme,
  safeImageUrl,
  sanitizeCustomCss,
} from './theme';

describe('resolving a saved design', () => {
  it('an empty design is the Midnight preset in the brand colour', () => {
    const t = resolveHelpTheme({}, '#7c3aed');
    expect(t.preset).toBe('midnight');
    expect(t.colors.accent).toBe('#7c3aed');
    expect(t.colors.headerBg).toBe('#0b0b0f');
    expect(t.colors.headerFg).toBe('#ffffff');
  });

  it('a saved field overrides the preset; an unset one keeps it', () => {
    const t = resolveHelpTheme({ preset: 'paper', accent: '#ff0000' });
    expect(t.colors.accent).toBe('#ff0000');
    expect(t.heading_font).toBe('lora');
    expect(t.card_style).toBe('flat');
  });

  it('"auto" (empty) colours fall back to the preset, not to blank', () => {
    const t = resolveHelpTheme({ preset: 'ocean', header_bg: '', hero_from: '' });
    expect(t.colors.headerBg).toBe('#0c1a33');
    expect(t.heroBackground).toContain('#0c1a33');
  });

  it('the Brand preset paints the top in the accent', () => {
    const t = resolveHelpTheme({ preset: 'brand' }, '#16a34a');
    expect(t.colors.headerBg).toBe('#16a34a');
    expect(t.heroBackground).toContain('#16a34a');
  });

  it.each(HELP_PRESETS.map((p) => p.id))('%s keeps every text readable', (id) => {
    for (const brand of ['#2e5bff', '#facc15', '#ffffff', '#111111']) {
      const c = resolveHelpTheme(presetTheme(id), brand).colors;
      expect(contrastRatio(c.headerFg, c.headerBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.onAccent, c.accent)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(c.ink, c.card)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(c.ink3, c.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.accentText, c.card)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('a pale accent is darkened for links, not used as is', () => {
    const t = resolveHelpTheme({ accent: '#fde68a' });
    expect(t.colors.accent).toBe('#fde68a');
    expect(contrastRatio(t.colors.accentText, t.colors.card)).toBeGreaterThanOrEqual(4.5);
  });

  it('a dark body flips the text colours', () => {
    const t = resolveHelpTheme({ preset: 'graphite' });
    expect(t.colors.ink).toBe('#f4f4f5');
    expect(contrastRatio(t.colors.ink, t.colors.page)).toBeGreaterThan(12);
  });

  it('a gradient hero picks text that reads on its midpoint', () => {
    const light = resolveHelpTheme({ preset: 'daylight' });
    expect(light.colors.heroFg).toBe('#0b0b0f');
    const dark = resolveHelpTheme({ preset: 'aurora' });
    expect(dark.colors.heroFg).toBe('#ffffff');
  });

  it('an image hero gets an overlay and white text', () => {
    const t = resolveHelpTheme({ hero_style: 'image', hero_image_url: 'https://cdn.example.com/a.jpg', hero_overlay: 40 });
    expect(t.heroBackground).toContain('rgba(0,0,0,0.40)');
    expect(t.heroBackground).toContain('url("https://cdn.example.com/a.jpg")');
    expect(t.colors.heroFg).toBe('#ffffff');
  });

  it('an image hero without a usable image falls back to a colour', () => {
    const t = resolveHelpTheme({ hero_style: 'image', hero_image_url: 'javascript:alert(1)' });
    expect(t.heroBackground).not.toContain('url(');
  });
});

describe('cleaning what is saved', () => {
  it('drops unknown keys and bad values', () => {
    const out = cleanHelpTheme({
      preset: 'nope',
      accent: 'red',
      font: 'comic-sans',
      radius: 'huge',
      hero_overlay: 500,
      evil: '<script>',
      show_toc: 'yes',
    });
    expect(out).toEqual({ preset: 'midnight', accent: '', font: 'inter', radius: 'round', hero_overlay: 90, show_toc: true });
  });

  it('accepts short hex and normalises it', () => {
    expect(cleanHelpTheme({ accent: '#ABC' }).accent).toBe('#aabbcc');
  });

  it('trims and caps texts', () => {
    const out = cleanHelpTheme({ hero_heading: `  ${'x'.repeat(300)}  ` });
    expect(out.hero_heading).toHaveLength(120);
  });

  it('only https (or same-site) hero images', () => {
    expect(safeImageUrl('https://a.example/x.png')).toBe('https://a.example/x.png');
    expect(safeImageUrl('/uploads/x.png')).toBe('/uploads/x.png');
    expect(safeImageUrl('http://a.example/x.png')).toBe('');
    expect(safeImageUrl('https://a.example/x.png") ; background:url(evil')).toBe('');
  });

  it('custom CSS cannot close its style element or import sheets', () => {
    const css = sanitizeCustomCss('</style><script>alert(1)</script> @import url(https://evil.example/x.css); .hc-hero{color:red}');
    expect(css).not.toMatch(/[<>]/);
    expect(css).not.toMatch(/@import/i);
    expect(css).toContain('.hc-hero{color:red}');
  });
});

describe('page output', () => {
  it('sets every variable the pages use', () => {
    const vars = helpThemeVars(resolveHelpTheme({}));
    for (const key of ['--hc-accent', '--hc-header-bg', '--hc-hero-bg', '--hc-page', '--hc-card', '--hc-ink', '--hc-line', '--hc-radius', '--hc-font']) {
      expect(vars[key]).toBeTruthy();
    }
  });

  it('loads Google Fonts only for the fonts in use', () => {
    expect(helpFontsHref({ font: 'system', heading_font: 'system' })).toBeNull();
    const href = helpFontsHref({ font: 'inter', heading_font: 'lora' })!;
    expect(href).toContain('family=Inter');
    expect(href).toContain('family=Lora');
  });
});
