'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Search, X, Sparkles } from 'lucide-react';

export const EMOJI_CATEGORIES = [
  {
    id: 'popular',
    name: 'Popular & Reactions',
    icon: '🔥',
    emojis: [
      '👋', '😊', '👍', '❤️', '🔥', '🎉', '🚀', '🙌',
      '💡', '✨', '🙏', '💯', '🤔', '👀', '😎', '🤝',
      '⭐', '⚡', '👏', '🎯', '💪', '🏆', '🌟', '😍',
    ],
  },
  {
    id: 'status',
    name: 'Status & Alerts',
    icon: '✅',
    emojis: [
      '✅', '❌', '⚠️', 'ℹ️', '🚨', '🛑', '🔔', '🟢',
      '🟡', '🔴', '📌', '⏳', '🔒', '🔑', '🛡️', '⚡',
      '⭕', '❗', '❓', '❕', '🔘', '🚩', '🏁', '🏷️',
    ],
  },
  {
    id: 'business',
    name: 'Business & Finance',
    icon: '💳',
    emojis: [
      '💳', '💼', '📊', '📈', '📄', '📁', '📂', '📝',
      '📅', '🏷️', '🏢', '🧾', '💰', '💸', '📦', '🛒',
      '💵', '💎', '📉', '🗂️', '📋', '📮', '🏛️', '🤝',
    ],
  },
  {
    id: 'tech',
    name: 'Tech & Devices',
    icon: '💻',
    emojis: [
      '💻', '📱', '⚙️', '🛠️', '🔧', '🔌', '🌐', '🤖',
      '🖥️', '⌨️', '🖱️', '📦', '💾', '💿', '📡', '🕹️',
      '🛰️', '💡', '🔍', '🔎', '🔗', '📺', '🧭', '🖨️',
    ],
  },
  {
    id: 'help',
    name: 'Help & Support',
    icon: '📖',
    emojis: [
      '📖', '📚', '💬', '📞', '📩', '🎧', '🎯', '💡',
      '❓', '❔', '🗣️', '📝', '✉️', '📥', '📤', '📣',
      '📢', '📫', '👤', '👥', '🧑‍💻', '🤝', '🎓', '🏷️',
    ],
  },
];

interface EmojiPickerPopoverProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  className?: string;
}

export function EmojiPickerPopover({
  onSelect,
  onClose,
  className = '',
}: EmojiPickerPopoverProps) {
  const [activeTab, setActiveTab] = useState('popular');
  const [search, setSearch] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const allEmojis = React.useMemo(() => {
    return EMOJI_CATEGORIES.flatMap((c) => c.emojis);
  }, []);

  const displayedEmojis = React.useMemo(() => {
    if (!search.trim()) {
      return EMOJI_CATEGORIES.find((c) => c.id === activeTab)?.emojis || [];
    }
    // Simple filter
    return allEmojis;
  }, [search, activeTab, allEmojis]);

  return (
    <div
      ref={popoverRef}
      className={`z-50 w-72 rounded-2xl border border-line bg-surface shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 ${className}`}
    >
      {/* Header with Search */}
      <div className="p-2.5 border-b border-line bg-surface-2/60 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-ink flex items-center gap-1.5">
            <span>Choose an Emoji</span>
          </span>
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-md hover:bg-surface-3 flex items-center justify-center text-ink-3 hover:text-ink"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search emoji or pick below..."
            className="w-full h-7.5 pl-8 pr-2.5 rounded-lg border border-line bg-surface text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      {/* Category Tabs */}
      {!search.trim() && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line/60 overflow-x-auto bg-surface">
          {EMOJI_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveTab(cat.id)}
              className={`h-6.5 px-2 rounded-md text-2xs font-semibold flex items-center gap-1 shrink-0 transition-colors ${
                activeTab === cat.id
                  ? 'bg-accent text-accent-ink shadow-2xs'
                  : 'text-ink-3 hover:bg-surface-2 hover:text-ink'
              }`}
              title={cat.name}
            >
              <span>{cat.icon}</span>
              <span className="text-2xs truncate max-w-[80px]">{cat.name.split(' ')[0]}</span>
            </button>
          ))}
        </div>
      )}

      {/* Emoji Grid */}
      <div className="p-2.5 max-h-48 overflow-y-auto grid grid-cols-6 gap-1.5">
        {displayedEmojis.map((emoji, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => {
              onSelect(emoji);
              onClose();
            }}
            className="w-8 h-8 rounded-lg hover:bg-surface-2 flex items-center justify-center text-lg hover:scale-125 transition-transform"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
