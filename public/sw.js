// Zen-try Progressive Web App Service Worker (v2.0.0)
const CACHE_NAME = 'zen-try-pwa-v2';

const STATIC_ASSETS = [
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon.png',
  '/manifest.webmanifest',
];

// 1. Install Event: Cache icons and static metadata
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.debug('[Zen-try SW] Pre-cache non-fatal warning:', err);
      });
    })
  );
});

// 2. Activate Event: Wipe all old caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        return Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// 3. Message Event: Allow manual skip waiting from client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 4. Fetch Event:
// CRITICAL: NEVER intercept 'navigate' requests! Let the browser handle page navigations,
// cookies, auth redirects, and streaming server responses directly without trapping the user
// in fake offline/reload loops.
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Let browser natively handle all page navigations
  if (request.mode === 'navigate') {
    return;
  }

  const url = new URL(request.url);

  // Bypass non-GET, internal HMR, Supabase APIs, Cloudinary, and Next.js APIs
  if (
    request.method !== 'GET' ||
    !url.protocol.startsWith('http') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/_next/webpack-hmr') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('cloudinary.com')
  ) {
    return;
  }

  // Static assets (images, icons, fonts) -> Stale-while-revalidate
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.woff2')
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const resClone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, resClone));
            }
            return networkResponse;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Pass through everything else
  return;
});

// 5. Push Notification Handler
self.addEventListener('push', (event) => {
  let data = { title: 'Zen-try Live Chat', body: 'New message received', icon: '/icon-192.png' };
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    if (event.data) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || 'New message in Zen-try',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/dashboard',
    },
  };

  event.waitUntil(self.registration.showNotification(data.title || 'Zen-try', options));
});

// 6. Notification Click Handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/dashboard';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/dashboard') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
