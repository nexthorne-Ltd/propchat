'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsClient } from './Modal';

export type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICON = { success: CheckCircle2, error: AlertTriangle, info: Info } as const;
const TONE = { success: 'text-success', error: 'text-danger', info: 'text-accent' } as const;

/**
 * Transient confirmations in the bottom-right (bottom-centre on phones).
 * Errors stay until dismissed and are announced assertively; the rest go
 * after five seconds and are announced politely.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const mounted = useIsClient();
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = ++seq.current;
      setItems((list) => [...list.slice(-3), { id, tone, message }]);
      if (tone !== 'error') setTimeout(() => dismiss(id), 5000);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({ show, success: (m) => show(m, 'success'), error: (m) => show(m, 'error') }),
    [show]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted &&
        createPortal(
          <div
            className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:right-4 flex flex-col items-center sm:items-end gap-2 pointer-events-none"
            style={{ zIndex: 'var(--ds-z-toast)' as unknown as number }}
          >
            {items.map((t) => {
              const Icon = ICON[t.tone];
              return (
                <div
                  key={t.id}
                  role={t.tone === 'error' ? 'alert' : 'status'}
                  aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
                  className="pointer-events-auto w-full sm:w-auto sm:min-w-[280px] max-w-sm flex items-start gap-2.5 px-3.5 py-3 rounded-xl border border-line bg-surface shadow-lg animate-toast"
                >
                  <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', TONE[t.tone])} aria-hidden="true" />
                  <p className="flex-1 text-ui text-ink">{t.message}</p>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs -mr-1 -mt-0.5"
                    aria-label="Dismiss notification"
                    onClick={() => dismiss(t.id)}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
}

/** Falls back to console output outside a provider, so a stray call never crashes a screen. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  return {
    show: (m) => console.info('[Toast]', m),
    success: (m) => console.info('[Toast]', m),
    error: (m) => console.error('[Toast]', m),
  };
}
