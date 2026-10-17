'use client';

import React from 'react';
import { Check, Home, HelpCircle, ImageIcon, MessageSquare, Search, Send, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PresetLauncherIcon } from '@/components/ui/WidgetLauncherIcon';
import {
  LAUNCHER_ICONS,
  WIDGET_DESIGNS,
  isChatFirstDesign,
  type WidgetColorMode,
  type WidgetDesignId,
  type WidgetIconChoice,
} from '@/lib/widget/launcher-icons';

/**
 * Settings → Chat widget → Appearance: the messenger design, its colours,
 * the launcher icon, and a preview that follows the real widget for each
 * design (widget/src/index.ts, designCSS). The widget's own palette is used
 * here (not the app's tokens), because the customer's messenger has its own
 * light/dark setting, independent of how this dashboard looks.
 */

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Same rule as the widget: white on all but very light brand colours. */
export function onBrandColor(brand: string): string {
  return luminance(brand) > 0.62 ? '#0b0b0f' : '#ffffff';
}

/** The widget's default second colour: the brand colour, darker. */
function secondOf(brand: string, secondary?: string | null): string {
  return secondary || `color-mix(in srgb, ${brand} 66%, #000)`;
}

const MIDNIGHT = '#0d0d12';

/** The widget's window palette (widget/src/index.ts :host and darkModeCSS). */
function palette(mode: WidgetColorMode) {
  return mode === 'dark'
    ? { canvas: '#0b0b0e', surface: '#101013', surface2: '#17171b', surface3: '#202026', ink: '#f5f5f3', ink2: '#b4b4bc', ink3: '#8b8b95', line: '#232329' }
    : { canvas: '#fbfbf9', surface: '#ffffff', surface2: '#f7f7f5', surface3: '#efefec', ink: '#0b0b0f', ink2: '#4f5057', ink3: '#64656c', line: '#e7e7e3' };
}

function heroStyle(design: WidgetDesignId, brand: string, secondary?: string | null): React.CSSProperties {
  switch (design) {
    case 'minimal':
      return {};
    case 'solid':
    case 'compact':
    case 'livechat':
      return { background: brand, color: onBrandColor(brand) };
    case 'midnight':
      return { background: `radial-gradient(120% 90% at 85% 0%, ${brand}47, transparent 60%), ${MIDNIGHT}`, color: '#fff' };
    case 'modern':
      return { background: `linear-gradient(135deg, ${brand} 0%, ${secondOf(brand, secondary)} 100%)`, color: onBrandColor(brand) };
    default:
      return { background: `linear-gradient(150deg, ${brand} 0%, ${secondOf(brand, secondary)} 100%)`, color: onBrandColor(brand) };
  }
}

