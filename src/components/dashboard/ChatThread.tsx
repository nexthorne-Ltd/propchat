'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  AtSign,
  PhoneCall,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  ExternalLink,
  FileText,
  GitMerge,
  Info,
  Lock,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Star,
  X,
  Zap,
  ArrowLeft,
  Smile,
  Frown,
  CornerUpLeft,
  Copy,
  Image as ImageIcon,
  Paperclip,
  Pencil,
  Trash2,
  Loader2,
  Globe,
  BookOpen,
  ThumbsUp,
  ThumbsDown,
  MessagesSquare,
} from 'lucide-react';
import { isSubAgentId, SUB_AGENT_BY_ID } from '@/lib/ai/sub-agents';
import { rateBotReplyAction, saveQuickQaAnswerAction } from '@/app/actions/unanswered';
import {
  Agent,
  CannedResponse,
  Conversation,
  ConversationPriority,
  ConversationStatus,
  Message,
  Workspace,
} from '@/types/database';
import { formatTime, formatTimeAgo, cn, isGreetingMessage } from '@/lib/utils';
import { ConversationTicketBar } from '@/components/tickets/ConversationTicketBar';
import { sound } from '@/lib/sound';
import { Avatar } from '@/components/ui/Avatar';
import { Menu } from '@/components/ui/Menu';
import { ChannelBadge } from '@/components/ui/ChannelBadge';
import { ConversationEvent } from '@/components/ui/ConversationEvent';
import { ChatThreadSkeleton } from '@/components/ui/Skeleton';
import {
  MessageTicks,
  messageStatusOf,
} from '@/components/ui/MessageTicks';
import { CountryFlag } from '@/components/ui/BrandIcon';
import { parseLocation } from '@/lib/visitor-meta';
import { looksLikeImage, uploadChatImage } from '@/lib/image-upload';
import { createClient } from '@/lib/supabase/client';
import { EMOJI_CATEGORIES, ALL_EMOJIS } from '@/lib/emojis';
import { Linkified } from '@/components/ui/Linkified';
import { ChatMarkdown } from '@/components/ui/ChatMarkdown';
import {
  detectLanguage,
  SUPPORTED_LANGUAGES,
  getLanguageInfo,
  isLikelyEnglishText,
  isRomanizedText,
  normalizeDetectedLanguage,
} from '@/lib/ai/translator';
import { errorMessage } from '@/lib/errors/user-error';

interface ChatThreadProps {
  conversation: Conversation;
  messages: Message[];
  currentAgent: Agent | null;
  agentsList: Agent[];
  /** @param replyToId - the message being quoted, when the agent used Reply. */
  onSendMessage: (
    content: string,
    isInternal?: boolean,
    conversationId?: string,
    replyToId?: string | null,
    attachmentUrl?: string | null,
    metadata?: Record<string, any> | null
  ) => Promise<void>;
  onEditMessage?: (id: string, content: string) => Promise<void>;
  onDeleteMessage?: (id: string) => Promise<void>;
  onUpdateStatus: (status: ConversationStatus) => Promise<void>;
  onAssignAgent: (agentId: string | null) => Promise<void>;
  onUpdatePriority?: (priority: ConversationPriority) => Promise<void>;
  onUpdateTags?: (tags: string[]) => Promise<void>;
  onToggleAiMode?: (mode: 'autopilot' | 'disabled') => Promise<void>;
  /**
   * The AI assistant owns the replies on this thread. Agents can still leave
   * internal notes, but a customer-facing reply needs them to take over first,
   * so the visitor never gets answers from both.
   */
  aiAnswering?: boolean;
  /** The bot handed this chat over and no person has taken it yet. */
  waitingForPerson?: boolean;
  /** This chat's handover is ringing on the agent's screen. */
  ringing?: boolean;
  /** Take the chat: bot off, assigned if nobody has it, the customer told a person is here. */
  onConnect?: () => Promise<void>;
  loading?: boolean;
  onBack?: () => void;
  onToggleDetailsSidebar?: () => void;
  isDetailsSidebarOpen?: boolean;
  onMerged?: (targetId: string) => Promise<void> | void;
  cannedResponses?: CannedResponse[];
  workspace?: Workspace | null;
  /** Opens team chat with this conversation attached, to ask a teammate about it. */
  onAskTeam?: () => void;
  /** Opens this chat's ticket in the Tickets view. */
  onOpenTicket?: (ticketId: string) => void;
}

interface CannedItem {
  shortcut: string;
  title: string;
  content: string;
}

type ThreadAction = "" | "snooze" | "merge" | "auto-assign" | "ai" | "pending" | "open";

const PRESET_TAGS = ['VIP', 'Billing', 'Bug', 'Sales lead', 'Feature request', 'Urgent'];

/** Why the AI is off on a thread, from conversations.ai_paused_reason. */
const AI_PAUSED_LABEL: Record<string, string> = {
  human_reply: 'Off because a teammate replied',
  agent_paused: 'Turned off by a teammate',
  human_requested: 'Off because the customer asked for a person',
  needs_attention: 'Off because the AI could not help',
  system: 'Off',
};

const PRIORITY_OPTIONS: { value: ConversationPriority; label: string; dot: string }[] = [
  { value: 'low', label: 'Low', dot: 'var(--ds-line-3)' },
  { value: 'normal', label: 'Normal', dot: 'var(--ds-accent)' },
  { value: 'high', label: 'High', dot: 'var(--ds-warn)' },
  { value: 'urgent', label: 'Urgent', dot: 'var(--ds-danger)' },
];

