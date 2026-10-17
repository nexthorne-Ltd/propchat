'use client';

import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import {
  Smartphone,
  Download,
  Share,
  PlusSquare,
  CheckCircle2,
  Copy,
  Check,
  Sparkles,
  ShieldCheck,
  Radio,
  ExternalLink,
  Laptop,
  CheckCircle,
  Zap,
  BellRing,
  WifiOff,
} from 'lucide-react';
import { usePwa } from '@/lib/pwa';
import { cn } from '@/lib/utils';

export function MobileAppSettingsCard() {
  const { canInstall, isStandalone, isIOS, isAndroid, promptInstall } = usePwa();

  const [activeTab, setActiveTab] = useState<'android' | 'ios' | 'qr'>('android');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installSuccess, setInstallSuccess] = useState(false);

  useEffect(() => {
    if (isIOS) setActiveTab('ios');
    else if (isAndroid) setActiveTab('android');
    else setActiveTab('qr');
  }, [isIOS, isAndroid]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const currentOrigin = window.location.origin;
    const mobileUrl = `${currentOrigin}/dashboard`;

    QRCode.toDataURL(mobileUrl, {
      width: 280,
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
      }
    } catch (err) {
      console.error(err);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Header Banner */}
      <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-6 md:p-8 shadow-sm">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl bg-surface-2 border border-line p-2 shadow-sm shrink-0 ring-4 ring-accent/15 flex items-center justify-center">
              <img
                src="/icon-192.png"
                alt="Zen-try App Icon"
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold text-ink tracking-tight">
                  Mobile App &amp; Home Screen Shortcuts
                </h2>
                <span className="text-2xs font-bold px-2.5 py-0.5 rounded-full bg-accent text-accent-ink uppercase tracking-wider">
                  No Play Store Needed
                </span>
                {isStandalone && (
                  <span className="text-2xs font-bold px-2.5 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                    ✓ Installed
                  </span>
                )}
              </div>
              <p className="text-sm text-ink-3 mt-1 max-w-2xl leading-relaxed">
                Add Zen-try directly to your Android or iPhone home screen. It launches in a distraction-free fullscreen window with zero browser bars, push notifications, and ultra-fast loading.
              </p>
            </div>
          </div>

          {canInstall && (
            <button
              onClick={handleTriggerInstall}
              disabled={installing || installSuccess}
              className="btn btn-primary px-5 py-3 rounded-xl font-bold shadow-md hover:shadow-lg transition-all flex items-center gap-2 shrink-0"
            >
              {installSuccess ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-white" />
                  <span>Shortcut Installed!</span>
                </>
              ) : installing ? (
                <span>Installing...</span>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>Install Shortcut</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* 2. Platform Navigation Tabs */}
      <div className="flex items-center gap-2 p-1.5 rounded-2xl bg-surface-2 border border-line w-fit">
        <button
          onClick={() => setActiveTab('android')}
          className={cn(
            'px-4 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2',
            activeTab === 'android'
              ? 'bg-surface text-ink font-bold shadow-xs border border-line/80'
              : 'text-ink-3 hover:text-ink'
          )}
        >
          <Smartphone className="w-3.5 h-3.5 text-success" />
          <span>Android (Chrome / Samsung)</span>
        </button>

        <button
          onClick={() => setActiveTab('ios')}
          className={cn(
            'px-4 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2',
            activeTab === 'ios'
              ? 'bg-surface text-ink font-bold shadow-xs border border-line/80'
              : 'text-ink-3 hover:text-ink'
          )}
        >
          <Smartphone className="w-3.5 h-3.5 text-accent" />
          <span>iPhone / iPad (Safari)</span>
        </button>

        <button
          onClick={() => setActiveTab('qr')}
          className={cn(
            'px-4 py-2 rounded-xl text-xs font-semibold transition-all flex items-center gap-2',
            activeTab === 'qr'
              ? 'bg-surface text-ink font-bold shadow-xs border border-line/80'
              : 'text-ink-3 hover:text-ink'
          )}
        >
          <Laptop className="w-3.5 h-3.5 text-accent" />
          <span>Scan QR Code</span>
        </button>
      </div>

      {/* 3. Tab Contents */}
      {activeTab === 'android' && (
        <div className="rounded-3xl border border-line bg-surface p-6 md:p-8 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-ink">
                How to Add Zen-try on Android
              </h3>
              <p className="text-xs text-ink-3 mt-0.5">
                Works on Google Chrome, Samsung Internet, Microsoft Edge, and Brave.
              </p>
            </div>
            {canInstall && (
              <span className="text-xs font-bold text-success bg-success/10 px-3 py-1 rounded-full border border-success/20">
                1-Click Ready
              </span>
            )}
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="p-4 rounded-2xl bg-surface-2 border border-line/60 flex flex-col justify-between space-y-3">
              <div className="w-8 h-8 rounded-xl bg-accent/10 text-accent font-bold text-sm flex items-center justify-center">
                1
              </div>
              <div>
                <h4 className="text-sm font-semibold text-ink">Open in Chrome</h4>
                <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                  Open your Zen-try dashboard in Google Chrome or your Android web browser.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-surface-2 border border-line/60 flex flex-col justify-between space-y-3">
              <div className="w-8 h-8 rounded-xl bg-accent/10 text-accent font-bold text-sm flex items-center justify-center">
                2
              </div>
              <div>
                <h4 className="text-sm font-semibold text-ink">Tap 3 Dots (⋮) Menu</h4>
                <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                  Tap the three vertical dots located at the top right corner of Chrome.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-surface-2 border border-line/60 flex flex-col justify-between space-y-3">
              <div className="w-8 h-8 rounded-xl bg-accent/10 text-accent font-bold text-sm flex items-center justify-center">
                3
              </div>
              <div>
                <h4 className="text-sm font-semibold text-ink">Tap &ldquo;Install app&rdquo;</h4>
                <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                  Select &ldquo;Install app&rdquo; or &ldquo;Add to Home screen&rdquo;. The icon will appear instantly on your phone!
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'ios' && (
        <div className="rounded-3xl border border-line bg-surface p-6 md:p-8 space-y-6">
          <div>
            <h3 className="text-base font-bold text-ink">
              How to Add Zen-try on iPhone &amp; iPad
            </h3>
            <p className="text-xs text-ink-3 mt-0.5">
              Requires Apple Safari browser (pre-installed on every iOS device).
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="p-4 rounded-2xl bg-surface-2 border border-line/60 flex flex-col justify-between space-y-3">
              <div className="w-8 h-8 rounded-xl bg-accent/10 text-accent font-bold text-sm flex items-center justify-center">
                1
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <h4 className="text-sm font-semibold text-ink">Tap Share Icon</h4>
                  <Share className="w-3.5 h-3.5 text-accent" />
                </div>
                <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                  At the bottom of Safari, tap the Share button (square icon with arrow pointing up).
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-surface-2 border border-line/60 flex flex-col justify-between space-y-3">
              <div className="w-8 h-8 rounded-xl bg-accent/10 text-accent font-bold text-sm flex items-center justify-center">
                2
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <h4 className="text-sm font-semibold text-ink">&ldquo;Add to Home Screen&rdquo;</h4>
                  <PlusSquare className="w-3.5 h-3.5 text-ink" />
                </div>
                <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                  Scroll down the share sheet menu and tap &ldquo;Add to Home Screen&rdquo;.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-surface-2 border border-line/60 flex flex-col justify-between space-y-3">
              <div className="w-8 h-8 rounded-xl bg-accent/10 text-accent font-bold text-sm flex items-center justify-center">
                3
              </div>
              <div>
                <h4 className="text-sm font-semibold text-ink">Tap &ldquo;Add&rdquo;</h4>
                <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                  Tap &ldquo;Add&rdquo; in the top-right corner. Zen-try is now placed on your iPhone screen!
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'qr' && (
        <div className="rounded-3xl border border-line bg-surface p-6 md:p-8 space-y-6">
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <div className="bg-white p-3 rounded-2xl shadow-md border border-black/10 shrink-0">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="Scan on mobile phone"
                  className="w-40 h-40 object-contain rounded-lg"
                />
              ) : (
                <div className="w-40 h-40 flex items-center justify-center text-xs text-ink-3">
                  Generating QR...
                </div>
              )}
            </div>

            <div className="space-y-3 text-center sm:text-left">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-0.5 rounded-full bg-accent-soft text-accent">
                <Sparkles className="w-3.5 h-3.5" />
                Mobile Handshake
              </span>
              <h3 className="text-lg font-bold text-ink">
                Scan with your Smartphone Camera
              </h3>
              <p className="text-xs text-ink-3 leading-relaxed max-w-md">
                Open your iPhone or Android camera app, point it at this QR code, and tap the link that appears to immediately open Zen-try on your mobile phone.
              </p>

              <div className="pt-2 flex items-center gap-2">
                <button
                  onClick={handleCopyLink}
                  className="btn btn-secondary btn-sm gap-1.5 text-xs font-semibold"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-success" />
                      <span>Copied Dashboard Link!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Direct Link</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. Why Mobile Shortcut is better than Play Store apps */}
      <div className="rounded-3xl border border-line bg-surface p-6 md:p-8 space-y-4">
        <h3 className="text-sm font-bold text-ink tracking-tight uppercase text-ink-3">
          Why Progressive Web App (PWA) is Better than App Stores
        </h3>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-surface-2/60 border border-line/60 space-y-1.5">
            <Zap className="w-5 h-5 text-warn" />
            <h4 className="text-xs font-bold text-ink">0 MB Storage Overhead</h4>
            <p className="text-xs text-ink-3 leading-relaxed">
              Unlike 100MB+ Play Store apps that fill your storage, Zen-try PWA uses almost zero space.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-surface-2/60 border border-line/60 space-y-1.5">
            <BellRing className="w-5 h-5 text-accent" />
            <h4 className="text-xs font-bold text-ink">Instant Realtime Alerts</h4>
            <p className="text-xs text-ink-3 leading-relaxed">
              Get notified immediately when visitors send a message or start browsing your site.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-surface-2/60 border border-line/60 space-y-1.5">
            <ShieldCheck className="w-5 h-5 text-success" />
            <h4 className="text-xs font-bold text-ink">Always Up-To-Date</h4>
            <p className="text-xs text-ink-3 leading-relaxed">
              No manual Play Store updates needed. You always have the latest features automatically.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-surface-2/60 border border-line/60 space-y-1.5">
            <WifiOff className="w-5 h-5 text-accent" />
            <h4 className="text-xs font-bold text-ink">Spotty Network Resilient</h4>
            <p className="text-xs text-ink-3 leading-relaxed">
              Cached app shell and service worker ensure the app opens instantly even on slow connections.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
