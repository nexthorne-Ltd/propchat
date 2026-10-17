import React from 'react';
import { Globe, Laptop, Monitor, Smartphone, Tablet } from 'lucide-react';
import type { BrowserId, DeviceId, OsId } from '@/lib/visitor-meta';
import { cn } from '@/lib/utils';

/**
 * Inline brand marks for browsers and operating systems.
 *
 * Drawn locally rather than pulled from a CDN: the visitor panel renders one
 * per row, and a remote icon sprite would make an agent's inbox depend on a
 * third party being up. Each is a simplified, recognisable form of the logo.
 */

interface IconProps {
  className?: string;
  title?: string;
}

const base = 'shrink-0';

/* --------------------------------------------------------------- browsers */

function ChromeIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <circle cx="24" cy="24" r="20" fill="#fff" />
      <path fill="#f44336" d="M24 4a20 20 0 0 1 17.32 10H24a10 10 0 0 0-9.43 6.67L8.2 9.7A19.96 19.96 0 0 1 24 4z" />
      <path fill="#4caf50" d="M8.2 9.7l6.37 10.97A10 10 0 0 0 24 34c.6 0 1.18-.05 1.74-.15l-6.3 10.9A20 20 0 0 1 8.2 9.7z" />
      <path fill="#ffc107" d="M41.32 14A20 20 0 0 1 25.74 43.85l6.3-10.9A10 10 0 0 0 34 24a9.95 9.95 0 0 0-1.34-5H41.3z" />
      <circle cx="24" cy="24" r="8" fill="#2196f3" />
    </svg>
  );
}

function FirefoxIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <circle cx="24" cy="25" r="19" fill="#ff9800" />
      <path fill="#ff5722" d="M24 6c9 0 16 6 18 14-3-5-8-8-14-8-9 0-16 7-16 16 0 3 .8 6 2.2 8.4A19 19 0 0 1 24 6z" />
      <circle cx="24" cy="26" r="10" fill="#ffc107" />
      <circle cx="24" cy="27" r="5" fill="#fff3e0" />
    </svg>
  );
}

function SafariIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <circle cx="24" cy="24" r="20" fill="#1e88e5" />
      <circle cx="24" cy="24" r="16" fill="#fff" />
      <path fill="#f44336" d="M31 17l-4.5 9.5L17 31l4.5-9.5z" />
      <path fill="#bdbdbd" d="M17 31l9.5-4.5L31 17l-9.5 4.5z" opacity=".9" />
    </svg>
  );
}

function EdgeIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <path fill="#1e88e5" d="M24 4c11 0 20 8 20 19 0 4-3 7-8 7H22c-4 0-6 2-6 4 0 3 3 5 8 5-8 1-16-4-16-13C8 12 15 4 24 4z" />
      <path fill="#00bcd4" d="M8 26c0-9 7-16 16-16 7 0 12 4 13 9-3-3-7-4-11-4-9 0-15 6-15 14 0 4 2 8 5 10-5-3-8-8-8-13z" />
      <path fill="#4caf50" d="M20 40c-5-1-9-5-9-10 0-3 2-6 5-7-1 6 2 13 12 15-3 1-6 2-8 2z" />
    </svg>
  );
}

function OperaIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <ellipse cx="24" cy="24" rx="20" ry="20" fill="#e53935" />
      <ellipse cx="24" cy="24" rx="8" ry="14" fill="#fff" />
    </svg>
  );
}

function SamsungIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <circle cx="24" cy="24" r="20" fill="#7e57c2" />
      <circle cx="24" cy="24" r="9" fill="#fff" />
      <circle cx="24" cy="24" r="4" fill="#7e57c2" />
    </svg>
  );
}

/* ---------------------------------------------------------- operating systems */

function WindowsIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <path fill="#00adef" d="M6 11.5l16-2.2v14.2H6zM24 9l18-2.5v16.9H24zM6 25.5h16v14.2l-16-2.2zM24 25.5h18v16.9L24 39.9z" />
    </svg>
  );
}

function AppleIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <path
        fill="currentColor"
        d="M33.2 25.5c0-4.3 3.5-6.4 3.7-6.5-2-2.9-5.1-3.3-6.2-3.4-2.6-.3-5.2 1.6-6.5 1.6-1.3 0-3.4-1.5-5.6-1.5-2.9 0-5.5 1.7-7 4.3-3 5.2-.8 12.9 2.1 17.1 1.4 2.1 3.1 4.4 5.3 4.3 2.1-.1 2.9-1.4 5.5-1.4s3.3 1.4 5.5 1.3c2.3 0 3.7-2.1 5.1-4.2 1.6-2.4 2.3-4.7 2.3-4.8-.1 0-4.4-1.7-4.4-6.8zM29 12.7c1.1-1.4 1.9-3.3 1.7-5.2-1.7.1-3.7 1.1-4.9 2.5-1.1 1.2-2 3.2-1.7 5 1.9.2 3.8-.9 4.9-2.3z"
      />
    </svg>
  );
}

function AndroidIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <path
        fill="#3ddc84"
        d="M14 20h20v14a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2V20zM10 21a2.5 2.5 0 0 1 5 0v9a2.5 2.5 0 0 1-5 0v-9zM33 21a2.5 2.5 0 0 1 5 0v9a2.5 2.5 0 0 1-5 0v-9zM19 36h3v5.5a2.5 2.5 0 0 1-5 0V36zM26 36h3v5.5a2.5 2.5 0 0 1-5 0V36z"
      />
      <path
        fill="#3ddc84"
        d="M24 9c5.5 0 10 3.6 10 8.5H14C14 12.6 18.5 9 24 9z"
      />
      <circle cx="19" cy="14" r="1.2" fill="#fff" />
      <circle cx="29" cy="14" r="1.2" fill="#fff" />
    </svg>
  );
}

function LinuxIcon({ className, title }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={cn(base, className)} role="img" aria-label={title}>
      <ellipse cx="24" cy="30" rx="12" ry="13" fill="#37474f" />
      <ellipse cx="24" cy="33" rx="8" ry="9" fill="#eceff1" />
      <path fill="#fbc02d" d="M24 36c3 0 6 1.6 6 3s-3 2.4-6 2.4-6-1-6-2.4 3-3 6-3z" />
      <circle cx="20.5" cy="24" r="2.6" fill="#fff" />
      <circle cx="27.5" cy="24" r="2.6" fill="#fff" />
      <circle cx="20.5" cy="24.4" r="1.2" fill="#263238" />
      <circle cx="27.5" cy="24.4" r="1.2" fill="#263238" />
    </svg>
  );
}

function ChromeOsIcon({ className, title }: IconProps) {
  return <ChromeIcon className={className} title={title} />;
}

/* ------------------------------------------------------------------ exports */

const BROWSERS: Record<BrowserId, React.ComponentType<IconProps>> = {
  chrome: ChromeIcon,
  firefox: FirefoxIcon,
  safari: SafariIcon,
  edge: EdgeIcon,
  opera: OperaIcon,
  samsung: SamsungIcon,
  unknown: ({ className }) => (
    <Globe className={cn(base, 'text-ink-3', className)} />
  ),
};

const OSES: Record<OsId, React.ComponentType<IconProps>> = {
  windows: WindowsIcon,
  macos: AppleIcon,
  ios: AppleIcon,
  android: AndroidIcon,
  linux: LinuxIcon,
  chromeos: ChromeOsIcon,
  unknown: ({ className }) => (
    <Monitor className={cn(base, 'text-ink-3', className)} />
  ),
};

export function BrowserIcon({
  browser,
  className,
  title,
}: {
  browser: BrowserId;
  className?: string;
  title?: string;
}) {
  const Icon = BROWSERS[browser] ?? BROWSERS.unknown;
  return <Icon className={cn('w-4 h-4', className)} title={title} />;
}

export function OsIcon({
  os,
  className,
  title,
}: {
  os: OsId;
  className?: string;
  title?: string;
}) {
  const Icon = OSES[os] ?? OSES.unknown;
  // Apple's mark is monochrome, so it inherits the surrounding text colour.
  const mono = os === 'macos' || os === 'ios';
  return (
    <Icon
      className={cn('w-4 h-4', mono && 'text-ink', className)}
      title={title}
    />
  );
}

export function DeviceIcon({
  device,
  className,
}: {
  device: DeviceId;
  className?: string;
}) {
  const Icon =
    device === 'mobile' ? Smartphone : device === 'tablet' ? Tablet : Laptop;
  return <Icon className={cn('w-4 h-4 text-ink-3', className)} />;
}

/**
 * High-definition country flag using crisp CDN badges with fallback
 * to emoji and Globe icon. Works across Windows, Mac, iOS, Android.
 */
export function CountryFlag({
  flag,
  countryCode,
  className,
}: {
  flag?: string | null;
  countryCode?: string | null;
  className?: string;
}) {
  const [imgError, setImgError] = React.useState(false);

  let code = countryCode ? countryCode.toUpperCase() : null;
  if (!code && flag && flag.length >= 2) {
    try {
      const codePoints = [...flag].map((c) => c.codePointAt(0) || 0);
      if (codePoints.length === 2 && codePoints.every((cp) => cp >= 127462 && cp <= 127487)) {
        code = String.fromCharCode(...codePoints.map((cp) => cp - 127397));
      }
    } catch {}
  }

  if (code && !imgError) {
    return (
      <img
        src={`https://flagcdn.com/w40/${code.toLowerCase()}.png`}
        srcSet={`https://flagcdn.com/w80/${code.toLowerCase()}.png 2x`}
        alt={code}
        onError={() => setImgError(true)}
        className={cn(
          'w-4 h-3 rounded-[2px] object-cover shrink-0 shadow-[0_0_0_1px_rgba(0,0,0,0.12)] select-none inline-block',
          className
        )}
      />
    );
  }

  if (!flag) {
    return <Globe className={cn('w-4 h-4 text-ink-3 shrink-0', className)} />;
  }

  return (
    <span
      className={cn(
        'w-4 h-4 shrink-0 inline-flex items-center justify-center text-[15px] leading-none select-none',
        className
      )}
      aria-hidden
    >
      {flag}
    </span>
  );
}
