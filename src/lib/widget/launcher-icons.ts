/**
 * The chat launcher's preset icons and the messenger's window designs, shared
 * by the embeddable widget (widget/src/index.ts, bundled by esbuild) and the
 * React settings preview, so the two can never draw different icons.
 *
 * Icons are static SVG markup on a 24×24 grid, painted with currentColor so
 * the launcher decides the colour. Nothing here comes from a workspace, so it
 * is safe to put straight into innerHTML.
 */

export type LauncherIconId = 'smile_bubble' | 'dots_bubble' | 'double_bubble' | 'smile_line' | 'headset' | 'help';
export type WidgetIconChoice = LauncherIconId | 'custom_logo';

export interface LauncherIcon {
  id: LauncherIconId;
  label: string;
  svg: string;
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${body}</svg>`;

export const LAUNCHER_ICONS: LauncherIcon[] = [
  {
    id: 'smile_bubble',
    label: 'Smile',
    svg: svg(
      '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M6 3h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-6.2l-4.13 3.1A1.05 1.05 0 0 1 6 20.26V18a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm2.3 7.7a.95.95 0 0 0-.43 1.27A4.7 4.7 0 0 0 12 14.6a4.7 4.7 0 0 0 4.13-2.63.95.95 0 1 0-1.7-.84A2.8 2.8 0 0 1 12 12.7a2.8 2.8 0 0 1-2.43-1.57.95.95 0 0 0-1.27-.43Z"/>'
    ),
  },
  {
    id: 'dots_bubble',
    label: 'Typing',
    svg: svg(
      '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M12 3c4.97 0 9 3.58 9 8s-4.03 8-9 8c-.97 0-1.9-.14-2.78-.39l-3.9 1.73a.8.8 0 0 1-1.09-.94l.85-3.17A7.6 7.6 0 0 1 3 11c0-4.42 4.03-8 9-8ZM8 12.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Zm4 0a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6Zm5.3-1.3a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0Z"/>'
    ),
  },
  {
    id: 'double_bubble',
    label: 'Conversation',
    svg: svg(
      '<path fill="currentColor" opacity=".5" d="M10 2.5h9A2.5 2.5 0 0 1 21.5 5v5.5A2.5 2.5 0 0 1 19 13h-.6v1.9a.5.5 0 0 1-.83.37L15.6 13H10a2.5 2.5 0 0 1-2.5-2.5V5A2.5 2.5 0 0 1 10 2.5Z"/>' +
        '<path fill="currentColor" d="M5 8.5h9a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-2.5 2.5H9.4l-2.97 2.27a.5.5 0 0 1-.83-.4V18.5H5A2.5 2.5 0 0 1 2.5 16v-5A2.5 2.5 0 0 1 5 8.5Z"/>'
    ),
  },
  {
    id: 'smile_line',
    label: 'Message',
    svg: svg(
      '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M6 3h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-6.2l-4.13 3.1A1.05 1.05 0 0 1 6 20.26V18a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm1.75 5a1 1 0 0 0 0 2h8.5a1 1 0 1 0 0-2h-8.5Zm0 4a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2h-5Z"/>'
    ),
  },
  {
    id: 'headset',
    label: 'Support',
    svg: svg(
      '<path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '<rect x="3" y="12.5" width="5" height="6.5" rx="2.2" fill="currentColor"/>' +
        '<rect x="16" y="12.5" width="5" height="6.5" rx="2.2" fill="currentColor"/>' +
        '<path d="M18.5 19v.4a2.6 2.6 0 0 1-2.6 2.6H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    ),
  },
  {
    id: 'help',
    label: 'Help',
    svg: svg(
      '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19Zm0 13.6a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Zm.1-9.6c-1.9 0-3.4 1.2-3.65 2.95a.95.95 0 0 0 1.88.27c.1-.75.8-1.32 1.75-1.32 1.02 0 1.72.62 1.72 1.42 0 .62-.33.98-1.15 1.48-.98.6-1.65 1.27-1.65 2.5v.3a.95.95 0 1 0 1.9 0v-.25c0-.45.2-.68.9-1.11 1-.62 1.9-1.42 1.9-2.94 0-1.9-1.6-3.3-3.6-3.3Z"/>'
    ),
  },
];

export const DEFAULT_LAUNCHER_ICON: LauncherIconId = 'smile_bubble';

export function launcherIcon(id: string | null | undefined): LauncherIcon {
  return LAUNCHER_ICONS.find((i) => i.id === id) || LAUNCHER_ICONS[0];
}

/* ── Window designs ─────────────────────────────────────────────────────── */

export type WidgetDesignId = 'classic' | 'compact' | 'livechat' | 'modern' | 'minimal' | 'solid' | 'midnight';

export interface WidgetDesign {
  id: WidgetDesignId;
  label: string;
  description: string;
  /** Opens straight into the conversation: no home screen. */
  chatFirst?: boolean;
}

export const WIDGET_DESIGNS: WidgetDesign[] = [
  { id: 'classic', label: 'Messenger', description: 'A home screen with a gradient header, cards and tabs. Like Intercom.' },
  { id: 'compact', label: 'Compact', description: 'Opens straight into the chat, slim header, a labelled launcher. Like Zendesk.', chatFirst: true },
  { id: 'livechat', label: 'Live chat', description: 'Straight into the chat, team photos and online status up top. Like Tawk.to.', chatFirst: true },
  { id: 'modern', label: 'Modern', description: 'Two-colour gradient, very round cards and bubbles. Like Chatway.' },
  { id: 'minimal', label: 'Minimal', description: 'White header, hairline borders, colour only on actions. Quiet and modern.' },
  { id: 'solid', label: 'Solid', description: 'Flat brand-colour header, rounded launcher and pill buttons. Bold and friendly.' },
  { id: 'midnight', label: 'Midnight', description: 'Dark header and launcher with your colour as the accent. Premium.' },
];

export const DEFAULT_WIDGET_DESIGN: WidgetDesignId = 'classic';

export function isWidgetDesign(value: unknown): value is WidgetDesignId {
  return WIDGET_DESIGNS.some((d) => d.id === value);
}


/** Opens straight into the conversation (no home screen). */
export function isChatFirstDesign(id: string | null | undefined): boolean {
  return WIDGET_DESIGNS.some((d) => d.id === id && d.chatFirst);
}

/** Window colours: the visitor's system setting, or always light / dark. */
export type WidgetColorMode = 'auto' | 'light' | 'dark';
export const WIDGET_COLOR_MODES: { id: WidgetColorMode; label: string }[] = [
  { id: 'auto', label: 'Match visitor' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];
export function isWidgetColorMode(value: unknown): value is WidgetColorMode {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/** A #rrggbb colour, or null. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
