'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { Agent, Conversation, Message, Visitor, Workspace, AgentStatus, ConversationStatus, ConversationPriority, CannedResponse } from '@/types/database';
import { Sidebar, type View } from '@/components/dashboard/Sidebar';
import { ConversationList } from '@/components/dashboard/ConversationList';
import { ChatThread } from '@/components/dashboard/ChatThread';
import { VisitorDetailsSidebar } from '@/components/dashboard/VisitorDetailsSidebar';
import { getOpenUnansweredCountAction } from '@/app/actions/unanswered';
import { EmptyState } from '@/components/ui/EmptyState';
import { DashboardCommandPalette } from '@/components/dashboard/DashboardCommandPalette';
import { MobileInstallBanner } from '@/components/pwa/MobileInstallBanner';
import { sound } from '@/lib/sound';
import { sendBrowserNotification, cn } from '@/lib/utils';
import { updateFaviconBadge } from '@/lib/favicon';
import { SetupChecklist } from '@/components/dashboard/SetupChecklist';
import { isVisitorOnline } from '@/lib/tracking/visitor-tracking';
import { isWaitingForPerson } from '@/lib/inbox/handovers';
import type { SectionId } from '@/components/dashboard/SettingsHub';
import { BarChart2, BookOpen, Inbox, MessagesSquare, Radio, Settings, Smartphone, ShieldAlert, LogOut, Sparkles, Ticket, HelpCircle, Hand } from 'lucide-react';
import { exitSuperAdminWorkspaceViewAction } from '@/app/actions/platform';
import dynamic from 'next/dynamic';
import { LoadingState } from '@/components/ui/States';
import { useTeamInbox } from '@/lib/team-chat/use-team-inbox';
import type { TeamChatShare } from '@/components/team-chat/TeamChat';
import type { TeamInboxRow, TeamMessage } from '@/types/database';

// Views other than the inbox load when first opened. Bundled together they
// made the dashboard download about 2 MB of script before the inbox could
// show (reports alone bring a charting library).
const viewLoading = () => <LoadingState className="flex-1" />;
const LiveVisitorsRadar = dynamic(() => import('@/components/dashboard/LiveVisitorsRadar').then((m) => m.LiveVisitorsRadar), { loading: viewLoading });
const SettingsHub = dynamic(() => import('@/components/dashboard/SettingsHub').then((m) => m.SettingsHub), { loading: viewLoading });
const ReportsDashboard = dynamic(() => import('@/components/reports/ReportsDashboard').then((m) => m.ReportsDashboard), { loading: viewLoading });
const HelpDeskDashboard = dynamic(() => import('@/components/dashboard/HelpDeskDashboard').then((m) => m.HelpDeskDashboard), { loading: viewLoading });
const TicketsView = dynamic(() => import('@/components/tickets/TicketsView').then((m) => m.TicketsView), { loading: viewLoading });
const HandoversView = dynamic(() => import('@/components/dashboard/HandoversView').then((m) => m.HandoversView), { loading: viewLoading });
const UnansweredQuestionsView = dynamic(() => import('@/components/dashboard/UnansweredQuestionsView').then((m) => m.UnansweredQuestionsView), { loading: viewLoading });
const KeyboardShortcutsModal = dynamic(() => import('@/components/ui/KeyboardShortcutsModal').then((m) => m.KeyboardShortcutsModal));
const TeamChat = dynamic(() => import('@/components/team-chat/TeamChat').then((m) => m.TeamChat), { loading: viewLoading });
const MobileInstallModal = dynamic(() => import('@/components/pwa/MobileInstallModal').then((m) => m.MobileInstallModal));

/**
 * Whether the AI assistant is the one replying on a thread. Mirrors the checks
 * in /api/ai/auto-respond, so the composer is only locked when the assistant
 * will actually answer.
 */
function isAiAnswering(conv: Conversation, ws: Workspace | null): boolean {
  if (conv.ai_mode === 'disabled') return false;
  const s = ws?.ai_settings;
  return !s || (s.enabled !== false && s.auto_response_enabled !== false);
}

