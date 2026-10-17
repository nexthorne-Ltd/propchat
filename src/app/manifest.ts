import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Zen-try — Live Chat & Customer Support',
    short_name: 'Zen-try',
    description: 'Real-time human support and live chat inbox on mobile and desktop.',
    start_url: '/dashboard',
    scope: '/',
    id: '/dashboard',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#08080a',
    theme_color: '#08080a',
    categories: ['business', 'productivity', 'communication'],
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'Open Inbox',
        short_name: 'Inbox',
        description: 'View active customer conversations',
        url: '/dashboard',
        icons: [{ src: '/icon-192.png', sizes: '192x192' }],
      },
      {
        name: 'Live Visitors',
        short_name: 'Radar',
        description: 'Monitor active visitors right now',
        url: '/dashboard?view=visitors',
        icons: [{ src: '/icon-192.png', sizes: '192x192' }],
      },
    ],
  };
}
