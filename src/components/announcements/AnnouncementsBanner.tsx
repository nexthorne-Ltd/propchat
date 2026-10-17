'use client';

import React, { useEffect, useState } from 'react';
import { Info, AlertTriangle, CheckCircle, Bell, X } from 'lucide-react';
import { PlatformAnnouncement } from '@/types/platform-management';
import { getActiveAnnouncementsForWorkspaceAction } from '@/app/actions/platform-management';

export function AnnouncementsBanner({
  workspaceId,
  planId,
}: {
  workspaceId?: string;
  planId?: string;
}) {
  const [announcements, setAnnouncements] = useState<PlatformAnnouncement[]>([]);

  useEffect(() => {
    let mounted = true;
    const fetchAnnouncements = async () => {
      try {
        const list = await getActiveAnnouncementsForWorkspaceAction(workspaceId || '', planId);
        if (!mounted) return;

        // Filter out dismissed announcements from localStorage
        const dismissed = JSON.parse(localStorage.getItem('zentry_dismissed_announcements') || '[]');
        const unread = list.filter((a) => !dismissed.includes(a.id));
        setAnnouncements(unread);
      } catch (e) {
        // Silently catch
      }
    };

    fetchAnnouncements();
    return () => {
      mounted = false;
    };
  }, [workspaceId, planId]);

  const handleDismiss = (id: string) => {
    const dismissed = JSON.parse(localStorage.getItem('zentry_dismissed_announcements') || '[]');
    dismissed.push(id);
    localStorage.setItem('zentry_dismissed_announcements', JSON.stringify(dismissed));
    setAnnouncements((prev) => prev.filter((a) => a.id !== id));
  };

  if (announcements.length === 0) return null;

  return (
    <div className="space-y-2">
      {announcements.map((a) => {
        const toneStyles = {
          info: 'bg-accent-soft border-accent/30 text-ink',
          warning: 'bg-warning-soft border-warning/30 text-ink',
          success: 'bg-success-soft border-success/30 text-ink',
          urgent: 'bg-danger-soft border-danger/30 text-danger font-medium',
        }[a.tone] || 'bg-surface border-line text-ink';

        const ToneIcon = {
          info: Info,
          warning: AlertTriangle,
          success: CheckCircle,
          urgent: AlertTriangle,
        }[a.tone] || Bell;

        return (
          <aside
            key={a.id}
            aria-label={a.title}
            className={`p-3 rounded-xl border flex items-start justify-between gap-3 text-xs shadow-xs transition-all ${toneStyles}`}
          >
            <div className="flex items-start gap-2.5">
              <ToneIcon className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <h5 className="font-semibold">{a.title}</h5>
                <p className="mt-0.5 text-ink-2 leading-relaxed">{a.message}</p>
              </div>
            </div>

            {a.is_dismissible && (
              <button
                type="button"
                onClick={() => handleDismiss(a.id)}
                className="p-1 rounded text-ink-3 hover:text-ink shrink-0"
                title="Dismiss announcement"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </aside>
        );
      })}
    </div>
  );
}