/** The launcher button: shape and colour follow the design. */
export function LauncherPreview({
  design,
  brand,
  secondary,
  icon,
  logoUrl,
  open = false,
  size = 52,
  onClick,
  label,
}: {
  design: WidgetDesignId;
  brand: string;
  secondary?: string | null;
  icon: WidgetIconChoice;
  logoUrl?: string | null;
  open?: boolean;
  size?: number;
  onClick?: () => void;
  label?: string;
}) {
  const logo = icon === 'custom_logo' && logoUrl;
  const pill = design === 'compact' && !open;
  const background = logo
    ? '#ffffff'
    : design === 'midnight'
    ? MIDNIGHT
    : design === 'modern'
    ? `linear-gradient(135deg, ${brand}, ${secondOf(brand, secondary)})`
    : brand;
  const fg = logo ? '#0b0b0f' : design === 'midnight' ? '#ffffff' : onBrandColor(brand);
  const radius = design === 'solid' ? Math.round(size / 3.1) : design === 'modern' ? Math.round(size / 2.8) : 999;
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick, 'aria-label': label } : { 'aria-hidden': true })}
      className="relative inline-flex items-center justify-center gap-2 shrink-0 transition-transform hover:scale-105"
      style={{
        width: pill ? 'auto' : size,
        height: pill ? Math.round(size * 0.9) : size,
        padding: pill ? `0 ${Math.round(size * 0.36)}px 0 ${Math.round(size * 0.28)}px` : 0,
        background,
        color: fg,
        borderRadius: radius,
        boxShadow:
          design === 'midnight'
            ? `0 0 0 2px ${brand}, 0 8px 20px rgba(11,11,15,.28)`
            : design === 'minimal' || design === 'compact'
            ? '0 6px 16px rgba(11,11,15,.16)'
            : `0 8px 22px ${brand}47, 0 2px 8px rgba(11,11,15,.16)`,
      }}
    >
      <span className="inline-flex items-center justify-center overflow-hidden" style={{ width: pill ? size * 0.42 : '100%', height: pill ? size * 0.42 : '100%', borderRadius: radius }}>
        {open ? (
          <X className="w-5 h-5" />
        ) : logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl!} alt="" className="w-full h-full object-cover" />
        ) : icon === 'custom_logo' ? (
          <ImageIcon className="w-5 h-5" />
        ) : (
          <PresetLauncherIcon id={icon} className={pill ? 'w-full h-full' : 'w-[46%] h-[46%]'} />
        )}
      </span>
      {pill && <span className="text-ui font-semibold">Chat</span>}
      {design === 'livechat' && !open && (
        <span className="absolute right-0.5 bottom-0.5 w-3 h-3 rounded-full border-2 border-white" style={{ background: '#22c55e' }} />
      )}
    </Tag>
  );
}

function BrandTile({ design, brand, logoUrl, name }: { design: WidgetDesignId; brand: string; logoUrl?: string | null; name: string }) {
  const minimal = design === 'minimal';
  return (
    <div
      className={cn(
        'w-9 h-9 grid place-items-center overflow-hidden shrink-0 text-ui font-bold',
        design === 'modern' ? 'rounded-full' : design === 'solid' ? 'rounded-xl' : 'rounded-[11px]'
      )}
      style={minimal ? { background: '#f7f7f5', border: '1px solid #e7e7e3', color: brand } : { background: 'rgba(255,255,255,.18)', border: '1.5px solid rgba(255,255,255,.3)' }}
    >
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        (name || 'W').charAt(0).toUpperCase()
      )}
    </div>
  );
}

const TEAM = [
  { l: 'A', c: '#2e5bff' },
  { l: 'S', c: '#0b7a5c' },
  { l: 'M', c: '#7c5cff' },
];

