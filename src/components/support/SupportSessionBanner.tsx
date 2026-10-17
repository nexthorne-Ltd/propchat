'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert, LogOut, Clock } from 'lucide-react';
import { SupportSession } from '@/types/platform-management';
import { getActiveSupportSessionAction, endSupportSessionAction } from '@/app/actions/platform-management';

export function SupportSessionBanner() {
  const router = useRouter();
  const [session, setSession] = useState<SupportSession | null>(null);
  const [timeLeft, setTimeLeft] = useState<string>('');
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    let interval: NodeJS.Timeout;

    const checkSession = async () => {
      try {
        const res = await getActiveSupportSessionAction();
        if (res.active && res.session) {
          setSession(res.session);

          // Update time left
          const updateRemaining = () => {
            const now = Date.now();
            const exp = new Date(res.session!.expires_at).getTime();
            const diffSec = Math.max(0, Math.floor((exp - now) / 1000));
            const mins = Math.floor(diffSec / 60);
            const secs = diffSec % 60;
            setTimeLeft(`${mins}m ${secs < 10 ? '0' : ''}${secs}s`);

            if (diffSec <= 0) {
              setSession(null);
            }
          };

          updateRemaining();
          interval = setInterval(updateRemaining, 1000);
        } else {
          setSession(null);
        }
      } catch (e) {
        // Silently catch in non-session environments
      }
    };

    checkSession();

    return () => {
      if (interval) clearInterval(interval);
    };
  }, []);

  const handleExit = async () => {
    setExiting(true);
    await endSupportSessionAction();
    setSession(null);
    router.push('/admin/workspaces');
    router.refresh();
  };

  if (!session) return null;

  return (
    <aside aria-label="Active support session" className="sticky top-0 z-[9999] bg-warning text-warning-contrast px-4 py-2 border-b border-warning-contrast/15 shadow-md">
      <div className="u-container flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2.5">
          <span className="flex h-2 w-2 rounded-full bg-danger animate-ping" />
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>
            <strong>Support Session Active:</strong> Viewing workspace{' '}
            <strong className="underline">{session.workspace_name}</strong> as staff member{' '}
            <code>{session.admin_email}</code>.
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 font-mono text-2xs bg-black/10 px-2 py-0.5 rounded">
            <Clock className="w-3 h-3" />
            <span>Expires in: {timeLeft}</span>
          </div>

          <button
            type="button"
            onClick={handleExit}
            disabled={exiting}
            className="btn btn-xs bg-black text-white hover:bg-black/80 font-bold px-2.5 py-1 rounded shadow-sm inline-flex items-center gap-1"
          >
            <LogOut className="w-3 h-3" />
            <span>{exiting ? 'Exiting...' : 'Exit Support Session'}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
