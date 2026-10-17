'use client';

import React from 'react';
import { ChannelType } from '@/types/database';
import { Globe, Phone } from 'lucide-react';

interface ChannelBadgeProps {
  channel?: ChannelType | string | null;
  size?: 'xs' | 'sm' | 'md';
  showLabel?: boolean;
  className?: string;
}

export function ChannelBadge({
  channel = 'web',
  size = 'sm',
  showLabel = false,
  className = '',
}: ChannelBadgeProps) {
  const normChannel = (channel || 'web').toLowerCase();

  switch (normChannel) {
    case 'whatsapp':
      return (
        <span
          title="WhatsApp Message"
          className={`inline-flex items-center gap-1.5 rounded-md font-semibold text-white bg-[#25D366] ${
            size === 'xs'
              ? 'px-1.5 py-0.5 text-2xs'
              : size === 'md'
              ? 'px-2.5 py-1 text-xs'
              : 'px-2 py-0.5 text-2xs'
          } ${className}`}
        >
          <Phone className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
          {showLabel && <span>WhatsApp</span>}
        </span>
      );

    case 'instagram':
      return (
        <span
          title="Instagram Direct"
          className={`inline-flex items-center gap-1.5 rounded-md font-semibold text-white bg-gradient-to-tr from-[#FD1D1D] via-[#E1306C] to-[#833AB4] ${
            size === 'xs'
              ? 'px-1.5 py-0.5 text-2xs'
              : size === 'md'
              ? 'px-2.5 py-1 text-xs'
              : 'px-2 py-0.5 text-2xs'
          } ${className}`}
        >
          <svg className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
          </svg>
          {showLabel && <span>Instagram</span>}
        </span>
      );

    case 'facebook':
    case 'messenger':
      return (
        <span
          title="Facebook Messenger"
          className={`inline-flex items-center gap-1.5 rounded-md font-semibold text-white bg-[#0084FF] ${
            size === 'xs'
              ? 'px-1.5 py-0.5 text-2xs'
              : size === 'md'
              ? 'px-2.5 py-1 text-xs'
              : 'px-2 py-0.5 text-2xs'
          } ${className}`}
        >
          <svg className={size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'} viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.373 0 0 4.974 0 11.111c0 3.498 1.744 6.614 4.469 8.654V24l4.088-2.242c1.092.302 2.249.464 3.443.464 6.627 0 12-4.975 12-11.111C24 4.974 18.627 0 12 0zm1.191 14.963l-3.055-3.26-5.963 3.26 6.559-6.963 3.13 3.259 5.889-3.259-6.56 6.963z" />
          </svg>
          {showLabel && <span>Messenger</span>}
        </span>
      );

    case 'threads':
      return (
        <span
          title="Threads Message"
          className={`inline-flex items-center gap-1.5 rounded-md font-semibold text-white bg-[#101010] border border-white/20 ${
            size === 'xs'
              ? 'px-1.5 py-0.5 text-2xs'
              : size === 'md'
              ? 'px-2.5 py-1 text-xs'
              : 'px-2 py-0.5 text-2xs'
          } ${className}`}
        >
          <span className="font-bold text-2xs">@</span>
          {showLabel && <span>Threads</span>}
        </span>
      );

    case 'linkedin':
      return (
        <span
          title="LinkedIn Message"
          className={`inline-flex items-center gap-1.5 rounded-md font-semibold text-white bg-[#0A66C2] ${
            size === 'xs'
              ? 'px-1.5 py-0.5 text-2xs'
              : size === 'md'
              ? 'px-2.5 py-1 text-xs'
              : 'px-2 py-0.5 text-2xs'
          } ${className}`}
        >
          <span className="font-bold text-2xs uppercase">in</span>
          {showLabel && <span>LinkedIn</span>}
        </span>
      );

    case 'web':
    default:
      return (
        <span
          title="Website Live Chat"
          className={`inline-flex items-center gap-1.5 rounded-md font-semibold text-ink bg-surface-3 border border-line-2 ${
            size === 'xs'
              ? 'px-1.5 py-0.5 text-2xs'
              : size === 'md'
              ? 'px-2.5 py-1 text-xs'
              : 'px-2 py-0.5 text-2xs'
          } ${className}`}
        >
          <Globe className={size === 'xs' ? 'w-2.5 h-2.5 text-accent' : 'w-3 h-3 text-accent'} />
          {showLabel && <span>Web</span>}
        </span>
      );
  }
}
