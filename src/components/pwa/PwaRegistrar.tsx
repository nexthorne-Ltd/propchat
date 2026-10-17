'use client';

import { useEffect } from 'react';

export function PwaRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    // In development the dev server keeps chunk names and changes their
    // contents, and sw.js answers /_next/static/ from its cache first, so an
    // edit left the browser running an old chunk ("module factory is not
    // available"). Production chunks are content-hashed, so only there is the
    // worker safe; in development any worker left from before is removed.
    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
        .then(() => ('caches' in window ? caches.keys() : Promise.resolve([] as string[])))
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .catch((err) => console.warn('[PWA] Could not remove the development service worker:', err));
      return;
    }

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          updateViaCache: 'none',
        });

        // Immediately check for update to evict any stale service workers
        registration.update();

        // If a new worker is waiting, activate it immediately
        if (registration.waiting) {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                newWorker.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          }
        });

        // Periodic update check
        setInterval(() => {
          registration.update().catch(() => {});
        }, 30 * 60 * 1000);
      } catch (err) {
        console.debug('[Zen-try PWA] SW registration ignored:', err);
      }
    };

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }, []);

  return null;
}