/** Groups consecutive messages into calendar days for the date separators. */
function dayKey(iso: string) {
  return new Date(iso).toDateString();
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86_400_000).toDateString();
  if (d.toDateString() === today) return 'Today';
  if (d.toDateString() === yesterday) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function ChatThread({
  conversation,
  messages,
  currentAgent,
  agentsList,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  onUpdateStatus,
  onAssignAgent,
  onUpdatePriority,
  onUpdateTags,
  onToggleAiMode,
  aiAnswering = false,
  waitingForPerson = false,
  ringing = false,
  onConnect,
  loading = false,
  onBack,
  onToggleDetailsSidebar,
  isDetailsSidebarOpen = true,
  onMerged,
  cannedResponses,
  workspace,
  onAskTeam,
  onOpenTicket,
}: ChatThreadProps) {
  const [inputText, setInputText] = useState('');
  const composerRef = useRef<HTMLDivElement>(null);
  /** The message the agent is replying to, or null for a plain message. */
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  /** Briefly tinted after a quote is clicked, so the eye finds the original. */
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  /**
   * Hand the chat back to the bot once this reply is sent. A person's reply
   * pauses the bot (the database's rule), so "turn the bot on, then write the
   * closing line" left it off again; this sends first and turns it on after.
   */
  const [handBackFor, setHandBackFor] = useState<string | null>(null);
  const handBack = handBackFor === conversation.id;
  const setHandBack = (on: boolean) => setHandBackFor(on ? conversation.id : null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [noteErrorToast, setNoteErrorToast] = useState<string | null>(null);
  const [chosenComposerMode, setComposerMode] = useState<'reply' | 'internal'>('reply');
  // Light agents can only add internal notes (the database refuses anything else).
  const isLightAgent = currentAgent?.role === 'light_agent';
  const composerMode: 'reply' | 'internal' = isLightAgent ? 'internal' : chosenComposerMode;
  const [showMacros, setShowMacros] = useState(false);
  const [macroSearch, setMacroSearch] = useState('');
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [tagPickerCoords, setTagPickerCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const [customTagInput, setCustomTagInput] = useState('');
  const [aiDrafting, setAiDrafting] = useState(false);
  const [suggestedReplies, setSuggestedReplies] = useState<{ title: string; text: string }[]>([]);
  const [collisionAgents, setCollisionAgents] = useState<
    { id: string; name: string; avatar_url?: string }[]
  >([]);
  const [dbMacros, setDbMacros] = useState<CannedResponse[]>([]);

  // Features State: Auto-Translation (Bidirectional English <-> Customer Language)
  const [targetLanguage, setTargetLanguage] = useState<string>('en');
  const [autoTranslateEnabled, setAutoTranslateEnabled] = useState<boolean>(false);
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [expandedTranslations, setExpandedTranslations] = useState<Record<string, boolean>>({});
  // Local translation store for immediate optimistic display of translated visitor messages
  const [inboundTranslations, setInboundTranslations] = useState<
    Record<
      string,
      {
        englishText: string;
        detectedLanguage: string;
        languageName: string;
        isOriginalEnglish: boolean;
        isRoman?: boolean;
      }
    >
  >({});
  // Agent-chosen language for this conversation; wins over auto-detection.
  // Local picks are keyed by conversation so switching threads never leaks one.
  const [localLanguageOverrides, setLocalLanguageOverrides] = useState<Record<string, string | null>>({});
  const savedLanguageOverride =
    ((conversation.channel_metadata as Record<string, unknown> | undefined)?.language_override as string | undefined) ||
    null;
  const languageOverride =
    conversation.id in localLanguageOverrides ? localLanguageOverrides[conversation.id] : savedLanguageOverride;
  const [showTranslateMenu, setShowTranslateMenu] = useState<boolean>(false);
  const translateMenuRef = useRef<HTMLDivElement>(null);
  const bottomTranslateBtnRef = useRef<HTMLButtonElement>(null);

  // Features State: Auto-Assign, Snooze, Merge, Mentions
  const [isAutoAssigning, setIsAutoAssigning] = useState(false);
  const [showSnoozeModal, setShowSnoozeModal] = useState(false);
  const [customSnoozeDate, setCustomSnoozeDate] = useState('');
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeCandidates, setMergeCandidates] = useState<Conversation[]>([]);
  const [selectedMergeId, setSelectedMergeId] = useState('');
  const [isMerging, setIsMerging] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionedAgentIds, setMentionedAgentIds] = useState<string[]>([]);
  // Bot Quality Rating & Save as Answer state
  const [ratedMessages, setRatedMessages] = useState<Record<string, 'good' | 'wrong'>>({});
  const [saveAnswerModalOpen, setSaveAnswerModalOpen] = useState(false);
  const [saveAnswerQuestion, setSaveAnswerQuestion] = useState('');
  const [saveAnswerContent, setSaveAnswerContent] = useState('');
  const [isSavingAnswer, setIsSavingAnswer] = useState(false);
  const [saveAnswerSuccessToast, setSaveAnswerSuccessToast] = useState<string | null>(null);

  const handleRateBot = async (messageId: string, rating: 'good' | 'wrong') => {
    const wsId = workspace?.id || conversation.workspace_id;
    if (!wsId) return;
    setRatedMessages((prev) => ({ ...prev, [messageId]: rating }));
    try {
      await rateBotReplyAction(wsId, messageId, rating);
    } catch (e) {
      console.warn('Failed to record rating:', e);
    }
  };

  const handleOpenSaveAsAnswer = (msg: Message) => {
    const msgTime = Date.parse(msg.created_at);
    const priorVisitor = messages
      .filter((m) => m.sender_type === 'visitor' && !m.is_internal && Date.parse(m.created_at) <= msgTime)
      .pop();

    setSaveAnswerQuestion(priorVisitor?.content || '');
    setSaveAnswerContent(msg.content || '');
    setSaveAnswerModalOpen(true);
  };

  const handleConfirmSaveAnswer = async (e: React.FormEvent) => {
    e.preventDefault();
    const wsId = workspace?.id || conversation.workspace_id;
    if (!wsId || !saveAnswerQuestion.trim() || !saveAnswerContent.trim()) return;
    setIsSavingAnswer(true);
    try {
      const res = await saveQuickQaAnswerAction(wsId, null, {
        question: saveAnswerQuestion.trim(),
        answer: saveAnswerContent.trim(),
      });
      if (res.pendingApproval) {
        setSaveAnswerSuccessToast('Answer submitted for admin review!');
      } else {
        setSaveAnswerSuccessToast('Answer saved and embedded! The AI bot will use it immediately.');
      }
      setTimeout(() => setSaveAnswerSuccessToast(null), 4000);
      setSaveAnswerModalOpen(false);
    } catch (err: any) {
      alert(errorMessage(err, 'Failed to save answer'));
    } finally {
      setIsSavingAnswer(false);
    }
  };

  // Emoji Picker State
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [activeEmojiCategory, setActiveEmojiCategory] = useState('smileys');
  const [emojiSearchQuery, setEmojiSearchQuery] = useState('');

  const handleInsertEmoji = (emoji: string) => {
    if (!textareaRef.current) {
      setInputText((prev) => prev + emoji);
      return;
    }
    const el = textareaRef.current;
    const start = el.selectionStart || inputText.length;
    const end = el.selectionEnd || inputText.length;
    const newText = inputText.substring(0, start) + emoji + inputText.substring(end);
    setInputText(newText);
    setTimeout(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + emoji.length;
    }, 10);
  };

  // Message Edit & Delete State
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [deleteConfirmMsg, setDeleteConfirmMsg] = useState<Message | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const startEditing = (msg: Message) => {
    setEditingMessageId(msg.id);
    setEditingContent(msg.content);
  };

  const cancelEditing = () => {
    setEditingMessageId(null);
    setEditingContent('');
    setIsSavingEdit(false);
  };

  const handleSaveEdit = async (messageId: string) => {
    if (!editingContent.trim() || isSavingEdit) return;
    try {
      setIsSavingEdit(true);
      if (onEditMessage) {
        await onEditMessage(messageId, editingContent.trim());
      }
      setEditingMessageId(null);
      setEditingContent('');
    } catch (err: any) {
      console.error('Failed to save message edit:', err);
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirmMsg || isDeleting) return;
    try {
      setIsDeleting(true);
      if (onDeleteMessage) {
        await onDeleteMessage(deleteConfirmMsg.id);
      }
      setDeleteConfirmMsg(null);
    } catch (err: any) {
      console.error('Failed to delete message:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tagPickerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [pendingAttachment, setPendingAttachment] = useState<{
    file: File;
    isImage: boolean;
    previewUrl: string;
  } | null>(null);
  const [previewImageModalUrl, setPreviewImageModalUrl] = useState<string | null>(null);
  const [sendOnEnter, setSendOnEnter] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('zen_send_on_enter') !== 'false';
  });

  const isImageAttachment = (url: string | null | undefined): boolean => {
    if (!url) return false;
    if (url.includes('cloudinary.com') && (url.includes('/image/upload/') || !url.includes('/raw/upload/'))) {
      return true;
    }
    return Boolean(url.match(/\.(jpeg|jpg|png|webp|gif|svg|avif|bmp)(\?.*)?$/i));
  };

  const handleSelectFile = (file: File) => {
    if (file.size > 40 * 1024 * 1024) {
      alert('This file is too large. Please choose a smaller one.');
      return;
    }
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl);
    }
    const isImg = looksLikeImage(file);
    const previewUrl = isImg ? URL.createObjectURL(file) : '';
    setPendingAttachment({ file, isImage: isImg, previewUrl });
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          handleSelectFile(file);
          break;
        }
      }
    }
  };

  // 1. Realtime Agent Collision Detection (Supabase Presence)
  useEffect(() => {
    if (!conversation.id || !currentAgent?.id) return;

    const supabase = createClient();
    const presenceChannel = supabase.channel(
      `conversation-presence-${conversation.id}`,
      {
        config: { presence: { key: currentAgent.id } },
      }
    );

    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        const state = presenceChannel.presenceState();
        const others: { id: string; name: string; avatar_url?: string }[] = [];

        Object.keys(state).forEach((key) => {
          if (key !== currentAgent.id) {
            const presences = state[key] as any[];
            presences.forEach((p) => {
              if (
                p &&
                p.agent_id !== currentAgent.id &&
                !others.some((o) => o.id === p.agent_id)
              ) {
                others.push({
                  id: p.agent_id,
                  name: p.agent_name || 'Another agent',
                  avatar_url: p.avatar_url,
                });
              }
            });
          }
        });

        setCollisionAgents(others);
      })
      .subscribe(async (status: any) => {
        if (status === 'SUBSCRIBED') {
          await presenceChannel.track({
            agent_id: currentAgent.id,
            agent_name: currentAgent.name,
            avatar_url: currentAgent.avatar_url,
          });
        }
      });

    return () => {
      presenceChannel.untrack();
      supabase.removeChannel(presenceChannel);
    };
  }, [conversation.id, currentAgent?.id, currentAgent?.name, currentAgent?.avatar_url]);

  // 2. Fetch Canned Responses from Database if not provided via props
  useEffect(() => {
    if (cannedResponses && cannedResponses.length > 0) return;
    const supabase = createClient();
    let query = supabase.from('canned_responses').select('*');
    if (conversation.workspace_id) {
      query = query.or(`workspace_id.eq.${conversation.workspace_id},workspace_id.is.null`);
    }
    query.then(({ data }: any) => {
      if (data && data.length > 0) {
        setDbMacros(data as CannedResponse[]);
      }
    });
  }, [cannedResponses, conversation.workspace_id]);

  // Whether the agent is reading the latest messages. Only then does the thread
  // follow new messages down; an agent scrolled up to read history is left
  // where they are, with a "new messages" button instead of being yanked away.
  const stickToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);
  const lastMessageIdRef = useRef<string | null>(null);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = messagesContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    setUnseenCount(0);
    const scroll = () => {
      // Re-checked on each pass: if the agent scrolled up while images were
      // still loading, the later passes must not drag them back down.
      if (!stickToBottomRef.current || !messagesContainerRef.current) return;
      const c = messagesContainerRef.current;
      c.scrollTo({ top: c.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    };
    scroll();
    requestAnimationFrame(scroll);
    // Late layout (images, markdown) can grow the thread after the first pass.
    setTimeout(scroll, 120);
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < 80;
    stickToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom && distance > 240);
    if (atBottom) setUnseenCount(0);
  }, []);

  // Opening or switching a conversation always starts at the latest message.
  useEffect(() => {
    lastMessageIdRef.current = null;
    stickToBottomRef.current = true;
    scrollToBottom(false);
  }, [conversation?.id, scrollToBottom]);

  // A new message at the end of the thread: follow it if the agent is at the
  // bottom or sent it themselves; otherwise count it. Edits to existing
  // messages (translations, read receipts) never move the view.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    const isNew = last.id !== lastMessageIdRef.current;
    const isFirstLoad = lastMessageIdRef.current === null;
    lastMessageIdRef.current = last.id;
    if (!isNew) return;

    const mine = last.sender_type === 'agent' && last.sender_id === currentAgent?.id;
    if (isFirstLoad || mine || stickToBottomRef.current) {
      scrollToBottom(!isFirstLoad);
    } else {
      setUnseenCount((n) => n + 1);
      setShowJumpToLatest(true);
    }
  }, [messages, currentAgent?.id, scrollToBottom]);

  // Jump to bottom when loading finishes
  useEffect(() => {
    if (!loading) {
      scrollToBottom(false);
    }
  }, [loading, scrollToBottom]);

  // Suggestions are fetched on demand from the AI Suggest button, not on every
  // open and every incoming message — that pushed a panel over the composer
  // unasked and spent an API call per keystroke-worth of traffic.
  // Reset during render (React's documented "adjust state on prop change"
  // pattern) rather than in an effect, which would render stale suggestions
  // for a frame after switching conversations.
  const [suggestionsFor, setSuggestionsFor] = useState(conversation.id);
  if (suggestionsFor !== conversation.id) {
    setSuggestionsFor(conversation.id);
    setSuggestedReplies([]);
  }

  // Trigger background sentiment & tag analysis only on a new unanalyzed visitor message
  const lastAnalyzedMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!conversation?.id || !conversation?.workspace_id || messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    if (
      lastMsg?.sender_type === 'visitor' &&
      lastMsg.id &&
      lastMsg.id !== lastAnalyzedMsgIdRef.current &&
      !conversation.sentiment
    ) {
      lastAnalyzedMsgIdRef.current = lastMsg.id;
      fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
          workspace_id: conversation.workspace_id,
        }),
      }).catch((err) => console.warn('Failed to trigger AI analysis:', err));
    }
  }, [conversation?.id, conversation?.sentiment, conversation?.workspace_id, messages]);

  // Close the tag popover on an outside click and track positioning
  useEffect(() => {
    if (!showTagPicker) return;

    const updateTagPosition = () => {
      if (!tagPickerRef.current) return;
      const rect = tagPickerRef.current.getBoundingClientRect();
      const menuWidth = 224; // w-56
      let left = rect.left;
      if (left + menuWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - menuWidth - 8);
      }
      setTagPickerCoords({
        top: Math.round(rect.bottom + 6),
        left: Math.round(left),
      });
    };

    updateTagPosition();

    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !tagPickerRef.current?.contains(target) &&
        !tagMenuRef.current?.contains(target)
      ) {
        setShowTagPicker(false);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setShowTagPicker(false);
      }
    };

    window.addEventListener('scroll', updateTagPosition, true);
    window.addEventListener('resize', updateTagPosition);
    window.addEventListener('keydown', onKey, { capture: true });
    document.addEventListener('mousedown', onDown);

    return () => {
      window.removeEventListener('scroll', updateTagPosition, true);
      window.removeEventListener('resize', updateTagPosition);
      window.removeEventListener('keydown', onKey, { capture: true });
      document.removeEventListener('mousedown', onDown);
    };
  }, [showTagPicker]);

  const typingSignalRef = React.useRef<{ convId: string; channel: any; last: number } | null>(null);

  // Lets the visitor's widget show "typing…". Throttled; never for internal notes.
  const sendTypingSignal = () => {
    if (!conversation?.id) return;
    const now = Date.now();
    let state = typingSignalRef.current;
    if (!state || state.convId !== conversation.id) {
      const supabase = createClient();
      if (state) supabase.removeChannel(state.channel);
      const channel = supabase.channel(`zen-try-typing-${conversation.id}`);
      channel.subscribe();
      state = { convId: conversation.id, channel, last: 0 };
      typingSignalRef.current = state;
    }
    if (now - state.last < 2500) return;
    state.last = now;
    state.channel.send({ type: 'broadcast', event: 'typing', payload: { sender: 'agent' } });
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    if (composerMode !== 'internal' && val.trim()) sendTypingSignal();

    // Typing '/' opens the saved-reply palette. Use one notation everywhere: "/shortcut"
    const slashMatch = val.match(/\/([a-zA-Z0-9_-]*)$/);
    if (slashMatch) {
      setShowMacros(true);
      setMacroSearch(slashMatch[1]);
    } else if (showMacros && !val.includes('/')) {
      setShowMacros(false);
    }

    // Typing '@' in internal note mode opens teammate mentions palette
    if (composerMode === 'internal') {
      if (val.endsWith('@')) {
        setShowMentions(true);
        setMentionFilter('');
      } else if (showMentions) {
        const match = val.match(/@([a-zA-Z0-9_\s]*)$/);
        if (match) {
          setMentionFilter(match[1].toLowerCase());
        } else {
          setShowMentions(false);
        }
      }
    }

    const el = e.target;
    el.style.height = 'auto';
    const computedLineHeight = 22;
    const minHeight = computedLineHeight * 3; // ~66px (3 lines)
    const maxHeight = computedLineHeight * 10; // ~220px (10 lines)
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
  };

  // Keep reply composer auto-grown from 3 to 10 lines whenever inputText changes
  useEffect(() => {
    if (textareaRef.current) {
      const el = textareaRef.current;
      el.style.height = 'auto';
      const computedLineHeight = 22;
      const minHeight = computedLineHeight * 3;
      const maxHeight = computedLineHeight * 10;
      const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
      el.style.height = `${nextHeight}px`;
    }
  }, [inputText]);

  // 1. Auto-Assign Handler
  const handleAutoAssign = async () => {
    setIsAutoAssigning(true);
    try {
      const res = await fetch('/api/conversations/auto-assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversation.id }),
      });
      const data = await res.json();
      if (data.agent) {
        await onAssignAgent(data.agent.id);
      }
    } catch (err) {
      console.error('Auto-assign failed:', err);
    } finally {
      setIsAutoAssigning(false);
    }
  };

  // 2. Snooze Handler
  const handleSnooze = async (minutesOrIso: number | string) => {
    let targetTime: Date;
    if (typeof minutesOrIso === 'string') {
      targetTime = new Date(minutesOrIso);
    } else {
      targetTime = new Date(Date.now() + minutesOrIso * 60 * 1000);
    }

    try {
      await fetch('/api/conversations/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
          snoozed_until: targetTime.toISOString(),
        }),
      });
      await onUpdateStatus('snoozed');
      setShowSnoozeModal(false);
    } catch (err) {
      console.error('Snooze failed:', err);
    }
  };

  // 3. Open Merge Modal and fetch other conversations from visitor (by visitor_id and email)
  const handleOpenMergeModal = async () => {
    setShowMergeModal(true);
    setSelectedMergeId('');
    try {
      const supabase = createClient();
      const vid = conversation.visitor_id;
      const email = conversation.visitor?.email?.trim().toLowerCase();
      let visitorIds = [vid].filter(Boolean) as string[];

      if (email) {
        const { data: matchedVisitors } = await supabase
          .from('visitors')
          .select('id')
          .eq('email', email);
        if (matchedVisitors) {
          const ids = (matchedVisitors as Array<{ id: string }>).map((v) => v.id);
          visitorIds = Array.from(new Set([...visitorIds, ...ids]));
        }
      }

      const { data } = await supabase
        .from('conversations')
        .select('id, status, created_at, updated_at, tags')
        .in('visitor_id', visitorIds)
        .neq('id', conversation.id)
        .order('updated_at', { ascending: false });

      setMergeCandidates((data as Conversation[]) || []);
    } catch (err) {
      console.error('Failed to load merge candidates:', err);
    }
  };

  // 4. Execute Merge
  const handleExecuteMerge = async (sourceId: string) => {
    if (!sourceId || isMerging) return;
    setIsMerging(true);
    try {
      const res = await fetch('/api/conversations/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_conversation_id: sourceId,
          target_conversation_id: conversation.id,
          agent_name: currentAgent?.name || 'Agent',
        }),
      });
      const data = await res.json();
      if (data.success) {
        setShowMergeModal(false);
        if (onMerged) {
          await onMerged(conversation.id);
        } else {
          window.location.reload();
        }
      }
    } catch (err) {
      console.error('Merge execution failed:', err);
    } finally {
      setIsMerging(false);
    }
  };

  // 5. Insert Mention
  const handleInsertMention = (agent: Agent) => {
    const cleaned = inputText.replace(/@[a-zA-Z0-9_\s]*$/, '');
    setInputText(`${cleaned}@${agent.name} `);
    if (!mentionedAgentIds.includes(agent.id)) {
      setMentionedAgentIds((prev) => [...prev, agent.id]);
    }
    setShowMentions(false);
    setMentionFilter('');
    textareaRef.current?.focus();
  };

  // Synchronized messages incorporating instant optimistic inbound translations
  const displayMessages = useMemo(() => {
    return messages.map((m) => {
      const trans = inboundTranslations[m.id];
      if (!trans) return m;

      const existingMeta = (m.metadata as Record<string, any>) || {};
      // A stored real translation wins; a stored "not translated" does not
      // when a fresh result says otherwise.
      if (existingMeta.translation?.english_text && (existingMeta.translation.is_translated || trans.isOriginalEnglish)) {
        return m;
      }

      return {
        ...m,
        metadata: {
          ...existingMeta,
          translation: {
            is_translated: !trans.isOriginalEnglish,
            direction: 'visitor_to_agent',
            original_text: m.content,
            english_text: trans.englishText,
            detected_language: trans.detectedLanguage,
            language_name: trans.languageName,
            is_roman: Boolean(trans.isRoman),
          },
          detected_language: trans.detectedLanguage,
          language_name: trans.languageName,
          english_translation: trans.englishText,
        },
      };
    });
  }, [messages, inboundTranslations]);

  // 6. Customer Language Auto-Detection & Sync
  const detectedVisitorLang = useMemo(() => {
    // 0. An agent's manual correction always wins
    if (languageOverride && SUPPORTED_LANGUAGES[languageOverride]) {
      return languageOverride;
    }

    // 1. Scan visitor messages in the thread (most recent visitor message with linguistic content determines current language)
    const visitorMsgs = [...displayMessages].filter(
      (m) => m.sender_type === 'visitor' && m.content?.trim()
    );

    const withLetters = [...visitorMsgs]
      .reverse()
      .filter((m) => /[a-zA-Z\u00C0-\uFFFF]/.test(m.content.trim()));
    // "ok" or "thanks" after a conversation in Spanish is not a switch to
    // English: skip one- and two-word English acknowledgements when an
    // earlier message says more.
    const isShortEnglish = (m: Message) =>
      m.content.trim().split(/\s+/).length <= 2 &&
      (m.metadata?.translation?.detected_language || detectLanguage(m.content).code) === 'en';
    const lastWithLetters = withLetters.find((m) => !isShortEnglish(m)) || withLetters[0];

    const targetMsg = lastWithLetters || visitorMsgs[visitorMsgs.length - 1];

    if (targetMsg) {
      const text = targetMsg.content.trim();
      const storedEnglish: string | undefined = targetMsg.metadata?.translation?.english_text;
      // A "translation" identical to the message means it was English after
      // all, whatever language code a detector attached to it.
      if (storedEnglish && storedEnglish.trim().toLowerCase() === text.toLowerCase()) {
        return 'en';
      }
      const transLang =
        inboundTranslations[targetMsg.id]?.detectedLanguage ||
        targetMsg.metadata?.translation?.detected_language ||
        targetMsg.metadata?.detected_language;

      // If explicitly detected and supported
      const normalizedLang = transLang ? normalizeDetectedLanguage(transLang, text) : '';
      if (normalizedLang && SUPPORTED_LANGUAGES[normalizedLang]) {
        return normalizedLang;
      }

      const det = detectLanguage(text);
      if (det.code && SUPPORTED_LANGUAGES[det.code]) {
        return normalizeDetectedLanguage(det.code, text);
      }
    }

    // STRICT LOGIC: Default to English ('en') if no visitor messages or purely numeric
    return 'en';
  }, [displayMessages, languageOverride, inboundTranslations]);

  const handleLanguageOverride = async (code: string) => {
    const next = code === 'auto' ? null : code;
    setLocalLanguageOverrides((prev) => ({ ...prev, [conversation.id]: next }));
    const effectiveLang = next || detectedVisitorLang;
    setTargetLanguage(effectiveLang);
    setAutoTranslateEnabled(effectiveLang !== 'en');
    try {
      const supabase = createClient();
      const meta: Record<string, unknown> = { ...((conversation.channel_metadata as Record<string, unknown>) || {}) };
      if (next) {
        meta.language_override = next;
        meta.visitor_language = next;
        meta.language_name = getLanguageInfo(next).name;
      } else {
        delete meta.language_override;
        meta.visitor_language = detectedVisitorLang;
        meta.language_name = getLanguageInfo(detectedVisitorLang).name;
      }
      await supabase.from('conversations').update({ channel_metadata: meta }).eq('id', conversation.id);
    } catch (err) {
      console.warn('Failed to save conversation language override:', err);
    }
  };

  // Close translation menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        translateMenuRef.current &&
        !translateMenuRef.current.contains(target) &&
        (!bottomTranslateBtnRef.current || !bottomTranslateBtnRef.current.contains(target))
      ) {
        setShowTranslateMenu(false);
      }
    };
    if (showTranslateMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showTranslateMenu]);

  // Track previous conversation ID to detect when user switches conversations
  const prevConvIdRef = useRef<string>(conversation.id);

  // Sync target language when conversation or detected visitor language changes
  useEffect(() => {
    const isNewConv = prevConvIdRef.current !== conversation.id;
    if (isNewConv) {
      prevConvIdRef.current = conversation.id;
    }
    // Replies go out in the customer's language by default; the agent can
    // still switch it off for this conversation from the Translate menu.
    const lang = languageOverride || detectedVisitorLang;
    setTargetLanguage(lang);
    setAutoTranslateEnabled(lang !== 'en');
  }, [detectedVisitorLang, conversation.id, languageOverride]);

  // Set to track in-flight translation requests so we don't repeat them
  const inFlightTranslationsRef = useRef<Set<string>>(new Set());

  // Every visitor message is shown to agents in English. The server usually
  // translates it as soon as it arrives; this catches anything it missed
  // (older messages, other channels). Messages already processed — English
  // ones included — carry metadata.translation and are skipped, so reopening
  // a thread does not translate it all over again.
  useEffect(() => {
    const untranslated = displayMessages.filter(
      (m) =>
        m.sender_type === 'visitor' &&
        m.content?.trim() &&
        !m.id.startsWith('temp') &&
        !inFlightTranslationsRef.current.has(m.id) &&
        // Not processed yet — or stored as "English" by an older engine that
        // dropped languages such as Hebrew; the server re-checks those once.
        (!m.metadata?.translation?.english_text ||
          (!m.metadata.translation.is_translated &&
            (m.metadata.translation.engine_version ?? 1) < 2)) &&
        // Plainly English text needs no round trip.
        !isLikelyEnglishText(m.content)
    );

    untranslated.forEach((m) => {
      inFlightTranslationsRef.current.add(m.id);
      fetch('/api/translation/process-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: m.id }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error('Translation failed');
          const data = await res.json();
          if (data?.success && data.englishText) {
            setInboundTranslations((prev) => ({
              ...prev,
              [m.id]: {
                englishText: data.englishText,
                detectedLanguage: data.detectedLanguage || 'en',
                languageName: data.languageName || 'English',
                isOriginalEnglish: Boolean(data.isOriginalEnglish),
                isRoman: Boolean(data.isRoman),
              },
            }));
          }
        })
        .catch((e) => {
          // Allow a later retry (e.g. the next render after a network blip).
          setTimeout(() => inFlightTranslationsRef.current.delete(m.id), 15_000);
          console.warn('Inbound translation failed:', e);
        });
    });
  }, [displayMessages]);

  /** Every bot switch in this screen goes through here, so a refusal is shown, not lost. */
  const toggleBot = async (mode: 'autopilot' | 'disabled') => {
    if (!onToggleAiMode) return;
    try {
      await onToggleAiMode(mode);
    } catch (err) {
      setNoteErrorToast(errorMessage(err, 'Could not change the bot. Try again.'));
    }
  };

  const handleSend = async () => {
    if ((!inputText.trim() && !pendingAttachment) || isSending || isTranslating) return;
    const text = inputText.trim();
    const isInternal = composerMode === 'internal';
    if (!isInternal && aiAnswering) return;

    setIsSending(true);
    setSendError(null);

    let attachmentUrl: string | null = null;
    if (pendingAttachment) {
      try {
        // Pictures are shrunk and sent straight to Cloudinary (no 4.5 MB
        // request limit); documents go through /api/upload.
        attachmentUrl = await uploadChatImage(pendingAttachment.file);
      } catch (err: any) {
        setSendError(errorMessage(err, 'Image upload failed'));
        setIsSending(false);
        return;
      }
    }

    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl);
    }
    setPendingAttachment(null);
    setInputText('');
    setShowEmojiPicker(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (imageInputRef.current) imageInputRef.current.value = '';

    try {
      sound.playSentMessage();

      if (isInternal) {
        const supabase = createClient();
        await supabase.from('internal_notes').insert({
          conversation_id: conversation.id,
          agent_id: currentAgent?.id || null,
          content: text || (attachmentUrl ? 'Attached an image' : ''),
          mentioned_agent_ids: mentionedAgentIds,
        });
        setMentionedAgentIds([]);
      }

      // Auto-translate agent reply (written in ANY language) into customer's native language and English
      let finalContentToSend = text;
      let translationMetadata: Record<string, any> | null = null;

      // Determine customer target language strictly for the specific message being answered
      let targetVisitorMsg = (replyTo && replyTo.sender_type === 'visitor')
        ? replyTo
        : undefined;

      if (!targetVisitorMsg) {
        const visitorMsgs = [...displayMessages].filter(
          (m) => m.sender_type === 'visitor' && m.content?.trim()
        );
        // Find most recent visitor message with linguistic words
        const lastWithLetters = [...visitorMsgs]
          .reverse()
          .find((m) => /[a-zA-Z\u00C0-\uFFFF]/.test(m.content.trim()));

        targetVisitorMsg = lastWithLetters || visitorMsgs[visitorMsgs.length - 1];
      }

      let currentCustomerLang = 'en';
      if (targetVisitorMsg && targetVisitorMsg.content) {
        const textToInspect = targetVisitorMsg.content.trim();
        const inboundMeta = inboundTranslations[targetVisitorMsg.id];
        const metaLang =
          inboundMeta?.detectedLanguage ||
          targetVisitorMsg.metadata?.translation?.detected_language ||
          targetVisitorMsg.metadata?.detected_language;

        if (metaLang && metaLang !== 'auto' && SUPPORTED_LANGUAGES[metaLang]) {
          currentCustomerLang = normalizeDetectedLanguage(metaLang, textToInspect);
        } else {
          const det = detectLanguage(textToInspect);
          if (det.code && SUPPORTED_LANGUAGES[det.code]) {
            currentCustomerLang = normalizeDetectedLanguage(det.code, textToInspect);
          }
        }
      }

      // Manual override wins if explicitly set by agent; otherwise STRICTLY stay in customer's language!
      // If customer writes in English -> currentCustomerLang is 'en'. NEVER override English to Hindi or another language!
      const effectiveCustomerLang = languageOverride || currentCustomerLang || 'en';

      // The language picked in the Translate menu is what the composer
      // promises ("Translate & Send"), so it is what the customer gets.
      const replyLang = autoTranslateEnabled ? targetLanguage || effectiveCustomerLang : 'en';

      // Check if agent typed in a foreign language (e.g. Urdu, Roman Urdu, Hindi)
      const agentInputLang = text ? detectLanguage(text).code : 'en';
      const isAgentWritingForeign = replyLang === 'en' && agentInputLang !== 'en' && !isLikelyEnglishText(text);

      // A customer who types Urdu/Hindi in Latin letters gets the reply in
      // Latin letters too, not in a script they did not use.
      const customerWritesRoman = Boolean(
        targetVisitorMsg &&
          (targetVisitorMsg.metadata?.translation?.is_roman ||
            inboundTranslations[targetVisitorMsg.id]?.isRoman ||
            isRomanizedText(replyLang, targetVisitorMsg.content || ''))
      );

      const shouldTranslate =
        !isInternal &&
        text.trim().length > 0 &&
        (replyLang !== 'en' || isAgentWritingForeign);

      if (shouldTranslate) {
        setIsTranslating(true);
        try {
          const transRes = await fetch('/api/translation/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              direction: 'agent_reply',
              text,
              targetLanguage: replyLang,
              workspaceId: conversation.workspace_id,
              romanize: customerWritesRoman && replyLang !== 'en',
            }),
          });
          if (transRes.ok) {
            const data = await transRes.json();
            const wasTranslated = Boolean(
              data.isTranslated ||
              (data.translatedText && data.translatedText.trim().toLowerCase() !== text.trim().toLowerCase())
            );

            if (wasTranslated && data.translatedText && data.translatedText.trim()) {
              finalContentToSend = data.translatedText.trim();
              const englishText = data.englishText?.trim() || text;
              const detectedLang = data.detectedSourceLanguage || 'en';
              const langInfo = getLanguageInfo(replyLang);
              translationMetadata = {
                translation: {
                  is_translated: true,
                  direction: 'agent_to_visitor',
                  original_agent_input: text,
                  agent_input_language: detectedLang,
                  english_text: englishText,
                  original_english: englishText,
                  translated_text: finalContentToSend,
                  target_language: replyLang,
                  target_language_name: langInfo.name,
                },
                english_text: englishText,
                original_english: englishText,
                original_agent_input: text,
                translated_text: finalContentToSend,
                target_language: replyLang,
              };
            }
          }
        } catch (tErr) {
          console.warn('[Auto-Translate Error, sending original text]:', tErr);
        } finally {
          setIsTranslating(false);
        }
      }

      // An internal note is not a chat message, so it cannot quote one.
      const quotedId = isInternal ? null : replyTo?.id ?? null;
      await onSendMessage(
        finalContentToSend,
        isInternal,
        conversation.id,
        quotedId,
        attachmentUrl,
        translationMetadata
      );
      setReplyTo(null);
      if (!isInternal && handBack) {
        setHandBack(false);
        await toggleBot('autopilot');
      }
      // The conversation's language is kept by the server as visitor messages
      // are translated. Writing channel_metadata from here would overwrite it
      // with this component's stale copy — including the last_human_reply_at
      // the send handler has just saved.

      // If customer is on WhatsApp, Instagram, Messenger, or LinkedIn, dispatch outbound
      if (!isInternal && conversation.channel && conversation.channel !== 'web') {
        fetch('/api/channels/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: conversation.id,
            workspaceId: conversation.workspace_id,
            content: finalContentToSend || (attachmentUrl ? '[Image Attachment]' : ''),
            channel: conversation.channel,
          }),
        }).catch((err) => console.error('[Outbound Dispatch Error]:', err));
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      // Give the draft back AND say so — silently restoring the text looked
      // like the message had been sent and then reappeared.
      // The quote is part of the draft: dropping it on failure would send a
      // bare message on retry, answering nothing in particular.
      setInputText(text);
      const errMsg =
        err instanceof Error
          ? errorMessage(err)
          : isInternal
          ? 'Failed to save internal note. Please try again.'
          : 'Could not send. Try again.';
      setSendError(errMsg);
      if (isInternal) {
        setNoteErrorToast(errMsg);
        setTimeout(() => setNoteErrorToast(null), 6000);
      }
    } finally {
      setIsSending(false);
      setIsTranslating(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.focus();
      }
    }
  };

  const handleGenerateAiSuggestion = async () => {
    if (aiDrafting) return;
    setAiDrafting(true);

    try {
      const recentMessages = messages.slice(-15);
      const lastVisitorMsg = [...messages]
        .reverse()
        .find((m) => m.sender_type === 'visitor');

      const res = await fetch('/api/agent/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
          workspace_id: conversation.workspace_id,
          incoming_message: lastVisitorMsg?.content || '',
          recent_messages: recentMessages,
          visitor: conversation.visitor,
          channel: conversation.channel || 'web',
        }),
      });

      const data = await res.json();
      // Shown as a suggestion card above the composer, never written straight
      // into it: the agent may already be typing, and a draft must be read
      // and chosen (Use) before it can be sent.
      if (data.draft) {
        setSuggestedReplies([{ title: 'AI draft', text: data.draft }]);
      }
    } catch (err) {
      console.error('Failed to get AI draft:', err);
    } finally {
      setAiDrafting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // If sendOnEnter is false, only Cmd+Enter / Ctrl+Enter sends
    if (!sendOnEnter) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSend();
        return;
      }
    } else {
      // Default: Enter without Shift sends message if popups are not active
      if (e.key === 'Enter' && !e.shiftKey && !showMacros && !showMentions) {
        e.preventDefault();
        handleSend();
        return;
      }
      // Also allow Cmd/Ctrl+Enter as fallback
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSend();
        return;
      }
    }

    // Escape closes popups or triggers onBack
    if (e.key === 'Escape') {
      if (showTagPicker) {
        setShowTagPicker(false);
        return;
      }
      if (showMacros) {
        setShowMacros(false);
        return;
      }
      if (showMentions) {
        setShowMentions(false);
        return;
      }
      if (onBack) {
        onBack();
        return;
      }
    }
  };

  const insertMacro = (macro: CannedItem) => {
    setInputText((prev) => {
      const cleaned = prev.replace(/\/([a-zA-Z0-9_-]*)$/, '');
      return cleaned
        ? `${cleaned}${cleaned.endsWith(' ') ? '' : ' '}${macro.content}`
        : macro.content;
    });
    setShowMacros(false);
    setMacroSearch('');
    textareaRef.current?.focus();
  };

  const handleToggleTag = (tag: string) => {
    if (!onUpdateTags) return;
    const currentTags = conversation.tags || [];
    onUpdateTags(
      currentTags.includes(tag)
        ? currentTags.filter((t) => t !== tag)
        : [...currentTags, tag]
    );
  };

  const handleAddCustomTag = () => {
    if (!customTagInput.trim() || !onUpdateTags) return;
    const clean = customTagInput.trim();
    const currentTags = conversation.tags || [];
    if (!currentTags.includes(clean)) onUpdateTags([...currentTags, clean]);
    setCustomTagInput('');
    setShowTagPicker(false);
  };

  const visitor = conversation.visitor;
  const displayName =
    visitor?.name ||
    (visitor?.email
      ? visitor.email.split('@')[0]
      : `Visitor ${conversation.visitor_id.slice(0, 6)}`);
  const truncatedDisplayName =
    displayName.length > 24 ? `${displayName.slice(0, 24)}…` : displayName;

  const isOnline = Boolean(
    visitor?.is_online !== false &&
    (visitor?.last_seen || visitor?.last_seen_at
      ? (Date.now() - new Date(visitor.last_seen || visitor.last_seen_at!).getTime()) / 1000 < 60
      : false)
  );

  const currentPriority: ConversationPriority = conversation.priority || 'normal';
  const visitorPlace = useMemo(
    () =>
      parseLocation(
        visitor?.location,
        visitor?.ip_location_city,
        visitor?.ip_location_country
      ),
    [visitor?.location, visitor?.ip_location_city, visitor?.ip_location_country]
  );
  const isInternalMode = composerMode === 'internal';
  const replyLocked = aiAnswering && !isInternalMode;

  const workspaceMacros = useMemo(() => {
    const list = cannedResponses && cannedResponses.length > 0 ? cannedResponses : dbMacros;
    return list
      .filter((c) => {
        // Workspace check: if canned response has a workspace_id, must match this workspace
        if (c.workspace_id && conversation.workspace_id && c.workspace_id !== conversation.workspace_id) {
          return false;
        }
        // Team replies are for all agents (agent_id is null/undefined)
        if (!c.agent_id) return true;
        // Personal replies are only for this agent
        return c.agent_id === currentAgent?.id;
      })
      .map((c) => ({
        shortcut: c.shortcut.replace(/^\/+/, ''),
        title: c.title || c.shortcut,
        content: c.content,
      }));
  }, [cannedResponses, dbMacros, conversation.workspace_id, currentAgent?.id]);

  const filteredMacros = useMemo(() => {
    const q = macroSearch.replace(/^\/+/, '').toLowerCase().trim();
    if (!q) return workspaceMacros;
    return workspaceMacros.filter(
      (m) =>
        m.shortcut.toLowerCase().includes(q) ||
        m.title.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q)
    );
  }, [workspaceMacros, macroSearch]);

  const assignOptions = useMemo(
    () => [
      { value: '', label: 'Unassigned' },
      ...agentsList.map((a) => ({
        value: a.id,
        label: a.id === currentAgent?.id ? `${a.name} (you)` : a.name,
        dot:
          a.status === 'online'
            ? 'var(--ds-success)'
            : a.status === 'away'
            ? 'var(--ds-warn)'
            : 'var(--ds-line-3)',
      })),
    ],
    [agentsList, currentAgent?.id]
  );

  // A quote needs the message it points at. The id is all that is stored, so
  // resolve it from the thread already in memory rather than re-fetching.
  const messageById = useMemo(
    () => new Map(displayMessages.map((m) => [m.id, m])),
    [displayMessages]
  );

  const startReply = useCallback((msg: Message) => {
    setReplyTo(msg);
    setComposerMode('reply');
    // Focus last: the composer grows when the quote bar appears, and focusing
    // before that leaves the caret scrolled out of view.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Escape drops the quote first: the composer's other Escape behaviours
  // (closing pickers, deselecting) would otherwise swallow it.
  useEffect(() => {
    if (!replyTo) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setReplyTo(null);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [replyTo]);

  // Copy puts on the clipboard the text the agent is looking at: the English
  // translation while that is shown, the original once "Show original" is open.
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copyMessage = useCallback(
    async (msg: Message) => {
      const t = msg.metadata?.translation;
      const english: string | undefined = t?.english_text || msg.metadata?.english_translation;
      const showingEnglish =
        Boolean(english) && Boolean(t?.is_translated) && !expandedTranslations[msg.id];
      const text =
        (showingEnglish ? english : msg.content)?.trim() || msg.attachment_url || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Older browsers / non-secure contexts: fall back to a hidden textarea.
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        el.remove();
      }
      setCopiedMessageId(msg.id);
      window.setTimeout(() => setCopiedMessageId((c) => (c === msg.id ? null : c)), 1500);
    },
    [expandedTranslations]
  );

  const jumpToMessage = useCallback((id: string) => {
    const node = document.getElementById(`msg-${id}`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(id);
    window.setTimeout(() => setHighlightedId((c) => (c === id ? null : c)), 1600);
  }, []);

  // Render list with day separators injected between calendar days.
  const rendered: React.ReactNode[] = [];
  let lastDay = '';

  displayMessages.forEach((msg) => {
    const key = dayKey(msg.created_at);
    if (key !== lastDay) {
      lastDay = key;
      rendered.push(
        <ConversationEvent key={`day-${key}`} rule className="py-2 text-2xs font-medium">
          {dayLabel(msg.created_at)}
        </ConversationEvent>
      );
    }

    // System rows (auto-resolve, merges) are events, not speech: a centred
    // line, never a bubble on the visitor's side.
    if (msg.sender_type === 'system' && !msg.is_internal) {
      const text = (msg.content || '').replace(/^[\uD800-\uDBFF][\uDC00-\uDFFF]️?\s*/, '');
      const icon = /merg/i.test(text) ? (
        <GitMerge />
      ) : /resolv|closed|solved/i.test(text) ? (
        <CheckCircle2 />
      ) : (
        <Info />
      );
      rendered.push(
        <div key={msg.id} id={`msg-${msg.id}`} className="scroll-mt-24">
          <ConversationEvent icon={icon} time={formatTime(msg.created_at)}>
            {text}
          </ConversationEvent>
        </div>
      );
      return;
    }

    if (msg.is_internal) {
      rendered.push(
        <div
          key={msg.id}
          id={`msg-${msg.id}`}
          className="rounded-md border border-warn-line bg-warn-soft px-4 py-3 group/note relative"
        >
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <span className="inline-flex items-center gap-1.5 text-2xs font-semibold text-warn">
              <Lock className="w-3.5 h-3.5" aria-hidden="true" />
              {msg.agent?.name || 'Teammate'} · Internal note
            </span>
            <div className="flex items-center gap-2">
              <span className="text-2xs text-warn tabular-nums">
                {formatTime(msg.created_at)}
              </span>
              {msg.metadata?.is_edited && (
                <span className="text-2xs text-warn italic">(edited)</span>
              )}
              <button
                type="button"
                title={copiedMessageId === msg.id ? 'Copied' : 'Copy note'}
                aria-label="Copy note"
                onClick={() => copyMessage(msg)}
                className={cn(
                  'transition-opacity p-0.5 cursor-pointer',
                  copiedMessageId === msg.id
                    ? 'opacity-100 text-success'
                    : 'opacity-0 group-hover/note:opacity-100 text-warn hover:text-warn'
                )}
              >
                {copiedMessageId === msg.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </button>
              <button
                type="button"
                title="Edit note"
                onClick={() => startEditing(msg)}
                className="opacity-0 group-hover/note:opacity-100 text-warn hover:text-warn transition-opacity p-0.5 cursor-pointer"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                type="button"
                title="Delete note"
                onClick={() => setDeleteConfirmMsg(msg)}
                className="opacity-0 group-hover/note:opacity-100 text-warn hover:text-danger transition-opacity p-0.5 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
          {editingMessageId === msg.id ? (
            <div className="w-full pt-1">
              <textarea
                value={editingContent}
                onChange={(e) => setEditingContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSaveEdit(msg.id);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEditing();
                  }
                }}
                autoFocus
                rows={3}
                className="w-full rounded-lg bg-surface border border-warn-line/80 p-2 text-ui text-ink focus:outline-none focus:ring-1 focus:ring-warn resize-none"
                placeholder="Edit internal note..."
              />
              <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs">
                <span className="text-warn text-2xs">Esc to cancel • Enter to save</span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={cancelEditing}
                    disabled={isSavingEdit}
                    className="px-2 py-0.5 rounded border border-line bg-surface text-ink-2 hover:bg-surface-2 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSaveEdit(msg.id)}
                    disabled={isSavingEdit || !editingContent.trim()}
                    className="px-2.5 py-0.5 rounded bg-warn text-ink-inv font-medium hover:bg-warn transition-colors flex items-center gap-1 shadow-xs disabled:opacity-50 cursor-pointer"
                  >
                    {isSavingEdit ? (
                      <>
                        <RotateCcw className="w-3 h-3 animate-spin" />
                        <span>Saving</span>
                      </>
                    ) : (
                      <>
                        <Check className="w-3 h-3" />
                        <span>Save</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
              <Linkified text={msg.content} />
            </p>
          )}
        </div>
      );
      return;
    }

    const isGreeting = isGreetingMessage(msg);
    const isAgent = msg.sender_type === 'agent' && !isGreeting;
    const isAI = msg.sender_type === 'ai' || isGreeting;

    rendered.push(
      <div
        key={msg.id}
        id={`msg-${msg.id}`}
        className={cn(
          'flex gap-2.5 scroll-mt-24 rounded-2xl transition-colors duration-500',
          isAgent ? 'justify-end' : 'justify-start',
          highlightedId === msg.id && 'bg-accent-soft/60'
        )}
      >
        {!isAgent && (
          <Avatar
            name={isGreeting ? 'Bot' : isAI ? 'AI' : displayName}
            seed={isGreeting ? 'zen-try-bot' : isAI ? 'zen-try-ai' : conversation.visitor_id}
            size="xs"
            className="mt-auto mb-1"
          />
        )}

        <div
          className={cn(
            'group/msg relative max-w-[min(560px,72%)]',
            isAgent && 'items-end'
          )}
        >
          {/* Quote the message being answered, so "yes, that's right" is never
              ambiguous about which of the last four questions it answers. */}
          {msg.reply_to_message_id && msg.sender_type !== 'ai' && (
            <QuotedMessage
              quoted={messageById.get(msg.reply_to_message_id) || null}
              visitorName={displayName}
              currentAgentId={currentAgent?.id}
              onJump={() => jumpToMessage(msg.reply_to_message_id!)}
              tone={isAgent ? 'out' : 'in'}
            />
          )}

          {/* Message Action Toolbar (Copy, Reply, Edit, Delete) */}
          <div
            className={cn(
              'absolute top-0 z-10 flex items-center gap-0.5 rounded-full border border-line bg-surface p-0.5 shadow-sm transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100',
              copiedMessageId === msg.id ? 'opacity-100' : 'opacity-0',
              isAgent ? '-left-[7.75rem]' : '-right-[4.25rem]'
            )}
          >
            <button
              type="button"
              title={copiedMessageId === msg.id ? 'Copied' : 'Copy message'}
              aria-label="Copy message"
              onClick={() => copyMessage(msg)}
              className={cn(
                'w-6 h-6 grid place-items-center rounded-full hover:bg-surface-2 transition-colors cursor-pointer',
                copiedMessageId === msg.id ? 'text-success' : 'text-ink-3 hover:text-ink'
              )}
            >
              {copiedMessageId === msg.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              title="Reply to this message"
              aria-label="Reply to this message"
              onClick={() => startReply(msg)}
              className="w-6 h-6 grid place-items-center rounded-full text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors cursor-pointer"
            >
              <CornerUpLeft className="w-3.5 h-3.5" />
            </button>
            {isAgent && (
              <>
                <button
                  type="button"
                  title="Save as answer in Knowledge Base"
                  aria-label="Save as answer"
                  onClick={() => handleOpenSaveAsAnswer(msg)}
                  className="w-6 h-6 grid place-items-center rounded-full text-ink-3 hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  title="Edit message"
                  aria-label="Edit message"
                  onClick={() => startEditing(msg)}
                  className="w-6 h-6 grid place-items-center rounded-full text-ink-3 hover:text-accent hover:bg-surface-2 transition-colors cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  title="Delete message"
                  aria-label="Delete message"
                  onClick={() => setDeleteConfirmMsg(msg)}
                  className="w-6 h-6 grid place-items-center rounded-full text-ink-3 hover:text-danger hover:bg-surface-2 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>

          <div
            className={cn(
              'px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words',
              isAgent
                ? 'rounded-2xl rounded-br-xs bg-bubble-out text-bubble-out-ink shadow-xs font-normal'
                : isAI
                ? 'rounded-2xl rounded-bl-xs bg-accent-soft border border-accent-line text-ink font-normal'
                : 'rounded-2xl rounded-bl-xs bg-surface-2 border border-line text-ink font-normal'
            )}
          >
            {/* No "AI" / "Bot greeting" heading: the bubble's colour and the
                "Bot · time" line under it already say who wrote it. */}
            {msg.attachment_url && (
              <div className="mb-2">
                {isImageAttachment(msg.attachment_url) ? (
                  <img
                    src={msg.attachment_url}
                    alt="Attachment"
                    onLoad={() => scrollToBottom(false)}
                    className="rounded-xl max-h-56 w-auto max-w-full object-cover cursor-pointer hover:opacity-90 transition-opacity border border-black/10 shadow-xs"
                    onClick={() => setPreviewImageModalUrl(msg.attachment_url)}
                  />
                ) : (
                  <a
                    href={msg.attachment_url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 p-2 bg-black/10 rounded-lg text-xs hover:underline"
                  >
                    <FileText className="w-4 h-4 shrink-0" />
                    <span className="truncate">View Attachment</span>
                  </a>
                )}
                {/* What the bot read in the screenshot (src/lib/ai/vision.ts). */}
                {typeof msg.metadata?.image_reading?.summary === 'string' && (
                  <p className="mt-1.5 text-2xs text-ink-2 max-w-xs" title={msg.metadata.image_reading.text || undefined}>
                    <span className="font-semibold">Bot read:</span> {msg.metadata.image_reading.summary}
                    {msg.metadata.image_reading.text ? ` “${String(msg.metadata.image_reading.text).slice(0, 160)}”` : ''}
                  </p>
                )}
              </div>
            )}
            {editingMessageId === msg.id ? (
              <div className="w-full min-w-[240px] pt-1">
                <textarea
                  value={editingContent}
                  onChange={(e) => setEditingContent(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSaveEdit(msg.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEditing();
                    }
                  }}
                  autoFocus
                  rows={Math.min(6, Math.max(2, editingContent.split('\n').length))}
                  className="w-full rounded-lg bg-black/15 text-white placeholder-white/50 p-2 text-ui border border-white/20 focus:outline-none focus:ring-1 focus:ring-white/40 resize-none font-normal"
                  placeholder="Edit message..."
                />
                <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs">
                  <span className="text-white/70 text-2xs">
                    Esc to cancel • Enter to save
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={cancelEditing}
                      disabled={isSavingEdit}
                      className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSaveEdit(msg.id)}
                      disabled={isSavingEdit || !editingContent.trim()}
                      className="px-2.5 py-0.5 rounded bg-white text-accent-strong font-medium hover:bg-white/90 transition-colors flex items-center gap-1 shadow-xs disabled:opacity-50 cursor-pointer"
                    >
                      {isSavingEdit ? (
                        <>
                          <RotateCcw className="w-3 h-3 animate-spin" />
                          <span>Saving</span>
                        </>
                      ) : (
                        <>
                          <Check className="w-3 h-3" />
                          <span>Save</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ) : isAI ? (
              (() => {
                const aiEnglish =
                  msg.metadata?.english_translation ||
                  msg.metadata?.translation?.english_text ||
                  msg.content;
                const aiDelivered = msg.content;
                const deliveredLangCode =
                  msg.metadata?.delivered_language ||
                  msg.metadata?.translation?.target_language ||
                  msg.metadata?.target_language;
                const deliveredLangInfo = deliveredLangCode ? getLanguageInfo(deliveredLangCode) : null;
                const isAiForeign = Boolean(
                  (deliveredLangCode && deliveredLangCode !== 'en') ||
                  (aiEnglish && aiDelivered && aiEnglish.trim().toLowerCase() !== aiDelivered.trim().toLowerCase())
                );
                const citedList: { id: string; title: string }[] =
                  msg.metadata?.cited_articles && Array.isArray(msg.metadata.cited_articles)
                    ? msg.metadata.cited_articles
                    : msg.metadata?.cited_article_id
                    ? [{ id: msg.metadata.cited_article_id, title: 'Help Center Article' }]
                    : [];
                const isExpanded = expandedTranslations[msg.id];

                return (
                  <div className="space-y-1.5">
                    <ChatMarkdown content={isExpanded ? aiDelivered : aiEnglish} />
                    {citedList.length > 0 && (
                      <div className="mt-2 pt-1.5 border-t border-accent-line/50 flex flex-wrap items-center gap-1.5 text-2xs">
                        <span className="font-semibold text-accent flex items-center gap-1">
                          <BookOpen className="w-3 h-3" />
                          <span>Sources:</span>
                        </span>
                        {citedList.map((art, idx) => (
                          <span
                            key={art.id || idx}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface border border-line text-ink-2 font-medium shadow-2xs text-2xs"
                            title={art.title}
                          >
                            <span className="max-w-[150px] truncate">{art.title}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Bot Rating: Good / Wrong */}
                    <div className="mt-2 pt-1.5 border-t border-accent-line/30 flex items-center justify-between text-2xs text-ink-3">
                      {/* Which specialist answered (sub-agents.ts); the rating
                          is two small icons, labelled for screen readers. */}
                      <span className="text-2xs text-ink-3 truncate">
                        {isSubAgentId(msg.metadata?.sub_agent) ? SUB_AGENT_BY_ID[msg.metadata.sub_agent].name : ''}
                      </span>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleRateBot(msg.id, 'good')}
                          aria-label="Good answer"
                          aria-pressed={ratedMessages[msg.id] === 'good'}
                          className={cn(
                            "w-6 h-6 grid place-items-center rounded transition-colors cursor-pointer",
                            ratedMessages[msg.id] === 'good'
                              ? "bg-success-soft text-success"
                              : "text-ink-3 hover:bg-surface hover:text-ink"
                          )}
                          title="Good answer"
                        >
                          <ThumbsUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRateBot(msg.id, 'wrong')}
                          aria-label="Wrong answer"
                          aria-pressed={ratedMessages[msg.id] === 'wrong'}
                          className={cn(
                            "w-6 h-6 grid place-items-center rounded transition-colors cursor-pointer",
                            ratedMessages[msg.id] === 'wrong'
                              ? "bg-danger-soft text-danger"
                              : "text-ink-3 hover:bg-surface hover:text-danger"
                          )}
                          title="Wrong answer (added to Unanswered so the bot can learn it)"
                        >
                          <ThumbsDown className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    {isAiForeign && (
                      <TranslationToggle
                        tone="ai"
                        label={`Sent in ${deliveredLangInfo?.name || deliveredLangCode || 'customer language'}`}
                        showText="View sent"
                        showingOriginal={Boolean(isExpanded)}
                        onToggle={() => setExpandedTranslations((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                      />
                    )}
                  </div>
                );
              })()
            ) : isAgent ? (
              (() => {
                const translationMeta = msg.metadata?.translation;
                const englishText =
                  translationMeta?.english_text ||
                  translationMeta?.original_english ||
                  msg.metadata?.english_text ||
                  msg.metadata?.original_english;
                const translatedForeign =
                  translationMeta?.translated_text || msg.metadata?.translated_text;
                const originalInput =
                  translationMeta?.original_agent_input || msg.metadata?.original_agent_input;
                const targetCode =
                  translationMeta?.target_language || msg.metadata?.target_language;
                const targetLangInfo = targetCode ? getLanguageInfo(targetCode) : null;
                const isExpanded = expandedTranslations[msg.id];

                const wasActuallyTranslatedToForeign = Boolean(
                  translationMeta?.is_translated &&
                  targetCode &&
                  targetCode !== 'en' &&
                  translatedForeign &&
                  englishText &&
                  translatedForeign.trim().toLowerCase() !== (originalInput || englishText).trim().toLowerCase()
                );

                const body = wasActuallyTranslatedToForeign ? (
                  <>
                    <p className="whitespace-pre-wrap leading-relaxed">
                      <Linkified text={(isExpanded ? translatedForeign : englishText) || ''} />
                    </p>
                    <TranslationToggle
                      tone="out"
                      label={`Sent in ${targetLangInfo?.name || targetCode}`}
                      showText="View sent"
                      showingOriginal={Boolean(isExpanded)}
                      onToggle={() => setExpandedTranslations((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                    />
                  </>
                ) : englishText && originalInput && originalInput !== englishText ? (
                  <>
                    <p className="whitespace-pre-wrap leading-relaxed">
                      <Linkified text={(isExpanded ? originalInput : englishText) || ''} />
                    </p>
                    <TranslationToggle
                      tone="out"
                      label="Sent in English"
                      showText="My input"
                      showingOriginal={Boolean(isExpanded)}
                      onToggle={() => setExpandedTranslations((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                    />
                  </>
                ) : (
                  <p className="whitespace-pre-wrap leading-relaxed font-normal">
                    <Linkified text={englishText || msg.content} />
                  </p>
                );

                return (
                  <div>
                    {body}
                    {!msg.is_internal && (
                      <div className="mt-1.5 pt-1 border-t border-white/20 flex justify-end">
                        <button
                          type="button"
                          onClick={() => handleOpenSaveAsAnswer(msg)}
                          className="inline-flex items-center gap-1 text-2xs text-white/80 hover:text-white font-medium transition-colors cursor-pointer"
                          title="Save as Q&A answer for the AI bot"
                        >
                          <BookOpen className="w-3 h-3" />
                          <span>Save as answer</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()
            ) : (
              (() => {
                // Visitor message
                const translationMeta = msg.metadata?.translation;
                const englishText = translationMeta?.english_text || msg.metadata?.english_translation;
                const originalText = translationMeta?.original_text || msg.content;
                const detectedCode =
                  translationMeta?.detected_language ||
                  msg.metadata?.detected_language ||
                  (msg.content ? detectLanguage(msg.content).code : 'en');
                const sourceCode = languageOverride || normalizeDetectedLanguage(detectedCode, msg.content || '');
                // Same language as the inbox (English): no translation UI at all.
                if (sourceCode === 'en') {
                  return <Linkified text={msg.content} />;
                }
                const hasEnglishTranslation =
                  Boolean(englishText) &&
                  englishText.trim().toLowerCase() !== originalText.trim().toLowerCase();
                const langInfo = getLanguageInfo(sourceCode);
                const isExpanded = expandedTranslations[msg.id];

                // Processed, and the "translation" is the same text (an English
                // word such as "purposefully" that a detector labelled Zulu):
                // nothing to translate, so no translation UI.
                if (translationMeta?.english_text && !hasEnglishTranslation) {
                  return <Linkified text={msg.content} />;
                }

                if (!englishText) {
                  // Still on its way from the server.
                  return (
                    <div>
                      <p className="whitespace-pre-wrap leading-relaxed"><Linkified text={msg.content} /></p>
                      <span className="mt-1 inline-flex items-center gap-1 text-2xs text-ink-3">
                        <Globe className="w-3 h-3 shrink-0 animate-pulse" />
                        Translating…
                      </span>
                    </div>
                  );
                }

                return (
                  <div>
                    {/* Original is the message exactly as the visitor sent it. */}
                    <p className="whitespace-pre-wrap leading-relaxed font-normal">
                      <Linkified text={(isExpanded ? msg.content : englishText) || ''} />
                    </p>
                    <TranslationToggle
                      label={translationMeta?.language_name || langInfo.name}
                      showingOriginal={Boolean(isExpanded)}
                      onToggle={() => setExpandedTranslations((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }))}
                    />
                  </div>
                );
              })()
            )}
          </div>

          <div
            className={cn(
              'mt-1 flex items-center gap-1.5 px-1 text-2xs text-ink-3',
              (isAgent || isAI) && 'justify-end'
            )}
          >
            {isGreeting ? (
              <span className="font-semibold text-accent inline-flex items-center gap-1">
                <Bot className="w-3 h-3" />
                <span>Bot</span>
                {' ·'}
              </span>
            ) : isAgent ? (
              <span className="font-semibold text-ink-2">
                {msg.sender_id === currentAgent?.id
                  ? 'You'
                  : msg.agent?.name || agentsList.find((a) => a.id === msg.sender_id)?.name || 'Agent'}
                {' ·'}
              </span>
            ) : isAI ? (
              <span className="font-semibold text-accent inline-flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                <span>AI</span>
                {' ·'}
              </span>
            ) : null}
            <span className="tabular-nums">{formatTime(msg.created_at)}</span>
            {msg.metadata?.is_edited && (
              <span className="italic text-2xs text-ink-3/70 ml-0.5">(edited)</span>
            )}
            {isAgent && (
              <MessageTicks
                status={messageStatusOf(msg)}
                readAt={msg.read_at}
              />
            )}
          </div>
        </div>
      </div>
    );
  });

  // Placed after every hook: an early return above them changes the hook
  // count between renders, which crashes React when loading flips to false.
  if (loading) {
    return <ChatThreadSkeleton />;
  }

  const replyPreview = replyTo
    ? {
        who:
          replyTo.sender_type === 'agent'
            ? replyTo.sender_id === currentAgent?.id
              ? 'You'
              : replyTo.agent?.name || 'Agent'
            : replyTo.sender_type === 'ai'
            ? 'AI'
            : displayName,
        text: replyTo.content,
      }
    : null;

  return (
    <div className="@container/thread flex-1 min-w-0 h-[var(--app-vvh,100dvh)] flex flex-col bg-canvas overflow-x-hidden">
      {/* ── Header ── */}
      <header className="shrink-0 px-3 sm:px-4 py-1.5 min-h-[46px] flex items-center justify-between gap-2 border-b border-line bg-surface max-w-full overflow-hidden">
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          {onBack && (
            <button
              onClick={onBack}
              className="md:hidden w-8 h-8 -ml-1 flex items-center justify-center rounded-lg text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors shrink-0"
              title="Back to conversations"
              aria-label="Back to conversations"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <Avatar
            name={displayName}
            seed={conversation.visitor_id}
            size="sm"
            online={isOnline}
            muted={!visitor?.name && !visitor?.email}
            className="shrink-0"
          />
          {/* Name on its own line, details under it: sharing one line made the
              name the first thing to be squeezed down to an ellipsis. */}
          <div className="flex flex-col min-w-0 flex-1 overflow-hidden">
            <div className="flex items-center gap-1.5 min-w-0">
              <h2
                className="text-sm font-semibold tracking-tight text-ink min-w-0 truncate leading-5"
                title={displayName}
              >
                {displayName}
              </h2>
              {conversation.channel && conversation.channel !== 'web' && (
                <ChannelBadge
                  channel={conversation.channel}
                  showLabel={false}
                  size="xs"
                />
              )}
            </div>

            <span className="text-2xs leading-4 text-ink-3 truncate hidden sm:flex items-center gap-1 min-w-0">
              {isOnline ? (
                <span className="inline-flex items-center gap-1 text-success font-medium shrink-0">
                  <span className="live-dot" />
                  Active now
                </span>
              ) : (
                <span className="shrink-0">Active {formatTimeAgo(visitor?.last_seen || conversation.updated_at)}</span>
              )}
              {visitorPlace.label && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1 text-ink-3 shrink-0" title={visitorPlace.label}>
                    <CountryFlag
                      flag={visitorPlace.flag}
                      countryCode={visitorPlace.countryCode}
                      className="w-3.5 h-2.5 shrink-0"
                    />
                    <span className="truncate max-w-[100px]">{visitorPlace.label}</span>
                  </span>
                </>
              )}
              {/* The email is in the customer panel, one click away; here it
                  only pushed the name and the actions together. */}
              {visitor?.email && !isDetailsSidebarOpen && (
                <>
                  <span>·</span>
                  <a
                    href={`mailto:${visitor.email}`}
                    className="truncate hover:text-accent transition-colors"
                  >
                    {visitor.email}
                  </a>
                </>
              )}
            </span>
          </div>
        </div>

        {/* Actions strip in header: keep in one row without shifting or wrapping */}
        {/* Status lives on the ticket row below (one place, not two); Resolve
            and "Waiting on customer" in More cover the chat's own status. */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0 ml-auto flex-nowrap">
          {onAskTeam && (
            <button
              type="button"
              onClick={onAskTeam}
              className="btn btn-sm btn-secondary shrink-0 px-2.5 flex items-center gap-1.5 cursor-pointer"
              title="Ask a teammate about this chat"
              aria-label="Ask the team about this conversation"
            >
              <MessagesSquare className="w-3.5 h-3.5" />
              <span className="hidden md:inline text-xs font-semibold">Ask team</span>
            </button>
          )}

          {conversation.status !== 'closed' ? (
            <button
              onClick={() => onUpdateStatus('closed')}
              className="btn btn-sm btn-primary shadow-xs shrink-0 px-2.5 flex items-center gap-1.5 cursor-pointer"
              title="Close and resolve this conversation"
              aria-label="Resolve conversation"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span className="text-xs font-semibold">Resolve</span>
            </button>
          ) : (
            <button
              onClick={() => onUpdateStatus('open')}
              className="btn btn-sm btn-secondary shadow-xs shrink-0 px-2.5 flex items-center gap-1.5 cursor-pointer"
              title="Reopen this conversation"
              aria-label="Reopen conversation"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="text-xs font-semibold">Reopen</span>
            </button>
          )}

          {/* More actions: AI Autopilot, Snooze, Merge, Auto-Assign */}
          <Menu<ThreadAction>
            value={"" as ThreadAction}
            label="More actions"
            className="shrink-0"
            options={[
              ...(onToggleAiMode
                ? [
                    {
                      value: "ai" as ThreadAction,
                      label:
                        conversation.ai_mode !== "disabled"
                          ? "Turn AI autopilot off"
                          : "Turn AI autopilot on",
                      description:
                        conversation.ai_mode !== "disabled"
                          ? "AI is answering this thread"
                          : `${AI_PAUSED_LABEL[conversation.ai_paused_reason ?? ""] ?? "AI is off"}. Turning it on answers the next customer message; nothing is sent now.`,
                    },
                  ]
                : []),
              ...(conversation.status !== "closed"
                ? [
                    conversation.status === "pending"
                      ? { value: "open" as ThreadAction, label: "Mark as open", description: "It needs a reply from the team" }
                      : {
                          value: "pending" as ThreadAction,
                          label: "Mark as waiting on customer",
                          description: "You replied and are waiting for them",
                        },
                  ]
                : []),
              {
                value: "snooze",
                label:
                  conversation.status === "snoozed" ? "Snoozed — edit" : "Snooze conversation",
                description: "Hide until a chosen time",
              },
              {
                value: "merge",
                label: "Merge with another conversation from this visitor",
                description: "Combine with another thread from this visitor",
              },
              {
                value: "auto-assign",
                label: isAutoAssigning ? "Assigning…" : "Auto-assign to agent",
                description: "Round-robin to an available teammate",
              },
            ]}
            onChange={(action) => {
              if (action === "pending" || action === "open") void onUpdateStatus(action);
              else if (action === "snooze") setShowSnoozeModal(true);
              else if (action === "merge") handleOpenMergeModal();
              else if (action === "auto-assign") handleAutoAssign();
              else if (action === "ai")
                void toggleBot(conversation.ai_mode === "disabled" ? "autopilot" : "disabled");
            }}
            trigger={({ open }) => (
              <span
                className={cn(
                  "btn btn-sm btn-secondary w-8 h-8 px-0 flex items-center justify-center shrink-0",
                  open && "bg-surface-3"
                )}
                title="More actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </span>
            )}
          />

          {/* CRM Details Sidebar Toggle */}
          {onToggleDetailsSidebar && (
            <button
              onClick={onToggleDetailsSidebar}
              title={isDetailsSidebarOpen ? "Hide customer details" : "Show customer details"}
              aria-label={isDetailsSidebarOpen ? "Hide customer details" : "Show customer details"}
              aria-pressed={!!isDetailsSidebarOpen}
              className={cn(
                "btn btn-sm btn-secondary w-8 h-8 px-0 flex items-center justify-center shrink-0 transition-all",
                isDetailsSidebarOpen ? "text-accent bg-accent-soft border-accent-line" : "text-ink-3 hover:text-ink"
              )}
            >
              {isDetailsSidebarOpen ? (
                <PanelRightClose className="w-4 h-4" />
              ) : (
                <PanelRightOpen className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </header>

      {/* The ticket behind this chat: number, status, priority, type, SLA. */}
      {conversation.current_ticket_id && workspace?.id && (
        <ConversationTicketBar
          workspaceId={workspace.id}
          ticketId={conversation.current_ticket_id}
          canEdit={currentAgent?.role !== 'light_agent'}
          refreshKey={[conversation.status, conversation.priority, conversation.updated_at].join('|')}
          onOpenTicket={onOpenTicket}
        />
      )}

      {/* ── Compact Metadata Toolbar: single line ──
          Who has it, how urgent, whether the bot answers, tags. The language
          is a correction tool, so it sits last. */}
      <div className="shrink-0 px-3 sm:px-4 py-1 flex items-center gap-1.5 border-b border-line bg-surface min-h-[34px] overflow-x-auto no-scrollbar">
        <Menu<string>
          value={conversation.assigned_agent_id || conversation.agent_id || ''}
          options={assignOptions}
          label="Assignee"
          align="start"
          className="shrink-0"
          onChange={(v) => onAssignAgent(v || null)}
        />

        <Menu<ConversationPriority>
          value={currentPriority}
          options={PRIORITY_OPTIONS}
          label="Priority"
          align="start"
          className="shrink-0"
          onChange={(v) => onUpdatePriority?.(v)}
        />
        <label
          className="order-last ml-auto h-6 px-2 rounded-md text-2xs font-semibold text-ink-3 hover:text-ink hover:bg-surface-3 flex items-center gap-1 shrink-0 cursor-pointer relative transition-colors"
          title={
            languageOverride
              ? `Language set manually: ${getLanguageInfo(detectedVisitorLang).name}`
              : `Detected language: ${getLanguageInfo(detectedVisitorLang).name} — click to correct`
          }
        >
          <Globe className="w-3 h-3 text-ink-3 shrink-0" />
          <span className="uppercase text-2xs">{detectedVisitorLang}</span>
          {languageOverride && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" aria-hidden />}
          <ChevronDown className="w-2.5 h-2.5 text-ink-3 shrink-0 opacity-60" />
          <select
            value={languageOverride || 'auto'}
            onChange={(e) => handleLanguageOverride(e.target.value)}
            aria-label="Conversation language"
            className="absolute inset-0 opacity-0 cursor-pointer"
          >
            <option value="auto">Auto-detect ({detectedVisitorLang.toUpperCase()})</option>
            {Object.values(SUPPORTED_LANGUAGES)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                  {l.nativeName && l.nativeName !== l.name ? ` (${l.nativeName})` : ''}
                </option>
              ))}
          </select>
        </label>

        {/* Interactive AI Autopilot Toggle Pill */}
        {onToggleAiMode && (() => {
          const isFullAutopilot = conversation.ai_mode === 'autopilot';
          const isAiDisabled = conversation.ai_mode === 'disabled';
          const isWorkspaceFirstReplyOn = Boolean(
            workspace?.ai_settings?.enabled !== false &&
            (workspace?.ai_settings?.auto_response_enabled ?? true)
          );

          return (
            <button
              type="button"
              onClick={() => void toggleBot(isFullAutopilot ? 'disabled' : 'autopilot')}
              className={cn(
                'shrink-0 h-6 px-2 rounded-md transition-all cursor-pointer inline-flex items-center gap-1 text-2xs',
                isFullAutopilot
                  ? 'bg-accent text-accent-ink font-semibold shadow-xs'
                  : isAiDisabled
                  ? 'bg-warn-soft text-warn border border-warn-line font-medium hover:bg-warn-line'
                  : isWorkspaceFirstReplyOn
                  ? 'bg-accent/15 text-accent border border-accent/30 font-medium'
                  : 'bg-surface-3 text-ink-3 hover:text-ink hover:bg-surface-3/80 border border-line'
              )}
              title={
                isFullAutopilot
                  ? 'The bot answers this chat. Click to pause it and reply yourself.'
                  : isAiDisabled
                  ? 'The bot is paused; a person is handling this chat. Click to let the bot answer again.'
                  : isWorkspaceFirstReplyOn
                  ? 'The bot gives the first reply. Click to let it answer the whole chat.'
                  : 'The bot is off. Click to let it answer.'
              }
            >
              <Bot className={cn('w-3 h-3', isFullAutopilot ? 'text-accent-ink' : isAiDisabled ? 'text-warn' : isWorkspaceFirstReplyOn ? 'text-accent' : 'text-ink-3')} />
              <span>
                {isFullAutopilot
                  ? 'Bot answering'
                  : isAiDisabled
                  ? 'Bot paused'
                  : isWorkspaceFirstReplyOn
                  ? 'Bot first reply'
                  : 'Bot off'}
              </span>
            </button>
          );
        })()}

        {conversation.status === "snoozed" && conversation.snoozed_until && (
          <span className="inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-2xs font-medium bg-warn/10 text-warn border border-warn/20 shrink-0">
            <Clock className="w-3 h-3" />
            Snoozed {formatTimeAgo(conversation.snoozed_until)}
          </span>
        )}

        <span className="w-px h-3.5 bg-line-2 mx-0.5 shrink-0" />

        {conversation.tags?.length ? (
          conversation.tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-2xs font-medium bg-accent/10 text-accent border border-accent/20 group shrink-0">
              {t}
              <button
                onClick={() => handleToggleTag(t)}
                aria-label={`Remove tag ${t}`}
                className="opacity-50 hover:opacity-100 transition-opacity"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))
        ) : null}

        <div ref={tagPickerRef} className="relative shrink-0">
          <button
            onClick={() => setShowTagPicker((s) => !s)}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-dashed border-line-2 text-2xs font-medium text-ink-3 hover:text-ink hover:border-line-3 transition-colors shrink-0 whitespace-nowrap"
          >
            <Plus className="w-3 h-3 shrink-0" />
            <span className="whitespace-nowrap">Tag</span>
          </button>

          {showTagPicker &&
            typeof document !== 'undefined' &&
            createPortal(
              <div
                ref={tagMenuRef}
                style={{
                  position: 'fixed',
                  top: `${tagPickerCoords.top}px`,
                  left: `${tagPickerCoords.left}px`,
                  zIndex: 9999,
                }}
                className="w-56 p-2 rounded-xl border border-line bg-surface shadow-2xl animate-pop"
              >
                <div className="eyebrow px-1.5 pb-1.5">Tags</div>
                <div className="space-y-0.5 mb-2">
                  {PRESET_TAGS.map((pt) => {
                    const active = (conversation.tags || []).includes(pt);
                    return (
                      <button
                        key={pt}
                        onClick={() => handleToggleTag(pt)}
                        className={cn(
                          'w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs transition-colors cursor-pointer',
                          active
                            ? 'bg-accent-soft text-accent font-medium'
                            : 'text-ink hover:bg-surface-3'
                        )}
                      >
                        {pt}
                        {active && <Check className="w-3.5 h-3.5" />}
                      </button>
                    );
                  })}
                </div>
                <div className="pt-2 border-t border-line flex items-center gap-1.5">
                  <input
                    type="text"
                    placeholder="Custom tag"
                    value={customTagInput}
                    onChange={(e) => setCustomTagInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddCustomTag()}
                    className="input input-sm flex-1"
                  />
                  <button
                    onClick={handleAddCustomTag}
                    className="btn btn-sm btn-primary shrink-0"
                  >
                    Add
                  </button>
                </div>
              </div>,
              document.body
            )}
        </div>

        {conversation.csat_rating && (
          <span
            className="inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-2xs font-medium bg-warn/10 text-warn border border-warn/20 shrink-0"
            title={
              conversation.csat_feedback
                ? `CSAT ${conversation.csat_rating}/5 — ${conversation.csat_feedback}`
                : `CSAT ${conversation.csat_rating}/5`
            }
          >
            <Star className="w-3 h-3 fill-current" />
            {conversation.csat_rating}/5
          </span>
        )}
      </div>

      {/* ── Collision Warning Banner ── */}
      {collisionAgents.length > 0 && (
        <div className="bg-warn/10 border-b border-warn/25 px-5 py-2.5 flex items-center justify-between text-xs text-warn animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warn shrink-0" />
            <span>
              <strong>Collision Warning:</strong>{' '}
              {collisionAgents.map((a) => a.name).join(', ')}{' '}
              {collisionAgents.length === 1 ? 'is' : 'are'} also viewing this conversation.
            </span>
          </div>
          <div className="flex -space-x-1.5 overflow-hidden">
            {collisionAgents.map((a) => (
              <Avatar key={a.id} name={a.name} size="xs" />
            ))}
          </div>
        </div>
      )}

      {/* ── Messages ── */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={messagesContainerRef}
          onScroll={handleMessagesScroll}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pt-6 pb-5 space-y-3.5"
        >
          <div className="flex justify-center">
            <span className="pill pill-neutral">
              Conversation opened {formatTimeAgo(conversation.created_at)}
            </span>
          </div>
          {rendered}
          <div ref={messagesEndRef} />
        </div>

        {showJumpToLatest && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 h-8 pl-3 pr-3.5 rounded-full bg-surface border border-line shadow-lg text-xs font-semibold text-ink hover:border-accent hover:text-accent transition-colors inline-flex items-center gap-1.5 cursor-pointer animate-pop"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            {unseenCount > 0
              ? `${unseenCount} new message${unseenCount === 1 ? '' : 's'}`
              : 'Jump to latest'}
          </button>
        )}
      </div>

      {/* ── Composer ── */}
      <div className="shrink-0 px-5 py-3.5 border-t border-line bg-surface relative">
        {/* Floating Error Toast for Note Saving Failure */}
        {noteErrorToast && (
          <div
            role="alert"
            className="absolute bottom-[calc(100%+8px)] left-5 right-5 z-50 rounded-xl bg-danger text-ink-inv shadow-xl p-3 flex items-center justify-between gap-2.5 animate-pop"
          >
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="w-4 h-4 shrink-0 text-white" />
              <span className="text-xs font-medium leading-snug">{noteErrorToast}</span>
            </div>
            <button
              type="button"
              onClick={() => setNoteErrorToast(null)}
              className="text-white/80 hover:text-white p-1 rounded-md hover:bg-white/20 transition-colors shrink-0 cursor-pointer"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {showMacros && (
          <div className="absolute bottom-[calc(100%-4px)] left-5 right-5 z-50 rounded-xl border border-line bg-surface shadow-xl p-2.5 animate-pop">
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="eyebrow flex items-center gap-1.5">
                <Zap className="w-3 h-3 text-accent" />
                Saved Quick Replies
              </span>
              <span className="text-2xs text-ink-3">
                Type <span className="kbd font-mono">/</span> to open
              </span>
            </div>

            <input
              type="text"
              placeholder="Search replies by /shortcut or title…"
              value={macroSearch}
              onChange={(e) => setMacroSearch(e.target.value)}
              className="input input-sm mb-2 font-mono text-xs"
              autoFocus
            />

            <div className="max-h-56 overflow-y-auto space-y-0.5">
              {filteredMacros.length === 0 ? (
                <p className="py-4 text-center text-xs text-ink-3">
                  No matching replies. Add them in Settings &gt; Saved Quick Replies.
                </p>
              ) : (
                filteredMacros.map((macro) => (
                  <button
                    key={macro.shortcut}
                    type="button"
                    onClick={() => insertMacro(macro)}
                    className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-surface-3 transition-colors group cursor-pointer"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold font-mono text-accent group-hover:text-accent-hover transition-colors">
                        /{macro.shortcut}
                      </span>
                      <span className="text-2xs text-ink-3 shrink-0">
                        {macro.title}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3 truncate">
                      {macro.content}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* ── Teammate @Mention Palette ── */}
        {showMentions && isInternalMode && (
          <div className="absolute bottom-[calc(100%-4px)] left-5 z-50 rounded-xl border border-line bg-surface shadow-xl p-2 w-64 animate-pop">
            <div className="flex items-center justify-between mb-1.5 px-1.5">
              <span className="eyebrow flex items-center gap-1 text-2xs text-warn font-semibold">
                <AtSign className="w-3 h-3" />
                Mention teammate
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {agentsList
                .filter(
                  (a) =>
                    !mentionFilter ||
                    a.name.toLowerCase().includes(mentionFilter)
                )
                .map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => handleInsertMention(agent)}
                    className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-surface-3 transition-colors flex items-center gap-2"
                  >
                    <Avatar name={agent.name} seed={agent.id} size="xs" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-ink truncate">
                        {agent.name}
                      </p>
                      <p className="text-2xs text-ink-3 truncate">
                        {agent.email}
                      </p>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* Suggested replies from the configured model provider */}
        {/* AI suggestions: a draft is only ever put into the composer for the
            agent to read and send. Nothing here sends on its own. */}
        {suggestedReplies.length > 0 && (
          <section
            aria-label="Suggested replies"
            className="mb-3 p-3 rounded-lg bg-accent-soft border border-accent-line flex flex-col gap-2 animate-fade"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-2xs font-semibold text-accent">
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                {suggestedReplies.length === 1 ? 'Suggested reply' : `${suggestedReplies.length} suggested replies`}
              </span>
              <button
                type="button"
                onClick={() => setSuggestedReplies([])}
                className="btn btn-ghost btn-xs"
              >
                Dismiss all
              </button>
            </div>
            {replyLocked && (
              <p className="text-2xs text-ink-2">The bot is answering this conversation. Take over to send a draft.</p>
            )}
            <ul className="flex flex-col gap-2 max-h-56 overflow-y-auto">
              {suggestedReplies.map((sr, idx) => (
                <li key={idx} className="rounded-md bg-surface border border-line p-2.5">
                  <p className="text-2xs font-semibold text-ink-2 mb-0.5">{sr.title}</p>
                  <p className="text-sm leading-snug text-ink line-clamp-3 whitespace-pre-wrap">{sr.text}</p>
                  <div className="mt-2 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setInputText(sr.text);
                        setSuggestedReplies([]);
                        if (textareaRef.current) {
                          textareaRef.current.style.height = 'auto';
                          textareaRef.current.focus();
                        }
                      }}
                      className="btn btn-primary btn-xs"
                    >
                      Use
                    </button>
                    <button
                      type="button"
                      onClick={() => setSuggestedReplies((prev) => prev.filter((_, i) => i !== idx))}
                      className="btn btn-ghost btn-xs"
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Unified Linear-Style Composer Card */}
        <div
          className={cn(
            // Note mode tints the whole composer, not just the tab, so a note
            // can't be mistaken for a reply while it is being written.
            'rounded-lg border transition-colors duration-200 relative',
            isInternalMode
              ? 'bg-warn-soft border-warn-line focus-within:border-warn'
              : 'bg-surface border-line-2 focus-within:border-accent focus-within:shadow-[var(--ds-ring)]'
          )}
        >
          {/* Replying to — kept above the toolbar so the message being
              answered stays in view while the answer is written. */}
          {replyPreview && !isInternalMode && (
            <div className="flex items-start gap-2 px-3 pt-2.5 pb-2 border-b border-line bg-accent-soft rounded-t-lg">
              <span className="mt-0.5 w-0.5 self-stretch rounded-full bg-accent shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-2xs font-semibold text-accent">
                  Replying to {replyPreview.who}
                </p>
                <p className="text-xs text-ink-2 truncate">
                  {replyPreview.text}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                title="Cancel reply"
                aria-label="Cancel reply"
                className="shrink-0 w-6 h-6 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Composer Header Bar */}
          <div
            className={cn(
              'px-2 pt-2 pb-1 flex items-center justify-between gap-2 min-w-0',
              !replyPreview && 'rounded-t-lg'
            )}
          >
            {/* Mode switcher: the segmented control from docs/DESIGN.md */}
            <div role="tablist" aria-label="Message type" className="tabs-pill shrink-0">
              {!isLightAgent && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={composerMode === 'reply'}
                  onClick={() => setComposerMode('reply')}
                  className="tab text-xs"
                >
                  <Send className="w-3 h-3 shrink-0" aria-hidden="true" />
                  Reply
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={composerMode === 'internal'}
                onClick={() => setComposerMode('internal')}
                className={cn('tab text-xs', composerMode === 'internal' && 'text-warn')}
              >
                <Lock className="w-3 h-3 shrink-0" aria-hidden="true" />
                Internal note
              </button>
            </div>

            <div className="text-2xs truncate">
              {isInternalMode && (
                <span className="hidden sm:inline text-warn font-medium">Only your team sees notes</span>
              )}
            </div>
          </div>

          {/* Hidden File Inputs for Attachments */}
          <input
            type="file"
            ref={imageInputRef}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleSelectFile(file);
            }}
            className="hidden"
            accept="image/*,.heic,.heif"
          />
          <input
            type="file"
            ref={fileInputRef}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleSelectFile(file);
            }}
            className="hidden"
            accept="image/*,.pdf,.txt"
          />

          {/* Pending Attachment Preview Banner */}
          {pendingAttachment && (
            <div className="flex items-center gap-2.5 px-3 py-2 border-b border-line/60 bg-surface-2/60 animate-rise">
              {pendingAttachment.isImage && pendingAttachment.previewUrl ? (
                <img
                  src={pendingAttachment.previewUrl}
                  alt="Preview"
                  className="w-10 h-10 rounded-lg object-cover border border-line shrink-0"
                />
              ) : (
                <div className="w-10 h-10 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-ink truncate">
                  {pendingAttachment.file.name}
                </p>
                <p className="text-2xs text-ink-3">
                  {(pendingAttachment.file.size / 1024).toFixed(0)} KB · Ready to send via Cloudinary
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (pendingAttachment.previewUrl) URL.revokeObjectURL(pendingAttachment.previewUrl);
                  setPendingAttachment(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                  if (imageInputRef.current) imageInputRef.current.value = '';
                }}
                className="p-1 rounded-md text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors cursor-pointer"
                title="Remove attachment"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* A customer the bot handed over: one button takes the chat and stops the ring. */}
          {waitingForPerson && onConnect && !isLightAgent && conversation.status !== 'closed' && (
            <div
              role="status"
              className="px-3 py-2 flex flex-wrap items-center gap-2 border-b border-warn-line bg-warn-soft text-xs"
            >
              <PhoneCall
                className={cn('w-4 h-4 text-warn shrink-0', ringing && 'animate-pulse')}
                aria-hidden="true"
              />
              <span className="flex-1 min-w-[160px] text-ink">
                <span className="font-bold text-warn">
                  {conversation.visitor?.name || 'The customer'} is waiting for a person.
                </span>{' '}
                Connect to take this chat: the bot stops and the customer is told you are here.
                {connectError && <span className="block text-danger mt-0.5">{connectError}</span>}
              </span>
              <button
                type="button"
                disabled={connecting}
                onClick={async () => {
                  setConnecting(true);
                  setConnectError(null);
                  try {
                    await onConnect();
                  } catch (err) {
                    setConnectError(errorMessage(err, 'Could not connect. Try again.'));
                  } finally {
                    setConnecting(false);
                  }
                }}
                className="h-7 px-3 rounded-md text-xs font-bold bg-accent hover:bg-accent-hover text-accent-ink shrink-0 inline-flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-60 disabled:cursor-wait"
              >
                <PhoneCall className="w-3.5 h-3.5" aria-hidden="true" />
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          )}

          {replyLocked && !(waitingForPerson && onConnect) && (
            <div className="px-3 py-2 flex items-center gap-2 border-b border-line/40 bg-accent/10 text-xs text-ink">
              <Bot className="w-3.5 h-3.5 text-accent shrink-0" />
              <span className="flex-1 min-w-0">
                The bot is answering this chat.
              </span>
              {onToggleAiMode && (
                <button
                  type="button"
                  onClick={() => void toggleBot('disabled')}
                  className="h-6 px-2.5 rounded-md text-2xs font-bold bg-accent hover:bg-accent-hover text-accent-ink shrink-0 cursor-pointer"
                >
                  Take over
                </button>
              )}
            </div>
          )}

          {/* A person has this chat. Two ways back to the bot: hand it back
              with this reply (sent first, so the reply cannot pause it
              again), or switch it on now without writing anything. */}
          {!replyLocked &&
            !isInternalMode &&
            conversation.ai_mode === 'disabled' &&
            onToggleAiMode &&
            !(waitingForPerson && onConnect) &&
            !isLightAgent && (
              <div className="px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-2 text-2xs">
                <span className="flex-1 min-w-[140px] text-ink-2">You are handling this chat. The bot is paused.</span>
                <label className="inline-flex items-center gap-1.5 text-ink-2 cursor-pointer select-none shrink-0">
                  <input
                    type="checkbox"
                    checked={handBack}
                    onChange={(e) => setHandBack(e.target.checked)}
                    className="accent-[var(--ds-accent)] w-3.5 h-3.5"
                  />
                  Hand back to the bot after my reply
                </label>
                <button
                  type="button"
                  onClick={() => void toggleBot('autopilot')}
                  title="The bot answers the customer's next message. Replying yourself after this pauses it again."
                  className="h-6 px-2 rounded-md font-semibold text-accent hover:bg-accent-soft shrink-0 inline-flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <Bot className="w-3 h-3" aria-hidden="true" />
                  Turn on now
                </button>
              </div>
            )}

          {/* Textarea */}
          <div className="p-3">
            <textarea
              ref={textareaRef}
              rows={3}
              disabled={replyLocked}
              value={inputText}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                isInternalMode
                  ? 'Write a note your team will see… (@ to mention)'
                  : replyLocked
                  ? 'Take over to reply, or switch to Internal note'
                  : pendingAttachment
                  ? 'Add a caption for this picture (optional)…'
                  : `Reply to ${displayName}…`
              }
              className="w-full bg-transparent text-ui leading-relaxed text-ink resize-none focus:outline-none placeholder:text-ink-3 min-h-[66px] max-h-[220px] overflow-y-auto"
            />
          </div>

          {/* A send that fails must say so. The draft is restored above, but
              without this the agent only saw their text reappear and assumed
              the message had gone out. */}
          {sendError && (
            <div
              role="alert"
              className="px-3 py-2 flex items-center gap-2 border-t border-danger-line bg-danger-soft text-xs text-danger"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1 min-w-0">{sendError}</span>
              <button
                onClick={handleSend}
                className="font-semibold underline underline-offset-2 hover:opacity-80 shrink-0"
              >
                Retry
              </button>
              <button
                onClick={() => setSendError(null)}
                aria-label="Dismiss"
                className="opacity-60 hover:opacity-100 shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* WhatsApp Style Emoji Picker Popover */}
          {showEmojiPicker && (
            <div className="p-2.5 bg-surface border-t border-line flex flex-col gap-2 shadow-lg max-h-64 animate-in fade-in duration-150">
              {/* Search */}
              <input
                type="text"
                value={emojiSearchQuery}
                onChange={(e) => setEmojiSearchQuery(e.target.value)}
                placeholder="Search emojis..."
                className="w-full px-2.5 py-1 text-xs rounded-lg border border-line bg-surface-2 focus:outline-none focus:ring-1 focus:ring-accent"
              />
              {/* Category tabs */}
              <div className="flex items-center gap-1 overflow-x-auto pb-1 border-b border-line">
                {EMOJI_CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      setActiveEmojiCategory(cat.id);
                      setEmojiSearchQuery('');
                    }}
                    title={cat.name}
                    className={cn(
                      'p-1 text-sm rounded-md transition-colors cursor-pointer',
                      activeEmojiCategory === cat.id && !emojiSearchQuery
                        ? 'bg-surface-3'
                        : 'hover:bg-surface-2'
                    )}
                  >
                    {cat.icon}
                  </button>
                ))}
              </div>
              {/* Emojis Grid */}
              <div className="grid grid-cols-10 sm:grid-cols-12 gap-1 max-h-36 overflow-y-auto pr-1">
                {(emojiSearchQuery
                  ? ALL_EMOJIS
                  : EMOJI_CATEGORIES.find((c) => c.id === activeEmojiCategory)?.emojis || EMOJI_CATEGORIES[0].emojis
                ).map((emoji, idx) => (
                  <button
                    key={`${emoji}-${idx}`}
                    type="button"
                    onClick={() => handleInsertEmoji(emoji)}
                    className="text-lg hover:scale-125 transition-transform p-1 rounded hover:bg-surface-2 flex items-center justify-center leading-none cursor-pointer"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Composer Footer Action Bar */}
          <div className="@container px-3 py-2 bg-surface-2/40 border-t border-line/40 flex items-center justify-between text-2xs text-ink-3 rounded-b-2xl min-h-[42px] gap-2">
            {/* Left Action Tools */}
            <div className="flex items-center gap-1 min-w-0 flex-nowrap">
              {/* Attachment Buttons */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isSending}
                className="w-7 h-7 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors inline-flex items-center justify-center cursor-pointer shrink-0"
                title="Attach document or file"
                aria-label="Attach file"
              >
                <Paperclip className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={isSending}
                className="w-7 h-7 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors inline-flex items-center justify-center cursor-pointer shrink-0"
                title="Attach photo/image (Cloudinary)"
                aria-label="Attach photo"
              >
                <ImageIcon className="w-3.5 h-3.5" />
              </button>

              {/* Emoji Button */}
              <button
                type="button"
                onClick={() => setShowEmojiPicker((prev) => !prev)}
                disabled={isSending}
                className={cn(
                  'w-7 h-7 rounded-lg transition-colors inline-flex items-center justify-center cursor-pointer shrink-0',
                  showEmojiPicker
                    ? 'text-accent bg-accent/15'
                    : 'text-ink-3 hover:text-ink hover:bg-surface-3'
                )}
                title="Insert emoji"
                aria-label="Insert emoji"
              >
                <Smile className="w-3.5 h-3.5" />
              </button>

              <span className="w-px h-3.5 bg-line-2 mx-1 shrink-0" />

              {/* Canned Replies */}
              <button
                type="button"
                onClick={() => setShowMacros((s) => !s)}
                className="h-7 px-2 rounded-lg text-2xs font-medium text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors inline-flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap"
                title="Saved canned responses (/)"
              >
                <Zap className="w-3.5 h-3.5 text-warn shrink-0" />
                <span className="hidden @min-[520px]:inline">Replies</span>
              </button>

              {/* AI Copilot */}
              <button
                type="button"
                onClick={handleGenerateAiSuggestion}
                disabled={aiDrafting}
                className="h-7 px-2 rounded-lg text-2xs font-semibold text-accent hover:bg-accent/10 transition-colors inline-flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap"
                title="Ask AI Copilot to draft a response"
              >
                <Sparkles className={cn('w-3.5 h-3.5 shrink-0', aiDrafting && 'animate-spin')} />
                <span className="hidden @min-[520px]:inline">{aiDrafting ? 'Drafting…' : 'AI Copilot'}</span>
              </button>

              {/* ── Translation Controls (Unified & Sleek) ── */}
              {composerMode === 'reply' && (
                <div className="relative shrink-0" ref={translateMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowTranslateMenu((prev) => !prev)}
                    className={cn(
                      'h-7 px-2 rounded-lg text-2xs font-medium transition-all inline-flex items-center gap-1.5 cursor-pointer shadow-2xs shrink-0 whitespace-nowrap',
                      autoTranslateEnabled && targetLanguage !== 'en'
                        ? 'bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25 font-bold'
                        : 'text-ink-3 hover:text-ink hover:bg-surface-3 border border-transparent'
                    )}
                    title={
                      autoTranslateEnabled && targetLanguage !== 'en'
                        ? `Auto-translating replies to ${getLanguageInfo(targetLanguage).name}. Click to change.`
                        : `Translate replies into customer's language. Click to enable.`
                    }
                  >
                    <Globe className={cn('w-3.5 h-3.5 shrink-0', autoTranslateEnabled && targetLanguage !== 'en' ? 'text-accent' : 'text-ink-3')} />
                    {autoTranslateEnabled && targetLanguage !== 'en' ? (
                      <span className="inline-flex items-center gap-1">
                        {/* Narrow composer (phones): the code only, so the
                            button never runs under the Send button. */}
                        <span className="uppercase @min-[520px]:hidden">{targetLanguage}</span>
                        <span className="hidden @min-[520px]:inline">{getLanguageInfo(targetLanguage).flag || ''}</span>
                        <span className="hidden @min-[520px]:inline max-w-[120px] truncate">{getLanguageInfo(targetLanguage).name}</span>
                        <ChevronDown className="w-2.5 h-2.5 opacity-60 ml-0.5" />
                      </span>
                    ) : (
                      <span className="hidden @min-[520px]:inline">Translate</span>
                    )}
                  </button>

                  {/* Popover Dropdown Menu (Opens Upward from Toolbar) */}
                  {showTranslateMenu && (
                    <div className="absolute left-0 bottom-full mb-2 z-50 w-80 max-h-[min(520px,calc(100vh-140px))] overflow-y-auto overscroll-contain bg-surface rounded-2xl border border-line shadow-2xl p-3.5 space-y-3 animate-pop focus:outline-none">
                      <div className="sticky -top-3.5 -mx-3.5 -mt-3.5 px-3.5 pt-3 pb-2.5 bg-surface border-b border-line/60 flex items-center justify-between z-10 rounded-t-2xl">
                        <div className="flex items-center gap-1.5 text-xs font-bold text-ink">
                          <Globe className="w-3.5 h-3.5 text-accent" />
                          <span>Translation Settings</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowTranslateMenu(false)}
                          className="text-ink-3 hover:text-ink p-1 rounded-md hover:bg-surface-2 transition-colors cursor-pointer"
                          title="Close settings"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Customer Native Language Status */}
                      <div className="bg-surface-2/70 rounded-lg p-2.5 space-y-2 border border-line/40">
                        <div className="flex items-center justify-between text-2xs">
                          <span className="text-ink-3 font-medium">Customer speaks:</span>
                          <span className="font-bold text-ink flex items-center gap-1">
                            <span>{getLanguageInfo(detectedVisitorLang).flag}</span>
                            <span>{getLanguageInfo(detectedVisitorLang).name}</span>
                            {getLanguageInfo(detectedVisitorLang).nativeName && (
                              <span className="text-ink-3 font-normal">({getLanguageInfo(detectedVisitorLang).nativeName})</span>
                            )}
                          </span>
                        </div>

                        {/* Reset / Lock to Customer Language Button */}
                        <button
                          type="button"
                          onClick={() => {
                            if (languageOverride) handleLanguageOverride('auto');
                            setTargetLanguage(detectedVisitorLang);
                            setAutoTranslateEnabled(detectedVisitorLang !== 'en');
                          }}
                          className="w-full py-1.5 px-2.5 rounded-lg text-2xs font-semibold bg-accent-soft hover:bg-accent-soft text-accent border border-accent-line transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
                        >
                          <RotateCcw className="w-3 h-3 shrink-0" />
                          <span>Auto-lock to Customer ({getLanguageInfo(detectedVisitorLang).name})</span>
                        </button>
                      </div>

                      {/* Manual Override Dropdown */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-2xs">
                          <label className="font-semibold text-ink">
                            Customer Receives Replies In:
                          </label>
                          {targetLanguage !== detectedVisitorLang && (
                            <span className="text-2xs text-warn font-bold bg-warn/10 px-1.5 py-0.5 rounded">
                              Custom Override
                            </span>
                          )}
                        </div>
                        <select
                          value={targetLanguage}
                          onChange={(e) => {
                            // Saved as the conversation's language override, so
                            // the choice survives a reload and is not undone by
                            // the next detected visitor message.
                            handleLanguageOverride(e.target.value);
                          }}
                          aria-label="Select Customer Language"
                          className="w-full text-xs font-semibold bg-surface border border-line-2 rounded-lg px-2.5 py-1.5 text-ink focus:outline-none focus:ring-2 focus:ring-accent cursor-pointer shadow-2xs"
                        >
                          <option value="en">🇬🇧 English (Original / No Translation)</option>
                          {Object.values(SUPPORTED_LANGUAGES)
                            .filter((l) => l.code !== 'en')
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map((l) => (
                              <option key={l.code} value={l.code}>
                                {l.flag || '🌐'} {l.name} {l.nativeName && l.nativeName !== l.name ? `(${l.nativeName})` : ''}
                              </option>
                            ))}
                        </select>
                      </div>

                      {/* On / Off Toggle */}
                      <div className="pt-2 border-t border-line/60 flex items-center justify-between">
                        <div className="space-y-0.5">
                          <p className="text-2xs font-bold text-ink">Auto-Translation</p>
                          <p className="text-2xs text-ink-3">Translate agent replies automatically</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setAutoTranslateEnabled(!autoTranslateEnabled)}
                          className={cn(
                            'text-2xs px-2.5 py-1 rounded-md font-bold transition-all cursor-pointer shadow-2xs',
                            autoTranslateEnabled
                              ? 'bg-accent hover:bg-accent text-white'
                              : 'bg-surface-2 hover:bg-surface-3 text-ink-2 border border-line'
                          )}
                        >
                          {autoTranslateEnabled ? 'Enabled (ON)' : 'Disabled (OFF)'}
                        </button>
                      </div>

                      <div className="text-2xs text-ink-3 bg-surface-2/40 p-2 rounded-lg border border-line/30 leading-snug">
                        ✨ <strong>Workflow:</strong> Write in English or any language. The customer receives your reply in {getLanguageInfo(targetLanguage).name}. Customer replies will always appear in English for you.
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right Action Tools: Shortcut Hint & Send Button */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setSendOnEnter((prev) => {
                    const next = !prev;
                    try {
                      localStorage.setItem('zen_send_on_enter', String(next));
                    } catch {}
                    return next;
                  });
                }}
                className="hidden @min-[640px]:inline-flex items-center gap-1 text-2xs text-ink-3 hover:text-ink transition-colors cursor-pointer group"
                title={
                  sendOnEnter
                    ? "Pressing Enter sends. Click to switch to Ctrl+Enter."
                    : "Pressing Ctrl+Enter sends. Click to switch to Enter."
                }
              >
                <span>Press</span>
                <span className="kbd text-2xs group-hover:border-accent group-hover:text-accent transition-colors font-semibold">
                  {sendOnEnter ? '↵' : 'Ctrl ↵'}
                </span>
                <span>to send</span>
              </button>

              <button
                onClick={handleSend}
                disabled={(!inputText.trim() && !pendingAttachment) || isSending || isTranslating || replyLocked}
                title={
                  isInternalMode
                    ? 'Post internal note (Ctrl+Enter)'
                    : autoTranslateEnabled && targetLanguage !== 'en'
                    ? `Translate into ${getLanguageInfo(targetLanguage).name} and send (Ctrl+Enter)`
                    : 'Send reply (Ctrl+Enter)'
                }
                className={cn(
                  'h-8 md:h-7 px-3 rounded-lg flex items-center shrink-0 whitespace-nowrap gap-1.5 text-xs font-bold transition-all shadow-xs cursor-pointer',
                  (!inputText.trim() && !pendingAttachment) || isSending || isTranslating || replyLocked
                    ? 'bg-surface-3 text-ink-3 cursor-not-allowed opacity-50'
                    : isInternalMode
                    ? 'bg-warn hover:bg-warn text-ink-inv shadow-sm hover:scale-102'
                    : autoTranslateEnabled && targetLanguage !== 'en'
                    ? 'bg-accent hover:bg-accent text-white shadow-sm hover:scale-102'
                    : 'bg-accent hover:bg-accent-hover text-accent-ink shadow-sm hover:scale-102'
                )}
              >
                {isTranslating ? (
                  <>
                    <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    <span>Translating…</span>
                  </>
                ) : isSending ? (
                  <>
                    <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    <span>Sending…</span>
                  </>
                ) : isInternalMode ? (
                  <>
                    <Lock className="w-3 h-3" />
                    <span>Add Note</span>
                  </>
                ) : autoTranslateEnabled && targetLanguage !== 'en' ? (
                  <>
                    <Globe className="w-3 h-3" />
                    <span className="hidden @min-[520px]:inline">Translate &amp; Send</span>
                    <span className="@min-[520px]:hidden">Send</span>
                  </>
                ) : handBack && conversation.ai_mode === 'disabled' ? (
                  <>
                    <Bot className="w-3 h-3" />
                    <span>Send &amp; hand back</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3 h-3" />
                    <span>Send</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Snooze Modal ── */}
      {showSnoozeModal && (
        <div className="fixed inset-0 z-50 bg-overlay flex items-center justify-center p-4">
          <div className="popover rounded-2xl border border-line shadow-2xl max-w-sm w-full p-5 animate-pop space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-md font-bold text-ink flex items-center gap-2">
                <Clock className="w-4 h-4 text-warn" />
                Snooze Conversation
              </h3>
              <button
                onClick={() => setShowSnoozeModal(false)}
                className="p-1 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-ink-2 leading-relaxed">
              This conversation will be hidden until the chosen time, then
              automatically reopen in your inbox.
            </p>

            <div className="space-y-2">
              <button
                onClick={() => handleSnooze(60)}
                className="w-full text-left p-2.5 rounded-xl border border-line hover:border-accent hover:bg-surface-2 transition-all flex items-center justify-between text-xs font-medium"
              >
                <span>In 1 hour</span>
                <span className="text-2xs text-ink-3">
                  {new Date(Date.now() + 3600000).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </button>

              <button
                onClick={() => {
                  const d = new Date();
                  d.setDate(d.getDate() + 1);
                  d.setHours(9, 0, 0, 0);
                  handleSnooze(d.toISOString());
                }}
                className="w-full text-left p-2.5 rounded-xl border border-line hover:border-accent hover:bg-surface-2 transition-all flex items-center justify-between text-xs font-medium"
              >
                <span>Tomorrow morning</span>
                <span className="text-2xs text-ink-3">9:00 AM</span>
              </button>

              <button
                onClick={() => {
                  const d = new Date();
                  d.setDate(d.getDate() + ((1 + 7 - d.getDay()) % 7 || 7));
                  d.setHours(9, 0, 0, 0);
                  handleSnooze(d.toISOString());
                }}
                className="w-full text-left p-2.5 rounded-xl border border-line hover:border-accent hover:bg-surface-2 transition-all flex items-center justify-between text-xs font-medium"
              >
                <span>Next Monday</span>
                <span className="text-2xs text-ink-3">9:00 AM</span>
              </button>
            </div>

            {/* Custom Datetime Picker */}
            <div className="pt-2 border-t border-line space-y-2">
              <label className="block text-2xs font-semibold text-ink-3 uppercase tracking-wider">
                Custom time
              </label>
              <div className="flex gap-2">
                <input
                  type="datetime-local"
                  value={customSnoozeDate}
                  onChange={(e) => setCustomSnoozeDate(e.target.value)}
                  className="input input-sm flex-1 text-xs"
                />
                <button
                  disabled={!customSnoozeDate}
                  onClick={() => handleSnooze(customSnoozeDate)}
                  className="btn btn-sm btn-primary shrink-0"
                >
                  Set
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Merge Conversations Modal ── */}
      {showMergeModal && (
        <div className="fixed inset-0 z-50 bg-overlay flex items-center justify-center p-4">
          <div className="popover rounded-2xl border border-line shadow-2xl max-w-md w-full p-5 animate-pop space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-md font-bold text-ink flex items-center gap-2">
                <GitMerge className="w-4 h-4 text-accent" />
                Merge Conversations
              </h3>
              <button
                onClick={() => setShowMergeModal(false)}
                className="p-1 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-ink-2 leading-relaxed">
              Consolidate messages and internal notes from another conversation
              into this active thread (<strong>#{conversation.id.slice(0, 8)}</strong>).
            </p>

            {/* Other Conversations from this Visitor */}
            <div className="space-y-2">
              <label className="block text-2xs font-semibold text-ink-3 uppercase tracking-wider">
                Visitor&apos;s other conversations
              </label>

              {mergeCandidates.length === 0 ? (
                <p className="text-xs text-ink-3 py-3 text-center border border-dashed border-line rounded-xl">
                  No other conversations found for this visitor.
                </p>
              ) : (
                <div className="max-h-48 overflow-y-auto space-y-1.5">
                  {mergeCandidates.map((cand) => (
                    <div
                      key={cand.id}
                      className="p-2.5 rounded-xl border border-line hover:border-accent hover:bg-surface-2 flex items-center justify-between gap-2 transition-colors"
                    >
                      <div className="min-w-0">
                        <span className="font-mono text-xs font-semibold text-ink block">
                          #{cand.id.slice(0, 8)}
                        </span>
                        <span className="text-2xs text-ink-3">
                          {formatTimeAgo(cand.created_at)} · {cand.status}
                        </span>
                      </div>
                      <button
                        onClick={() => handleExecuteMerge(cand.id)}
                        disabled={isMerging}
                        className="btn btn-xs btn-primary shrink-0"
                      >
                        {isMerging ? 'Merging…' : 'Merge this'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Manual ID Input */}
            <div className="pt-2 border-t border-line space-y-2">
              <label className="block text-2xs font-semibold text-ink-3 uppercase tracking-wider">
                Or enter another Conversation ID
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Paste conversation UUID…"
                  value={selectedMergeId}
                  onChange={(e) => setSelectedMergeId(e.target.value.trim())}
                  className="input input-sm flex-1 font-mono text-xs"
                />
                <button
                  disabled={!selectedMergeId || isMerging}
                  onClick={() => handleExecuteMerge(selectedMergeId)}
                  className="btn btn-sm btn-secondary shrink-0"
                >
                  Merge
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Image Lightbox Modal ── */}
      {previewImageModalUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 animate-in fade-in duration-150"
          onClick={() => setPreviewImageModalUrl(null)}
        >
          <div className="relative max-w-3xl max-h-[90vh] flex flex-col items-center">
            <button
              onClick={() => setPreviewImageModalUrl(null)}
              className="absolute -top-10 right-0 text-white hover:text-ink-3 p-1.5 rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
              title="Close image"
            >
              <X className="w-5 h-5" />
            </button>
            <img
              src={previewImageModalUrl}
              alt="Enlarged attachment"
              className="max-h-[80vh] w-auto max-w-full rounded-2xl object-contain shadow-2xl border border-white/10"
              onClick={(e) => e.stopPropagation()}
            />
            <div className="mt-3 text-center">
              <a
                href={previewImageModalUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-xs text-accent hover:text-accent-hover hover:underline inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 transition-colors"
              >
                <span>Open original in new tab</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Message Confirmation Modal ── */}
      {deleteConfirmMsg && (
        <div
          className="fixed inset-0 z-50 bg-overlay flex items-center justify-center p-4 animate-in fade-in duration-150"
          onClick={() => !isDeleting && setDeleteConfirmMsg(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-line popover p-5 shadow-2xl animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 text-danger mb-3">
              <div className="w-10 h-10 rounded-full bg-danger/10 grid place-items-center shrink-0">
                <Trash2 className="w-5 h-5 text-danger" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-ink">Delete message?</h3>
                <p className="text-xs text-ink-3 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>

            <p className="text-xs text-ink-2 mb-3">
              Are you sure you want to delete this message? It will be removed for everyone in this conversation:
            </p>

            <div className="p-3 rounded-xl bg-surface-2 border border-line mb-5 text-xs text-ink-2 max-h-24 overflow-y-auto italic">
              &ldquo;{deleteConfirmMsg.content || (deleteConfirmMsg.attachment_url ? 'Attachment file' : 'Message')}&rdquo;
            </div>

            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setDeleteConfirmMsg(null)}
                disabled={isDeleting}
                className="px-3.5 py-1.5 rounded-xl border border-line bg-surface text-xs font-medium text-ink hover:bg-surface-2 transition-colors disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="px-4 py-1.5 rounded-xl bg-danger text-ink-inv text-xs font-medium hover:bg-danger/90 transition-colors flex items-center gap-1.5 shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {isDeleting ? (
                  <>
                    <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete for everyone</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Toast Notification */}
      {saveAnswerSuccessToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-ink text-surface shadow-xl text-xs font-medium border border-line animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
          <span>{saveAnswerSuccessToast}</span>
        </div>
      )}

      {/* Save as Answer Modal */}
      {saveAnswerModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-surface border border-line rounded-2xl shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent grid place-items-center">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-ink">Save as Knowledge Base Answer</h3>
                  <p className="text-2xs text-ink-muted">Turn this exchange into an immediate bot training Q&A</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSaveAnswerModalOpen(false)}
                className="w-7 h-7 rounded-lg hover:bg-surface-2 text-ink-muted grid place-items-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmSaveAnswer} className="space-y-3.5">
              <div>
                <label className="block text-2xs font-semibold text-ink-2 uppercase tracking-wider mb-1">
                  Customer Question
                </label>
                <textarea
                  rows={2}
                  value={saveAnswerQuestion}
                  onChange={(e) => setSaveAnswerQuestion(e.target.value)}
                  placeholder="The question or issue this answers..."
                  required
                  className="w-full px-3 py-2 text-xs rounded-xl bg-surface-2 border border-line text-ink focus:outline-none focus:ring-1 focus:ring-accent resize-none"
                />
              </div>

              <div>
                <label className="block text-2xs font-semibold text-ink-2 uppercase tracking-wider mb-1">
                  Agent Answer / Bot Response
                </label>
                <textarea
                  rows={4}
                  value={saveAnswerContent}
                  onChange={(e) => setSaveAnswerContent(e.target.value)}
                  placeholder="The helpful, direct answer the AI bot should provide..."
                  required
                  className="w-full px-3 py-2 text-xs rounded-xl bg-surface-2 border border-line text-ink focus:outline-none focus:ring-1 focus:ring-accent resize-none"
                />
              </div>

              <div className="p-2.5 rounded-xl bg-surface-2 border border-line text-2xs text-ink-muted flex items-start gap-2">
                <BookOpen className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                <span>
                  This Q&A will be saved to your Knowledge Base, vectorized into embeddings immediately, and ready for the AI bot to answer similar customer questions going forward.
                </span>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setSaveAnswerModalOpen(false)}
                  disabled={isSavingAnswer}
                  className="px-3.5 py-1.5 rounded-xl border border-line text-xs font-medium text-ink-muted hover:text-ink hover:bg-surface-2 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingAnswer || !saveAnswerQuestion.trim() || !saveAnswerContent.trim()}
                  className="px-4 py-1.5 rounded-xl bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors flex items-center gap-1.5 shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {isSavingAnswer ? (
                    <>
                      <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving & Training...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Save & Train Bot</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One quiet line under a translated message: which language it was in, and a
 * link to flip between the English and the original. It used to be two
 * boxed pills that wrapped onto three lines on a phone and dwarfed the
 * message itself.
 */
function TranslationToggle({
  label,
  showingOriginal,
  onToggle,
  tone = 'in',
  showText = 'Original',
}: {
  /** e.g. "Zulu", "Sent in Arabic". */
  label: string;
  showingOriginal: boolean;
  onToggle: () => void;
  /** Link text while the English is shown ("Original", "View Arabic"). */
  showText?: string;
  /** 'out' sits on the agent's coloured bubble. */
  tone?: 'in' | 'out' | 'ai';
}) {
  return (
    <div
      className={cn(
        'mt-1.5 pt-1.5 border-t flex items-center gap-1.5 text-2xs leading-4 select-none min-w-0',
        tone === 'out'
          ? 'border-white/20 text-white/75'
          : tone === 'ai'
          ? 'border-accent/15 text-ink-3'
          : 'border-line text-ink-3'
      )}
    >
      <Globe className="w-3 h-3 shrink-0" />
      <span className="truncate min-w-0">{label}</span>
      <span aria-hidden className="shrink-0">·</span>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'shrink-0 font-semibold underline-offset-2 hover:underline cursor-pointer',
          tone === 'out' ? 'text-white' : tone === 'ai' ? 'text-accent' : 'text-accent'
        )}
      >
        {showingOriginal ? 'English' : showText}
      </button>
    </div>
  );
}

/**
 * The message a reply is answering, shown above it.
 *
 * A deleted original leaves the reply intact but unquotable — say so rather
 * than render an empty bar, which reads like a rendering bug.
 */
function QuotedMessage({
  quoted,
  visitorName,
  currentAgentId,
  onJump,
  tone,
}: {
  quoted: Message | null;
  visitorName: string;
  currentAgentId?: string;
  onJump: () => void;
  tone: 'in' | 'out';
}) {
  const who = !quoted
    ? ''
    : quoted.sender_type === 'agent'
    ? quoted.sender_id === currentAgentId
      ? 'You'
      : quoted.agent?.name || 'Agent'
    : quoted.sender_type === 'ai'
    ? 'AI'
    : visitorName;

  return (
    <button
      type="button"
      onClick={quoted ? onJump : undefined}
      disabled={!quoted}
      className={cn(
        'mb-1 w-full flex items-stretch gap-2 rounded-xl border px-2.5 py-1.5 text-left transition-colors',
        tone === 'out'
          ? 'border-line/60 bg-surface-2/70'
          : 'border-line/60 bg-surface-2/50',
        quoted ? 'hover:bg-surface-3/60 cursor-pointer' : 'cursor-default'
      )}
    >
      <span
        className={cn(
          'w-0.5 rounded-full shrink-0',
          quoted ? 'bg-accent' : 'bg-line'
        )}
      />
      <span className="min-w-0 flex-1">
        {quoted ? (
          <>
            <span className="block text-2xs font-semibold text-accent">
              {who}
            </span>
            <span className="block text-xs text-ink-2 line-clamp-2">
              {quoted.content}
            </span>
          </>
        ) : (
          <span className="block text-xs italic text-ink-3">
            Original message deleted
          </span>
        )}
      </span>
    </button>
  );
}
