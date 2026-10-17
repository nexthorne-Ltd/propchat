'use client';

import React, { useMemo, useState, useRef, useEffect, useCallback, memo } from 'react';
import {
  Search,
  Star,
  X,
  Sparkles,
  SlidersHorizontal,
  Check,
  CheckCheck,
  ArrowUpDown,
  RefreshCw,
  UserPlus,
  CheckCircle2,
  ShieldAlert,
  Loader2,
  CheckSquare,
  Square,
  Users,
  ChevronDown,
  Clock,
  Globe,
  AlertTriangle,
  Bot,
} from 'lucide-react';
import {
  Conversation,
  ConversationStatus,
  ChannelType,
  Agent,
} from '@/types/database';
import { formatTimeAgo, cn, stripMarkdown, isGreetingMessage } from '@/lib/utils';
import { Avatar } from '@/components/ui/Avatar';
import { ChannelBadge } from '@/components/ui/ChannelBadge';
import { CountryFlag } from '@/components/ui/BrandIcon';
import { parseLocation } from '@/lib/visitor-meta';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConversationListSkeleton } from '@/components/ui/Skeleton';

export type StatusTab = 'open' | 'waiting' | 'mine' | 'unassigned' | 'resolved' | 'all';
export type SortOption = 'newest' | 'waiting' | 'unread' | 'priority';

export interface ConversationListProps {
  conversations: Conversation[];
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
  currentAgent?: Agent | null;
  agentsList?: Agent[];
  statusFilter?: ConversationStatus | 'all';
  loading?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  lastSynced?: Date;
  // Infinite scroll (pages of 30)
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  // Bulk actions
  onBulkResolve?: (ids: string[]) => Promise<void>;
  onBulkAssign?: (ids: string[], agentId: string | null) => Promise<void>;
  onBulkMarkSpam?: (ids: string[]) => Promise<void>;
  onOpenSimulator?: () => void;
}

const CHANNELS: { value: ChannelType | 'all'; label: string }[] = [
  { value: 'all', label: 'All Channels' },
  { value: 'web', label: 'Web' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Messenger' },
  { value: 'linkedin', label: 'LinkedIn' },
];

const SORT_LABELS: Record<SortOption, { label: string; desc: string }> = {
  newest: { label: 'Newest Activity', desc: 'Latest activity on top' },
  waiting: { label: 'Needs Reply First', desc: 'Waiting customers on top' },
  unread: { label: 'Unread First', desc: 'Unread messages on top' },
  priority: { label: 'Urgent & High', desc: 'Urgent priority on top' },
};

export const PRIMARY_STATUS_TABS: { id: StatusTab; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'mine', label: 'Mine' },
];

