'use client';

import { getWidgetOrigin } from '@/lib/domain';
import React, { useState, useEffect, useMemo } from 'react';
import {
  CheckCircle2,
  Circle,
  Copy,
  Check,
  ExternalLink,
  Sparkles,
  Palette,
  BookOpen,
  Users,
  MessageSquare,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Radio,
  Send,
  Eye,
  ArrowRight,
} from 'lucide-react';
import { Workspace, Visitor, Agent, Conversation } from '@/types/database';
import { cn } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import type { View } from '@/components/dashboard/Sidebar';
import type { SectionId } from '@/components/dashboard/SettingsHub';

export interface SetupChecklistProps {
  workspace: Workspace | null;
  visitors: Visitor[];
  allAgents: Agent[];
  conversations: Conversation[];
  articlesCount: number;
  sectionsCount: number;
  onNavigate: (view: View) => void;
  onOpenSettingsSection?: (section: SectionId) => void;
  onOpenSimulator: () => void;
  className?: string;
}

export function SetupChecklist({
  workspace,
  visitors,
  allAgents,
  conversations,
  articlesCount,
  sectionsCount,
  onNavigate,
  onOpenSettingsSection,
  onOpenSimulator,
  className,
}: SetupChecklistProps) {
  const supabase = createClient();
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [isCheckingLive, setIsCheckingLive] = useState(false);
  const [liveCheckDetected, setLiveCheckDetected] = useState(false);
  const [showCodeSnippet, setShowCodeSnippet] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hasInteractedCustomise, setHasInteractedCustomise] = useState(false);

  const storageKey = workspace?.id ? `zentry_setup_checklist_collapsed_${workspace.id}` : null;
  const legacyStorageKey = workspace?.id ? `chatify_setup_checklist_collapsed_${workspace.id}` : null;
  const customiseStorageKey = workspace?.id ? `zentry_customise_done_${workspace.id}` : null;
  const legacyCustomiseStorageKey = workspace?.id ? `chatify_customise_done_${workspace.id}` : null;

  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = localStorage.getItem(storageKey) || (legacyStorageKey ? localStorage.getItem(legacyStorageKey) : null);
      if (stored === 'true') setIsCollapsed(true);
      const custStored = (customiseStorageKey ? localStorage.getItem(customiseStorageKey) : null) ||
        (legacyCustomiseStorageKey ? localStorage.getItem(legacyCustomiseStorageKey) : null);
      if (custStored === 'true') {
        setHasInteractedCustomise(true);
      }
    } catch {
      // ignore
    }
  }, [storageKey, customiseStorageKey]);

  const toggleCollapsed = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, String(next));
        } catch {}
      }
      return next;
    });
  };

  // 1. Live Detection for Widget Installation
  const isWidgetDetected = useMemo(() => {
    return (
      visitors.length > 0 ||
      Boolean(workspace?.widget_installed) ||
      liveCheckDetected
    );
  }, [visitors.length, workspace?.widget_installed, liveCheckDetected]);

  // Real-time ping to check if widget registered visitors
  const handleCheckLiveDetection = async () => {
    if (!workspace?.id || isCheckingLive) return;
    setIsCheckingLive(true);
    try {
      const { count } = await supabase
        .from('visitors')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id);

      if (count && count > 0) {
        setLiveCheckDetected(true);
      }
    } catch (e) {
      console.error('Failed to query visitors:', e);
    } finally {
      setTimeout(() => setIsCheckingLive(false), 500);
    }
  };

  // 2. Customise widget check
  const isCustomised = useMemo(() => {
    if (hasInteractedCustomise) return true;
    if (!workspace) return false;
    // Check if brand color or logo or greeting is non-default
    const hasCustomColor = Boolean(workspace.brand_color && workspace.brand_color.toLowerCase() !== '#2e5bff');
    const hasCustomLogo = Boolean(workspace.logo_url);
    const hasCustomGreeting = Boolean(workspace.greeting_title && workspace.greeting_title !== 'Support Team');
    return hasCustomColor || hasCustomLogo || hasCustomGreeting;
  }, [workspace, hasInteractedCustomise]);

  // 3. Add first help section and 3 articles
  const isHelpCenterReady = useMemo(() => {
    return sectionsCount >= 1 && articlesCount >= 3;
  }, [sectionsCount, articlesCount]);

  // 4. Invite a teammate
  const isTeamInvited = useMemo(() => {
    return allAgents.length > 1;
  }, [allAgents.length]);

  // 5. Send a test message
  const isTestMessageSent = useMemo(() => {
    return conversations.length > 0;
  }, [conversations.length]);

  const checklistItems = [
    {
      id: 'install',
      title: 'Install widget',
      description: 'Add the Zen-try script tag to your website before the closing </body> tag.',
      done: isWidgetDetected,
      statusBadge: isWidgetDetected ? (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-semibold bg-success/15 text-success border border-success/25">
          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
          Live on site
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-2xs font-semibold bg-warn/15 text-warn border border-warn/25">
          Awaiting detection
        </span>
      ),
      icon: Radio,
      renderActions: () => (
        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          <button
            type="button"
            onClick={copyEmbedSnippet}
            className="btn btn-xs btn-secondary gap-1.5"
          >
            {copiedSnippet ? (
              <>
                <Check className="w-3 h-3 text-success" />
                Copied Snippet!
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                Copy Snippet
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleCheckLiveDetection}
            disabled={isCheckingLive}
            className="btn btn-xs btn-ghost gap-1.5 text-ink-2 hover:text-ink"
            title="Scan for live visitor heartbeats"
          >
            <RefreshCw className={cn('w-3 h-3', isCheckingLive && 'animate-spin text-accent')} />
            {isCheckingLive ? 'Scanning…' : 'Check detection'}
          </button>

          <button
            type="button"
            onClick={() => setShowCodeSnippet((prev) => !prev)}
            className="btn btn-xs btn-ghost gap-1 text-ink-3 hover:text-ink text-2xs"
          >
            <Eye className="w-3 h-3" />
            {showCodeSnippet ? 'Hide code' : 'View snippet'}
          </button>
        </div>
      ),
    },
    {
      id: 'customise',
      title: 'Customise widget',
      description: 'Tune your brand colors, messenger title, avatar logo, and launcher style.',
      done: isCustomised,
      statusBadge: isCustomised ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold bg-success/15 text-success border border-success/25">
          <Check className="w-3 h-3" />
          Customised
        </span>
      ) : (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-semibold bg-surface-2 text-ink-3 border border-line">
          Default theme
        </span>
      ),
      icon: Palette,
      renderActions: () => (
        <div className="flex items-center gap-2 mt-2.5">
          <button
            type="button"
            onClick={() => {
              if (onOpenSettingsSection) onOpenSettingsSection('widget');
              else onNavigate('settings');
              if (customiseStorageKey) {
                try {
                  localStorage.setItem(customiseStorageKey, 'true');
                  setHasInteractedCustomise(true);
                } catch {}
              }
            }}
            className="btn btn-xs btn-secondary gap-1.5"
          >
            <Palette className="w-3 h-3 text-accent" />
            Customise in Settings
          </button>
        </div>
      ),
    },
    {
      id: 'articles',
      title: 'Add first help section and 3 articles',
      description: 'Provide instant answers so customers get help even when your team is offline.',
      done: isHelpCenterReady,
      statusBadge: isHelpCenterReady ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold bg-success/15 text-success border border-success/25">
          <Check className="w-3 h-3" />
          {articlesCount} articles in {sectionsCount} section{sectionsCount !== 1 ? 's' : ''}
        </span>
      ) : (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-semibold bg-warn/15 text-warn border border-warn/25">
          {articlesCount}/3 articles • {sectionsCount}/1 sections
        </span>
      ),
      icon: BookOpen,
      renderActions: () => (
        <div className="flex items-center gap-2 mt-2.5">
          <button
            type="button"
            onClick={() => onNavigate('helpdesk')}
            className="btn btn-xs btn-secondary gap-1.5"
          >
            <BookOpen className="w-3 h-3 text-accent" />
            Manage Help Center
          </button>
        </div>
      ),
    },
    {
      id: 'team',
      title: 'Invite a teammate',
      description: 'Add your co-workers to manage incoming chats and collaborate seamlessly.',
      done: isTeamInvited,
      statusBadge: isTeamInvited ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold bg-success/15 text-success border border-success/25">
          <Check className="w-3 h-3" />
          {allAgents.length} team members
        </span>
      ) : (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-semibold bg-warn/15 text-warn border border-warn/25">
          1 member (Solo)
        </span>
      ),
      icon: Users,
      renderActions: () => (
        <div className="flex items-center gap-2 mt-2.5">
          <button
            type="button"
            onClick={() => {
              if (onOpenSettingsSection) onOpenSettingsSection('team');
              else onNavigate('settings');
            }}
            className="btn btn-xs btn-secondary gap-1.5"
          >
            <Users className="w-3 h-3 text-accent" />
            Invite Teammates
          </button>
        </div>
      ),
    },
    {
      id: 'test_message',
      title: 'Send a test message',
      description: 'Experience your live chat widget as a customer and verify real-time messaging.',
      done: isTestMessageSent,
      statusBadge: isTestMessageSent ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold bg-success/15 text-success border border-success/25">
          <Check className="w-3 h-3" />
          First conversation started
        </span>
      ) : (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-semibold bg-warn/15 text-warn border border-warn/25">
          Awaiting test chat
        </span>
      ),
      icon: MessageSquare,
      renderActions: () => (
        <div className="flex items-center gap-2 mt-2.5">
          <button
            type="button"
            onClick={onOpenSimulator}
            className="btn btn-xs btn-primary gap-1.5 shadow-xs"
          >
            <Sparkles className="w-3 h-3" />
            Send yourself a test chat
          </button>
        </div>
      ),
    },
  ];

  const completedCount = checklistItems.filter((item) => item.done).length;
  const progressPercent = Math.round((completedCount / checklistItems.length) * 100);
  const isAllComplete = completedCount === checklistItems.length;

  const origin = getWidgetOrigin();
  const workspaceId = workspace?.id || 'YOUR_WORKSPACE_ID';

  const embedSnippet = `<!-- Zen-try Live Chat Support -->
<script
  src="${origin}/widget.js"
  data-workspace-id="${workspaceId}"
  defer>
</script>`;

  const copyEmbedSnippet = () => {
    navigator.clipboard.writeText(embedSnippet);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2500);
  };

  return (
    <div
      className={cn(
        'w-full max-w-2xl mx-auto rounded-2xl border border-line bg-surface shadow-sm overflow-hidden transition-all',
        className
      )}
    >
      {/* Top Banner / Header */}
      <div className="p-4 sm:p-5 border-b border-line bg-surface-2/60">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="eyebrow text-accent font-bold tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                Setup Checklist
              </span>
              <span
                className={cn(
                  'px-2 py-0.5 rounded-full text-2xs font-bold',
                  isAllComplete
                    ? 'bg-success/20 text-success'
                    : 'bg-accent/15 text-accent'
                )}
              >
                {completedCount} of {checklistItems.length} completed
              </span>
            </div>

            <h2 className="text-base sm:text-lg font-bold text-ink mt-1 tracking-tight">
              {isAllComplete
                ? '🎉 Workspace setup complete!'
                : 'Get your workspace ready for visitors'}
            </h2>
            <p className="text-xs text-ink-3 mt-0.5 leading-relaxed">
              {isAllComplete
                ? 'All foundational setup tasks are done. You can now launch and support visitors anytime.'
                : 'Follow these quick steps to customize your widget, populate answers, and test real-time chat.'}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Prominent 'Send yourself a test chat' button */}
            <button
              type="button"
              onClick={onOpenSimulator}
              className="btn btn-sm btn-primary shadow-xs gap-1.5 hidden sm:inline-flex"
              title="Launch simulator customer website"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Send test chat</span>
            </button>

            {/* Collapse/Expand Toggle */}
            <button
              type="button"
              onClick={toggleCollapsed}
              className="w-8 h-8 rounded-lg border border-line bg-surface flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors"
              aria-label={isCollapsed ? 'Expand checklist' : 'Collapse checklist'}
            >
              {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-4">
          <div className="w-full h-1.5 rounded-full bg-surface-3 overflow-hidden">
            <div
              className={cn(
                'h-full transition-all duration-500 ease-out rounded-full',
                isAllComplete ? 'bg-success' : 'bg-accent'
              )}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* Checklist items (collapsible) */}
      {!isCollapsed && (
        <div className="divide-y divide-line/60">
          {checklistItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <div
                key={item.id}
                className={cn(
                  'p-4 sm:p-5 transition-colors',
                  item.done ? 'bg-surface/50' : 'bg-surface hover:bg-surface-2/40'
                )}
              >
                <div className="flex items-start gap-3.5">
                  {/* Status Indicator */}
                  <div className="shrink-0 mt-0.5">
                    {item.done ? (
                      <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
                    ) : (
                      <Circle className="w-5 h-5 text-ink-3 shrink-0 stroke-[1.75]" />
                    )}
                  </div>

                  {/* Body */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className="text-2xs font-bold text-ink-3 uppercase tracking-wider">
                          Step {index + 1}
                        </span>
                        <h3
                          className={cn(
                            'text-ui font-semibold leading-snug',
                            item.done ? 'text-ink-2 line-through decoration-line-2' : 'text-ink'
                          )}
                        >
                          {item.title}
                        </h3>
                      </div>
                      {item.statusBadge}
                    </div>

                    <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                      {item.description}
                    </p>

                    {/* Expandable snippet for widget */}
                    {item.id === 'install' && showCodeSnippet && (
                      <div className="mt-3 card overflow-hidden border-line">
                        <div className="h-8 px-3 flex items-center justify-between border-b border-line bg-surface-2 text-2xs">
                          <span className="font-mono text-ink-3">HTML Snippet</span>
                          <button
                            type="button"
                            onClick={copyEmbedSnippet}
                            className="font-medium text-accent hover:underline flex items-center gap-1"
                          >
                            {copiedSnippet ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                            {copiedSnippet ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <pre className="p-3 text-2xs font-mono leading-relaxed bg-surface overflow-x-auto text-ink-2">
                          {embedSnippet}
                        </pre>
                      </div>
                    )}

                    {/* Step specific actions */}
                    {item.renderActions()}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Footer bar inside expanded container */}
          <div className="p-3.5 px-5 bg-surface-2/40 flex items-center justify-between gap-3 text-xs flex-wrap">
            <span className="text-ink-3">
              Need to test your changes? Open the simulator at any time.
            </span>
            <button
              type="button"
              onClick={onOpenSimulator}
              className="btn btn-xs btn-primary gap-1.5 ml-auto shadow-xs"
            >
              <ExternalLink className="w-3 h-3" />
              Send yourself a test chat
            </button>
          </div>
        </div>
      )}

      {/* Minimized bottom summary bar when collapsed */}
      {isCollapsed && (
        <div className="p-3 px-5 flex items-center justify-between gap-3 text-xs bg-surface-2/40">
          <span className="text-ink-3 font-medium">
            Setup: {completedCount}/{checklistItems.length} steps completed ({progressPercent}%)
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenSimulator}
              className="btn btn-xs btn-secondary gap-1"
            >
              <Send className="w-3 h-3 text-accent" />
              Send test chat
            </button>
            <button
              type="button"
              onClick={toggleCollapsed}
              className="font-semibold text-accent hover:underline"
            >
              Show checklist
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
