import React from 'react';
import { ImageIcon } from 'lucide-react';
import { LAUNCHER_ICONS, launcherIcon, type WidgetIconChoice } from '@/lib/widget/launcher-icons';

/**
 * The launcher icon in React (settings previews). The
 * drawings live in src/lib/widget/launcher-icons.ts, which the embeddable
 * widget renders too, so a preview always matches the real launcher.
 */

export type WidgetIconType = WidgetIconChoice;

export interface WidgetIconOption {
  id: WidgetIconType;
  label: string;
}

export const WIDGET_ICON_OPTIONS: WidgetIconOption[] = [
  ...LAUNCHER_ICONS.map((i) => ({ id: i.id as WidgetIconType, label: i.label })),
  { id: 'custom_logo', label: 'Your logo' },
];

/** One preset drawing; inherits the text colour. Static markup, not user input. */
export function PresetLauncherIcon({ id, className = 'w-6 h-6' }: { id: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center [&>svg]:w-full [&>svg]:h-full ${className}`}
      dangerouslySetInnerHTML={{ __html: launcherIcon(id).svg }}
    />
  );
}

export interface WidgetLauncherIconProps {
  type?: WidgetIconType | string;
  brandColor?: string;
  logoUrl?: string | null;
  className?: string;
  fallbackToDefault?: boolean;
}

export function WidgetLauncherIcon({ type = 'smile_bubble', logoUrl, className = 'w-6 h-6' }: WidgetLauncherIconProps) {
  if (type === 'custom_logo' && logoUrl) {
    return <img src={logoUrl} alt="" className="w-full h-full object-cover rounded-[inherit] bg-white" />;
  }
  if (type === 'custom_logo') return <ImageIcon className={className} aria-hidden="true" />;
  return <PresetLauncherIcon id={type} className={className} />;
}
