'use client';

import React, { useState } from 'react';
import { Paperclip } from 'lucide-react';

interface EmailMeta {
  channel_type?: string;
  attachments?: { name: string; type: string; size: number; url: string | null; inline?: boolean; skipped?: string }[];
  email?: {
    subject?: string;
    cc?: { email: string; name?: string }[];
    html?: string;
    quoted?: string;
  };
}

/** True when a message arrived by email, so the thread shows its attachments, CC and original formatting. */
export function isEmailMessage(metadata: unknown): boolean {
  return (metadata as EmailMeta | null | undefined)?.channel_type === 'email';
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * What an email has beyond its text: files, who was copied, the original
 * formatting and the quoted history. The HTML was sanitised on the server and
 * is shown in a frame with every permission switched off (no scripts, no
 * forms, no navigation), as a second layer.
 */
export function EmailMessageExtras({ metadata }: { metadata: unknown }) {
  const meta = (metadata || {}) as EmailMeta;
  const [view, setView] = useState<'html' | 'quoted' | null>(null);
  const files = (meta.attachments || []).filter((a) => !a.inline || !a.url);
  const cc = meta.email?.cc || [];
  const html = meta.email?.html;
  const quoted = meta.email?.quoted;
  if (!files.length && !cc.length && !html && !quoted) return null;

  return (
    <div className="mt-2 space-y-2 text-xs text-ink-2">
      {cc.length > 0 && (
        <p>
          <span className="text-ink-3">Cc:</span> {cc.map((c) => c.name || c.email).join(', ')}
        </p>
      )}
      {files.length > 0 && (
        <ul className="space-y-1" aria-label="Attachments">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex flex-wrap items-center gap-1.5">
              <Paperclip className="w-3.5 h-3.5 shrink-0 text-ink-3" aria-hidden="true" />
              {f.url ? (
                <a href={f.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 break-all">
                  {f.name}
                </a>
              ) : (
                <span className="break-all">{f.name}</span>
              )}
              <span className="text-ink-3">{size(f.size)}</span>
              {f.skipped && <span className="text-warn">Not saved: {f.skipped}</span>}
            </li>
          ))}
        </ul>
      )}
      {(html || quoted) && (
        <div className="flex flex-wrap gap-3">
          {html && (
            <button type="button" className="underline underline-offset-2" aria-expanded={view === 'html'} onClick={() => setView(view === 'html' ? null : 'html')}>
              {view === 'html' ? 'Hide original formatting' : 'Show original formatting'}
            </button>
          )}
          {quoted && (
            <button type="button" className="underline underline-offset-2" aria-expanded={view === 'quoted'} onClick={() => setView(view === 'quoted' ? null : 'quoted')}>
              {view === 'quoted' ? 'Hide earlier messages' : 'Show earlier messages'}
            </button>
          )}
        </div>
      )}
      {view === 'html' && html && (
        <iframe
          title="Original email formatting"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:14px/1.5 sans-serif;margin:8px;word-wrap:break-word;background:#fff;color:#1f2933}img{max-width:100%}</style>${html}`}
          className="w-full h-72 rounded-md border border-line bg-surface"
        />
      )}
      {view === 'quoted' && quoted && <pre className="whitespace-pre-wrap break-words rounded-md border border-line bg-surface-2 p-2.5 text-ink-2 max-h-72 overflow-auto font-sans">{quoted}</pre>}
    </div>
  );
}
