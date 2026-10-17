'use client';

import { useState, useEffect } from 'react';

// Custom types for BeforeInstallPromptEvent
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
    appinstalled: Event;
  }
}

export interface PwaState {
  canInstall: boolean;
  isStandalone: boolean;
  isInstalled: boolean;
}

class PwaManager {
  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private listeners = new Set<() => void>();
  private state: PwaState = {
    canInstall: false,
    isStandalone: false,
    isInstalled: false,
  };

  constructor() {
    if (typeof window !== 'undefined') {
      this.checkStandalone();
      this.initListeners();
    }
  }

  private checkStandalone() {
    try {
      const isStandaloneDisplay =
        typeof window !== 'undefined' &&
        window.matchMedia('(display-mode: standalone)').matches;
      const isNavigatorStandalone =
        typeof window !== 'undefined' &&
        (window.navigator as any)?.standalone === true;
      const isStandalone = !!(isStandaloneDisplay || isNavigatorStandalone);

      this.state = {
        canInstall: !!this.deferredPrompt,
        isStandalone,
        isInstalled: isStandalone || this.state.isInstalled,
      };
    } catch (e) {
      // Safe fallback
    }
  }

  private initListeners() {
    try {
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.deferredPrompt = e;
        this.state = {
          ...this.state,
          canInstall: true,
        };
        this.notify();
      });

      window.addEventListener('appinstalled', () => {
        this.deferredPrompt = null;
        this.state = {
          canInstall: false,
          isStandalone: true,
          isInstalled: true,
        };
        this.notify();
      });

      window.matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
        this.state = {
          ...this.state,
          isStandalone: e.matches,
          isInstalled: e.matches || this.state.isInstalled,
        };
        this.notify();
      });
    } catch (e) {}
  }

  private notify() {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.error(err);
      }
    });
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public getState = (): PwaState => {
    return this.state;
  };

  public async promptInstall(): Promise<'accepted' | 'dismissed' | 'unsupported'> {
    if (!this.deferredPrompt) {
      return 'unsupported';
    }

    try {
      await this.deferredPrompt.prompt();
      const choice = await this.deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        this.deferredPrompt = null;
        this.state = {
          ...this.state,
          canInstall: false,
          isInstalled: true,
        };
        this.notify();
      }
      return choice.outcome;
    } catch (err) {
      console.error('[PWA] Install prompt error:', err);
      return 'unsupported';
    }
  }
}

export const pwaManager = new PwaManager();

export function usePwa() {
  const [pwaState, setPwaState] = useState<PwaState>(() => pwaManager.getState());
  const [deviceInfo, setDeviceInfo] = useState({
    isIOS: false,
    isAndroid: false,
    isMobile: false,
    isSafari: false,
  });

  useEffect(() => {
    // Sync initial state after hydration
    setPwaState(pwaManager.getState());

    const unsubscribe = pwaManager.subscribe(() => {
      setPwaState(pwaManager.getState());
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
    const isAndroid = /Android/i.test(ua);
    const isMobile = isIOS || isAndroid || /Mobi|Tablet|iPad/i.test(ua);
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

    setDeviceInfo({
      isIOS,
      isAndroid,
      isMobile,
      isSafari,
    });
  }, []);

  return {
    ...pwaState,
    ...deviceInfo,
    promptInstall: () => pwaManager.promptInstall(),
  };
}
