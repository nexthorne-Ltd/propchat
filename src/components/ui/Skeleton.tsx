'use client';

import React from 'react';

export function ConversationCardSkeleton() {
  return (
    <div className="p-2.5 rounded-xl border border-line/60 bg-surface/80 animate-pulse flex items-start gap-2.5 shadow-xs">
      {/* Avatar skeleton */}
      <div className="w-9 h-9 rounded-full bg-surface-3 shrink-0 mt-0.5" />

      {/* Content skeleton */}
      <div className="flex-1 min-w-0 space-y-2 py-0.5">
        <div className="flex items-center justify-between gap-2">
          <div className="h-3.5 w-24 bg-surface-3 rounded-md" />
          <div className="h-2.5 w-8 bg-surface-2 rounded" />
        </div>
        <div className="h-3 w-4/5 bg-surface-2 rounded" />
        <div className="flex items-center gap-1.5 pt-1">
          <div className="h-3.5 w-14 bg-surface-2 rounded-md" />
          <div className="h-3.5 w-10 bg-surface-2/70 rounded-md" />
        </div>
      </div>
    </div>
  );
}

export function ConversationListSkeleton({ count = 7 }: { count?: number }) {
  return (
    <div className="space-y-1 p-0.5">
      {Array.from({ length: count }).map((_, i) => (
        <ConversationCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function ChatThreadSkeleton() {
  return (
    <div className="flex-1 flex flex-col h-full bg-surface animate-pulse">
      {/* Header Skeleton */}
      <div className="h-16 px-6 border-b border-line flex items-center justify-between bg-surface shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-surface-2" />
          <div className="space-y-1.5">
            <div className="h-4 w-32 bg-surface-2 rounded-md" />
            <div className="h-3 w-20 bg-surface-2/60 rounded" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-8 w-24 bg-surface-2 rounded-lg" />
          <div className="h-8 w-20 bg-surface-2 rounded-lg" />
        </div>
      </div>

      {/* Messages Canvas Skeleton */}
      <div className="flex-1 p-6 space-y-5 overflow-hidden">
        {/* Visitor bubble 1 */}
        <div className="flex items-start gap-2.5 max-w-[65%]">
          <div className="w-7 h-7 rounded-full bg-surface-2 shrink-0" />
          <div className="space-y-1">
            <div className="h-10 w-52 bg-surface-2 rounded-2xl rounded-tl-sm" />
            <div className="h-2.5 w-12 bg-surface-2/50 rounded" />
          </div>
        </div>

        {/* Visitor bubble 2 */}
        <div className="flex items-start gap-2.5 max-w-[65%]">
          <div className="w-7 h-7 rounded-full bg-surface-2 shrink-0" />
          <div className="space-y-1">
            <div className="h-14 w-64 bg-surface-2 rounded-2xl rounded-tl-sm" />
            <div className="h-2.5 w-12 bg-surface-2/50 rounded" />
          </div>
        </div>

        {/* Agent reply 1 */}
        <div className="flex items-start justify-end gap-2.5 ml-auto max-w-[65%]">
          <div className="space-y-1 items-end flex flex-col">
            <div className="h-12 w-60 bg-accent/20 rounded-2xl rounded-tr-sm" />
            <div className="h-2.5 w-12 bg-surface-2/50 rounded" />
          </div>
        </div>

        {/* Agent reply 2 */}
        <div className="flex items-start justify-end gap-2.5 ml-auto max-w-[65%]">
          <div className="space-y-1 items-end flex flex-col">
            <div className="h-16 w-72 bg-accent/20 rounded-2xl rounded-tr-sm" />
            <div className="h-2.5 w-12 bg-surface-2/50 rounded" />
          </div>
        </div>
      </div>

      {/* Composer Skeleton */}
      <div className="p-4 border-t border-line bg-surface shrink-0">
        <div className="h-24 w-full bg-surface-2 rounded-2xl border border-line" />
      </div>
    </div>
  );
}
