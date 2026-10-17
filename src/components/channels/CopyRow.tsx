'use client';

import React from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

/** A value the admin pastes into another platform's dashboard, with a copy button. */
export function CopyRow({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="min-w-0">
      <p className="text-2xs font-medium text-ink-3">{label}</p>
      <div className="mt-1 flex items-center gap-2 min-w-0">
        <code className="flex-1 min-w-0 truncate rounded-sm bg-surface-2 border border-line px-2 py-1 font-mono text-xs text-ink">{value}</code>
        <Button
          size="xs"
          iconOnly
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() =>
            navigator.clipboard
              .writeText(value)
              .then(() => toast.success(`${label} copied`))
              .catch(() => toast.error('Could not copy; select the text instead.'))
          }
        >
          <Copy className="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
