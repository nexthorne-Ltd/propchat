'use client';

import React, { useState, useEffect } from 'react';
import { Smartphone, Download, X, Sparkles } from 'lucide-react';
import { usePwa } from '@/lib/pwa';
import { cn } from '@/lib/utils';

interface MobileInstallBannerProps {
  onOpenModal: () => void;
  className?: string;
}

export function MobileInstallBanner({ onOpenModal, className }: MobileInstallBannerProps) {
  const { isStandalone, isMobile, canInstall, promptInstall } = usePwa();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const isDismissed = localStorage.getItem('zentry-mobile-banner-dismissed') || localStorage.getItem('chatify-mobile-banner-dismissed');
      if (isDismissed === '1' || isDismissed === 'true') {
        setDismissed(true);
      } else {
        setDismissed(false);
      }
    } catch {
      setDismissed(false);
    }
  }, []);

  // Do not show if already running in standalone app mode or dismissed
  if (isStandalone || dismissed) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem('zentry-mobile-banner-dismissed', '1');
    } catch (e) {}
  };

  const handleAction = async () => {
    if (canInstall) {
      const outcome = await promptInstall();
      if (outcome === 'accepted') {
        handleDismiss();
        return;
      }
    }
    // Otherwise open the guide modal
    onOpenModal();
  };

  return (
    <div
      className={cn(
        'relative bg-accent-soft border border-accent/25 rounded-xl px-2.5 py-1.5 shadow-2xs flex items-center justify-between gap-2 text-ink select-none animate-fade-in',
        className
      )}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="w-6 h-6 rounded-lg bg-accent text-accent-ink flex items-center justify-center shrink-0 shadow-2xs">
          <Smartphone className="w-3.5 h-3.5" />
        </div>
        <span className="text-xs font-semibold text-ink truncate">
          Get Mobile App Shortcut
        </span>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={handleAction}
          className="btn btn-xs btn-primary text-2xs font-semibold px-2 py-1 rounded-lg shadow-2xs flex items-center gap-1 shrink-0"
        >
          <Download className="w-3 h-3" />
          <span>Add</span>
        </button>

        <button
          onClick={handleDismiss}
          className="w-6 h-6 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors shrink-0"
          title="Dismiss"
          aria-label="Dismiss banner"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