export const MORE_STATUS_TABS: { id: StatusTab; label: string }[] = [
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

const STATUS_TABS: { id: StatusTab; label: string }[] = [
  ...PRIMARY_STATUS_TABS,
  ...MORE_STATUS_TABS,
];

function displayNameFor(conv: Conversation) {
  return (
    conv.visitor?.name ||
    (conv.visitor?.email
      ? conv.visitor.email.split('@')[0]
      : conv.channel_user_id
      ? `${conv.channel?.toUpperCase() || 'CHAT'}: ${conv.channel_user_id}`
      : `Visitor ${conv.visitor_id.slice(0, 6)}`)
  );
}

function getLastActivityTime(conv: Conversation): number {
  // Most recent message timestamp determines list recency
  if (conv.last_message?.created_at) {
    const t = new Date(conv.last_message.created_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  // For newly started conversations with no messages yet, use conversation creation time
  if (conv.created_at) {
    const t = new Date(conv.created_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (conv.updated_at) {
    const t = new Date(conv.updated_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function isWaitingOnAgent(conv: Conversation): boolean {
  if (conv.status === 'closed' || conv.status === 'snoozed') return false;
  if ((conv.unread_count || 0) > 0) return true;
  // If the customer actually sent a message, we are waiting on agent
  if (conv.last_message && conv.last_message.sender_type === 'visitor') return true;
  // If only a greeting was sent (or no messages yet), we are waiting on the customer, NOT agent
  if (!conv.last_message || isGreetingMessage(conv.last_message)) return false;
  return false;
}

export interface SlaInfo {
  isBreached: boolean;
  isWarning: boolean;
  waitMinutes: number;
  waitLabel: string;
}

function getSlaInfo(conv: Conversation): SlaInfo | null {
  if (conv.status === 'closed' || conv.status === 'snoozed') return null;
  if (!isWaitingOnAgent(conv)) return null;
  if (!conv.last_message || isGreetingMessage(conv.last_message) || conv.last_message.sender_type !== 'visitor') return null;

  const activityTime = getLastActivityTime(conv);
  if (!activityTime) return null;

  const waitMs = Date.now() - activityTime;
  const waitMinutes = Math.max(1, Math.floor(waitMs / (1000 * 60)));

  // SLA Thresholds by priority:
  // urgent: 15 min limit
  // high: 30 min limit
  // normal: 60 min limit
  // low: 120 min limit
  const limitMinutes =
    conv.priority === 'urgent'
      ? 15
      : conv.priority === 'high'
      ? 30
      : conv.priority === 'low'
      ? 120
      : 60;

  const isBreached = waitMinutes >= limitMinutes;
  const isWarning = !isBreached && waitMinutes >= Math.floor(limitMinutes * 0.7);

  let waitLabel = '';
  if (waitMinutes < 60) {
    waitLabel = `${waitMinutes}m`;
  } else {
    const h = Math.floor(waitMinutes / 60);
    const m = waitMinutes % 60;
    waitLabel = m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  return {
    isBreached,
    isWarning,
    waitMinutes,
    waitLabel,
  };
}

function isVisitorOnline(lastSeen?: string, isOnlineFlag?: boolean): boolean {
  if (isOnlineFlag === false) return false;
  if (!lastSeen) return false;
  return (Date.now() - new Date(lastSeen).getTime()) / 1000 < 60;
}

/**
 * Memoized single conversation item for high-performance 60fps list scrolling.
 */
interface ConversationItemProps {
  conversation: Conversation;
  isSelected: boolean;
  onSelect: (id: string) => void;
  currentAgent?: Agent | null;
  isSelectionMode?: boolean;
  isChecked?: boolean;
  onToggleCheck?: (id: string) => void;
}

const ConversationItem = memo(function ConversationItem({
  conversation: conv,
  isSelected,
  onSelect,
  currentAgent,
  isSelectionMode = false,
  isChecked = false,
  onToggleCheck,
}: ConversationItemProps) {
  const online = isVisitorOnline(
    conv.visitor?.last_seen || conv.visitor?.last_seen_at,
    conv.visitor?.is_online
  );
  const name = displayNameFor(conv);
  const fromAgent = conv.last_message?.sender_type === 'agent';
  const fromAi = conv.last_message?.sender_type === 'ai';
  const hasUnread = (conv.unread_count || 0) > 0;
  const isWaiting = isWaitingOnAgent(conv);
  const sla = useMemo(() => getSlaInfo(conv), [conv]);
  const isUrgent = conv.priority === 'urgent';
  const isHigh = conv.priority === 'high';
  const isResolved = conv.status === 'closed';
  const activityTime = getLastActivityTime(conv);
  const place = useMemo(
    () =>
      parseLocation(
        conv.visitor?.location,
        conv.visitor?.ip_location_city,
        conv.visitor?.ip_location_country
      ),
    [
      conv.visitor?.location,
      conv.visitor?.ip_location_city,
      conv.visitor?.ip_location_country,
    ]
  );

  // Requirement 6: Render last-message preview as plain text (strip markdown symbols)
  const rawPreview =
    conv.last_message?.metadata?.translation?.english_text ||
    conv.last_message?.metadata?.english_translation ||
    conv.last_message?.metadata?.translation?.original_english ||
    conv.last_message?.metadata?.original_english ||
    conv.last_message?.content ||
    (conv.last_message?.attachment_url
      ? '📎 Attachment'
      : 'Conversation started');
  const previewText = stripMarkdown(rawPreview);

  // Requirement 7: One consistent sender label:
  // - "Bot" for automated greetings
  // - "AI" for AI copilot/autopilot
  // - "You" only for human agent replies
  const isBotGreeting = isGreetingMessage(conv.last_message);

  const senderLabel = useMemo(() => {
    if (isBotGreeting) {
      return 'Bot';
    }
    if (fromAi) {
      return 'AI';
    }
    if (fromAgent) {
      if (conv.last_message?.sender_id === currentAgent?.id) {
        return 'You';
      }
      return conv.last_message?.agent?.name || conv.agent?.name || 'Agent';
    }
    return null;
  }, [isBotGreeting, fromAi, fromAgent, conv.last_message, conv.agent, currentAgent?.id]);

  const langCode: string | undefined =
    (conv.channel_metadata as any)?.visitor_language ||
    conv.last_message?.metadata?.translation?.detected_language ||
    conv.last_message?.metadata?.detected_language;
  const showLang = Boolean(langCode && langCode !== 'en' && !langCode.startsWith('en'));
  const tags = (conv.tags || []).slice(0, 2);
  const hasChips =
    Boolean(sla?.isBreached || sla?.isWarning) ||
    isUrgent ||
    isHigh ||
    (isWaiting && !isResolved) ||
    (isBotGreeting && !isResolved && !isWaiting) ||
    isResolved ||
    tags.length > 0 ||
    showLang ||
    Boolean(conv.csat_rating) ||
    Boolean(conv.agent);

  // Chips share one shape so the row reads as a set, not a pile of styles.
  const chip =
    'inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-2xs leading-none font-semibold border shrink-0 whitespace-nowrap';

  const activate = () => {
    if (isSelectionMode && onToggleCheck) {
      onToggleCheck(conv.id);
    } else {
      onSelect(conv.id);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      data-selected={isSelected}
      className={cn(
        'w-full text-left px-3 py-3 rounded-xl transition-all duration-150 flex items-start gap-3 relative border cursor-pointer group select-none outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:scale-[0.995]',
        isSelected
          ? 'bg-accent/[0.07] dark:bg-accent/15 border-accent/40 shadow-sm ring-1 ring-accent/20'
          : hasUnread
          ? 'bg-surface border-line-2 hover:bg-surface-2 shadow-xs'
          : 'bg-surface border-line/70 hover:bg-surface-2/60 hover:border-line shadow-xs',
        isChecked && 'ring-1 ring-accent/40 bg-accent/[0.05]'
      )}
    >
      {/* Active Left Indicator Bar */}
      {isSelected && (
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-r-full bg-accent" />
      )}

      {/* Bulk Checkbox: always shown in selection mode; on desktop it also
          appears on hover. On touch screens that hover slot only wasted
          width, so it is not rendered there. */}
      {(isSelectionMode || isChecked) ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck?.(conv.id);
          }}
          className={cn(
            'shrink-0 mt-2.5 w-5 h-5 rounded-md border flex items-center justify-center transition-colors',
            isChecked
              ? 'bg-accent border-accent text-accent-ink'
              : 'border-line-2 bg-surface hover:border-accent'
          )}
          aria-label={isChecked ? 'Deselect conversation' : 'Select conversation'}
        >
          {isChecked && <Check className="w-3.5 h-3.5 stroke-[3]" />}
        </button>
      ) : (
        <div
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck?.(conv.id);
          }}
          className="hidden md:block shrink-0 mt-2.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
        >
          <div className="w-4 h-4 rounded border border-line-2 bg-surface" />
        </div>
      )}

      <Avatar
        name={name}
        seed={conv.visitor_id}
        size="md"
        online={online}
        muted={!conv.visitor?.name && !conv.visitor?.email}
        className="shrink-0"
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Line 1: name, flag, channel — time on the right */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {hasUnread && (
              <span className="w-2 h-2 rounded-full bg-accent shrink-0" title="Unread conversation" />
            )}
            <span
              className={cn(
                'text-sm truncate leading-5',
                hasUnread
                  ? 'font-bold text-ink'
                  : isSelected
                  ? 'font-semibold text-accent'
                  : 'font-semibold text-ink-2 group-hover:text-ink'
              )}
              title={name}
            >
              {name}
            </span>
            {place.countryCode && (
              <span title={place.label || place.country || undefined} className="inline-flex shrink-0">
                <CountryFlag
                  flag={place.flag}
                  countryCode={place.countryCode}
                  className="w-4 h-3 shrink-0 rounded-[2px]"
                />
              </span>
            )}
            {conv.channel && conv.channel !== 'web' && <ChannelBadge channel={conv.channel} />}
          </div>
          <span
            className={cn(
              'text-xs shrink-0 tabular-nums',
              hasUnread ? 'text-accent font-bold' : 'text-ink-3'
            )}
          >
            {formatTimeAgo(activityTime)}
          </span>
        </div>

        {/* Line 2: last message preview — unread count on the right */}
        <div className="flex items-center gap-2 mt-1">
          <p
            className={cn(
              'text-ui truncate leading-5 flex-1 min-w-0',
              hasUnread ? 'font-medium text-ink' : 'text-ink-3 group-hover:text-ink-2'
            )}
          >
            {isBotGreeting ? (
              <span className="text-accent font-semibold inline-flex items-center gap-1 mr-1 align-[-2px]">
                <Bot className="w-3.5 h-3.5" />
                Bot:
              </span>
            ) : fromAi ? (
              <span className="text-accent font-semibold inline-flex items-center gap-1 mr-1 align-[-2px]">
                <Sparkles className="w-3.5 h-3.5" />
                AI:
              </span>
            ) : fromAgent ? (
              <span className="text-ink-2 font-medium inline-flex items-center gap-1 mr-1 align-[-2px]">
                {conv.last_message?.read_at ? (
                  <CheckCheck className="w-3.5 h-3.5 text-accent stroke-[2.5]" />
                ) : online ? (
                  <CheckCheck className="w-3.5 h-3.5 text-ink-3/70 stroke-[2]" />
                ) : (
                  <Check className="w-3.5 h-3.5 text-ink-3/70 stroke-[2]" />
                )}
                {senderLabel}:
              </span>
            ) : null}
            {previewText}
          </p>
          {hasUnread && (
            <span className="h-5 min-w-[20px] px-1.5 grid place-items-center text-2xs font-bold rounded-full bg-accent text-accent-ink shrink-0">
              {conv.unread_count}
            </span>
          )}
        </div>

        {/* Line 3: status chips on their own row, so they never squeeze the
            name or the message on a narrow screen. */}
        {hasChips && (
          <div className="flex items-end gap-2 mt-2 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
              {sla?.isBreached ? (
                <span
                  className={cn(chip, 'bg-danger/10 text-danger border-danger/30')}
                  title={`SLA breached: customer waiting ${sla.waitLabel} without an agent reply`}
                >
                  <Clock className="w-3 h-3" />
                  {sla.waitLabel} overdue
                </span>
              ) : sla?.isWarning ? (
                <span
                  className={cn(chip, 'bg-warn/10 text-warn border-warn/30')}
                  title={`Approaching SLA limit: customer waiting ${sla.waitLabel}`}
                >
                  <Clock className="w-3 h-3" />
                  Wait {sla.waitLabel}
                </span>
              ) : null}

              {isUrgent ? (
                <span className={cn(chip, 'bg-danger/10 text-danger border-danger/25')}>Urgent</span>
              ) : isHigh ? (
                <span className={cn(chip, 'bg-warn/10 text-warn border-warn/25')}>High</span>
              ) : null}

              {isWaiting && !isResolved && (
                <span className={cn(chip, 'bg-warn/10 text-warn border-warn/25')}>
                  <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
                  Waiting
                </span>
              )}

              {isBotGreeting && !isResolved && !isWaiting && (
                <span className={cn(chip, 'bg-accent/10 text-accent border-accent/25 font-medium')}>
                  <Bot className="w-3 h-3" />
                  Bot greeting
                </span>
              )}

              {isResolved && (
                <span className={cn(chip, 'bg-success/10 text-success border-success/25')}>
                  <Check className="w-3 h-3 stroke-[2.5]" />
                  Resolved
                </span>
              )}

              {showLang && (
                <span
                  title={`Visitor language: ${langCode!.toUpperCase()}`}
                  className={cn(chip, 'bg-accent/10 text-accent border-accent/25 uppercase')}
                >
                  <Globe className="w-3 h-3" />
                  {langCode}
                </span>
              )}

              {tags.map((t) => (
                <span
                  key={t}
                  title={t}
                  className={cn(chip, 'bg-accent/10 text-accent border-accent/20 font-medium max-w-[120px]')}
                >
                  <span className="truncate">{t}</span>
                </span>
              ))}

              {conv.csat_rating && (
                <span className={cn(chip, 'bg-warn/10 text-warn border-warn/25')}>
                  <Star className="w-3 h-3 fill-current" />
                  {conv.csat_rating}
                </span>
              )}
            </div>

            {conv.agent && (
              <span
                className="text-2xs text-ink-3 truncate max-w-[90px] shrink-0"
                title={`Assigned: ${conv.agent.name}`}
              >
                {conv.agent.name.split(' ')[0]}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export function ConversationList({
  conversations,
  selectedConversationId,
  onSelectConversation,
  currentAgent,
  agentsList = [],
  loading = false,
  isRefreshing = false,
  onRefresh,
  lastSynced,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onBulkResolve,
  onBulkAssign,
  onBulkMarkSpam,
  onOpenSimulator,
}: ConversationListProps) {
  // Requirement 2: Status tabs: Open, Waiting, Mine, Unassigned, Resolved, All
  const [activeTab, setActiveTab] = useState<StatusTab>('open');
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [searchQuery, setSearchQuery] = useState('');
  const [channelFilter, setChannelFilter] = useState<ChannelType | 'all'>('all');
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | 'all'>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [showMoreTabs, setShowMoreTabs] = useState(false);

  // Requirement 3: Bulk selection state
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isAssignMenuOpen, setIsAssignMenuOpen] = useState(false);
  const [isBulkOperating, setIsBulkOperating] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const moreTabsRef = useRef<HTMLDivElement>(null);
  const assignMenuRef = useRef<HTMLDivElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Focus search with "/" (Ctrl/Cmd+K belongs to the command palette).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Close filter & more tabs popover on outside click
  useEffect(() => {
    if (!showFilters && !isAssignMenuOpen && !showMoreTabs) return;
    const onDown = (e: MouseEvent) => {
      if (showFilters && !filterRef.current?.contains(e.target as Node)) {
        setShowFilters(false);
      }
      if (isAssignMenuOpen && !assignMenuRef.current?.contains(e.target as Node)) {
        setIsAssignMenuOpen(false);
      }
      if (showMoreTabs && !moreTabsRef.current?.contains(e.target as Node)) {
        setShowMoreTabs(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showFilters, isAssignMenuOpen, showMoreTabs]);

  // Requirement 2: Tab counts
  const counts = useMemo(() => {
    let open = 0;
    let waiting = 0;
    let mine = 0;
    let unassigned = 0;
    let resolved = 0;
    let all = 0;

    conversations.forEach((c) => {
      all++;
      const isClosed = c.status === 'closed';
      const agentId = c.assigned_agent_id || c.agent_id;

      if (isClosed) {
        resolved++;
      } else {
        open++;
        if (isWaitingOnAgent(c)) waiting++;
        if (currentAgent?.id && agentId === currentAgent.id) mine++;
        if (!agentId) unassigned++;
      }
    });

    return { open, waiting, mine, unassigned, resolved, all };
  }, [conversations, currentAgent?.id]);

  // Extract distinct tags
  const availableTags = useMemo(() => {
    const set = new Set<string>(['Billing', 'Bug', 'Refund', 'VIP', 'Sales lead', 'Urgent']);
    conversations.forEach((c) => {
      c.tags?.forEach((t) => set.add(t));
    });
    return Array.from(set);
  }, [conversations]);

  // Filter and sort conversations
  const filteredAndSorted = useMemo(() => {
    const list = conversations.filter((conv) => {
      const agentId = conv.assigned_agent_id || conv.agent_id;
      const isClosed = conv.status === 'closed';

      // 1. Status Tabs Filter
      if (activeTab === 'open' && isClosed) return false;
      if (activeTab === 'waiting' && (isClosed || !isWaitingOnAgent(conv))) return false;
      if (activeTab === 'mine' && (isClosed || agentId !== currentAgent?.id)) return false;
      if (activeTab === 'unassigned' && (isClosed || !!agentId)) return false;
      if (activeTab === 'resolved' && !isClosed) return false;
      // activeTab === 'all' includes all conversations

      // 2. Channel Filter
      if (channelFilter !== 'all' && (conv.channel || 'web') !== channelFilter) {
        return false;
      }

      // 3. Tag Filter
      if (
        selectedTagFilter !== 'all' &&
        (!conv.tags || !conv.tags.includes(selectedTagFilter))
      ) {
        return false;
      }

      // 4. Search query
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;

      return (
        (conv.visitor?.name?.toLowerCase() || '').includes(q) ||
        (conv.visitor?.email?.toLowerCase() || '').includes(q) ||
        (conv.channel_user_id?.toLowerCase() || '').includes(q) ||
        (conv.last_message?.content?.toLowerCase() || '').includes(q) ||
        (conv.tags?.some((t) => t.toLowerCase().includes(q)) ?? false) ||
        conv.id.toLowerCase().includes(q)
      );
    });

    return list.sort((a, b) => {
      // 1. PIN SLA Breached conversations to the very top!
      const slaA = getSlaInfo(a);
      const slaB = getSlaInfo(b);
      const isBreachedA = slaA?.isBreached ? 1 : 0;
      const isBreachedB = slaB?.isBreached ? 1 : 0;

      if (isBreachedA !== isBreachedB) {
        return isBreachedB - isBreachedA;
      }
      if (isBreachedA && isBreachedB) {
        // Longest waiting customer gets highest priority on top
        return (slaB?.waitMinutes || 0) - (slaA?.waitMinutes || 0);
      }

      const timeA = getLastActivityTime(a);
      const timeB = getLastActivityTime(b);

      if (sortBy === 'waiting') {
        const aWait = isWaitingOnAgent(a) ? 1 : 0;
        const bWait = isWaitingOnAgent(b) ? 1 : 0;
        if (aWait !== bWait) return bWait - aWait;
        return timeB - timeA;
      }

      if (sortBy === 'unread') {
        const aUnread = (a.unread_count || 0) > 0 ? 1 : 0;
        const bUnread = (b.unread_count || 0) > 0 ? 1 : 0;
        if (aUnread !== bUnread) return bUnread - aUnread;
        return timeB - timeA;
      }

      if (sortBy === 'priority') {
        const pOrder: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };
        const pA = pOrder[a.priority || 'normal'] || 1;
        const pB = pOrder[b.priority || 'normal'] || 1;
        if (pA !== pB) return pB - pA;
        return timeB - timeA;
      }

      // Default: newest activity on top (most recent message first)
      if (timeB !== timeA) return timeB - timeA;
      return b.id.localeCompare(a.id);
    });
  }, [
    conversations,
    activeTab,
    sortBy,
    channelFilter,
    selectedTagFilter,
    searchQuery,
    currentAgent?.id,
  ]);

  // Requirement 1: Infinite Scroll Intersection Observer on sentinel
  useEffect(() => {
    if (!hasMore || loadingMore || !onLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore();
        }
      },
      {
        root: listContainerRef.current,
        rootMargin: '200px',
        threshold: 0.05,
      }
    );

    if (sentinelRef.current) {
      observer.observe(sentinelRef.current);
    }

    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  // Infinite Scroll scroll position threshold fallback
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (showFilters) setShowFilters(false);
      if (showMoreTabs) setShowMoreTabs(false);
      if (isAssignMenuOpen) setIsAssignMenuOpen(false);
      if (!hasMore || loadingMore || !onLoadMore) return;
      const target = e.currentTarget;
      if (target.scrollHeight - target.scrollTop - target.clientHeight < 250) {
        onLoadMore();
      }
    },
    [showFilters, showMoreTabs, isAssignMenuOpen, hasMore, loadingMore, onLoadMore]
  );

  // Bulk Selection Handlers
  const handleToggleCheck = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = () => {
    if (selectedIds.size === filteredAndSorted.length && filteredAndSorted.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredAndSorted.map((c) => c.id)));
    }
  };

  const handleBulkResolveClick = async () => {
    if (selectedIds.size === 0 || !onBulkResolve) return;
    setIsBulkOperating(true);
    try {
      await onBulkResolve(Array.from(selectedIds));
      setSelectedIds(new Set());
      setIsSelectionMode(false);
    } finally {
      setIsBulkOperating(false);
    }
  };

  const handleBulkAssignClick = async (agentId: string | null) => {
    if (selectedIds.size === 0 || !onBulkAssign) return;
    setIsBulkOperating(true);
    try {
      await onBulkAssign(Array.from(selectedIds), agentId);
      setSelectedIds(new Set());
      setIsSelectionMode(false);
      setIsAssignMenuOpen(false);
    } finally {
      setIsBulkOperating(false);
    }
  };

  const handleBulkMarkSpamClick = async () => {
    if (selectedIds.size === 0 || !onBulkMarkSpam) return;
    setIsBulkOperating(true);
    try {
      await onBulkMarkSpam(Array.from(selectedIds));
      setSelectedIds(new Set());
      setIsSelectionMode(false);
    } finally {
      setIsBulkOperating(false);
    }
  };

  // Keyboard navigation for moving between conversations (ArrowUp / ArrowDown / J / K)
  useEffect(() => {
    const handleNavKeys = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName.toLowerCase();
      const isInputActive =
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        (document.activeElement as HTMLElement)?.isContentEditable;

      // Modifier combos belong to someone else (Ctrl/Cmd+K is the command palette).
      if (isInputActive || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        if (filteredAndSorted.length === 0) return;
        const currentIndex = filteredAndSorted.findIndex(
          (c) => c.id === selectedConversationId
        );
        const nextIndex =
          currentIndex < filteredAndSorted.length - 1 ? currentIndex + 1 : 0;
        onSelectConversation(filteredAndSorted[nextIndex].id);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        if (filteredAndSorted.length === 0) return;
        const currentIndex = filteredAndSorted.findIndex(
          (c) => c.id === selectedConversationId
        );
        const prevIndex =
          currentIndex > 0 ? currentIndex - 1 : filteredAndSorted.length - 1;
        onSelectConversation(filteredAndSorted[prevIndex].id);
      }
    };

    window.addEventListener('keydown', handleNavKeys);
    return () => window.removeEventListener('keydown', handleNavKeys);
  }, [filteredAndSorted, selectedConversationId, onSelectConversation]);

  // Scroll active item into view when changed via keyboard
  useEffect(() => {
    if (!selectedConversationId || !listContainerRef.current) return;
    const selectedEl = listContainerRef.current.querySelector('[data-selected="true"]');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedConversationId]);

  const hasActiveFilters =
    channelFilter !== 'all' ||
    selectedTagFilter !== 'all' ||
    sortBy !== 'newest';

  const isAllFilteredSelected =
    filteredAndSorted.length > 0 && selectedIds.size === filteredAndSorted.length;

  return (
    <div className="w-full h-[var(--app-vvh,100dvh)] flex flex-col border-r border-line bg-surface select-none relative min-w-0">
      {/* 1. Header Toolbar */}
      <div className="p-3 border-b border-line/80 space-y-2 bg-surface relative z-30 min-w-0">
        <div className="flex items-center justify-between gap-1.5 px-0.5 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <h2 className="text-lg md:text-sm font-bold tracking-tight text-ink">
              Inbox
            </h2>
          </div>

          <div className="flex items-center gap-1 shrink-0 min-w-0">
            {/* Test Chat simulator shortcut button */}
            {onOpenSimulator && (
              <button
                type="button"
                onClick={onOpenSimulator}
                title="Send test chat (Simulator)"
                aria-label="Send test chat"
                className="w-9 h-9 md:w-7 md:h-7 rounded-lg inline-flex items-center justify-center transition-all border border-line/70 bg-surface-2 text-ink-3 hover:text-accent hover:border-accent/40 hover:bg-accent/10 shadow-2xs shrink-0 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-accent shrink-0" />
              </button>
            )}

            {/* Bulk select toggle */}
            <button
              type="button"
              onClick={() => {
                if (isSelectionMode) {
                  setIsSelectionMode(false);
                  setSelectedIds(new Set());
                } else {
                  setIsSelectionMode(true);
                }
              }}
              title={isSelectionMode ? 'Cancel bulk select' : 'Bulk select conversations'}
              aria-label="Bulk select conversations"
              className={cn(
                'w-9 h-9 md:w-7 md:h-7 rounded-lg inline-flex items-center justify-center transition-all border shrink-0 cursor-pointer',
                isSelectionMode || selectedIds.size > 0
                  ? 'border-accent bg-accent/10 text-accent font-bold'
                  : 'border-line/70 bg-surface-2 text-ink-3 hover:text-ink hover:bg-surface-3'
              )}
            >
              <CheckSquare className="w-3.5 h-3.5 shrink-0" />
            </button>

            {/* Sync / Refresh Button */}
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={isRefreshing}
                title={isRefreshing ? 'Refreshing inbox…' : 'Refresh inbox (Press R)'}
                className={cn(
                  'w-9 h-9 md:w-7 md:h-7 rounded-lg flex items-center justify-center transition-all border border-line/70 hover:border-line hover:bg-surface-3 text-ink-3 hover:text-ink shrink-0 cursor-pointer',
                  isRefreshing && 'bg-surface-3 text-accent cursor-not-allowed'
                )}
              >
                <RefreshCw
                  className={cn(
                    'w-3.5 h-3.5 transition-transform shrink-0',
                    isRefreshing && 'animate-spin text-accent'
                  )}
                />
              </button>
            )}

            {/* Sort & Filter Popover Trigger */}
            <div ref={filterRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => setShowFilters((v) => !v)}
                aria-label="Sort & Filters"
                title={`${SORT_LABELS[sortBy].label} • Click to change sort & filters`}
                className={cn(
                  'h-9 md:h-7 px-2.5 md:px-2 rounded-lg text-xs md:text-2xs font-semibold inline-flex items-center gap-1.5 transition-all border shadow-2xs whitespace-nowrap shrink-0 cursor-pointer',
                  hasActiveFilters
                    ? 'border-accent/50 bg-accent/10 text-accent font-bold ring-1 ring-accent/20'
                    : 'border-line/70 bg-surface-2 text-ink-3 hover:text-ink hover:bg-surface-3'
                )}
              >
                <ArrowUpDown className="w-2.5 h-2.5 shrink-0" />
                <span className="hidden min-[400px]:inline truncate max-w-[85px]">{SORT_LABELS[sortBy].label}</span>
                <SlidersHorizontal className="w-2.5 h-2.5 opacity-60 shrink-0 ml-0.5" />
                {hasActiveFilters && (
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0 animate-pulse" />
                )}
              </button>

              {/* Filter Popover Menu */}
              {showFilters && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[min(18rem,calc(100vw-1.5rem))] p-3.5 rounded-2xl border border-line bg-surface shadow-2xl animate-pop text-left">
                  {/* Sort Order Selector */}
                  <div className="mb-3">
                    <div className="flex items-center gap-1 text-2xs font-bold text-ink-3 uppercase tracking-wider mb-1.5">
                      <ArrowUpDown className="w-3 h-3 text-accent" />
                      Sort Order
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(Object.keys(SORT_LABELS) as SortOption[]).map((key) => (
                        <button
                          key={key}
                          onClick={() => setSortBy(key)}
                          className={cn(
                            'px-2 py-1.5 rounded-lg text-2xs font-medium transition-all text-left border',
                            sortBy === key
                              ? 'bg-accent text-accent-ink border-accent font-bold shadow-xs'
                              : 'bg-surface-2 text-ink-2 hover:bg-surface-3 border-line/60'
                          )}
                        >
                          <div className="leading-tight">{SORT_LABELS[key].label}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Channel Selector */}
                  <div className="mb-3 pt-2.5 border-t border-line">
                    <div className="text-2xs font-bold text-ink-3 uppercase tracking-wider mb-1.5">
                      Channel
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {CHANNELS.map((ch) => (
                        <button
                          key={ch.value}
                          onClick={() => setChannelFilter(ch.value)}
                          className={cn(
                            'px-2.5 h-6 rounded-lg text-2xs font-semibold transition-all',
                            channelFilter === ch.value
                              ? 'bg-ink text-ink-inv shadow-xs'
                              : 'bg-surface-2 text-ink-2 hover:bg-surface-3 border border-line/60'
                          )}
                        >
                          {ch.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Tag Selector */}
                  {availableTags.length > 0 && (
                    <div className="mb-3 pt-2.5 border-t border-line">
                      <div className="text-2xs font-bold text-ink-3 uppercase tracking-wider mb-1.5">
                        Tag
                      </div>
                      <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                        <button
                          onClick={() => setSelectedTagFilter('all')}
                          className={cn(
                            'px-2 h-5.5 rounded-lg text-2xs font-semibold transition-all',
                            selectedTagFilter === 'all'
                              ? 'bg-ink text-ink-inv'
                              : 'bg-surface-2 text-ink-2 hover:bg-surface-3 border border-line/60'
                          )}
                        >
                          All
                        </button>
                        {availableTags.map((tag) => (
                          <button
                            key={tag}
                            onClick={() => setSelectedTagFilter(tag)}
                            className={cn(
                              'px-2 h-5.5 rounded-lg text-2xs font-semibold transition-all flex items-center gap-1',
                              selectedTagFilter === tag
                                ? 'bg-accent text-accent-ink'
                                : 'bg-surface-2 text-ink-2 hover:bg-surface-3 border border-line/60'
                            )}
                          >
                            #{tag}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {hasActiveFilters && (
                    <div className="pt-2 border-t border-line/80 flex justify-end">
                      <button
                        onClick={() => {
                          setSortBy('newest');
                          setChannelFilter('all');
                          setSelectedTagFilter('all');
                        }}
                        className="text-2xs font-semibold text-accent hover:underline"
                      >
                        Reset filters
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 2. Search Bar */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input input-sm h-10 md:h-8 pl-8.5 pr-14 bg-surface-2 text-base md:text-xs w-full border-line/70 focus:border-accent"
          />
          {searchQuery ? (
            <button
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <span className="kbd hidden md:inline-flex absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-2xs">
              /
            </span>
          )}
        </div>

        {/* 3. Requirement 2: Status Tabs: Primary (Open, Waiting, Mine) + More Menu (Unassigned, Resolved, All) */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-surface-2 border border-line/70 min-w-0">
          {PRIMARY_STATUS_TABS.map((tab) => {
            const active = activeTab === tab.id;
            const count = counts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  if (selectedIds.size > 0) setSelectedIds(new Set());
                }}
                title={`${tab.label} (${count})`}
                className={cn(
                  'h-8 md:h-6 px-2.5 md:px-2 rounded-lg text-xs md:text-2xs font-medium transition-all flex items-center justify-center gap-1 shrink-0 cursor-pointer',
                  active
                    ? 'bg-surface text-ink shadow-xs border border-line/60 font-bold'
                    : 'text-ink-3 hover:text-ink hover:bg-surface-3/60'
                )}
              >
                <span>{tab.label}</span>
                {count > 0 && (
                  <span
                    className={cn(
                      'tabular-nums text-2xs px-1 py-0.1 rounded-full font-bold',
                      active
                        ? tab.id === 'waiting'
                          ? 'bg-warn/15 text-warn'
                          : 'bg-accent/10 text-accent'
                        : 'bg-surface-3 text-ink-3'
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}

          {/* More Tabs Dropdown */}
          {(() => {
            const isMoreTabActive = MORE_STATUS_TABS.some((t) => t.id === activeTab);
            const activeMoreTab = MORE_STATUS_TABS.find((t) => t.id === activeTab);
            const moreTotalCount = MORE_STATUS_TABS.reduce((acc, t) => acc + (counts[t.id] || 0), 0);
            return (
              <div className="relative shrink-0 ml-auto" ref={moreTabsRef}>
                <button
                  type="button"
                  onClick={() => setShowMoreTabs((v) => !v)}
                  title={isMoreTabActive ? `${activeMoreTab?.label} (Click for more tabs)` : 'More status tabs'}
                  className={cn(
                    'h-8 md:h-6 px-2.5 md:px-2 rounded-lg text-xs md:text-2xs font-medium transition-all flex items-center justify-center gap-1 shrink-0 cursor-pointer',
                    isMoreTabActive
                      ? 'bg-surface text-ink shadow-xs border border-line/60 font-bold'
                      : 'text-ink-3 hover:text-ink hover:bg-surface-3/60'
                  )}
                >
                  <span>{isMoreTabActive ? activeMoreTab?.label : 'More'}</span>
                  {isMoreTabActive && activeMoreTab && counts[activeMoreTab.id] > 0 ? (
                    <span className="tabular-nums text-2xs px-1 py-0.1 rounded-full font-bold bg-accent/10 text-accent">
                      {counts[activeMoreTab.id]}
                    </span>
                  ) : !isMoreTabActive && moreTotalCount > 0 ? (
                    <span className="tabular-nums text-2xs px-1 py-0.1 rounded-full font-bold bg-surface-3 text-ink-3">
                      {moreTotalCount}
                    </span>
                  ) : null}
                  <ChevronDown className="w-2.5 h-2.5 opacity-60 shrink-0" />
                </button>

                {showMoreTabs && (
                  <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-44 p-1.5 rounded-xl border border-line bg-surface shadow-xl animate-pop text-left space-y-0.5">
                    {MORE_STATUS_TABS.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          setActiveTab(tab.id);
                          setShowMoreTabs(false);
                          if (selectedIds.size > 0) setSelectedIds(new Set());
                        }}
                        className={cn(
                          'w-full px-2.5 py-2.5 md:py-1.5 rounded-lg text-ui md:text-2xs font-medium transition-all flex items-center justify-between cursor-pointer',
                          activeTab === tab.id
                            ? 'bg-accent/10 text-accent font-bold'
                            : 'text-ink-2 hover:bg-surface-2'
                        )}
                      >
                        <span>{tab.label}</span>
                        <span className="tabular-nums text-2xs px-1.5 py-0.2 rounded-full font-bold bg-surface-2 text-ink-3 border border-line/40">
                          {counts[tab.id]}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Requirement 3: Bulk Actions Toolbar (Sticky when items selected) */}
      {(selectedIds.size > 0 || isSelectionMode) && (
        <div className="p-2 border-b border-accent/30 bg-accent/[0.06] dark:bg-accent/15 flex items-center justify-between gap-2 z-20 animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={handleSelectAll}
              title={isAllFilteredSelected ? 'Deselect all' : 'Select all visible'}
              className="w-4 h-4 rounded border border-accent bg-surface flex items-center justify-center text-accent shrink-0"
            >
              {isAllFilteredSelected ? (
                <Check className="w-3 h-3 stroke-[3]" />
              ) : selectedIds.size > 0 ? (
                <div className="w-2 h-2 bg-accent rounded-xs" />
              ) : null}
            </button>
            <span className="text-xs font-bold text-ink truncate">
              {selectedIds.size} selected
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Resolve bulk */}
            {onBulkResolve && (
              <button
                disabled={selectedIds.size === 0 || isBulkOperating}
                onClick={handleBulkResolveClick}
                className="btn btn-xs btn-primary gap-1 shadow-xs"
                title="Resolve selected conversations"
              >
                <CheckCircle2 className="w-3 h-3" />
                <span>Resolve</span>
              </button>
            )}

            {/* Assign bulk */}
            {onBulkAssign && (
              <div ref={assignMenuRef} className="relative">
                <button
                  disabled={selectedIds.size === 0 || isBulkOperating}
                  onClick={() => setIsAssignMenuOpen((v) => !v)}
                  className="btn btn-xs btn-secondary gap-1"
                  title="Assign selected conversations to agent"
                >
                  <UserPlus className="w-3 h-3" />
                  <span>Assign</span>
                </button>

                {isAssignMenuOpen && (
                  <div className="absolute right-0 top-[calc(100%+4px)] z-50 w-48 p-1.5 rounded-xl border border-line bg-surface shadow-xl text-left animate-pop">
                    <div className="px-2 py-1 text-2xs font-bold text-ink-3 uppercase tracking-wider">
                      Assign to teammate
                    </div>
                    <button
                      onClick={() => handleBulkAssignClick(null)}
                      className="w-full text-left px-2 py-1.5 rounded-lg text-2xs font-medium text-ink-2 hover:bg-surface-2 transition-colors flex items-center gap-2"
                    >
                      <Users className="w-3 h-3 text-ink-3" />
                      <span>Unassign</span>
                    </button>
                    {agentsList.map((ag) => (
                      <button
                        key={ag.id}
                        onClick={() => handleBulkAssignClick(ag.id)}
                        className="w-full text-left px-2 py-1.5 rounded-lg text-2xs font-medium text-ink hover:bg-surface-2 transition-colors flex items-center gap-2"
                      >
                        <Avatar name={ag.name} seed={ag.id} size="xs" />
                        <span className="truncate">{ag.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Mark as spam bulk */}
            {onBulkMarkSpam && (
              <button
                disabled={selectedIds.size === 0 || isBulkOperating}
                onClick={handleBulkMarkSpamClick}
                className="btn btn-xs btn-secondary text-danger hover:bg-danger/10 border-danger/20 gap-1"
                title="Mark selected as spam and close"
              >
                <ShieldAlert className="w-3 h-3" />
                <span className="hidden sm:inline">Spam</span>
              </button>
            )}

            {/* Cancel Selection */}
            <button
              onClick={() => {
                setSelectedIds(new Set());
                setIsSelectionMode(false);
              }}
              title="Clear selection"
              className="p-1 rounded-md text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 4. Conversations List Canvas (Infinite Scroll in pages of 30) */}
      <div
        ref={listContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overscroll-contain px-2.5 md:px-2 py-2.5 md:py-2 space-y-2 md:space-y-1.5 scrollbar-thin relative z-0"
      >
        {loading ? (
          <ConversationListSkeleton />
        ) : filteredAndSorted.length === 0 ? (
          <div className="p-4 flex items-center justify-center h-full">
            {searchQuery ? (
              <EmptyState
                type="no-search-results"
                title="No matching threads"
                description={`No conversations matched "${searchQuery}". Try another keyword or clear your query.`}
                actionLabel="Clear Search"
                onAction={() => setSearchQuery('')}
              />
            ) : (
              <EmptyState
                type="no-conversations"
                title={
                  activeTab === 'resolved'
                    ? 'No resolved conversations'
                    : activeTab === 'waiting'
                    ? 'No waiting customers'
                    : activeTab === 'unassigned'
                    ? 'Nothing unassigned'
                    : activeTab === 'mine'
                    ? 'Nothing assigned to you'
                    : 'Inbox zero'
                }
                description={
                  hasActiveFilters
                    ? 'No conversations match the currently selected filters.'
                    : 'When visitors send a message on your site, conversations appear here live.'
                }
                actionLabel={
                  hasActiveFilters
                    ? 'Reset Filters'
                    : onOpenSimulator
                    ? 'Send yourself a test chat'
                    : undefined
                }
                onAction={() => {
                  if (hasActiveFilters) {
                    setSortBy('newest');
                    setChannelFilter('all');
                    setSelectedTagFilter('all');
                  } else if (onOpenSimulator) {
                    onOpenSimulator();
                  }
                }}
              />
            )}
          </div>
        ) : (
          <>
            {filteredAndSorted.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isSelected={conv.id === selectedConversationId}
                onSelect={onSelectConversation}
                currentAgent={currentAgent}
                isSelectionMode={isSelectionMode}
                isChecked={selectedIds.has(conv.id)}
                onToggleCheck={handleToggleCheck}
              />
            ))}

            {/* Infinite Scroll Sentinel element */}
            <div ref={sentinelRef} className="h-4 w-full pointer-events-none" />

            {/* Loading more indicator */}
            {loadingMore && (
              <div className="py-2.5 flex items-center justify-center gap-2 text-ink-3 text-2xs font-medium animate-pulse">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                <span>Loading more conversations…</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
