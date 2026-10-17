'use client';

import React from 'react';
import {
  Inbox,
  Radio,
  Tag,
  Search,
  MessageSquare,
  Plus,
} from 'lucide-react';

export type EmptyStateType =
  | 'no-conversations'
  | 'no-visitors'
  | 'no-tags'
  | 'no-search-results'
  | 'custom';

interface EmptyStateProps {
  type?: EmptyStateType;
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  quickTags?: string[];
  onSelectTag?: (tag: string) => void;
  className?: string;
}

export function EmptyState({
  type = 'no-conversations',
  title,
  description,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  quickTags,
  onSelectTag,
  className = '',
}: EmptyStateProps) {
  // Preset configurations
  let defaultIcon = <Inbox className="w-8 h-8 text-ink-3" />;
  let defaultTitle = 'No conversations yet';
  let defaultDesc =
    'When visitors send messages through your chat widget, they will appear here in real time.';
  let iconBg = 'bg-surface-2 border-line';

  if (type === 'no-conversations') {
    defaultIcon = (
      <div className="relative">
        <div className="w-14 h-14 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
          <MessageSquare className="w-7 h-7" />
        </div>
        <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-success text-white flex items-center justify-center text-2xs font-bold border-2 border-surface">
          ✓
        </div>
      </div>
    );
    defaultTitle = 'All caught up!';
    defaultDesc =
      'There are no active conversations matching this view. When a visitor needs help, new chats will pop up here instantly.';
  } else if (type === 'no-visitors') {
    defaultIcon = (
      <div className="relative flex items-center justify-center">
        <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center text-accent animate-pulse">
          <Radio className="w-8 h-8" />
        </div>
        <div className="absolute inset-0 rounded-full border-2 border-accent/20 animate-ping opacity-40 pointer-events-none" />
      </div>
    );
    defaultTitle = 'Live Radar Scanning...';
    defaultDesc =
      'No active visitors on your site at this moment. As soon as someone browses your pages, their live URL, location, and device will appear right here.';
  } else if (type === 'no-tags') {
    defaultIcon = (
      <div className="w-10 h-10 rounded-xl bg-warn/10 border border-warn/20 text-warn flex items-center justify-center">
        <Tag className="w-5 h-5" />
      </div>
    );
    defaultTitle = 'No tags applied yet';
    defaultDesc =
      'Organize this conversation by adding tags like #Billing, #Bug, or #VIP for team tracking.';
  } else if (type === 'no-search-results') {
    defaultIcon = (
      <div className="w-12 h-12 rounded-2xl bg-surface-2 border border-line text-ink-3 flex items-center justify-center">
        <Search className="w-6 h-6" />
      </div>
    );
    defaultTitle = 'No matching conversations';
    defaultDesc = 'We could not find anything matching your search. Try another keyword, visitor name, or email.';
  }

  const finalTitle = title || defaultTitle;
  const finalDesc = description || defaultDesc;

  return (
    <div
      className={`flex flex-col items-center justify-center text-center p-8 max-w-sm mx-auto select-none ${className}`}
    >
      <div className="mb-4 flex items-center justify-center">{defaultIcon}</div>

      <h3 className="text-md font-semibold text-ink tracking-tight mb-1.5">
        {finalTitle}
      </h3>

      <p className="text-xs text-ink-3 leading-relaxed mb-5">
        {finalDesc}
      </p>

      {/* Preset Tag Chips (For No Tags state) */}
      {type === 'no-tags' && (quickTags || ['Billing', 'Bug', 'VIP', 'Sales', 'Feature']).length > 0 && onSelectTag && (
        <div className="space-y-2 w-full mb-4">
          <div className="text-2xs font-semibold text-ink-3 uppercase tracking-wider">
            Quick Add Preset:
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {(quickTags || ['Billing', 'Bug', 'VIP', 'Sales', 'Feature']).map((tag) => (
              <button
                key={tag}
                onClick={() => onSelectTag(tag)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-2 hover:bg-surface-3 border border-line text-ink transition-colors"
              >
                <Plus className="w-3 h-3 text-accent" />
                <span>#{tag}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center gap-2.5">
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            className="btn btn-sm btn-primary inline-flex items-center gap-1.5"
          >
            <span>{actionLabel}</span>
          </button>
        )}
        {secondaryActionLabel && onSecondaryAction && (
          <button
            onClick={onSecondaryAction}
            className="btn btn-sm btn-secondary inline-flex items-center gap-1.5"
          >
            <span>{secondaryActionLabel}</span>
          </button>
        )}
      </div>
    </div>
  );
}
