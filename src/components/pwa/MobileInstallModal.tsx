'use client';

import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import {
  Smartphone,
  Download,
  Share,
  PlusSquare,
  CheckCircle2,
  X,
  Copy,
  Check,
  Sparkles,
  ShieldCheck,
  Radio,
  ArrowRight,
  ExternalLink,
  Laptop,
  CheckCircle,
} from 'lucide-react';
import { usePwa } from '@/lib/pwa';
import { cn } from '@/lib/utils';

interface MobileInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type PlatformTab = 'auto' | 'android' | 'ios' | 'desktop';

export function MobileInstallModal({ isOpen, onClose }: MobileInstallModalProps) {
  const { canInstall, isStandalone, isInstalled, isIOS, isAndroid, isMobile, promptInstall } =
    usePwa();

  const [activeTab, setActiveTab] = useState<PlatformTab>('auto');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installSuccess, setInstallSuccess] = useState(false);

  // Set default tab based on detected device
  useEffect(() => {
    if (isIOS) setActiveTab('ios');
    else if (isAndroid) setActiveTab('android');
    else setActiveTab('desktop');
  }, [isIOS, isAndroid]);

  // Generate QR Code for mobile scanning
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const currentOrigin = window.location.origin;
    const mobileUrl = `${currentOrigin}/dashboard`;

    QRCode.toDataURL(mobileUrl, {
      width: 260,
      margin: 1.5,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then((url) => setQrDataUrl(url))
      .catch((err) => console.error('QR code error:', err));
  }, []);

  const handleCopyLink = () => {
    if (typeof window === 'undefined') return;
    navigator.clipboard.writeText(`${window.location.origin}/dashboard`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleTriggerInstall = async () => {
    setInstalling(true);
    try {
      const outcome = await promptInstall();
      if (outcome === 'accepted') {
        setInstallSuccess(true);
        setTimeout(() => {
          onClose();
        }, 2000);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setInstalling(false);
    }
  };

  if (!isOpen) return null;

  const currentTab =
    activeTab === 'auto'
      ? isIOS
        ? 'ios'
        : isAndroid
        ? 'android'
        : 'desktop'
      : activeTab;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay animate-fade-in select-none">
      <div
        className="relative w-full max-w-lg popover border border-line rounded-3xl shadow-2xl overflow-hidden animate-rise flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with App Icon and Badge */}
        <div className="p-5 sm:p-6 border-b border-line bg-accent-soft flex items-start justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-surface-2 border border-line shadow-sm overflow-hidden flex items-center justify-center p-1.5 shrink-0 ring-2 ring-accent/20">
              <img
                src="/icon-192.png"
                alt="Zen-try Mobile App"
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-bold text-ink tracking-tight">
                  Zen-try Mobile App
                </h3>
                <span className="text-2xs font-bold px-2 py-0.5 rounded-full bg-accent text-accent-ink uppercase tracking-wide">
                  PWA Shortcut
                </span>
              </div>
              <p className="text-xs sm:text-ui text-ink-3 mt-0.5">
                Install as a mobile shortcut without Play Store or App Store
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="px-5 pt-3 pb-0 border-b border-line/60 bg-surface-2/40 flex items-center gap-2 overflow-x-auto">
          <button
            onClick={() => setActiveTab('android')}
            className={cn(
              'px-3.5 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all flex items-center gap-1.5 shrink-0',
              currentTab === 'android'
                ? 'border-accent text-accent bg-surface shadow-xs'
                : 'border-transparent text-ink-3 hover:text-ink'
            )}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>Android (Chrome)</span>
          </button>

          <button
            onClick={() => setActiveTab('ios')}
            className={cn(
              'px-3.5 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all flex items-center gap-1.5 shrink-0',
              currentTab === 'ios'
                ? 'border-accent text-accent bg-surface shadow-xs'
                : 'border-transparent text-ink-3 hover:text-ink'
            )}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>iPhone / iPad (Safari)</span>
          </button>

          <button
            onClick={() => setActiveTab('desktop')}
            className={cn(
              'px-3.5 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all flex items-center gap-1.5 shrink-0',
              currentTab === 'desktop'
                ? 'border-accent text-accent bg-surface shadow-xs'
                : 'border-transparent text-ink-3 hover:text-ink'
            )}
          >
            <Laptop className="w-3.5 h-3.5" />
            <span>Scan QR on Mobile</span>
          </button>
        </div>

        {/* Tab Content Body */}
        <div className="p-5 sm:p-6 overflow-y-auto flex-1 space-y-5">
          {/* Status banner if already standalone */}
          {isStandalone && (
            <div className="p-3.5 rounded-2xl bg-success/10 border border-success/20 flex items-center gap-3 text-success">
              <CheckCircle className="w-5 h-5 shrink-0" />
              <div className="text-xs">
                <span className="font-bold block text-ui">App Already Installed!</span>
                You are currently running Zen-try directly from your mobile home screen.
              </div>
            </div>
          )}

          {/* 1. ANDROID TAB */}
          {currentTab === 'android' && (
            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-surface-2/60 border border-line space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold uppercase tracking-wider text-ink-2">
                    Android 1-Click Install
                  </div>
                  {canInstall && (
                    <span className="text-2xs font-bold px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                      Ready to install
                    </span>
                  )}
                </div>

                <p className="text-xs text-ink-3 leading-relaxed">
                  You can add Zen-try directly to your Android home screen as an app icon with standalone full-screen window support.
                </p>

                {canInstall ? (
                  <button
                    onClick={handleTriggerInstall}
                    disabled={installing || installSuccess}
                    className="w-full btn btn-primary py-3 rounded-xl font-bold flex items-center justify-center gap-2 shadow-md hover:shadow-lg transition-all"
                  >
                    {installSuccess ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-white" />
                        <span>Installed Successfully!</span>
                      </>
                    ) : installing ? (
                      <span>Installing...</span>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        <span>Add Shortcut to Mobile Home Screen</span>
                      </>
                    )}
                  </button>
                ) : (
                  <div className="p-3 rounded-xl bg-accent-soft text-accent text-xs font-medium">
                    💡 If the 1-click button doesn't pop up automatically, follow the simple 2-step guide below:
                  </div>
                )}
              </div>

              {/* Step by step for Android Chrome */}
              <div className="space-y-2.5">
                <div className="text-xs font-bold text-ink">
                  Manual 2-Step Android Instructions (Chrome / Edge / Brave):
                </div>

                <div className="grid gap-2 text-xs">
                  <div className="flex items-start gap-3 p-3 rounded-xl bg-surface-2 border border-line/60">
                    <div className="w-6 h-6 rounded-full bg-accent/10 text-accent font-bold text-xs flex items-center justify-center shrink-0">
                      1
                    </div>
                    <div>
                      <span className="font-semibold text-ink block">
                        Tap the 3 dots menu (⋮)
                      </span>
                      <span className="text-ink-3 text-xs">
                        Located in the top right corner of your Chrome mobile browser.
                      </span>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 p-3 rounded-xl bg-surface-2 border border-line/60">
                    <div className="w-6 h-6 rounded-full bg-accent/10 text-accent font-bold text-xs flex items-center justify-center shrink-0">
                      2
                    </div>
                    <div>
                      <span className="font-semibold text-ink block">
                        Tap &ldquo;Install app&rdquo; or &ldquo;Add to Home screen&rdquo;
                      </span>
                      <span className="text-ink-3 text-xs">
                        Confirm the dialog. The Zen-try logo shortcut will appear on your phone's home screen!
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. IOS TAB */}
          {currentTab === 'ios' && (
            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-surface-2/60 border border-line space-y-2">
                <div className="text-xs font-bold uppercase tracking-wider text-ink-2">
                  iPhone / iPad Safari Setup
                </div>
                <p className="text-xs text-ink-3 leading-relaxed">
                  Apple Safari lets you add Zen-try to your iPhone home screen in 3 seconds. It works exactly like an iOS app with push notifications and full screen.
                </p>
              </div>

              <div className="space-y-2.5">
                <div className="flex items-start gap-3 p-3 rounded-xl bg-surface-2 border border-line/60">
                  <div className="w-6 h-6 rounded-full bg-accent/10 text-accent font-bold text-xs flex items-center justify-center shrink-0">
                    1
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 font-semibold text-ink">
                      <span>Tap the Share Button</span>
                      <span className="inline-flex items-center justify-center p-1 rounded bg-surface border border-line text-accent">
                        <Share className="w-3.5 h-3.5" />
                      </span>
                    </div>
                    <span className="text-ink-3 text-xs">
                      At the bottom toolbar of Safari on your iPhone.
                    </span>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-xl bg-surface-2 border border-line/60">
                  <div className="w-6 h-6 rounded-full bg-accent/10 text-accent font-bold text-xs flex items-center justify-center shrink-0">
                    2
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 font-semibold text-ink">
                      <span>Scroll down &amp; tap &ldquo;Add to Home Screen&rdquo;</span>
                      <span className="inline-flex items-center justify-center p-1 rounded bg-surface border border-line text-ink">
                        <PlusSquare className="w-3.5 h-3.5" />
                      </span>
                    </div>
                    <span className="text-ink-3 text-xs">
                      Located in the Safari share sheet options list.
                    </span>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-3 rounded-xl bg-surface-2 border border-line/60">
                  <div className="w-6 h-6 rounded-full bg-accent/10 text-accent font-bold text-xs flex items-center justify-center shrink-0">
                    3
                  </div>
                  <div>
                    <span className="font-semibold text-ink block">
                      Tap &ldquo;Add&rdquo; in the top-right corner
                    </span>
                    <span className="text-ink-3 text-xs">
                      Zen-try is now installed on your home screen without needing Apple App Store!
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 3. DESKTOP QR CODE TAB */}
          {currentTab === 'desktop' && (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row items-center gap-5 p-4 rounded-2xl bg-surface-2/60 border border-line">
                {/* QR Canvas */}
                <div className="bg-white p-2.5 rounded-2xl shadow-md border border-black/10 shrink-0">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="Scan to open on phone"
                      className="w-36 h-36 object-contain rounded-lg"
                    />
                  ) : (
                    <div className="w-36 h-36 flex items-center justify-center text-xs text-ink-3">
                      Generating QR...
                    </div>
                  )}
                </div>

                {/* Instructions */}
                <div className="space-y-2.5 text-center sm:text-left">
                  <span className="inline-flex items-center gap-1.5 text-2xs font-bold px-2 py-0.5 rounded-full bg-accent-soft text-accent">
                    <Sparkles className="w-3 h-3" />
                    Instant Mobile Handshake
                  </span>
                  <h4 className="text-sm font-bold text-ink">
                    Scan with your Phone Camera
                  </h4>
                  <p className="text-xs text-ink-3 leading-relaxed">
                    Point your iPhone camera or Android scanner at this QR code to open the dashboard immediately on your mobile, then tap &ldquo;Add to Home Screen&rdquo;.
                  </p>
                </div>
              </div>

              {/* Copy URL Box */}
              <div className="space-y-1.5">
                <span className="text-2xs font-bold text-ink-3 uppercase tracking-wider">
                  Direct Mobile Link
                </span>
                <div className="flex items-center gap-2 p-1.5 rounded-xl bg-surface-2 border border-line">
                  <span className="px-2 text-xs font-mono text-ink-2 truncate flex-1 select-all">
                    {typeof window !== 'undefined'
                      ? `${window.location.origin}/dashboard`
                      : 'https://.../dashboard'}
                  </span>
                  <button
                    onClick={handleCopyLink}
                    className="btn btn-sm btn-secondary shrink-0 gap-1.5 text-xs font-semibold"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-success" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy URL</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* App Advantages Feature List */}
          <div className="pt-2 border-t border-line/60 grid grid-cols-2 gap-2 text-xs text-ink-2">
            <div className="flex items-center gap-2 p-2 rounded-xl bg-surface-2/40 border border-line/40">
              <ShieldCheck className="w-4 h-4 text-accent shrink-0" />
              <span>No Play Store account needed</span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-xl bg-surface-2/40 border border-line/40">
              <Radio className="w-4 h-4 text-success shrink-0" />
              <span>Real-time push &amp; sound alerts</span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-xl bg-surface-2/40 border border-line/40">
              <Smartphone className="w-4 h-4 text-accent shrink-0" />
              <span>Fullscreen native app feel</span>
            </div>
            <div className="flex items-center gap-2 p-2 rounded-xl bg-surface-2/40 border border-line/40">
              <Download className="w-4 h-4 text-accent shrink-0" />
              <span>Ultra-fast 0-second loading</span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-line bg-surface-2/40 flex items-center justify-between gap-3">
          <div className="text-2xs text-ink-3">
            Powered by Progressive Web App (PWA) standard
          </div>
          <button
            onClick={onClose}
            className="btn btn-sm btn-secondary text-xs px-4"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
