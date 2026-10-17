import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PwaRegistrar } from "@/components/pwa/PwaRegistrar";
import { ToastProvider } from "@/components/ui/Toast";
import { SupportSessionBanner } from "@/components/support/SupportSessionBanner";
import { AnnouncementsBanner } from "@/components/announcements/AnnouncementsBanner";
import { ZenTryChatSupport } from "@/components/marketing/ZenTryChatSupport";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zen-try — Live chat your customers actually want to use",
  description:
    "Real-time human support for any website. See who's browsing, reply in one shared inbox, and ship it with a single line of code.",
  manifest: "/manifest.webmanifest",
  applicationName: "Zen-try",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Zen-try",
  },
  icons: {
    icon: [
      { url: "/chat-icon.png", sizes: "256x256", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/chat-icon.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbf9" },
    { media: "(prefers-color-scheme: dark)", color: "#08080a" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  // Android: shrink the layout when the keyboard opens so fixed composers and
  // form fields stay visible above it.
  interactiveWidget: "resizes-content",
};

/**
 * Applies the stored theme before first paint. Without this the page renders
 * light for a frame and then snaps to dark, which looks broken.
 */
/**
 * Resolves the theme before first paint. `data-theme` is ALWAYS written — even
 * on "system" — because the `dark:` Tailwind variant keys off the attribute and
 * cannot see a media query. Storage stays empty for "system" so the choice
 * remains "follow the OS" rather than a pinned value.
 */
const themeBootstrap = `
(function () {
  var stored = null;
  try { stored = localStorage.getItem('zentry-theme') || localStorage.getItem('chatify-theme'); } catch (e) {}
  var theme = stored === 'light' || stored === 'dark'
    ? stored
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-full bg-canvas text-ink">
        <PwaRegistrar />
        <ToastProvider>
          <SupportSessionBanner />
          <AnnouncementsBanner />
          {children}
        </ToastProvider>
        {/* Zen-try Live Chat Support */}
        <ZenTryChatSupport />
      </body>
    </html>
  );
}