/** The messenger as each design draws it: the home screen, or the chat for chat-first designs. */
export function MessengerPreview({
  design,
  brand,
  secondary,
  mode = 'auto',
  logoUrl,
  name,
  greetingTitle,
  greetingMessage,
  showHelpTab,
  helpTabLabel,
  onClose,
  className,
}: {
  design: WidgetDesignId;
  brand: string;
  secondary?: string | null;
  mode?: WidgetColorMode;
  logoUrl?: string | null;
  name: string;
  greetingTitle: string;
  greetingMessage: string;
  showHelpTab: boolean;
  helpTabLabel: string;
  onClose?: () => void;
  className?: string;
}) {
  const p = palette(mode);
  const onBrand = onBrandColor(brand);
  const radius = design === 'compact' ? 10 : design === 'modern' ? 24 : design === 'minimal' ? 16 : 22;
  const closeBtn = (light: boolean) => (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close preview"
      className="w-8 h-8 rounded-full grid place-items-center shrink-0"
      style={light ? { border: `1px solid ${p.line}`, color: p.ink3 } : { background: 'rgba(255,255,255,.15)', border: '1px solid rgba(255,255,255,.2)', color: onBrand }}
    >
      <X className="w-4 h-4" />
    </button>
  );

  // Compact and Live chat open straight into the conversation.
  if (isChatFirstDesign(design)) {
    const live = design === 'livechat';
    const bubble = live ? 20 : 8;
    return (
      <div className={cn('flex flex-col overflow-hidden shadow-2xl', className)} style={{ borderRadius: live ? 16 : 10, background: p.canvas, border: `1px solid ${p.line}` }}>
        <div className="px-4 shrink-0" style={{ ...heroStyle(design, brand), paddingTop: live ? 18 : 12, paddingBottom: live ? 18 : 12 }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {live && (
                <div className="flex -space-x-2 mb-2.5">
                  {TEAM.map((t) => (
                    <span key={t.l} className="w-8 h-8 rounded-full grid place-items-center text-2xs font-bold text-white" style={{ background: t.c, border: `2px solid ${brand}` }}>
                      {t.l}
                    </span>
                  ))}
                </div>
              )}
              <div className={cn('font-bold leading-tight', live ? 'text-md' : 'text-ui')}>{greetingTitle || `Chat with ${name}`}</div>
              <div className="text-xs mt-0.5 flex items-center gap-1.5" style={{ opacity: 0.9 }}>
                {live && <span className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />}
                {live ? 'We are online' : greetingMessage}
              </div>
            </div>
            {closeBtn(false)}
          </div>
        </div>
        <div className="flex-1 px-3.5 py-4 space-y-2.5 overflow-hidden">
          <div className="max-w-[80%] px-3 py-2 text-xs" style={{ background: live ? p.surface2 : p.surface3, color: p.ink, borderRadius: `${bubble}px ${bubble}px ${bubble}px ${live ? 4 : bubble}px` }}>
            Hi! How can we help you today?
          </div>
          <div className="max-w-[80%] ml-auto px-3 py-2 text-xs" style={{ background: brand, color: onBrand, borderRadius: `${bubble}px ${bubble}px ${live ? 4 : bubble}px ${bubble}px` }}>
            Where is my order?
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2 p-2.5" style={{ borderTop: `1px solid ${p.line}`, background: p.surface }}>
          <div className="flex-1 h-9 px-3 flex items-center text-xs rounded-lg" style={{ background: p.surface2, color: p.ink3 }}>
            Write a message…
          </div>
          <span className="w-9 h-9 grid place-items-center" style={{ background: brand, color: onBrand, borderRadius: live ? 999 : 6 }}>
            <Send className="w-4 h-4" />
          </span>
        </div>
      </div>
    );
  }

  const minimal = design === 'minimal';
  const modern = design === 'modern';
  const ctaRadius = design === 'solid' || modern ? 999 : minimal || design === 'midnight' ? 10 : 12;
  const cardRadius = minimal ? 12 : design === 'solid' ? 16 : modern ? 22 : design === 'midnight' ? 14 : 18;
  const cta = modern ? `linear-gradient(135deg, ${brand}, ${secondOf(brand, secondary)})` : brand;
  return (
    <div className={cn('flex flex-col overflow-hidden shadow-2xl', className)} style={{ borderRadius: radius, background: p.canvas, border: `1px solid ${p.line}` }}>
      <div
        className={cn('px-5 pt-5 shrink-0', minimal ? 'pb-4' : modern ? 'pb-14' : 'pb-12')}
        style={minimal ? { background: p.surface, borderBottom: `1px solid ${p.line}`, color: p.ink } : heroStyle(design, brand, secondary)}
      >
        <div className="flex items-center justify-between mb-5">
          <BrandTile design={design} brand={brand} logoUrl={logoUrl} name={name} />
          {closeBtn(minimal)}
        </div>
        <div className={cn('font-bold leading-tight', modern ? 'text-2xl' : 'text-xl')}>{greetingTitle || `Hello from ${name}`}</div>
        <p className="mt-1 text-ui" style={{ opacity: minimal ? 1 : 0.9, color: minimal ? p.ink2 : undefined }}>
          {greetingMessage}
        </p>
      </div>

      <div className={cn('flex-1 px-3.5 pb-3.5 space-y-3 overflow-hidden', minimal ? 'pt-3.5' : modern ? '-mt-10' : '-mt-8')}>
        <div
          className="p-4"
          style={{
            background: p.surface,
            borderRadius: cardRadius,
            border: modern ? 'none' : `1px solid ${p.line}`,
            boxShadow: minimal ? 'none' : modern ? '0 10px 30px -8px rgba(15,23,42,.18)' : '0 6px 22px -4px rgba(15,23,42,.12)',
          }}
        >
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex -space-x-2">
              {TEAM.map((t) => (
                <span key={t.l} className="w-7 h-7 rounded-full grid place-items-center text-2xs font-bold text-white" style={{ background: t.c, border: `2px solid ${p.surface}` }}>
                  {t.l}
                </span>
              ))}
            </div>
            <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-2xs font-semibold whitespace-nowrap" style={{ border: `1px solid ${p.line}`, background: p.surface2, color: p.ink2 }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#22c55e' }} />
              Replies in minutes
            </span>
          </div>
          <div className="text-md font-bold" style={{ color: p.ink }}>Chat with us</div>
          <p className="text-xs mt-0.5 mb-3" style={{ color: p.ink2 }}>We usually reply in a few minutes.</p>
          <div className="h-10 grid place-items-center text-ui font-semibold" style={{ background: cta, color: onBrand, borderRadius: ctaRadius }}>
            Send us a message
          </div>
        </div>
        {showHelpTab && (
          <div className="px-3.5 h-11 flex items-center justify-between text-ui" style={{ background: p.surface, color: p.ink2, borderRadius: cardRadius, border: modern ? 'none' : `1px solid ${p.line}` }}>
            <span>Search {helpTabLabel || 'help'}…</span>
            <Search className="w-4 h-4" style={{ color: brand }} />
          </div>
        )}
      </div>

      <div className="h-14 shrink-0 grid grid-cols-3 text-2xs font-semibold" style={{ borderTop: `1px solid ${p.line}`, background: p.surface }}>
        {[
          { icon: Home, label: 'Home', active: true },
          { icon: MessageSquare, label: 'Chat' },
          ...(showHelpTab ? [{ icon: HelpCircle, label: helpTabLabel || 'Help' }] : []),
        ].map((t) => (
          <span key={t.label} className="flex flex-col items-center justify-center gap-0.5" style={{ color: t.active ? brand : p.ink3 }}>
            <t.icon className="w-4.5 h-4.5" />
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** One card per design, each with a miniature of its layout. */
export function DesignPicker({
  value,
  onChange,
  brand,
  secondary,
}: {
  value: WidgetDesignId;
  onChange: (d: WidgetDesignId) => void;
  brand: string;
  secondary?: string | null;
}) {
  return (
    <div role="radiogroup" aria-label="Messenger design" className="grid grid-cols-2 gap-3">
      {WIDGET_DESIGNS.map((d) => {
        const selected = value === d.id;
        const minimal = d.id === 'minimal';
        const chatFirst = isChatFirstDesign(d.id);
        return (
          <button
            key={d.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(d.id)}
            className={cn(
              'text-left rounded-xl border p-2.5 transition-colors',
              selected ? 'border-accent bg-accent-soft ring-2 ring-accent/20' : 'border-line bg-surface hover:border-line-3'
            )}
          >
            <div className="rounded-lg overflow-hidden border border-line bg-canvas h-24 flex flex-col" style={{ borderRadius: d.id === 'compact' ? 4 : d.id === 'modern' ? 12 : 8 }}>
              {chatFirst ? (
                <>
                  <div className="px-2.5 shrink-0 flex items-center gap-1.5" style={{ ...heroStyle(d.id, brand), height: d.id === 'livechat' ? 36 : 24 }}>
                    {d.id === 'livechat' && (
                      <span className="flex -space-x-1">
                        {[0, 1, 2].map((i) => (
                          <span key={i} className="w-3.5 h-3.5 rounded-full bg-white/80 border border-white/40" />
                        ))}
                      </span>
                    )}
                    <span className="h-1.5 w-10 rounded-full bg-white/85" />
                  </div>
                  <div className="flex-1 px-2 py-1.5 space-y-1">
                    <div className="h-3 w-16 bg-surface-3" style={{ borderRadius: d.id === 'livechat' ? 8 : 3 }} />
                    <div className="h-3 w-12 ml-auto" style={{ background: brand, borderRadius: d.id === 'livechat' ? 8 : 3 }} />
                    <div className="h-3 w-14 bg-surface-3" style={{ borderRadius: d.id === 'livechat' ? 8 : 3 }} />
                  </div>
                </>
              ) : (
                <>
                  <div className={cn('h-11 px-2.5 pt-2 shrink-0', minimal && 'bg-surface border-b border-line')} style={minimal ? undefined : heroStyle(d.id, brand, secondary)}>
                    <div className={cn('h-1.5 w-12 rounded-full', minimal ? 'bg-ink/70' : 'bg-white/85')} />
                    <div className={cn('mt-1.5 h-1 w-16 rounded-full', minimal ? 'bg-ink/25' : 'bg-white/50')} />
                  </div>
                  <div className={cn('px-2 flex-1', minimal ? 'pt-1.5' : '-mt-3')}>
                    <div
                      className="bg-surface border border-line p-1.5"
                      style={{ borderRadius: minimal ? 5 : d.id === 'modern' ? 12 : 8, boxShadow: minimal ? 'none' : '0 3px 10px rgba(15,23,42,.10)' }}
                    >
                      <div className="h-1 w-10 rounded-full bg-ink/30" />
                      <div
                        className="mt-1.5 h-3.5"
                        style={{
                          background: d.id === 'modern' ? `linear-gradient(135deg, ${brand}, ${secondOf(brand, secondary)})` : brand,
                          borderRadius: d.id === 'solid' || d.id === 'modern' ? 999 : 4,
                        }}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <span className="text-ui font-semibold text-ink">{d.label}</span>
              {selected && <Check className="w-4 h-4 text-accent shrink-0" aria-hidden="true" />}
            </div>
            <p className="text-xs text-ink-3 mt-0.5 leading-snug">{d.description}</p>
          </button>
        );
      })}
    </div>
  );
}

/** Six presets plus "Your logo", drawn as the real launcher in the chosen design. */
export function LauncherIconPicker({
  value,
  onChange,
  brand,
  secondary,
  design,
  logoUrl,
}: {
  value: WidgetIconChoice;
  onChange: (icon: WidgetIconChoice) => void;
  brand: string;
  secondary?: string | null;
  design: WidgetDesignId;
  logoUrl?: string | null;
}) {
  const options: { id: WidgetIconChoice; label: string }[] = [
    ...LAUNCHER_ICONS.map((i) => ({ id: i.id as WidgetIconChoice, label: i.label })),
    { id: 'custom_logo', label: 'Your logo' },
  ];
  // The labelled pill does not fit a grid cell; show its round form here.
  const tileDesign: WidgetDesignId = design === 'compact' ? 'classic' : design;
  return (
    <div role="radiogroup" aria-label="Launcher icon" className="grid grid-cols-4 sm:grid-cols-7 gap-2">
      {options.map((o) => {
        const selected = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.id)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-xl border px-1 py-3 transition-colors',
              selected ? 'border-accent bg-accent-soft ring-2 ring-accent/20' : 'border-line bg-surface hover:border-line-3'
            )}
          >
            <LauncherPreview design={tileDesign} brand={brand} secondary={secondary} icon={o.id} logoUrl={logoUrl} size={44} />
            <span className={cn('text-2xs font-semibold', selected ? 'text-accent' : 'text-ink-2')}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