export default function DashboardPage() {
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [currentAgent, setCurrentAgent] = useState<Agent | null>(null);
  const [isViewingAsSuperAdmin, setIsViewingAsSuperAdmin] = useState(false);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([]);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [showMobileInstallModal, setShowMobileInstallModal] = useState(false);
  const [isDetailsSidebarOpen, setIsDetailsSidebarOpen] = useState(true);
  const [articlesCount, setArticlesCount] = useState(0);
  const [sectionsCount, setSectionsCount] = useState(0);
  const [unansweredCount, setUnansweredCount] = useState(0);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId | undefined>(undefined);
  const [settingsNonce, setSettingsNonce] = useState(0);
  // What the command palette asked the tickets screen to show.
  const [ticketsRequest, setTicketsRequest] = useState<{ viewId?: string; ticketId?: string; nonce: number } | null>(null);

  useEffect(() => {
    if (currentWorkspace?.id) {
      getOpenUnansweredCountAction(currentWorkspace.id)
        .then(setUnansweredCount)
        .catch(() => {});
    }
  }, [currentWorkspace?.id]);

  // Five destinations: the inbox, the visitor radar, reports, help desk,
  // and the Settings hub.
  const [activeView, setActiveView] = useState<View>('inbox');

  // Conversations & Messages (Pages of 30)
  const PAGE_SIZE = 30;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  // Size the app to the *visible* viewport. On phones this shrinks when the
  // on-screen keyboard opens, so the composer stays above it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const sync = () => root.style.setProperty('--app-vvh', `${Math.round(vv.height)}px`);
    sync();
    vv.addEventListener('resize', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      root.style.removeProperty('--app-vvh');
    };
  }, []);

  // Mobile: an open conversation is its own history entry, so the browser
  // back button / edge-swipe returns to the list instead of leaving the app.
  useEffect(() => {
    if (!selectedConversationId) return;
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    if (window.history.state?.zentryThread) return;
    window.history.pushState({ ...(window.history.state || {}), zentryThread: true }, '');
  }, [selectedConversationId]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      if (!e.state?.zentryThread) setSelectedConversationId(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const handleMobileBack = useCallback(() => {
    if (window.history.state?.zentryThread) {
      window.history.back(); // popstate clears the selection
    } else {
      setSelectedConversationId(null);
    }
  }, []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date>(new Date());
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const messagesCacheRef = useRef<Record<string, Message[]>>({});

  // Visitors
  const [visitors, setVisitors] = useState<Visitor[]>([]);

  // Refs for tracking active state in realtime callbacks
  const selectedConversationIdRef = useRef<string | null>(null);
  selectedConversationIdRef.current = selectedConversationId;

  const currentWorkspaceIdRef = useRef<string | null>(null);
  currentWorkspaceIdRef.current = currentWorkspace?.id || null;

  const currentAgentRef = useRef<Agent | null>(null);
  currentAgentRef.current = currentAgent;

  const currentWorkspaceRef = useRef<Workspace | null>(null);
  currentWorkspaceRef.current = currentWorkspace;

  // Arms audio so the agent's first click anywhere unlocks it; otherwise the
  // browser silently drops alerts until they happen to interact.
  useEffect(() => {
    sound.prime();
  }, []);

  const conversationsRef = useRef<Conversation[]>([]);
  conversationsRef.current = conversations;

  // Team chat. The thread list lives here so the sidebar badge and alerts work
  // on every view. A direct message or an @mention rings (unless that thread
  // is on screen); other channel chatter only counts.
  const [teamShare, setTeamShare] = useState<TeamChatShare | null>(null);
  const [teamThreadRequest, setTeamThreadRequest] = useState<{ threadId: string; nonce: number } | null>(null);
  const openTeamThreadRef = useRef<string | null>(null);
  const activeViewRef = useRef<View>('inbox');
  const allAgentsRef = useRef<Agent[]>([]);
  useEffect(() => {
    activeViewRef.current = activeView;
    allAgentsRef.current = allAgents;
  }, [activeView, allAgents]);
  const onTeamMessage = useCallback((msg: TeamMessage, threads: TeamInboxRow[]) => {
    const me = currentAgentRef.current?.id;
    if (!me || msg.sender_id === me) return;
    const thread = threads.find((t) => t.thread_id === msg.thread_id);
    // A thread not in the list yet is a direct message someone just started.
    const direct = !thread || thread.kind === 'direct';
    const mentioned = (msg.mentions || []).includes(me);
    if (!direct && !mentioned) return;
    const looking =
      activeViewRef.current === 'team' && openTeamThreadRef.current === msg.thread_id && document.visibilityState === 'visible';
    if (looking) return;
    const sender = allAgentsRef.current.find((a) => a.id === msg.sender_id);
    const name = sender?.name || sender?.email || 'A teammate';
    sound.playMention();
    sendBrowserNotification(direct ? name : `${name} mentioned you`, msg.content, {
      tag: `team-${msg.thread_id}`,
      onClick: () => {
        setActiveView('team');
        setTeamThreadRequest({ threadId: msg.thread_id, nonce: Date.now() });
      },
    });
  }, []);
  const teamInbox = useTeamInbox(supabase, currentWorkspace?.id, onTeamMessage);
  const onTeamThreadChange = useCallback((threadId: string | null) => {
    openTeamThreadRef.current = threadId;
  }, []);

  // Bumped to tear down and re-open the realtime channels after a dropped
  // connection (laptop sleep, network change, server restart).
  const [realtimeEpoch, setRealtimeEpoch] = useState(0);
  const realtimeHealthyRef = useRef(true);

  // Dynamically update favicon badge and title count when unread conversations change
  useEffect(() => {
    const unreadTotal = conversations.reduce(
      (acc, c) => acc + (c.unread_count || 0),
      0
    );
    updateFaviconBadge(unreadTotal);
  }, [conversations]);

  // Global Keyboard Shortcuts Listener (? for cheatsheet, Esc to deselect, R to refresh)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName.toLowerCase();
      const isInputActive =
        activeTag === 'input' ||
        activeTag === 'textarea' ||
        (document.activeElement as HTMLElement)?.isContentEditable;

      if (e.key === '?' && !isInputActive && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowShortcutsModal((prev) => !prev);
        return;
      }

      // 'r' or 'R' to refresh when not typing
      if ((e.key === 'r' || e.key === 'R') && !isInputActive && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        refreshConversations();
        return;
      }

      // Escape used to deselect even while typing a reply, throwing away the
      // draft along with the thread.
      if (
        e.key === 'Escape' &&
        !showShortcutsModal &&
        selectedConversationId &&
        !isInputActive
      ) {
        setSelectedConversationId(null);
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [showShortcutsModal, selectedConversationId]);


  // 1. Initial Load & Auth Verification
  const initializeDashboard = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/login?redirect=%2Fdashboard');
        return;
      }

      // Fetch or auto-create agent profile
      let agent: Agent | null = null;
      // The agent and their workspace in one round trip (the embed follows
      // agents.workspace_id); if the embed is refused, the plain row still
      // loads and the workspace is fetched below as before.
      let joinedWorkspace: Workspace | null = null;
      const first = await supabase
        .from('agents')
        .select('*, workspace:workspaces(*)')
        .eq('id', session.user.id)
        .maybeSingle();
      let agentData = first.data;
      if (first.error) {
        ({ data: agentData } = await supabase.from('agents').select('*').eq('id', session.user.id).maybeSingle());
      } else if (agentData?.workspace) {
        joinedWorkspace = agentData.workspace as Workspace;
      }
      if (agentData) delete (agentData as { workspace?: unknown }).workspace;

      if (agentData) {
        agent = agentData as Agent;
      } else {
        const newAgent = {
          id: session.user.id,
          name: session.user.user_metadata?.name || session.user.email?.split('@')[0] || 'Agent',
          email: session.user.email || '',
          status: 'online' as AgentStatus,
          role: 'owner',
        };
        const { data: inserted } = await supabase.from('agents').upsert(newAgent).select().single();
        agent = inserted as Agent;
      }

      // Check if user has a workspace
      let workspace: Workspace | null = null;
      let viewingSuperAdmin = false;

      // If user is a super admin, check if they are viewing a switched workspace
      if (agent?.is_super_admin) {
        const cookieMatch = typeof document !== 'undefined' ? document.cookie.match(/super_admin_viewing_workspace_id=([^;]+)/) : null;
        const switchedId = cookieMatch ? decodeURIComponent(cookieMatch[1].trim()) : null;
        if (switchedId) {
          const { data: switchedWs } = await supabase
            .from('workspaces')
            .select('*')
            .eq('id', switchedId)
            .maybeSingle();
          if (switchedWs) {
            workspace = switchedWs as Workspace;
            viewingSuperAdmin = true;
          }
        }
      }

      // A deactivated agent keeps their account but loses the workspace.
      if (agent && agent.is_active === false && !agent.is_super_admin) {
        await supabase.auth.signOut();
        router.replace(
          `/login?error=${encodeURIComponent('Your access to this workspace was deactivated. Contact a workspace admin to get it back.')}`
        );
        return;
      }

      setIsViewingAsSuperAdmin(viewingSuperAdmin);

      if (!workspace && joinedWorkspace && joinedWorkspace.id === agent?.workspace_id) {
        workspace = joinedWorkspace;
      }
      if (!workspace && agent?.workspace_id) {
        const { data: wsData } = await supabase
          .from('workspaces')
          .select('*')
          .eq('id', agent.workspace_id)
          .maybeSingle();
        workspace = wsData as Workspace;
      }

      // If still no workspace, check if user owns one
      if (!workspace) {
        const { data: ownedWs } = await supabase
          .from('workspaces')
          .select('*')
          .eq('owner_id', session.user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (ownedWs) {
          workspace = ownedWs as Workspace;
          // link agent to this workspace
          await supabase.from('agents').update({ workspace_id: workspace.id }).eq('id', session.user.id);
          agent.workspace_id = workspace.id;
        }
      }

      // If user has NO workspace at all, redirect to Admin if platform admin, else Onboarding
      if (!workspace) {
        if (agent?.is_super_admin) {
          router.replace('/admin');
          return;
        }
        router.replace('/onboarding');
        return;
      }

      // If user is not super admin and workspace is suspended or deleted, log out and redirect
      if (!agent?.is_super_admin) {
        if (workspace.is_suspended) {
          await supabase.auth.signOut();
          router.replace(
            `/login?error=${encodeURIComponent(
              workspace.suspension_reason
                ? `Workspace suspended: ${workspace.suspension_reason}`
                : 'This workspace is currently suspended. Please contact your platform administrator.'
            )}`
          );
          return;
        }

        if (workspace.deleted_at) {
          await supabase.auth.signOut();
          router.replace(
            `/login?error=${encodeURIComponent('This workspace has been deactivated/deleted. Please contact support.')}`
          );
          return;
        }
      }

      setCurrentAgent(agent);
      setCurrentWorkspace(workspace);

      // Everything below depends only on the workspace, so it loads at once
      // instead of six round trips one after another.
      const [{ data: agentsList }, , , { data: cannedList }, { count: artCount }, { count: secCount }] = await Promise.all([
        supabase.from('agents').select('*').eq('workspace_id', workspace.id),
        refreshConversations(workspace.id),
        refreshVisitors(workspace.id),
        supabase.from('canned_responses').select('*').eq('workspace_id', workspace.id).order('shortcut'),
        supabase.from('articles').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
        supabase.from('help_sections').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
      ]);
      if (agentsList) setAllAgents(agentsList as Agent[]);
      if (cannedList) setCannedResponses(cannedList as CannedResponse[]);
      if (artCount !== null && artCount !== undefined) setArticlesCount(artCount);
      if (secCount !== null && secCount !== undefined) setSectionsCount(secCount);

      // Trigger auto-close rule for stale inactive conversations (light agents cannot change conversations)
      try {
        if (agent?.role === 'light_agent') throw new Error('skip');
        const autoCloseDays = (workspace?.auto_assignment as any)?.auto_close_inactive_days || workspace?.auto_close_days || 7;
        fetch('/api/conversations/auto-close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspace.id, days: autoCloseDays }),
        }).catch(() => {});
      } catch (e) {}

      setLoading(false);
    } catch (err) {
      console.error('Error initializing dashboard:', err);
      setLoading(false);
    }
  }, [supabase, router]);

  useEffect(() => {
    initializeDashboard();
  }, [initializeDashboard]);

  // Unread-reply emails to customers are sent by the scheduler
  // (/api/cron/unread-notifications, migration 20261104090000). Every open
  // dashboard used to trigger the platform-wide job once a minute.

  const handleOpenSimulator = useCallback(() => {
    if (!currentWorkspace) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_APP_URL || '');
    const simUrl = `${origin}/demo.html?workspaceId=${encodeURIComponent(currentWorkspace.id)}&name=${encodeURIComponent(currentWorkspace.name)}`;
    window.open(simUrl, '_blank');
  }, [currentWorkspace]);

  const handleOpenSettingsSection = useCallback((section: SectionId) => {
    setSettingsInitialSection(section);
    setSettingsNonce((n) => n + 1);
    setActiveView('settings');
  }, []);

  // Instagram's login sends the admin back here with ?settings=channels.
  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get('settings');
    if (target === 'channels') handleOpenSettingsSection('channels');
  }, [handleOpenSettingsSection]);

  // Team alert emails link to /dashboard?conversation=<id>. RLS decides
  // whether it loads; an id from another workspace simply shows nothing.
  const openLinkedConversation = useCallback(
    async (id: string) => {
      setActiveView('inbox');
      setSelectedConversationId(id);
      // The inbox loads the 30 most recent conversations; a linked one may be
      // older, so it is fetched on its own and put at the top.
      const { data } = await supabase
        .from('conversations')
        .select('*, visitor:visitors(*), agent:agents(*)')
        .eq('id', id)
        .maybeSingle();
      if (data) {
        setConversations((prev) => (prev.some((c) => c.id === id) ? prev : [data as Conversation, ...prev]));
      }
    },
    [supabase]
  );
  const linkedConversationOpened = useRef(false);
  useEffect(() => {
    // Once, after the first load: the initial conversation list would
    // otherwise replace the one the link put at the top.
    if (loading || linkedConversationOpened.current) return;
    const id = new URLSearchParams(window.location.search).get('conversation');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    linkedConversationOpened.current = true;
    const timer = window.setTimeout(() => void openLinkedConversation(id), 0);
    return () => window.clearTimeout(timer);
  }, [loading, openLinkedConversation]);

  const handleOpenTickets = useCallback((target: { viewId?: string; ticketId?: string }) => {
    setTicketsRequest({ ...target, nonce: Date.now() });
    setActiveView('tickets');
  }, []);

  // 2. Fetch Messages for Active Conversation with Instant In-Memory Cache
  const loadMessages = useCallback(async (conversationId: string) => {
    // 1. Instant Cache Hit: Show messages immediately (0ms perceived lag)
    if (messagesCacheRef.current[conversationId]) {
      setMessages(messagesCacheRef.current[conversationId]);
      setIsMessagesLoading(false);
    } else {
      setIsMessagesLoading(true);
    }

    // 2. Fetch fresh messages in the background
    const { data, error } = await supabase
      .from('messages')
      .select('*, agent:agents(*)')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Failed to load messages:', error);
      setIsMessagesLoading(false);
      return;
    }

    const fetchedMessages = (data as Message[]) || [];
    messagesCacheRef.current[conversationId] = fetchedMessages;

    // Only update active state if the agent is still viewing this conversation
    if (selectedConversationIdRef.current === conversationId) {
      setMessages(fetchedMessages);
      setIsMessagesLoading(false);
    }

    // Opening the thread is the agent reading it.
    try {
      await supabase.rpc('fn_mark_messages_read', {
        p_conversation_id: conversationId,
        p_exclude_sender: 'agent',
      });
    } catch {
      // ignored
    }

    // Immediately clear unread_count for the opened conversation in UI state
    // while keeping last_message intact so conversation list ordering does not jump
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              unread_count: 0,
              last_message:
                c.last_message ||
                (fetchedMessages.length > 0
                  ? fetchedMessages[fetchedMessages.length - 1]
                  : null),
            }
          : c
      )
    );
  }, [supabase]);

  // 3. Fetch/Refresh Conversations (Pages of 30, ordered by updated_at)
  const refreshConversations = useCallback(
    async (wsId?: string, pageNum: number = 0, isAppend: boolean = false) => {
      const targetWsId = wsId || currentWorkspaceIdRef.current;
      if (isAppend) {
        setLoadingMore(true);
      } else {
        setIsRefreshing(true);
      }
      try {
        let query = supabase
          .from('conversations')
          .select(`
            *,
            visitor:visitors(*),
            agent:agents(*)
          `)
          .order('updated_at', { ascending: false })
          .range(pageNum * PAGE_SIZE, (pageNum + 1) * PAGE_SIZE - 1);

        if (targetWsId) {
          query = query.eq('workspace_id', targetWsId);
        }

        const { data: convData, error } = await query;
        if (error) {
          console.error('Failed to fetch conversations:', error);
          setConversationsError(error.message || 'Conversations could not be loaded.');
          return;
        }
        setConversationsError(null);

        const fetchedConvs = (convData as any[]) || [];
        if (fetchedConvs.length < PAGE_SIZE) {
          setHasMore(false);
        } else {
          setHasMore(true);
        }

        if (fetchedConvs.length === 0 && !isAppend) {
          setConversations([]);
          setLastSynced(new Date());
          return;
        }

        const convIds = fetchedConvs.map((c: any) => c.id);

        // In parallel: Batch fetch unread visitor messages and latest messages in 2 queries
        let unreadCountMap: Record<string, number> = {};
        let latestMessageMap: Record<string, Message> = {};

        const visitorMsgCounts: Record<string, number> = {};
        // One small row per conversation (fn_inbox_summaries). Until that
        // migration is applied the call fails and the old way below runs,
        // which downloads every message of the page's conversations.
        const summaries =
          convIds.length > 0 ? await supabase.rpc('fn_inbox_summaries', { p_conversation_ids: convIds }) : null;
        if (summaries && !summaries.error && Array.isArray(summaries.data)) {
          for (const row of summaries.data as {
            conversation_id: string;
            last_message: Message | null;
            unread_count: number;
            has_visitor_message: boolean;
          }[]) {
            if (row.unread_count) unreadCountMap[row.conversation_id] = row.unread_count;
            if (row.last_message) latestMessageMap[row.conversation_id] = row.last_message;
            if (row.has_visitor_message) visitorMsgCounts[row.conversation_id] = 1;
          }
        } else if (convIds.length > 0) {
          const [unreadRes, recentMsgsRes] = await Promise.all([
            supabase
              .from('messages')
              .select('conversation_id')
              .in('conversation_id', convIds)
              .eq('sender_type', 'visitor')
              .is('read_at', null),
            supabase
              .from('messages')
              .select('*')
              .in('conversation_id', convIds)
              .order('created_at', { ascending: false }),
          ]);

          if (unreadRes.data) {
            for (const row of unreadRes.data) {
              unreadCountMap[row.conversation_id] = (unreadCountMap[row.conversation_id] || 0) + 1;
            }
          }

          if (recentMsgsRes.data) {
            for (const msg of recentMsgsRes.data) {
              if (msg.sender_type === 'visitor') {
                visitorMsgCounts[msg.conversation_id] = (visitorMsgCounts[msg.conversation_id] || 0) + 1;
              }
              if (!latestMessageMap[msg.conversation_id]) {
                latestMessageMap[msg.conversation_id] = msg as Message;
              }
            }
          }
        }

        // Auto-close abandoned empty conversations (0 visitor messages after 10 minutes).
        // The batch above is capped by the API (1,000 rows), so a busy page can
        // be missing older conversations' messages entirely. Absence there is
        // not proof: candidates are re-checked with a query of their own before
        // anything is closed.
        let abandonedIds: string[] = [];
        const nowMs = Date.now();
        const candidates = fetchedConvs
          .filter((c: any) => {
            if (c.status !== 'open' || visitorMsgCounts[c.id]) return false;
            const ageMinutes = (nowMs - new Date(c.created_at || c.updated_at).getTime()) / (1000 * 60);
            return ageMinutes >= 10;
          })
          .map((c: any) => c.id as string);

        if (candidates.length > 0) {
          const { data: withVisitorMsgs } = await supabase
            .from('messages')
            .select('conversation_id')
            .in('conversation_id', candidates)
            .eq('sender_type', 'visitor')
            .limit(1000);
          const spoken = new Set((withVisitorMsgs || []).map((r: any) => r.conversation_id));
          abandonedIds = candidates.filter((id: string) => !spoken.has(id));
        }

        if (abandonedIds.length > 0) {
          const closedAt = new Date().toISOString();
          // Per conversation, so each keeps its own channel_metadata (language
          // override, autopilot history) instead of all being replaced.
          for (const c of fetchedConvs.filter((fc: any) => abandonedIds.includes(fc.id))) {
            supabase
              .from('conversations')
              .update({
                status: 'closed',
                closed_at: closedAt,
                channel_metadata: {
                  ...((c.channel_metadata as Record<string, any>) || {}),
                  auto_closed_reason: 'no_customer_message_10m',
                },
              })
              .eq('id', c.id)
              .eq('status', 'open')
              .then();
          }
        }

        const knownLastMessage = new Map(
          conversationsRef.current.map((c) => [c.id, c.last_message] as const)
        );
        const enrichedConversations: Conversation[] = fetchedConvs.map((c: any) => {
          const isCurrentlySelected = selectedConversationIdRef.current === c.id;
          const isAutoClosed = abandonedIds.includes(c.id);
          return {
            ...c,
            status: isAutoClosed ? 'closed' : c.status,
            closed_at: isAutoClosed ? (c.closed_at || new Date().toISOString()) : c.closed_at,
            // Missing from the capped batch is not "no messages": keep what we had.
            last_message: latestMessageMap[c.id] || knownLastMessage.get(c.id) || null,
            unread_count: isCurrentlySelected ? 0 : (unreadCountMap[c.id] || 0),
          };
        });

        if (isAppend) {
          setPage(pageNum);
          setConversations((prev) => {
            const existingIds = new Set(prev.map((c) => c.id));
            const newItems = enrichedConversations.filter((c) => !existingIds.has(c.id));
            return [...prev, ...newItems];
          });
        } else {
          setPage(0);
          // Preserve currently active conversation so chat never drops or backs out
          setConversations((prev) => {
            const currentSelectedId = selectedConversationIdRef.current;
            if (currentSelectedId) {
              const existingCurrent = prev.find((c) => c.id === currentSelectedId);
              if (existingCurrent && !enrichedConversations.some((c) => c.id === currentSelectedId)) {
                enrichedConversations.unshift(existingCurrent);
              }
            }
            return enrichedConversations;
          });

          // Desktop opens the newest thread; phones start on the list.
          const isPhone = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
          if (!selectedConversationIdRef.current && enrichedConversations.length > 0 && !isPhone) {
            setSelectedConversationId(enrichedConversations[0].id);
          } else if (selectedConversationIdRef.current) {
            loadMessages(selectedConversationIdRef.current);
          }
        }
        setLastSynced(new Date());
      } catch (err) {
        console.error('Failed to refresh conversations:', err);
      } finally {
        setIsRefreshing(false);
        setLoadingMore(false);
      }
    },
    [supabase, loadMessages]
  );

  // Infinite Scroll: Load Next Page of 30
  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    refreshConversations(undefined, page + 1, true);
  }, [loadingMore, hasMore, page, refreshConversations]);

  // Bulk Action 1: Resolve Selected Conversations
  const handleBulkResolve = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const nowIso = new Date().toISOString();
      await supabase
        .from('conversations')
        .update({ status: 'closed', closed_at: nowIso, updated_at: nowIso })
        .in('id', ids);

      setConversations((prev) =>
        prev.map((c) => (ids.includes(c.id) ? { ...c, status: 'closed', closed_at: nowIso } : c))
      );
    },
    [supabase]
  );

  // Bulk Action 2: Assign Selected Conversations to Agent
  const handleBulkAssign = useCallback(
    async (ids: string[], agentId: string | null) => {
      if (ids.length === 0) return;
      const nowIso = new Date().toISOString();
      const assignedAgent = allAgents.find((a) => a.id === agentId) || null;
      await supabase
        .from('conversations')
        .update({
          assigned_agent_id: agentId,
          agent_id: agentId,
          updated_at: nowIso,
        })
        .in('id', ids);

      setConversations((prev) =>
        prev.map((c) =>
          ids.includes(c.id)
            ? {
                ...c,
                assigned_agent_id: agentId,
                agent_id: agentId,
                agent: assignedAgent || undefined,
                updated_at: nowIso,
              }
            : c
        )
      );
    },
    [supabase, allAgents]
  );

  // Bulk Action 3: Mark Selected Conversations as Spam
  const handleBulkMarkSpam = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const nowIso = new Date().toISOString();
      for (const id of ids) {
        const conv = conversations.find((c) => c.id === id);
        const curTags = conv?.tags || [];
        const updatedTags = curTags.includes('Spam') ? curTags : [...curTags, 'Spam'];
        await supabase
          .from('conversations')
          .update({
            status: 'closed',
            closed_at: nowIso,
            tags: updatedTags,
            updated_at: nowIso,
          })
          .eq('id', id);
      }

      setConversations((prev) =>
        prev.map((c) =>
          ids.includes(c.id)
            ? {
                ...c,
                status: 'closed',
                closed_at: nowIso,
                tags: c.tags?.includes('Spam') ? c.tags : [...(c.tags || []), 'Spam'],
                updated_at: nowIso,
              }
            : c
        )
      );
    },
    [supabase, conversations]
  );

  // 4. Refresh Visitors
  const refreshVisitors = async (wsId?: string) => {
    const targetWsId = wsId || currentWorkspaceIdRef.current;
    // The most recently seen visitors only: every site visit creates a row,
    // so "all of them" grows without bound (and PostgREST stops at 1000 anyway).
    // Realtime adds newcomers as they arrive.
    let query = supabase
      .from('visitors')
      .select('*')
      .order('last_seen', { ascending: false })
      .limit(300);

    if (targetWsId) {
      query = query.eq('workspace_id', targetWsId);
    }

    const { data: vData, error } = await query;
    if (error) {
      console.error('Failed to fetch visitors:', error);
      return;
    }
    setVisitors((vData as Visitor[]) || []);
  };

  useEffect(() => {
    if (selectedConversationId) {
      loadMessages(selectedConversationId);
    } else {
      setMessages([]);
    }
  }, [selectedConversationId, loadMessages]);

  // 5. Supabase Realtime Subscriptions
  // Conversations and visitors are filtered to this workspace on the server.
  // Unfiltered, every visitor heartbeat on every customer site reached every
  // open dashboard (and Realtime ran an RLS check for each one), which is what
  // made the inbox sluggish as the platform grew.
  const realtimeWorkspaceId = currentWorkspace?.id;
  useEffect(() => {
    if (!realtimeWorkspaceId) return;
    const wsFilter = `workspace_id=eq.${realtimeWorkspaceId}`;
    const channelSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // A channel that errors, times out or closes is re-opened a few seconds
    // later; once it is back, one refresh picks up whatever was missed.
    const onStatus = (status: string) => {
      if (cancelled) return;
      if (status === 'SUBSCRIBED') {
        if (!realtimeHealthyRef.current) {
          realtimeHealthyRef.current = true;
          refreshConversations();
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        realtimeHealthyRef.current = false;
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => setRealtimeEpoch((n) => n + 1), 3000);
        }
      }
    };

    const messagesChannel = supabase
      .channel(`zen-try-dashboard-messages-${channelSuffix}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload: any) => {
          const newMsg = payload.new as Message;

          if (newMsg.conversation_id === selectedConversationIdRef.current) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMsg.id)) return prev;
              return [...prev, newMsg];
            });

            if (newMsg.sender_type === 'visitor') {
              // Arriving over realtime IS delivery. Whether it counts as read
              // depends on the agent actually looking at the tab.
              const receipt = document.hasFocus()
                ? 'fn_mark_messages_read'
                : 'fn_mark_messages_delivered';
              supabase
                .rpc(receipt, {
                  p_conversation_id: newMsg.conversation_id,
                  p_exclude_sender: 'agent',
                })
                .then(undefined, () => {});
            }
          }

          // The bot could not answer: tell the person it was given to (or
          // everyone, when nobody could be assigned), loudly and by name. Ringing
          // for every message the bot is answering buried this one.
          const meta = (newMsg.metadata || {}) as { is_handover?: boolean; assigned_agent_id?: string | null };
          if (newMsg.is_internal && meta.is_handover) {
            const me = currentAgentRef.current?.id;
            if (!meta.assigned_agent_id || meta.assigned_agent_id === me) {
              const conv = conversationsRef.current.find((c) => c.id === newMsg.conversation_id);
              const customer = conv?.visitor?.name || conv?.visitor?.email || 'A customer';
              sound.playMention();
              sendBrowserNotification(
                meta.assigned_agent_id ? `${customer} needs you` : `${customer} needs someone`,
                'The bot could not answer. Open the chat to reply.',
                {
                  tag: `handover-${newMsg.conversation_id}`,
                  onClick: () => {
                    setActiveView('inbox');
                    setSelectedConversationId(newMsg.conversation_id);
                  },
                }
              );
            }
          }

          if (newMsg.sender_type === 'visitor') {
            const conv = conversationsRef.current.find((c) => c.id === newMsg.conversation_id);
            // While the bot is answering on its own, a new line is not a call
            // for a person; the list still shows it. It rings again the moment
            // the bot hands over (above) or a person takes the chat.
            // (New chats are assigned on creation, so the assignee does not
            // mean a person is answering; a person's reply pauses the bot.)
            const botHandling = conv?.ai_mode === 'autopilot' && !conv.ai_paused_reason && !conv.ai_needs_attention_at;
            if (!botHandling) {
              sound.playIncomingMessage();
              sendBrowserNotification('New Customer Message', newMsg.content || 'Sent an attachment', {
                tag: `msg-${newMsg.conversation_id}`,
                onClick: () => {
                  setSelectedConversationId(newMsg.conversation_id);
                },
              });
            }

            // Dispatch offline agent email check
            fetch('/api/notifications/dispatch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'new_message',
                conversation_id: newMsg.conversation_id,
                message: newMsg,
                workspace_id: currentWorkspaceIdRef.current,
              }),
            }).catch((err) => console.error('[Offline Email Dispatch]:', err));
          }

          // Update in-memory cache immediately
          if (messagesCacheRef.current[newMsg.conversation_id]) {
            const cached = messagesCacheRef.current[newMsg.conversation_id];
            if (!cached.some((m) => m.id === newMsg.id)) {
              messagesCacheRef.current[newMsg.conversation_id] = [...cached, newMsg];
            }
          }

          // 1. If conversation already exists in memory, bump to top immediately
          setConversations((prev) => {
            const index = prev.findIndex((c) => c.id === newMsg.conversation_id);
            if (index !== -1) {
              const target = prev[index];
              const isSelected = target.id === selectedConversationIdRef.current;
              const updated: Conversation = {
                ...target,
                status: newMsg.sender_type === 'visitor' ? 'open' : target.status,
                closed_at: newMsg.sender_type === 'visitor' ? null : target.closed_at,
                snoozed_until: newMsg.sender_type === 'visitor' ? null : target.snoozed_until,
                updated_at: newMsg.created_at,
                last_message: newMsg,
                unread_count: isSelected
                  ? 0
                  : newMsg.sender_type === 'visitor'
                  ? (target.unread_count || 0) + 1
                  : target.unread_count,
              };
              const others = prev.filter((c) => c.id !== newMsg.conversation_id);
              return [updated, ...others];
            }
            return prev;
          });

          // 2. Fetch conversation details outside state updater to guarantee visitor details and instant appearance
          supabase
            .from('conversations')
            .select('*, visitor:visitors(*), agent:agents(*)')
            .eq('id', newMsg.conversation_id)
            .single()
            .then(({ data: fetchedConv }: any) => {
              if (fetchedConv) {
                if (
                  currentWorkspaceIdRef.current &&
                  fetchedConv.workspace_id &&
                  fetchedConv.workspace_id !== currentWorkspaceIdRef.current
                ) {
                  return;
                }

                const isSelected = fetchedConv.id === selectedConversationIdRef.current;
                const newConvItem: Conversation = {
                  ...fetchedConv,
                  status: newMsg.sender_type === 'visitor' ? 'open' : fetchedConv.status,
                  closed_at: newMsg.sender_type === 'visitor' ? null : fetchedConv.closed_at,
                  snoozed_until: newMsg.sender_type === 'visitor' ? null : fetchedConv.snoozed_until,
                  updated_at: newMsg.created_at,
                  last_message: newMsg,
                  unread_count: isSelected ? 0 : (newMsg.sender_type === 'visitor' ? 1 : 0),
                };

                setConversations((current) => {
                  const exists = current.some((c) => c.id === newConvItem.id);
                  if (exists) {
                    return current.map((c) => (c.id === newConvItem.id ? { ...c, ...newConvItem } : c));
                  }
                  return [newConvItem, ...current];
                });

                if (!selectedConversationIdRef.current) {
                  setSelectedConversationId(newConvItem.id);
                }
              }
            })
            .catch(() => {});
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload: any) => {
          const updatedMsg = payload.new as Message;
          if (messagesCacheRef.current[updatedMsg.conversation_id]) {
            messagesCacheRef.current[updatedMsg.conversation_id] = messagesCacheRef.current[
              updatedMsg.conversation_id
            ].map((m) => (m.id === updatedMsg.id ? { ...m, ...updatedMsg } : m));
          }
          if (updatedMsg.conversation_id === selectedConversationIdRef.current) {
            setMessages((prev) =>
              prev.map((m) => (m.id === updatedMsg.id ? { ...m, ...updatedMsg } : m))
            );
          }
          setConversations((prev) =>
            prev.map((c) =>
              c.id === updatedMsg.conversation_id && (!c.last_message || c.last_message.id === updatedMsg.id)
                ? { ...c, last_message: { ...(c.last_message || {}), ...updatedMsg } }
                : c
            )
          );
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages' },
        (payload: any) => {
          const deletedId = payload.old?.id;
          if (!deletedId) return;
          setMessages((prev) => prev.filter((m) => m.id !== deletedId));
          for (const convId in messagesCacheRef.current) {
            messagesCacheRef.current[convId] = messagesCacheRef.current[convId].filter(
              (m) => m.id !== deletedId
            );
          }
          refreshConversations();
        }
      )
      .subscribe(onStatus);

    const conversationsChannel = supabase
      .channel(`zen-try-dashboard-conversations-${channelSuffix}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations', filter: wsFilter },
        (payload: any) => {
          if (payload.eventType === 'INSERT') {
            sound.playNewConversation();
            const newConv = payload.new as Conversation;
            sendBrowserNotification(
              'New Conversation Started',
              'A visitor started a new conversation on your site.',
              {
                tag: `conv-${newConv.id}`,
                onClick: () => {
                  setSelectedConversationId(newConv.id);
                },
              }
            );

            // Fetch enriched conversation details (visitor, agent) and prepend smoothly
            supabase
              .from('conversations')
              .select('*, visitor:visitors(*), agent:agents(*)')
              .eq('id', newConv.id)
              .single()
              .then(({ data }: any) => {
                if (data) {
                  if (
                    currentWorkspaceIdRef.current &&
                    data.workspace_id &&
                    data.workspace_id !== currentWorkspaceIdRef.current
                  ) {
                    return;
                  }
                  setConversations((prev) => {
                    if (prev.some((c) => c.id === data.id)) return prev;
                    return [data as Conversation, ...prev];
                  });
                  if (!selectedConversationIdRef.current) {
                    setSelectedConversationId(data.id);
                  }
                }
              })
              .catch(() => {});

            // Dispatch Slack notification
            fetch('/api/notifications/dispatch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'conversation_created',
                conversation_id: newConv.id,
                workspace_id: currentWorkspaceIdRef.current,
              }),
            }).catch((err) => console.error('[Slack Dispatch]:', err));
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as Conversation;
            setConversations((prev) =>
              prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c))
            );
          }
        }
      )
      .subscribe(onStatus);

    const visitorsChannel = supabase
      .channel(`zen-try-dashboard-visitors-${channelSuffix}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'visitors', filter: wsFilter },
        (payload: any) => {
          const updatedVisitor = payload.new as Visitor;
          // Only process if belongs to this workspace
          if (
            currentWorkspaceIdRef.current &&
            updatedVisitor.workspace_id &&
            updatedVisitor.workspace_id !== currentWorkspaceIdRef.current
          ) {
            return;
          }

          setVisitors((prev) => {
            const index = prev.findIndex((v) => v.id === updatedVisitor.id);
            if (index >= 0) {
              const copy = [...prev];
              copy[index] = updatedVisitor;
              return copy;
            } else {
              return [updatedVisitor, ...prev];
            }
          });

          setConversations((prev) =>
            prev.map((c) =>
              c.visitor_id === updatedVisitor.id ? { ...c, visitor: updatedVisitor } : c
            )
          );
        }
      )
      .subscribe(onStatus);

    const internalNotesChannel = supabase
      .channel(`zen-try-dashboard-internal-notes-${channelSuffix}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'internal_notes' },
        (payload: any) => {
          const note = payload.new as any;
          const agentId = currentAgentRef.current?.id;
          if (
            agentId &&
            note.mentioned_agent_ids?.includes(agentId) &&
            note.agent_id !== agentId
          ) {
            sound.playMention();
            sendBrowserNotification(
              'You were @mentioned in a conversation',
              note.content
            );
          }
        }
      )
      .subscribe(onStatus);

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      supabase.removeChannel(messagesChannel);
      supabase.removeChannel(conversationsChannel);
      supabase.removeChannel(visitorsChannel);
      supabase.removeChannel(internalNotesChannel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, realtimeEpoch, realtimeWorkspaceId]);

  // Realtime events are lost while a laptop sleeps or a tab is frozen in the
  // background, without any error being raised. Coming back to the tab, or
  // back online, re-syncs the list and the open thread; a slow heartbeat
  // covers the rest (faster while realtime is known to be down).
  useEffect(() => {
    let lastSync = Date.now();
    const sync = (minGapMs: number) => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastSync < minGapMs) return;
      if (!currentWorkspaceIdRef.current) return;
      lastSync = Date.now();
      refreshConversations();
    };
    const onVisible = () => sync(5_000);
    const onOnline = () => {
      realtimeHealthyRef.current = false;
      setRealtimeEpoch((n) => n + 1);
      sync(0);
    };
    const heartbeat = setInterval(
      () => sync(realtimeHealthyRef.current ? 120_000 : 15_000),
      15_000
    );
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [refreshConversations]);

  // 6. Action Handlers
  /**
   * The thread passes the conversation it is actually showing. Reading
   * `selectedConversationId` here instead was a second source of truth, and
   * when it was momentarily null the send returned silently — the composer had
   * already cleared the text, so the reply vanished with no error and no
   * message. Every failure path now throws so the caller can restore the draft.
   */
  const handleSendMessage = async (
    content: string,
    isInternal: boolean = false,
    conversationId?: string,
    replyToId?: string | null,
    attachmentUrl?: string | null,
    metadata?: Record<string, any> | null
  ) => {
    const targetId = conversationId || selectedConversationIdRef.current;
    if (!targetId) {
      throw new Error('No conversation selected — reply not sent.');
    }
    if (!currentAgent) {
      throw new Error('Your session expired — reload and try again.');
    }
    const target = conversations.find((c) => c.id === targetId);
    if (!isInternal) {
      if (target && isAiAnswering(target, currentWorkspaceRef.current)) {
        throw new Error('AI autopilot is replying to this conversation — take over to reply.');
      }
    }

    const shouldAutoAssign = !isInternal && target && (!target.agent_id && !target.assigned_agent_id);

    if (shouldAutoAssign) {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetId
            ? { ...c, agent_id: currentAgent.id, assigned_agent_id: currentAgent.id, agent: currentAgent }
            : c
        )
      );
    }

    const { data: insertedMsg, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: targetId,
        sender_type: 'agent',
        sender_id: currentAgent.id,
        content: content || (attachmentUrl ? 'Sent an attachment' : ''),
        is_internal: isInternal,
        ...(metadata ? { metadata } : {}),
        ...(attachmentUrl ? { attachment_url: attachmentUrl } : {}),
        // Omitted rather than set to null when there is no quote, so the insert
        // still works against a database that has not run the migration yet.
        ...(replyToId ? { reply_to_message_id: replyToId } : {}),
      })
      .select('*, agent:agents(*)')
      .single();

    if (error) {
      console.error('Error sending message:', error);
      throw error;
    }

    // Immediately display the note/reply in the thread without waiting for realtime latency
    if (insertedMsg && insertedMsg.conversation_id === selectedConversationIdRef.current) {
      setMessages((prev) => {
        if (prev.some((m) => m.id === insertedMsg.id)) return prev;
        return [...prev, insertedMsg as Message];
      });
    }

    if (!isInternal) {
      const now = new Date().toISOString();
      const newStatus = target?.status === 'closed' ? 'closed' : 'pending';

      await supabase
        .from('conversations')
        .update({
          updated_at: now,
          status: newStatus,
          ai_mode: 'disabled',
          channel_metadata: {
            ...((target?.channel_metadata as Record<string, any>) || {}),
            last_human_reply_at: now,
          },
          ...(shouldAutoAssign ? { agent_id: currentAgent.id, assigned_agent_id: currentAgent.id } : {}),
        })
        .eq('id', targetId);

      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetId
            ? {
                ...c,
                status: newStatus,
                ai_mode: 'disabled',
                last_message: (insertedMsg as Message) || c.last_message,
                channel_metadata: {
                  ...((c.channel_metadata as Record<string, any>) || {}),
                  last_human_reply_at: now,
                },
                ...(shouldAutoAssign ? { agent_id: currentAgent.id, assigned_agent_id: currentAgent.id, agent: currentAgent } : {}),
              }
            : c
        )
      );

      // Real-time Reinforcement Learning: Learn from human agent's verified reply in this workspace
      if (currentWorkspaceRef.current?.id && insertedMsg?.id && content?.trim()) {
        fetch('/api/ai/reinforce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: currentWorkspaceRef.current.id,
            conversationId: targetId,
            agentMessageId: insertedMsg.id,
            agentContent: content,
          }),
        }).catch((err) => {
          console.warn('[Reinforce] Background learning failed:', err);
        });
      }
    } else {
      await supabase
        .from('conversations')
        .update({
          updated_at: new Date().toISOString(),
          ...(shouldAutoAssign ? { agent_id: currentAgent.id, assigned_agent_id: currentAgent.id } : {}),
        })
        .eq('id', targetId);

      setConversations((prev) =>
        prev.map((c) =>
          c.id === targetId
            ? {
                ...c,
                last_message: (insertedMsg as Message) || c.last_message,
                ...(shouldAutoAssign ? { agent_id: currentAgent.id, assigned_agent_id: currentAgent.id, agent: currentAgent } : {}),
              }
            : c
        )
      );
    }
  };

  const handleEditMessage = async (messageId: string, newContent: string) => {
    if (!currentAgent) {
      throw new Error('Your session expired — reload and try again.');
    }

    const nowIso = new Date().toISOString();

    // 1. Optimistic local state update
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              content: newContent,
              metadata: {
                ...(m.metadata || {}),
                is_edited: true,
                edited_at: nowIso,
              },
            }
          : m
      )
    );

    if (selectedConversationId && messagesCacheRef.current[selectedConversationId]) {
      messagesCacheRef.current[selectedConversationId] = messagesCacheRef.current[
        selectedConversationId
      ].map((m) =>
        m.id === messageId
          ? {
              ...m,
              content: newContent,
              metadata: {
                ...(m.metadata || {}),
                is_edited: true,
                edited_at: nowIso,
              },
            }
          : m
      );
    }

    // 2. Fetch current metadata
    const { data: existing } = await supabase
      .from('messages')
      .select('metadata')
      .eq('id', messageId)
      .single();

    const currentMeta = (existing?.metadata as Record<string, any>) || {};

    // 3. Update message content in database
    const { error } = await supabase
      .from('messages')
      .update({
        content: newContent,
        metadata: {
          ...currentMeta,
          is_edited: true,
          edited_at: nowIso,
        },
      })
      .eq('id', messageId);

    if (error) {
      console.error('Error editing message:', error);
      if (selectedConversationId) {
        loadMessages(selectedConversationId);
      }
      throw error;
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!currentAgent) {
      throw new Error('Your session expired — reload and try again.');
    }

    // 1. Optimistic local state removal
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    if (selectedConversationId && messagesCacheRef.current[selectedConversationId]) {
      messagesCacheRef.current[selectedConversationId] = messagesCacheRef.current[
        selectedConversationId
      ].filter((m) => m.id !== messageId);
    }

    // 2. Delete row from database
    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('id', messageId);

    if (error) {
      console.error('Error deleting message:', error);
      if (selectedConversationId) {
        loadMessages(selectedConversationId);
      }
      throw error;
    }

    refreshConversations();
  };

  const handleUpdatePriority = async (priority: ConversationPriority) => {
    if (!selectedConversationId) return;

    const { error } = await supabase
      .from('conversations')
      .update({ priority, updated_at: new Date().toISOString() })
      .eq('id', selectedConversationId);

    if (error) {
      console.error('Error updating conversation priority:', error);
      return;
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === selectedConversationId ? { ...c, priority } : c))
    );
  };

  const handleUpdateTags = async (tags: string[]) => {
    if (!selectedConversationId) return;

    const { error } = await supabase
      .from('conversations')
      .update({ tags, updated_at: new Date().toISOString() })
      .eq('id', selectedConversationId);

    if (error) {
      console.error('Error updating conversation tags:', error);
      return;
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === selectedConversationId ? { ...c, tags } : c))
    );
  };

  const handleUpdateStatus = async (status: ConversationStatus) => {
    if (!selectedConversationId) return;

    const updates: Partial<Conversation> = {
      status,
      closed_at: status === 'closed' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('conversations')
      .update(updates)
      .eq('id', selectedConversationId);

    if (error) {
      console.error('Error updating conversation status:', error);
      return;
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === selectedConversationId ? { ...c, ...updates } : c))
    );
  };

  const handleAssignAgent = async (agentId: string | null) => {
    if (!selectedConversationId) return;

    const { error } = await supabase
      .from('conversations')
      .update({
        agent_id: agentId,
        assigned_agent_id: agentId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', selectedConversationId);

    if (error) {
      console.error('Error assigning agent:', error);
      return;
    }

    const assignedAgent = allAgents.find((a) => a.id === agentId) || null;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === selectedConversationId
          ? { ...c, agent_id: agentId, assigned_agent_id: agentId, agent: assignedAgent }
          : c
      )
    );
  };

  const handleUpdateAgentStatus = async (status: AgentStatus) => {
    if (!currentAgent) return;

    const { error } = await supabase
      .from('agents')
      .update({ status })
      .eq('id', currentAgent.id);

    if (error) {
      console.error('Error updating agent status:', error);
      return;
    }
    setCurrentAgent((prev) => (prev ? { ...prev, status } : null));
  };

  const handleOpenConversationForVisitor = async (visitorId: string) => {
    let existing = conversations.find((c) => c.visitor_id === visitorId);
    if (!existing) {
      const { data } = await supabase
        .from('conversations')
        .insert({
          visitor_id: visitorId,
          workspace_id: currentWorkspace?.id || null,
          status: 'open',
        })
        .select('*, visitor:visitors(*)')
        .single();

      if (data) {
        existing = data as Conversation;
        setConversations((prev) => [existing!, ...prev]);
      }
    }

    if (existing) {
      setSelectedConversationId(existing.id);
      setActiveView('inbox');
    }
  };

  const handleLogout = async () => {
    if (currentAgent) {
      await supabase.from('agents').update({ status: 'offline' }).eq('id', currentAgent.id);
    }
    await supabase.auth.signOut();
    router.replace('/login');
  };

  const activeConversation = conversations.find((c) => c.id === selectedConversationId);

  const isAdmin =
    currentAgent?.role === 'admin' || currentAgent?.role === 'owner';

  const counts = {
    open: conversations.filter((c) => c.status === 'open').length,
    liveVisitors: visitors.filter((v) => isVisitorOnline(v)).length,
    articles: articlesCount,
    unanswered: unansweredCount,
    handovers: conversations.filter(isWaitingForPerson).length,
    teamUnread: teamInbox.unread,
    teamUrgent: teamInbox.urgent,
  };

  if (loading) {
    return (
      <div className="h-screen w-screen bg-canvas flex flex-col items-center justify-center gap-4">
        <div className="w-14 h-14 flex items-center justify-center animate-breathe">
          <img
            src="/logo.png"
            alt="Loading"
            className="w-full h-full object-contain filter drop-shadow-sm"
          />
        </div>
        <p className="text-ui font-medium text-ink-3">Loading workspace…</p>
      </div>
    );
  }

  const handleExitSuperAdminView = async () => {
    await exitSuperAdminWorkspaceViewAction();
    window.location.reload();
  };

  return (
    <div className="flex flex-col h-[var(--app-vvh,100dvh)] w-screen overflow-hidden bg-canvas relative">
      {/* Super Admin Switch Banner */}
      {isViewingAsSuperAdmin && (
        <div className="bg-accent text-white px-6 py-2.5 text-xs font-semibold flex items-center justify-between shadow-md z-50 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex h-2 w-2 rounded-full bg-warn animate-ping" />
            <ShieldAlert className="w-4 h-4 text-warn" />
            <span>
              Viewing as super admin: <strong className="underline underline-offset-2">{currentWorkspace?.name}</strong>{' '}
              <span className="opacity-80 font-mono text-2xs">({currentWorkspace?.id})</span>
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <Link
              href="/admin"
              className="px-3 py-1 rounded-lg bg-white/20 hover:bg-white/30 text-white text-xs font-bold transition-colors"
            >
              Super Admin Area
            </Link>
            <button
              onClick={handleExitSuperAdminView}
              className="px-3 py-1 rounded-lg bg-danger/80 hover:bg-danger text-ink-inv text-xs font-bold flex items-center gap-1.5 transition-colors"
            >
              <LogOut className="w-3 h-3" />
              <span>Exit Super Admin View</span>
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden relative">
      {/* 1. Left Sidebar Navigation (Desktop) */}
      <div
        className={cn(
          'h-screen shrink-0',
          selectedConversationId ? 'hidden md:flex' : 'hidden md:flex'
        )}
      >
        <Sidebar
          currentAgent={currentAgent}
          workspace={currentWorkspace}
          activeView={activeView}
          onSelectView={setActiveView}
          counts={counts}
          onUpdateAgentStatus={handleUpdateAgentStatus}
          onLogout={handleLogout}
          onOpenShortcuts={() => setShowShortcutsModal(true)}
          onOpenMobileInstall={() => setShowMobileInstallModal(true)}
          hasVisitors={visitors.length > 0}
        />
      </div>

      {/* 2. Middle & Right Content Area based on activeView */}
      {activeView === 'inbox' && (
        <div className="flex-1 flex overflow-hidden w-full">
          {/* Conversation List: full width on mobile when no conversation active */}
          <div
            className={cn(
              'h-full shrink-0 flex flex-col min-w-0',
              selectedConversationId
                ? 'hidden md:flex md:w-[340px] xl:w-[360px]'
                : 'flex w-full md:w-[340px] xl:w-[360px] pb-14 md:pb-0'
            )}
          >
            <div className="px-3 pt-2.5 pb-0">
              <MobileInstallBanner onOpenModal={() => setShowMobileInstallModal(true)} />
            </div>
            {conversationsError && (
              <div role="alert" className="mx-3 mt-2 flex items-center gap-2 px-3 py-2 rounded-lg border border-danger-line bg-danger-soft text-xs text-danger">
                <span className="flex-1">Couldn&apos;t refresh conversations: {conversationsError}</span>
                <button type="button" className="btn btn-xs btn-secondary" onClick={() => refreshConversations()}>
                  Retry
                </button>
              </div>
            )}
            <ConversationList
              conversations={conversations}
              selectedConversationId={selectedConversationId}
              onSelectConversation={setSelectedConversationId}
              currentAgent={currentAgent}
              agentsList={allAgents}
              loading={loading}
              isRefreshing={isRefreshing}
              onRefresh={() => refreshConversations()}
              lastSynced={lastSynced}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={handleLoadMore}
              onBulkResolve={handleBulkResolve}
              onBulkAssign={handleBulkAssign}
              onBulkMarkSpam={handleBulkMarkSpam}
              onOpenSimulator={handleOpenSimulator}
            />
          </div>

          {/* Chat Thread + Visitor CRM Sidebar */}
          {activeConversation ? (
            <div
              className={cn(
                'flex-1 min-w-0 flex overflow-hidden',
                selectedConversationId ? 'flex w-full' : 'hidden md:flex'
              )}
            >
              <ChatThread
                conversation={activeConversation}
                messages={messages}
                loading={isMessagesLoading}
                currentAgent={currentAgent}
                agentsList={allAgents}
                cannedResponses={cannedResponses}
                workspace={currentWorkspace}
                onOpenTicket={(ticketId) => handleOpenTickets({ ticketId })}
                onAskTeam={() => {
                  setTeamShare({
                    conversationId: activeConversation.id,
                    label: activeConversation.visitor?.name || activeConversation.visitor?.email || 'Customer',
                  });
                  setActiveView('team');
                }}
                onSendMessage={handleSendMessage}
                onEditMessage={handleEditMessage}
                onDeleteMessage={handleDeleteMessage}
                onUpdateStatus={handleUpdateStatus}
                onAssignAgent={handleAssignAgent}
                onUpdatePriority={handleUpdatePriority}
                onUpdateTags={handleUpdateTags}
                onBack={handleMobileBack}
                isDetailsSidebarOpen={isDetailsSidebarOpen}
                onToggleDetailsSidebar={() => setIsDetailsSidebarOpen((prev) => !prev)}
                onMerged={async () => {
                  await refreshConversations();
                  if (selectedConversationId) {
                    await loadMessages(selectedConversationId);
                  }
                }}
                aiAnswering={isAiAnswering(activeConversation, currentWorkspace)}
                onToggleAiMode={async (mode) => {
                  if (!selectedConversationId) return;
                  const now = new Date().toISOString();
                  const metaUpdate = {
                    ...((activeConversation?.channel_metadata as Record<string, any>) || {}),
                    ...(mode === 'autopilot' ? { autopilot_enabled_at: now } : {}),
                    ...(mode === 'disabled' ? { ai_disabled_at: now } : {}),
                  };
                  const isAutopilot = mode === 'autopilot';
                  const dbUpdates: Record<string, any> = {
                    ai_mode: mode,
                    updated_at: now,
                    channel_metadata: metaUpdate,
                    ...(isAutopilot
                      ? {
                          ai_paused_reason: null,
                          ai_needs_attention_at: null,
                          ai_resumed_at: now,
                        }
                      : {
                          ai_paused_reason: 'agent_takeover',
                        }),
                  };
                  await supabase
                    .from('conversations')
                    .update(dbUpdates)
                    .eq('id', selectedConversationId);

                  setConversations((prev) =>
                    prev.map((c) =>
                      c.id === selectedConversationId
                        ? { ...c, ...dbUpdates, ai_mode: mode, channel_metadata: metaUpdate }
                        : c
                    )
                  );
                }}
              />

              {isDetailsSidebarOpen && (
                <VisitorDetailsSidebar
                  visitor={activeConversation.visitor}
                  conversation={activeConversation}
                  workspace={currentWorkspace}
                  currentAgent={currentAgent}
                  onSelectConversation={setSelectedConversationId}
                  onUpdateTags={handleUpdateTags}
                  onClose={() => setIsDetailsSidebarOpen(false)}
                />
              )}
            </div>
          ) : (
            <div className="hidden md:flex flex-1 min-w-0 flex-col items-center justify-start p-4 sm:p-6 lg:p-8 bg-canvas text-center select-none overflow-y-auto w-full space-y-6">
              {/* Setup Checklist */}
              <SetupChecklist
                workspace={currentWorkspace}
                visitors={visitors}
                allAgents={allAgents}
                conversations={conversations}
                articlesCount={articlesCount}
                sectionsCount={sectionsCount}
                onNavigate={setActiveView}
                onOpenSettingsSection={handleOpenSettingsSection}
                onOpenSimulator={handleOpenSimulator}
                className="w-full max-w-xl text-left"
              />

              <div className="max-w-xl w-full p-5 sm:p-6 rounded-3xl border border-line bg-surface shadow-xs flex flex-col items-center animate-rise min-w-0">
                <div className="flex items-center justify-between w-full mb-3 text-left">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
                      <Inbox className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-ink">Ready for conversations</h3>
                      <p className="text-xs text-ink-3">Live updates stream instantly as visitors arrive.</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleOpenSimulator}
                    className="btn btn-xs btn-primary gap-1.5 shadow-xs"
                  >
                    <Sparkles className="w-3 h-3" />
                    <span>Send test chat</span>
                  </button>
                </div>

                <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 w-full mb-4">
                  <button
                    onClick={() => setActiveView('visitors')}
                    className="flex-1 min-w-[130px] btn btn-sm btn-secondary shadow-xs hover:border-line-2 gap-1.5"
                  >
                    <Radio className="w-3.5 h-3.5 text-success shrink-0" />
                    <span className="truncate">Live Radar ({counts.liveVisitors})</span>
                  </button>
                  <button
                    onClick={() => handleOpenSettingsSection('widget')}
                    className="flex-1 min-w-[130px] btn btn-sm btn-secondary shadow-xs hover:border-line-2 gap-1.5"
                  >
                    <Settings className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">Widget Settings</span>
                  </button>
                </div>

                {/* Keyboard Quick Guide */}
                <div className="w-full pt-3 border-t border-line/60 grid grid-cols-2 sm:grid-cols-4 gap-2 text-2xs text-ink-3 text-left">
                  <div className="flex items-center justify-between px-2 py-1 rounded-lg bg-surface-2">
                    <span>Search inbox</span>
                    <span className="kbd text-2xs">/</span>
                  </div>
                  <div className="flex items-center justify-between px-2 py-1 rounded-lg bg-surface-2">
                    <span>Shortcuts</span>
                    <span className="kbd text-2xs">?</span>
                  </div>
                  <div className="flex items-center justify-between px-2 py-1 rounded-lg bg-surface-2">
                    <span>Saved Replies</span>
                    <span className="kbd text-2xs">/</span>
                  </div>
                  <div className="flex items-center justify-between px-2 py-1 rounded-lg bg-surface-2">
                    <span>Send Message</span>
                    <span className="kbd text-2xs">Ctrl ↵</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeView === 'visitors' && (
        <div className="flex-1 flex overflow-hidden w-full pb-14 md:pb-0">
          <LiveVisitorsRadar
            visitors={visitors}
            workspace={currentWorkspace}
            onOpenConversationForVisitor={handleOpenConversationForVisitor}
            onOpenTicket={(ticketId) => handleOpenTickets({ ticketId })}
            onRefresh={() => refreshVisitors()}
          />
        </div>
      )}

      {activeView === 'reports' && currentWorkspace && currentAgent && (
        <div className="flex-1 flex overflow-hidden w-full pb-14 md:pb-0">
          <ReportsDashboard
            workspace={currentWorkspace}
            currentAgent={currentAgent}
            onOpenSettings={(sec) => handleOpenSettingsSection(sec as SectionId)}
            onOpenInbox={() => setActiveView('inbox')}
          />
        </div>
      )}

      {activeView === 'team' && currentWorkspace && currentAgent && (
        <div className="flex-1 flex overflow-hidden w-full pb-14 md:pb-0">
          <TeamChat
            supabase={supabase}
            workspaceId={currentWorkspace.id}
            currentAgent={currentAgent}
            agents={allAgents}
            inbox={teamInbox}
            share={teamShare}
            onClearShare={() => setTeamShare(null)}
            requestedThread={teamThreadRequest}
            onOpenConversation={(id) => void openLinkedConversation(id)}
            conversationLabel={(id) => {
              const c = conversationsRef.current.find((x) => x.id === id);
              return c ? c.visitor?.name || c.visitor?.email || 'Customer' : null;
            }}
            onOpenThreadChange={onTeamThreadChange}
          />
        </div>
      )}

      {activeView === 'tickets' && currentWorkspace && (
        <div className="flex-1 flex overflow-hidden w-full pb-14 md:pb-0">
          <TicketsView workspaceId={currentWorkspace.id} request={ticketsRequest} />
        </div>
      )}

      {activeView === 'helpdesk' && (
        <div className="flex-1 flex overflow-hidden w-full pb-14 md:pb-0">
          <HelpDeskDashboard
            workspace={currentWorkspace}
            currentAgent={currentAgent}
            onArticlesCountChange={(c) => {
              setArticlesCount(c);
              if (currentWorkspace?.id) {
                supabase
                  .from('help_sections')
                  .select('*', { count: 'exact', head: true })
                  .eq('workspace_id', currentWorkspace.id)
                  .then((res: any) => {
                    const count = res?.count;
                    if (count !== null && count !== undefined) setSectionsCount(count);
                  });
              }
            }}
          />
        </div>
      )}

      {activeView === 'handovers' && (
        <div className="flex-1 flex overflow-hidden w-full pb-14 md:pb-0">
          <HandoversView
            workspace={currentWorkspace}
            currentAgent={currentAgent}
            waitingCount={counts.handovers}
            onOpenConversation={(id) => void openLinkedConversation(id)}
          />
        </div>
      )}

      {activeView === 'unanswered' && (
        <div className="flex-1 flex overflow-hidden w-full pb-14 md:pb-0">
          <UnansweredQuestionsView
            workspace={currentWorkspace}
            currentAgent={currentAgent}
            onSelectConversation={(convId) => {
              setSelectedConversationId(convId);
              setActiveView('inbox');
            }}
          />
        </div>
      )}

      {activeView === 'settings' && (
        <div className="flex-1 flex overflow-hidden w-full pb-14 md:pb-0">
          <SettingsHub
            workspace={currentWorkspace}
            currentAgent={currentAgent}
            agents={allAgents}
            cannedResponses={cannedResponses}
            hasVisitors={visitors.length > 0}
            latestVisitorUrl={visitors[0]?.current_url}
            initialSection={settingsInitialSection}
            sectionNonce={settingsNonce}
            onWorkspaceUpdated={(ws) => setCurrentWorkspace(ws)}
            onNavigate={(view) => setActiveView(view as typeof activeView)}
          />
        </div>
      )}

      {/* 3. Mobile bottom navigation — mirrors the desktop rail exactly, so
          the app has one navigation model rather than two. */}
      {!selectedConversationId && (
        <nav aria-label="Main" className="md:hidden fixed bottom-0 left-0 right-0 h-14 bg-surface border-t border-line flex items-stretch px-1 z-40 pb-[env(safe-area-inset-bottom)]">
          {(
            [
              ['inbox', 'Inbox', Inbox, true],
              ['handovers', 'Waiting', Hand, true],
              ['tickets', 'Tickets', Ticket, true],
              ['team', 'Team', MessagesSquare, true],
              ['visitors', 'Visitors', Radio, true],
              // Charts need a wide screen; on a phone the slot goes to team chat.
              ['reports', 'Reports', BarChart2, false],
              ['helpdesk', 'Help', BookOpen, true],
              ['settings', 'Settings', Settings, true],
            ] as [View, string, typeof Inbox, boolean][]
          )
            .filter(([, , , visible]) => visible)
            .map(([view, label, Icon]) => (
              <button
                key={view}
                onClick={() => setActiveView(view)}
                aria-current={activeView === view ? 'page' : undefined}
                className={cn(
                  'flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 rounded-lg text-2xs font-medium transition-colors',
                  activeView === view ? 'text-accent font-semibold' : 'text-ink-3'
                )}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                <span className="max-w-full truncate">{label}</span>
              </button>
            ))}

          <button
            onClick={() => setShowMobileInstallModal(true)}
            className="flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 rounded-lg text-2xs font-medium text-ink-3 hover:text-accent transition-colors"
            title="Mobile App Shortcut"
          >
            <Smartphone className="w-4 h-4 text-accent" aria-hidden="true" />
            <span>App</span>
          </button>
        </nav>
      )}

      {currentWorkspace && (
        <DashboardCommandPalette
          workspaceId={currentWorkspace.id}
          isAdmin={isAdmin}
          onNavigate={(view) => {
            setSelectedConversationId(null);
            setActiveView(view);
          }}
          onOpenTicketView={(viewId) => handleOpenTickets({ viewId })}
          onOpenTicket={(ticketId) => handleOpenTickets({ ticketId })}
          onOpenSettings={handleOpenSettingsSection}
          onShowShortcuts={() => setShowShortcutsModal(true)}
        />
      )}

      {/* 4. Global Keyboard Shortcuts Cheatsheet Modal */}
      {showShortcutsModal && (
        <KeyboardShortcutsModal isOpen onClose={() => setShowShortcutsModal(false)} />
      )}

      {/* 5. Mobile App & Shortcut Installer Modal */}
      {showMobileInstallModal && (
        <MobileInstallModal isOpen onClose={() => setShowMobileInstallModal(false)} />
      )}
      </div>
    </div>
  );
}
