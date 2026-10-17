'use client';

import React from 'react';
import { Modal } from './Modal';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ isOpen, onClose }: KeyboardShortcutsModalProps) {
  if (!isOpen) return null;

  const isMac = typeof window !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const modKey = isMac ? '⌘' : 'Ctrl';

  const shortcutGroups = [
    {
      group: 'General & Navigation',
      items: [
        { keys: [`${modKey}`, 'K'], description: 'Command palette: jump to tickets, views and settings' },
        { keys: ['/'], description: 'Search conversations' },
        { keys: ['Esc'], description: 'Close modal / deselect conversation' },
        { keys: ['?'], description: 'Toggle this keyboard shortcuts cheatsheet' },
      ],
    },
    {
      group: 'Chat Composer & Replying',
      items: [
        { keys: [`${modKey}`, 'Enter'], description: 'Send message / private internal note' },
        { keys: ['/'], description: 'Trigger canned response saved replies' },
        { keys: ['@'], description: 'Mention agent in private internal notes' },
      ],
    },
    {
      group: 'Ticket Management',
      items: [
        { keys: ['E'], description: 'Mark conversation as Closed / Resolved' },
        { keys: ['S'], description: 'Open snooze schedule dialog' },
        { keys: ['M'], description: 'Open thread merge dialog' },
      ],
    },
  ];

  return (
    <Modal
      title="Keyboard shortcuts"
      description="Speed up your support workflow"
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className="btn btn-sm btn-secondary">
          Got it
        </button>
      }
    >
      {/* Content */}
      <div className="space-y-6">
        {shortcutGroups.map((grp) => (
          <div key={grp.group} className="space-y-3">
            <div className="text-2xs font-bold text-ink-3 uppercase tracking-wider">
              {grp.group}
            </div>
            <div className="divide-y divide-line/60 border border-line rounded-xl overflow-hidden">
              {grp.items.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between px-3.5 py-2.5 bg-surface hover:bg-surface-2/50 transition-colors text-xs"
                >
                  <span className="text-ink font-medium">{item.description}</span>
                  <div className="flex items-center gap-1 shrink-0 ml-4">
                    {item.keys.map((k, kIdx) => (
                      <kbd
                        key={kIdx}
                        className="kbd"
                      >
                        {k}
                      </kbd>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

    </Modal>
  );
}
