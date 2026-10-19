import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CHATIFY_ICON_DATA_URI, ZENTRY_ICON_DATA_URI } from './icon';
import { EMOJI_CATEGORIES, ALL_EMOJIS } from '../../src/lib/emojis';
import { looksLikeImage, uploadChatImage } from '../../src/lib/image-upload';
import { splitLinks } from '../../src/lib/text/links';
import { normalizePrechat, prechatAsksNothing, type PrechatConfig, type PrechatFieldMode } from '../../src/lib/widget/prechat';
import { isChatFirstDesign, isHexColor, isWidgetColorMode, isWidgetDesign, launcherIcon, type WidgetColorMode, type WidgetDesignId } from '../../src/lib/widget/launcher-icons';
import { formatMarkdownToHtml } from '../../src/lib/widget/article-markdown';

const DEFAULT_API_URL = 'https://zen-try.site';
/** Hosts that only redirect to DEFAULT_API_URL; API calls go there directly. */
const LEGACY_API_HOSTS = new Set(['chat-system-wabd.vercel.app']);
const DEFAULT_SUPABASE_URL ='https://vfjsaynnubxywdbevxtx.supabase.co';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmanNheW5udWJ4eXdkYmV2eHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTA5MDEsImV4cCI6MjEwMzgyNjkwMX0.YyBCXMqwrOk5BRhQafYLFw8tiM5PC8lc8Yocodw9wf0';

interface NavbarTriggerConfig {
  enabled: boolean;
  label: string;
  action: 'help' | 'messages' | 'redirect';
  auto_inject: boolean;
  style: 'navbar_link' | 'pill';
  position?: 'start' | 'end';
  target_selector?: string;
  dismissed_prompt?: boolean;
}

interface WidgetConfig {
  supabaseUrl: string;
  supabaseKey: string;
  workspaceId: string | null;
  title: string;
  subtitle: string;
  primaryColor: string;
  position: 'bottom-right' | 'bottom-left';
  helpTabLabel: string;
  showHelpTab: boolean;
  helpTabIcon: string;
  logoUrl?: string;
  showLauncherLogo?: boolean;
  widgetIcon?: string;
  /** Window design chosen in Settings → Chat widget (classic, minimal, solid, midnight). */
  widgetDesign?: WidgetDesignId;
  /** Second colour for gradients; defaults to a darker brand colour. */
  secondaryColor?: string;
  /** auto follows the visitor's system; light / dark force one. */
  colorMode?: WidgetColorMode;
  greetingTitle?: string;
  welcomeText?: string;
  businessName?: string;
  customDomain?: string;
  helpSlug?: string;
  navbarTriggerConfig?: NavbarTriggerConfig;
  apiUrl?: string;
  businessHours?: any;
  offsetBottom?: number;
  offsetSide?: number;
  zIndex?: number;
  enableProactiveWelcome?: boolean;
  proactiveDelaySeconds?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MessageItem {
  id: string;
  sender_type: 'visitor' | 'agent' | 'ai';
  content: string;
  attachment_url?: string | null;
  created_at: string;
  is_internal?: boolean;
  /** Set once the agent's client acknowledged receipt. */
  delivered_at?: string | null;
  read_at?: string | null;
  /** Client-only: still in flight, shown as a clock rather than a tick. */
  pending?: boolean;
  /** The message this one answers, when the agent used Reply. */
  reply_to_message_id?: string | null;
  /** Edits, translations, handover and greeting markers (the session functions pass only these). */
  metadata?: Record<string, unknown> | null;
  conversation_id?: string;
}

/** fn_widget_session: the token (only when newly issued), realtime topic and latest conversation. */
interface WidgetSession {
  token?: string | null;
  topic?: string | null;
  conversation?: { id: string; status: string; csat_rating?: number | null } | null;
}

/** Broadcasts on the visitor's session topic (fn_widget_broadcast_* triggers). */
interface LiveMessagePayload {
  op?: 'INSERT' | 'UPDATE' | 'DELETE';
  message?: MessageItem;
}
interface LiveConversationPayload {
  op?: 'INSERT' | 'UPDATE';
  conversation?: { id: string; status: string };
}

interface HelpSectionItem {
  id: string;
  name: string;
  description?: string | null;
  icon?: string;
  order_index?: number;
  slug?: string;
  articleCount?: number;
}

interface FAQItem {
  id?: string;
  slug?: string;
  q: string;
  a: string;
  summary?: string;
  category: string;
  icon?: string;
  sectionId?: string | null;
  order_index?: number;
}

export interface ZentryAPI {
  open: (tab?: 'home' | 'messages' | 'help') => void;
  close: () => void;
  toggle: () => void;
  openHelp: () => void;
  openMessages: () => void;
  openArticle: (idOrSlug: string) => void;
  search: (query: string) => void;
  isOpen: () => boolean;
  resetSession: () => void;
  switchTab: (tab: 'home' | 'messages' | 'help') => void;
  showPopup: (text?: string, senderTitle?: string) => void;
  hidePopup: () => void;
  instance: ZentryWidget;
}

export type ChatifyAPI = ZentryAPI;

declare global {
  interface Window {
    Zentry?: ZentryAPI | any;
    'Zen-try'?: ZentryAPI | any;
    Chatify?: ChatifyAPI | any;
    __ZentryInstance?: ZentryWidget;
    __ChatifyInstance?: ZentryWidget;
  }
}

class ZentryWidget {
  private config: WidgetConfig;
  private supabase: SupabaseClient;
  private container: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;

  // Session state
  private visitorId: string;
  private conversationId: string | null = null;
  private conversationStatus: string = 'open';
  private visitorName: string = '';
  private visitorEmail: string = '';

  // UI state
  private isOpen: boolean = false;
  private activeTab: 'home' | 'messages' | 'help' = 'home';
  private unreadCount: number = 0;
  private messages: MessageItem[] = [];
  private faqs: FAQItem[] = [];
  private sections: HelpSectionItem[] = [];
  private activeSectionId: string | null = null;
  private faqSearchQuery: string = '';
  private isPreChatCompleted: boolean = false;
  /** Settings → Chat widget → Pre-chat form; defaults until the config arrives. */
  private prechat: PrechatConfig = normalizePrechat(undefined);
  private csatRated: boolean = false;
  private pendingAttachment: { file: File; previewUrl: string } | null = null;
  private activeEmojiCategory: string = 'smileys';
  private emojiSearchQuery: string = '';
  private currentPopupMsgId: string | null = null;
  private popupCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private workspaceAgents: Array<{ id: string; name?: string; avatar_url?: string | null; status?: string }> = [];
  private presenceInterval: ReturnType<typeof setInterval> | null = null;

  private audioCtx: AudioContext | null = null;

  // Conversation UX state
  private botTyping: boolean = false;
  private agentTyping: boolean = false;
  private agentTypingTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeChannel: any = null;
  private typingChannel: any = null;
  private forceNewConversation: boolean = false;

  /*
   * Visitor session (docs/AUDIT.md H-3). The widget reaches the database only
   * through the fn_widget_* functions, which check this token, so the public
   * anon key on its own cannot read anyone's chat. Live updates arrive as
   * broadcasts on the session's topic, with polling as the safety net.
   */
  private storageSuffix: string = '';
  private visitorToken: string | null = null;
  private sessionTopic: string | null = null;
  private sessionConversation: { id: string; status: string; csat_rating?: number | null } | null = null;
  private sessionPromise: Promise<boolean> | null = null;
  /** The project has not run the session migration: use the older direct table access. */
  private legacyData: boolean = false;
  private liveChannel: ReturnType<SupabaseClient['channel']> | null = null;
  private liveConnected: boolean = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private agentsPollTimer: ReturnType<typeof setInterval> | null = null;
  private previousConversations: Array<{
    id: string;
    status: string;
    created_at: string;
    updated_at: string;
    csat_rating?: number | null;
    unread_count?: number;
    last_message?: { content?: string; sender_type?: string; attachment_url?: string | null; created_at?: string } | null;
  }> = [];

  // Live Visitor Telemetry & SPA Tracking
  private pageEnteredAt: number = Date.now();
  private lastReportedUrl: string = typeof window !== 'undefined' ? window.location.href : '';
  private referrerSource: string = typeof document !== 'undefined' ? (document.referrer || '') : '';
  private routeChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private getTimeOnPage(): number {
    return Math.max(0, Math.round((Date.now() - this.pageEnteredAt) / 1000));
  }

  private isImageAttachment(url: string | null | undefined): boolean {
    if (!url) return false;
    if (url.includes('cloudinary.com') && (url.includes('/image/upload/') || !url.includes('/raw/upload/'))) {
      return true;
    }
    return Boolean(url.match(/\.(jpeg|jpg|png|webp|gif|svg|avif|bmp)(\?.*)?$/i));
  }

  constructor() {
    this.config = this.parseConfig();
    this.supabase = createClient(this.config.supabaseUrl, this.config.supabaseKey);

    // Initialize or restore visitor ID (scoped to workspace)
    const storageKeySuffix = this.config.workspaceId ? `_${this.config.workspaceId.slice(0, 8)}` : '';
    this.storageSuffix = storageKeySuffix;
    this.visitorId = this.getOrCreateVisitorId(storageKeySuffix);
    try {
      this.visitorToken = localStorage.getItem(`zentry_visitor_token${storageKeySuffix}`);
    } catch {}
    this.conversationId =
      localStorage.getItem(`zentry_conversation_id${storageKeySuffix}`) ||
      localStorage.getItem(`chatify_conversation_id${storageKeySuffix}`);
    this.visitorName =
      localStorage.getItem(`zentry_visitor_name${storageKeySuffix}`) ||
      localStorage.getItem(`chatify_visitor_name${storageKeySuffix}`) ||
      '';
    this.visitorEmail =
      localStorage.getItem(`zentry_visitor_email${storageKeySuffix}`) ||
      localStorage.getItem(`chatify_visitor_email${storageKeySuffix}`) ||
      '';
    let prechatDone = false;
    try {
      prechatDone = localStorage.getItem(`zentry_prechat_done${storageKeySuffix}`) === '1';
    } catch {}
    if (this.visitorEmail || prechatDone) {
      this.isPreChatCompleted = true;
    }

    this.initDOM();
    this.fetchWorkspaceSettingsAndApply().then(async (isActive) => {
      // Branding is applied now — swap the shimmer for the real launcher.
      this.shadow?.getElementById('chatifyLauncherBtn')?.classList.remove('is-loading');
      if (isActive === false) return;
      this.bindGlobalTriggers();
      // The session first: it creates the visitor and says which conversation
      // is theirs. A visitor whose stored token does not match starts afresh.
      const sessionActive = await this.ensureSession();
      if (!sessionActive) return;
      this.initVisitorTracking();
      this.initSPANavigationTracking();

      if (!this.legacyData) {
        const conv = this.sessionConversation;
        if (!this.conversationId && conv?.id) {
          this.conversationId = conv.id;
          this.conversationStatus = conv.status || 'open';
          try {
            localStorage.setItem(`zentry_conversation_id${storageKeySuffix}`, conv.id);
            localStorage.setItem(`chatify_conversation_id${storageKeySuffix}`, conv.id);
          } catch {}
        }
      } else if (!this.conversationId && this.visitorId) {
        try {
          let query = this.supabase
            .from('conversations')
            .select('id, status')
            .eq('visitor_id', this.visitorId)
            .order('created_at', { ascending: false })
            .limit(1);
          if (this.config.workspaceId) {
            query = query.eq('workspace_id', this.config.workspaceId);
          }
          const { data: existingConv } = await query.maybeSingle();
          if (existingConv?.id) {
            this.conversationId = existingConv.id;
            this.conversationStatus = existingConv.status || 'open';
            localStorage.setItem(`zentry_conversation_id${storageKeySuffix}`, existingConv.id);
            localStorage.setItem(`chatify_conversation_id${storageKeySuffix}`, existingConv.id);
          }
        } catch {}
      }

      if (this.conversationId) {
        await this.loadMessageHistory();
      }
      // The stored conversation may have turned out not to be this visitor's.
      if (this.conversationId) {
        this.subscribeToRealtime();
      } else if (this.visitorId) {
        this.subscribeToVisitorConversations(storageKeySuffix);
      }

      // Restore widget state if visitor reloaded while widget was open
      try {
        const savedOpen =
          sessionStorage.getItem(`zentry_widget_open${storageKeySuffix}`) ||
          sessionStorage.getItem(`chatify_widget_open${storageKeySuffix}`);
        const savedTab = (sessionStorage.getItem(`zentry_widget_tab${storageKeySuffix}`) ||
          sessionStorage.getItem(`chatify_widget_tab${storageKeySuffix}`)) as 'home' | 'messages' | 'help' | null;
        if (savedOpen === '1') {
          this.open(savedTab || 'messages');
          this.scrollToBottom(false);
        }
      } catch {}

      this.initProactiveWelcome();
      this.loadPreviousConversations();
    });
  }

  // 1. Read Script Config
  private parseConfig(): WidgetConfig {
    let script = document.currentScript as HTMLScriptElement | null;
    if (!script) {
      script = document.querySelector('script[src*="widget.js"]');
    }
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const urlWs = urlParams?.get('workspaceId') || urlParams?.get('ws') || urlParams?.get('zentry_workspace') || urlParams?.get('chatify_workspace');
    const urlLogo = urlParams?.get('logo') || urlParams?.get('logoUrl') || urlParams?.get('logo_url');
    const urlShowLauncherLogo = urlParams?.get('show_launcher_logo') ?? urlParams?.get('launcher_logo');
    const urlWidgetIcon = urlParams?.get('widget_icon') || urlParams?.get('icon');

    let apiUrl = script?.getAttribute('data-api-url') || '';
    if (!apiUrl && script?.src) {
      try {
        const parsed = new URL(script.src);
        if (parsed.origin && parsed.origin !== 'null') {
          // An old host redirects to the app. A script follows the redirect,
          // but the CORS preflight of every API call does not, so the
          // widget showed and saved messages while the bot was never asked.
          apiUrl = LEGACY_API_HOSTS.has(parsed.hostname) ? DEFAULT_API_URL : parsed.origin;
        }
      } catch (e) {}
    }
    if (!apiUrl && typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        apiUrl = window.location.origin;
      }
    }
    if (!apiUrl) {
      apiUrl = DEFAULT_API_URL;
    }
    try {
      if (LEGACY_API_HOSTS.has(new URL(apiUrl).hostname)) apiUrl = DEFAULT_API_URL;
    } catch (e) {}

    return {
      supabaseUrl: script?.getAttribute('data-supabase-url') || DEFAULT_SUPABASE_URL,
      supabaseKey: script?.getAttribute('data-supabase-key') || DEFAULT_SUPABASE_KEY,
      workspaceId: urlWs || script?.getAttribute('data-workspace-id') || null,
      title: script?.getAttribute('data-title') || 'Support Team',
      subtitle: script?.getAttribute('data-subtitle') || 'We reply in under 5 minutes',
      primaryColor: script?.getAttribute('data-color') || '#2e5bff',
      position: (script?.getAttribute('data-position') as 'bottom-right' | 'bottom-left') || 'bottom-right',
      helpTabLabel: script?.getAttribute('data-help-label') || 'Help',
      showHelpTab: script?.getAttribute('data-show-help') !== 'false',
      helpTabIcon: script?.getAttribute('data-help-icon') || '📖',
      logoUrl: urlLogo || script?.getAttribute('data-logo-url') || script?.getAttribute('data-logo') || undefined,
      showLauncherLogo: urlShowLauncherLogo !== null ? urlShowLauncherLogo !== 'false' : (script?.getAttribute('data-show-launcher-logo') !== 'false'),
      widgetIcon: urlWidgetIcon || script?.getAttribute('data-widget-icon') || script?.getAttribute('data-icon') || undefined,
      widgetDesign: (() => {
        const d = urlParams?.get('widget_design') || script?.getAttribute('data-design');
        return isWidgetDesign(d) ? d : undefined;
      })(),
      welcomeText: script?.getAttribute('data-welcome-text') || undefined,
      businessName: script?.getAttribute('data-business-name') || script?.getAttribute('data-company-name') || undefined,
      customDomain: script?.getAttribute('data-custom-domain') || undefined,
      apiUrl,
      offsetBottom: script?.hasAttribute('data-offset-bottom') ? parseInt(script.getAttribute('data-offset-bottom')!, 10) : 20,
      offsetSide: script?.hasAttribute('data-offset-side') ? parseInt(script.getAttribute('data-offset-side')!, 10) : 20,
      zIndex: script?.hasAttribute('data-z-index') ? parseInt(script.getAttribute('data-z-index')!, 10) : 2147483000,
      enableProactiveWelcome: script?.getAttribute('data-enable-proactive-welcome') !== 'false' && script?.getAttribute('data-proactive-welcome') !== 'false',
      proactiveDelaySeconds: Math.max(8, parseInt(script?.getAttribute('data-proactive-delay') || '8', 10)),
    };
  }

  // Helper for simulators: reset visitor session
  public resetSession() {
    const storageKeySuffix = this.config.workspaceId ? `_${this.config.workspaceId.slice(0, 8)}` : '';
    localStorage.removeItem(`zentry_visitor_id${storageKeySuffix}`);
    localStorage.removeItem(`zentry_visitor_token${storageKeySuffix}`);
    localStorage.removeItem(`zentry_prechat_done${storageKeySuffix}`);
    localStorage.removeItem(`zentry_conversation_id${storageKeySuffix}`);
    localStorage.removeItem(`zentry_visitor_name${storageKeySuffix}`);
    localStorage.removeItem(`zentry_visitor_email${storageKeySuffix}`);
    localStorage.removeItem(`chatify_visitor_id${storageKeySuffix}`);
    localStorage.removeItem(`chatify_conversation_id${storageKeySuffix}`);
    localStorage.removeItem(`chatify_visitor_name${storageKeySuffix}`);
    localStorage.removeItem(`chatify_visitor_email${storageKeySuffix}`);
    window.location.reload();
  }

  private async fetchWorkspaceSettingsAndApply(): Promise<boolean> {
    if (!this.config.workspaceId) return true;

    try {
      const { data, error } = await this.supabase.rpc('fn_get_workspace_config', {
        p_workspace_id: this.config.workspaceId,
      });

      if (error || !data) {
        console.warn('[Zen-try] Workspace is suspended, inactive, or not found. Widget will not load.');
        if (this.container && this.container.parentNode) {
          this.container.parentNode.removeChild(this.container);
        }
        return false;
      }
        if (data.name) this.config.businessName = data.name;
        if (data.brand_color) this.config.primaryColor = data.brand_color;
        if (data.greeting_title) this.config.title = data.greeting_title;
        if (data.greeting_message) {
          this.config.subtitle = data.greeting_message;
          this.config.welcomeText = data.greeting_message;
        }
        if (typeof data.launcher_offset_bottom === 'number') {
          this.config.offsetBottom = data.launcher_offset_bottom;
        } else if (data.navbar_trigger_config?.launcher_offset_bottom !== undefined) {
          this.config.offsetBottom = Number(data.navbar_trigger_config.launcher_offset_bottom);
        }
        if (typeof data.launcher_offset_side === 'number') {
          this.config.offsetSide = data.launcher_offset_side;
        } else if (data.navbar_trigger_config?.launcher_offset_side !== undefined) {
          this.config.offsetSide = Number(data.navbar_trigger_config.launcher_offset_side);
        }
        if (typeof data.widget_z_index === 'number') {
          this.config.zIndex = data.widget_z_index;
        } else if (data.navbar_trigger_config?.widget_z_index !== undefined) {
          this.config.zIndex = Number(data.navbar_trigger_config.widget_z_index);
        }
        if (typeof data.enable_proactive_welcome === 'boolean') {
          this.config.enableProactiveWelcome = data.enable_proactive_welcome;
        } else if (data.navbar_trigger_config?.enable_proactive_welcome !== undefined) {
          this.config.enableProactiveWelcome = Boolean(data.navbar_trigger_config.enable_proactive_welcome);
        }
        if (typeof data.proactive_delay_seconds === 'number') {
          this.config.proactiveDelaySeconds = Math.max(8, data.proactive_delay_seconds);
        } else if (data.navbar_trigger_config?.proactive_delay_seconds !== undefined) {
          this.config.proactiveDelaySeconds = Math.max(8, Number(data.navbar_trigger_config.proactive_delay_seconds));
        }
        if (data.widget_position) {
          this.config.position = data.widget_position === 'left' ? 'bottom-left' : 'bottom-right';
        }
        if (data.help_center_tab_label) {
          this.config.helpTabLabel = data.help_center_tab_label;
        }
        if (data.logo_url) this.config.logoUrl = data.logo_url;
        if (typeof data.show_launcher_logo === 'boolean') {
          this.config.showLauncherLogo = data.show_launcher_logo;
        }
        if (data.navbar_trigger_config?.widget_icon) {
          this.config.widgetIcon = data.navbar_trigger_config.widget_icon;
        } else if (data.widget_icon) {
          this.config.widgetIcon = data.widget_icon;
        }
        if (isWidgetDesign(data.navbar_trigger_config?.widget_design)) {
          this.config.widgetDesign = data.navbar_trigger_config.widget_design;
        }
        if (isHexColor(data.navbar_trigger_config?.widget_secondary_color)) {
          this.config.secondaryColor = data.navbar_trigger_config.widget_secondary_color;
        }
        if (isWidgetColorMode(data.navbar_trigger_config?.widget_color_mode)) {
          this.config.colorMode = data.navbar_trigger_config.widget_color_mode;
        }
        this.prechat = normalizePrechat(data.navbar_trigger_config?.prechat);
        this.applyPrechatConfig();
        if (data.greeting_title) this.config.greetingTitle = data.greeting_title;
        if (typeof data.show_help_tab === 'boolean') {
          this.config.showHelpTab = data.show_help_tab;
        }
        if (data.help_center_tab_icon) {
          this.config.helpTabIcon = data.help_center_tab_icon;
        }
        if (data.custom_domain && (data.custom_domain_status === 'live' || data.custom_domain_status === 'verified')) {
          this.config.customDomain = data.custom_domain;
        }
        if (data.slug) {
          this.config.helpSlug = data.slug;
        }
        if (data.navbar_trigger_config) {
          this.config.navbarTriggerConfig = data.navbar_trigger_config;
        }
        if (data.business_hours) {
          this.config.businessHours = data.business_hours;
        }
        if (Array.isArray(data.agents)) {
          this.workspaceAgents = data.agents;
        }

        this.initNavbarAutoTrigger();
        this.updateThemeAndTexts();

        this.renderAvatarsStack(this.workspaceAgents);
        this.updatePresenceAndTexts();
        this.subscribeToAgentsRealtime();

        // Load Help Desk / Knowledge Base articles dynamically
        await this.loadWorkspaceArticles();
        return true;
      } catch (e) {
        console.warn('[Zen-try] Could not fetch workspace config:', e);
        return true;
      }
    }

  private isOutsideBusinessHours(businessHours: any): boolean {
    if (!businessHours || !businessHours.enabled || !businessHours.schedule) return false;
    try {
      const now = new Date();
      const tz = businessHours.timezone || 'UTC';
      const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(now).toLowerCase();
      const daySchedule = businessHours.schedule[dayName];
      if (!daySchedule || !daySchedule.enabled) return true;

      const timeStr = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(now);
      if (timeStr < daySchedule.start || timeStr > daySchedule.end) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // 2b. Dynamic Knowledge Base Articles & Sections
  private async loadWorkspaceArticles() {
    if (!this.config.workspaceId) {
      this.sections = [];
      this.faqs = [];
      this.renderFaqList();
      return;
    }

    try {
      const [secRes, artRes] = await Promise.all([
        this.supabase
          .from('help_sections')
          .select('id, name, description, icon, order_index, slug')
          .eq('workspace_id', this.config.workspaceId)
          .order('order_index', { ascending: true })
          .order('created_at', { ascending: true }),
        this.supabase
          .from('articles')
          .select('id, title, slug, summary, content, category, section_id, order_index, section:help_sections(id, name, icon)')
          .eq('workspace_id', this.config.workspaceId)
          .eq('status', 'published')
          .order('order_index', { ascending: true })
          .order('created_at', { ascending: true }),
      ]);

      const articles = artRes.data || [];
      const rawSections = secRes.data || [];

      this.faqs = articles.map((a: any) => ({
        id: a.id,
        slug: a.slug,
        q: a.title,
        summary: a.summary || '',
        a: a.content,
        category: a.section?.name || (a.section_id ? (a.category || 'Other') : 'Other'),
        icon: a.section?.icon || '📚',
        sectionId: a.section_id || null,
        order_index: a.order_index ?? 0,
      }));

      // Count articles per section
      const countMap: Record<string, number> = {};
      let unsortedCount = 0;
      this.faqs.forEach((faq) => {
        if (faq.sectionId) {
          countMap[faq.sectionId] = (countMap[faq.sectionId] || 0) + 1;
        } else {
          unsortedCount++;
        }
      });

      // 1. Do not list a section that has zero published articles
      const publishedSections = rawSections
        .filter((s: any) => (countMap[s.id] || 0) > 0)
        .map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description || null,
          icon: s.icon || '📚',
          order_index: s.order_index ?? 0,
          slug: s.slug || '',
          articleCount: countMap[s.id] || 0,
        }));

      // 2. Never duplicate a section name
      const seenNames = new Set<string>();
      const uniqueSections: HelpSectionItem[] = [];
      for (const sec of publishedSections) {
        const norm = (sec.name || '').trim().toLowerCase();
        if (norm && !seenNames.has(norm)) {
          seenNames.add(norm);
          uniqueSections.push(sec);
        }
      }

      // 3. Articles without a section_id appear under one group named "Other" only if such articles exist
      if (unsortedCount > 0) {
        let otherName = 'Other';
        if (seenNames.has('other')) {
          otherName = 'More Articles';
        }
        seenNames.add(otherName.toLowerCase());
        uniqueSections.push({
          id: '__other__',
          name: otherName,
          description: null,
          icon: '📚',
          order_index: 9999,
          slug: 'other',
          articleCount: unsortedCount,
        });
      }

      this.sections = uniqueSections;

      if (!this.config.customDomain || !this.config.helpSlug) {
        const { data: ws } = await this.supabase
          .from('public_workspaces')
          .select('custom_domain, custom_domain_status, slug')
          .eq('id', this.config.workspaceId)
          .maybeSingle();
        if (ws) {
          if (ws.custom_domain && (ws.custom_domain_status === 'live' || ws.custom_domain_status === 'verified')) {
            this.config.customDomain = ws.custom_domain;
          }
          if (ws.slug) {
            this.config.helpSlug = ws.slug;
          }
        }
      }

      this.renderFaqList();
      this.updateThemeAndTexts();
      this.initNavbarAutoTrigger();
    } catch (err) {
      console.warn('[Zen-try] Failed to fetch dynamic articles or sections:', err);
      this.sections = [];
      this.faqs = [];
      this.renderFaqList();
      this.updateThemeAndTexts();
      this.initNavbarAutoTrigger();
    }
  }

  /**
   * Markdown for chat replies — what the AI assistant writes: headings, bold,
   * bullet and numbered lists, links. Line based, so a "* " bullet is never
   * mistaken for italics and an underscore in an email stays an underscore.
   * Everything is escaped first; only the tags produced here reach the DOM.
   */
  private formatChatMarkdown(markdown: string): string {
    const inline = (raw: string) => {
      let s = this.escapeHTML(raw);
      s = s.replace(/`([^`]+)`/g, '<code class="chatify-inline-code">$1</code>');
      s = s.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)"'<>]+|mailto:[^\s)"'<>]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      );
      // Bare URLs, www. and plain domains, and emails (src/lib/text/links.ts),
      // only in text outside the tags made above, so a markdown link is never
      // wrapped twice.
      s = s
        .split(/(<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>)/)
        .map((piece, i) => (i % 2 ? piece : this.linkifyHTML(this.unescapeHTML(piece))))
        .join('');
      s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>');
      return s;
    };

    const out: string[] = [];
    let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
    let para: string[] = [];

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br/>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
      list = null;
    };

    for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
      const trimmed = line.trim();
      const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
      const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
      const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);

      if (!trimmed) {
        flushPara();
        flushList();
      } else if (heading) {
        flushPara();
        flushList();
        // # and ## → h3, ### → h4, #### → h5: a bubble has no room for page-size titles.
        const level = Math.min(Math.max(heading[1].length, 2) + 1, 5);
        out.push(`<h${level}>${inline(heading[2].replace(/\*\*/g, ''))}</h${level}>`);
      } else if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
        flushPara();
        flushList();
        out.push('<hr/>');
      } else if (bullet || numbered) {
        flushPara();
        const tag = bullet ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push(inline((bullet || numbered)![1]));
      } else if (list && /^\s{2,}/.test(line)) {
        // An indented line continues the previous list item.
        list.items[list.items.length - 1] += `<br/>${inline(trimmed)}`;
      } else {
        flushList();
        para.push(trimmed);
      }
    }
    flushPara();
    flushList();
    return out.join('');
  }

  private formatMarkdownToHtml(markdown: string): string {
    return formatMarkdownToHtml(markdown);
  }

  private renderArticleItem(faq: FAQItem, idx: number, showCategory: boolean): string {
    const articleSlugOrId = encodeURIComponent(faq.slug || faq.id || '');
    let rawArticleUrl = '';
    if (this.config.workspaceId && articleSlugOrId) {
      if (this.config.customDomain) {
        rawArticleUrl = `https://${this.config.customDomain.replace(/^https?:\/\//i, '').replace(/\/$/, '')}/${articleSlugOrId}`;
      } else {
        const base = (this.config.apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
        rawArticleUrl = `${base}/help/${encodeURIComponent(this.config.workspaceId)}/${articleSlugOrId}`;
      }
    }
    const articleUrl = this.safeUrl(rawArticleUrl);

    return `
      <div class="chatify-faq-item" data-idx="${idx}" data-id="${this.escapeHTML(faq.id || '')}" data-slug="${this.escapeHTML(faq.slug || '')}">
        ${
          showCategory && faq.category
            ? `
          <div style="font-size:11px; font-weight:600; color:var(--w-brand); margin-bottom:4px; display:flex; align-items:center; gap:4px;">
            <span>${this.escapeHTML(faq.icon || '📚')}</span>
            <span>${this.escapeHTML(faq.category)}</span>
          </div>
        `
            : ''
        }
        <div class="chatify-faq-q">
          <span>${this.escapeHTML(faq.q)}</span>
          <span class="chatify-faq-arrow">›</span>
        </div>
        <div class="chatify-faq-a">
          ${faq.summary ? `<p style="font-size:12px; font-weight:600; color:var(--w-ink); margin-bottom:6px; line-height:1.4;">${this.escapeHTML(faq.summary)}</p>` : ''}
          <div class="chatify-faq-markdown">${this.formatMarkdownToHtml(faq.a)}</div>
          
          <div style="margin-top:12px; padding-top:8px; border-top:1px solid var(--w-line); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
            ${
              articleUrl
                ? `
              <a href="${articleUrl}" target="_blank" rel="noopener noreferrer" class="chatify-article-ext-link" title="Open full article in dedicated Help Center">
                <span>Open in full Help Center</span> ↗
              </a>
            `
                : '<span></span>'
            }

            ${
              faq.id
                ? `
              <div class="chatify-vote-group" style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:11px; color:var(--w-ink-3);">Helpful?</span>
                <button class="chatify-vote-btn" data-art-id="${this.escapeHTML(faq.id)}" data-helpful="true" style="padding:3px 8px; border-radius:4px; border:1px solid var(--w-line); background:var(--w-surface); font-size:11.5px; cursor:pointer; color:var(--w-ink);">👍 Yes</button>
                <button class="chatify-vote-btn" data-art-id="${this.escapeHTML(faq.id)}" data-helpful="false" style="padding:3px 8px; border-radius:4px; border:1px solid var(--w-line); background:var(--w-surface); font-size:11.5px; cursor:pointer; color:var(--w-ink);">👎 No</button>
              </div>
            `
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  private renderFaqList() {
    const listEl = this.shadow?.getElementById('faqList');
    if (!listEl) return;

    const cardHelpSearch = this.shadow?.getElementById('cardHelpSearch') as HTMLElement | null;
    if (cardHelpSearch) {
      cardHelpSearch.style.display = (this.config.showHelpTab !== false && this.faqs.length > 0) ? 'block' : 'none';
    }

    if (this.faqs.length === 0) {
      listEl.innerHTML = '';
      return;
    }

    const q = (this.faqSearchQuery || '').toLowerCase().trim();

    // 1. Search Results Mode
    if (q) {
      const filteredFaqs = this.faqs.filter(
        (f) =>
          f.q.toLowerCase().includes(q) ||
          (f.summary && f.summary.toLowerCase().includes(q)) ||
          f.a.toLowerCase().includes(q) ||
          (f.category && f.category.toLowerCase().includes(q))
      );

      if (filteredFaqs.length === 0) {
        listEl.innerHTML = `
          <div id="faqNoResults" style="padding: 32px 16px; text-align: center; color: var(--w-ink-3); font-size: 13px;">
            <div style="font-size: 24px; margin-bottom: 8px;">🔍</div>
            <p style="margin: 0; font-weight: 500;">No articles match &ldquo;${this.escapeHTML(q)}&rdquo;.</p>
          </div>
        `;
        return;
      }

      listEl.innerHTML = `
        <div style="font-size: 11.5px; font-weight: 600; color: var(--w-ink-3); margin-bottom: 10px; padding-left: 2px;">
          ${filteredFaqs.length} article${filteredFaqs.length === 1 ? '' : 's'} found
        </div>
        <div class="chatify-faq-list">
          ${filteredFaqs.map((faq, idx) => this.renderArticleItem(faq, idx, true)).join('')}
        </div>
      `;
      this.bindFaqListeners();
      return;
    }

    // 2. Sections List Mode (order_index wise)
    if (!this.activeSectionId) {
      if (this.sections.length === 0) {
        listEl.innerHTML = `
          <div class="chatify-faq-list">
            ${this.faqs.map((faq, idx) => this.renderArticleItem(faq, idx, true)).join('')}
          </div>
        `;
        this.bindFaqListeners();
        return;
      }

      listEl.innerHTML = `
        <div class="chatify-section-list">
          ${this.sections
            .map(
              (section) => `
            <div class="chatify-section-card" data-section-id="${this.escapeHTML(section.id)}">
              <div class="chatify-section-card-icon">${this.escapeHTML(section.icon || '📚')}</div>
              <div class="chatify-section-card-info">
                <h4 class="chatify-section-card-title">${this.escapeHTML(section.name)}</h4>
                <p class="chatify-section-card-desc">
                  ${
                    section.description
                      ? this.escapeHTML(section.description)
                      : `${section.articleCount || 0} article${(section.articleCount || 0) === 1 ? '' : 's'}`
                  }
                </p>
              </div>
              <span class="chatify-section-card-arrow">›</span>
            </div>
          `
            )
            .join('')}
        </div>
      `;
      this.bindFaqListeners();
      return;
    }

    // 3. Section Detail Mode: Show articles inside active section
    const currentSection = this.sections.find((s) => s.id === this.activeSectionId) || {
      id: this.activeSectionId,
      name: 'Articles',
      icon: '📚',
      description: null,
      articleCount: 0,
    };

    const sectionArticles = this.faqs.filter(
      (f) =>
        f.sectionId === this.activeSectionId ||
        (this.activeSectionId === '__other__' && !f.sectionId)
    );

    listEl.innerHTML = `
      <div class="chatify-section-view">
        <button class="chatify-section-back-btn" id="faqBackToSections" title="Back to collections">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <span>All Collections</span>
        </button>

        <div class="chatify-section-view-header">
          <span class="chatify-section-view-icon">${this.escapeHTML(currentSection.icon || '📚')}</span>
          <div class="chatify-section-view-text">
            <h3>${this.escapeHTML(currentSection.name)}</h3>
            ${
              currentSection.description
                ? `<p>${this.escapeHTML(currentSection.description)}</p>`
                : `<p>${sectionArticles.length} article${sectionArticles.length === 1 ? '' : 's'}</p>`
            }
          </div>
        </div>

        <div class="chatify-faq-list">
          ${
            sectionArticles.length === 0
              ? `
            <div style="padding: 32px 16px; text-align: center; color: var(--w-ink-3); font-size: 13px;">
              <p style="margin: 0; font-weight: 500;">No articles in this section yet.</p>
            </div>
          `
              : sectionArticles.map((faq, idx) => this.renderArticleItem(faq, idx, false)).join('')
          }
        </div>
      </div>
    `;

    this.bindFaqListeners();
  }

  private bindFaqListeners() {
    // Back button
    const backBtn = this.shadow?.getElementById('faqBackToSections');
    if (backBtn) {
      backBtn.onclick = () => {
        this.activeSectionId = null;
        this.renderFaqList();
      };
    }

    // Section cards
    this.shadow?.querySelectorAll('.chatify-section-card').forEach((card) => {
      (card as HTMLElement).onclick = () => {
        const secId = card.getAttribute('data-section-id');
        if (secId) {
          this.activeSectionId = secId;
          this.renderFaqList();
        }
      };
    });

    // FAQ items accordion
    this.shadow?.querySelectorAll('.chatify-faq-item').forEach((item) => {
      (item as HTMLElement).onclick = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.chatify-vote-btn')) return;
        if ((e.target as HTMLElement).closest('.chatify-article-ext-link')) return;
        item.classList.toggle('open');
      };
    });

    // Helpful voting
    this.shadow?.querySelectorAll('.chatify-vote-btn').forEach((btn) => {
      (btn as HTMLElement).onclick = async (e) => {
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        const artId = target.getAttribute('data-art-id');
        const helpful = target.getAttribute('data-helpful') === 'true';
        const group = target.closest('.chatify-vote-group');

        if (group) {
          group.innerHTML = '<span style="font-size:11px; color:var(--w-brand); font-weight:600;">✓ Feedback sent</span>';
        }

        if (artId && this.config.workspaceId) {
          try {
            await this.supabase.rpc('fn_submit_article_feedback', {
              p_article_id: artId,
              p_workspace_id: this.config.workspaceId,
              p_visitor_id: this.visitorId,
              p_is_helpful: helpful,
              p_feedback_text: null,
            });
          } catch (err) {}
        }
      };
    });
  }

  // 3. Visitor ID Management
  private getOrCreateVisitorId(suffix: string): string {
    let id =
      localStorage.getItem(`zentry_visitor_id${suffix}`) ||
      localStorage.getItem(`chatify_visitor_id${suffix}`);
    if (!id || !UUID_RE.test(id)) {
      id = this.newVisitorId();
      localStorage.setItem(`zentry_visitor_id${suffix}`, id);
      localStorage.setItem(`chatify_visitor_id${suffix}`, id);
    } else {
      localStorage.setItem(`zentry_visitor_id${suffix}`, id);
    }
    return id;
  }

  private newVisitorId(): string {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private static isMissingFunction(error: unknown): boolean {
    const e = error as { code?: string; message?: string } | null | undefined;
    return e?.code === 'PGRST202' || e?.code === '42883' || /could not find the function/i.test(String(e?.message || ''));
  }

  private static errorText(error: unknown): string {
    return String((error as { message?: string } | null)?.message || error || '');
  }

  /** Opens (or resumes) this visitor's session; false only when the server could not be reached. */
  private ensureSession(): Promise<boolean> {
    if (this.legacyData || (this.visitorToken && this.sessionTopic)) return Promise.resolve(true);
    if (!this.sessionPromise) {
      this.sessionPromise = this.openSession().finally(() => {
        this.sessionPromise = null;
      });
    }
    return this.sessionPromise;
  }

  private async openSession(): Promise<boolean> {
    if (!this.config.workspaceId) {
      // Nothing to scope a session to (a bare preview); the old path is all there is.
      this.legacyData = true;
      return true;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let data: WidgetSession | null = null;
      let error: unknown = null;
      try {
        const res = await this.supabase.rpc('fn_widget_session', {
          p_workspace_id: this.config.workspaceId,
          p_visitor_id: this.visitorId,
          p_token: this.visitorToken,
        });
        data = res.data;
        error = res.error;
      } catch (e) {
        error = e;
      }
      if (!error && data) {
        if (data.token) {
          this.visitorToken = data.token;
          try {
            localStorage.setItem(`zentry_visitor_token${this.storageSuffix}`, data.token);
          } catch {}
        }
        this.sessionTopic = data.topic || null;
        this.sessionConversation = data.conversation || null;
        return true;
      }
      if (ZentryWidget.isMissingFunction(error)) {
        this.legacyData = true;
        return true;
      }
      if (/workspace_unavailable/.test(ZentryWidget.errorText(error))) {
        if (this.container && this.container.parentNode) {
          this.container.parentNode.removeChild(this.container);
        }
        return false;
      }
      if (!/visitor_session_invalid/.test(ZentryWidget.errorText(error))) {
        console.warn('[Zen-try] Could not start the chat session:', ZentryWidget.errorText(error));
        return false;
      }
      if (attempt === 0) {
        // Another tab on this site may have been given the token a moment ago.
        await new Promise((r) => setTimeout(r, 400));
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(`zentry_visitor_token${this.storageSuffix}`);
        } catch {}
        if (stored && stored !== this.visitorToken) {
          this.visitorToken = stored;
          continue;
        }
      }
      // This browser's visitor id has a token we do not hold (storage was
      // partly cleared, or the id was copied): carry on as a new visitor.
      this.resetVisitorIdentity();
    }
    return false;
  }

  private resetVisitorIdentity() {
    const suffix = this.storageSuffix;
    this.visitorId = this.newVisitorId();
    this.visitorToken = null;
    this.sessionTopic = null;
    this.sessionConversation = null;
    this.forgetConversation();
    try {
      localStorage.setItem(`zentry_visitor_id${suffix}`, this.visitorId);
      localStorage.setItem(`chatify_visitor_id${suffix}`, this.visitorId);
      localStorage.removeItem(`zentry_visitor_token${suffix}`);
    } catch {}
  }

  /** Drops the current conversation locally (it is closed, or not this visitor's). */
  private forgetConversation() {
    const suffix = this.storageSuffix;
    this.conversationId = null;
    this.conversationStatus = 'open';
    this.messages = [];
    try {
      localStorage.removeItem(`zentry_conversation_id${suffix}`);
      localStorage.removeItem(`chatify_conversation_id${suffix}`);
    } catch {}
  }

  /** A fn_widget_* call made as this visitor. Throws the database error. */
  private async widgetRpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!(await this.ensureSession())) throw new Error('Chat session unavailable');
    const { data, error } = await this.supabase.rpc(fn, {
      p_visitor_id: this.visitorId,
      p_token: this.visitorToken,
      ...args,
    });
    if (error) {
      if (/visitor_session_invalid/.test(error.message || '')) {
        // Renewed on the next call.
        this.sessionTopic = null;
      }
      throw error;
    }
    return data as T;
  }

  /** Name, email, page and place of this visitor. */
  private async saveVisitorDetails(location: string | null) {
    if (this.legacyData) {
      await this.supabase.rpc('fn_upsert_visitor', {
        p_id: this.visitorId,
        p_name: this.visitorName || null,
        p_email: this.visitorEmail || null,
        p_current_url: window.location.href,
        p_user_agent: navigator.userAgent,
        p_ip_address: null,
        p_location: location,
        p_workspace_id: this.config.workspaceId || null,
      });
      return;
    }
    await this.widgetRpc('fn_widget_update_visitor', {
      p_name: this.visitorName || null,
      p_email: this.visitorEmail || null,
      p_current_url: window.location.href,
      p_user_agent: navigator.userAgent,
      p_location: location,
    });
  }

  // 4. Visitor Tracking
  private async initVisitorTracking() {
    this.pageEnteredAt = Date.now();
    this.lastReportedUrl = window.location.href;
    this.referrerSource = document.referrer || '';
    let locationStr = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown';

    // 1. Immediately upsert visitor (0ms block) so conversations/messages can send right away
    try {
      try {
        await this.saveVisitorDetails(locationStr);
      } catch (e) {
        console.warn('[Zen-try] Visitor details not saved:', ZentryWidget.errorText(e));
      }

      // Record first page visit into visitor_page_history
      await this.recordPage(window.location.href, document.title || null, 0);

      try {
        if (this.legacyData) {
          await this.supabase.rpc('fn_update_visitor_meta', {
            p_id: this.visitorId,
            p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
            p_language: navigator.language || null,
          });
        } else {
          await this.widgetRpc('fn_widget_update_meta', {
            p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
            p_language: navigator.language || null,
          });
        }
      } catch {}
    } catch (e) {
      console.warn('[Zen-try] Visitor tracking error:', e);
    }

    // 2. City & country from the visitor's IP, worked out by our own server.
    // Browser-side lookups (ipwho.is, ipapi.co) are blocked by ad blockers and
    // rate-limited, which left visitors with a wrong timezone-based guess.
    (async () => {
      try {
        const res = await fetch(`${this.config.apiUrl || ''}/api/visitor/geo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visitor_id: this.visitorId, visitor_token: this.visitorToken }),
          signal: AbortSignal.timeout(6000),
        });
        const d = res.ok ? await res.json() : null;
        if (d?.location) {
          // The upsert writes the location column too; send the real place so
          // it does not keep the timezone written above.
          await this.saveVisitorDetails(d.location);
        }
      } catch {}
    })();

    // 3. Throttle periodic heartbeats to 20 seconds to minimize overhead
    setInterval(() => {
      this.sendHeartbeat();
    }, 20000);

    // A keepalive request survives the page closing (sendBeacon cannot carry
    // the apikey header Supabase needs).
    const notifyOffline = () => {
      try {
        const legacy = this.legacyData;
        fetch(`${this.config.supabaseUrl}/rest/v1/rpc/${legacy ? 'fn_visitor_offline' : 'fn_widget_offline'}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': this.config.supabaseKey,
            'Authorization': `Bearer ${this.config.supabaseKey}`,
          },
          body: JSON.stringify(
            legacy ? { p_visitor_id: this.visitorId } : { p_visitor_id: this.visitorId, p_token: this.visitorToken }
          ),
          keepalive: true,
        }).catch(() => {});
      } catch {}
    };

    window.addEventListener('beforeunload', notifyOffline);
    window.addEventListener('pagehide', notifyOffline);
  }

  private async sendHeartbeat() {
    try {
      const args = {
        p_current_url: window.location.href,
        p_page_title: document.title || null,
        p_referrer: this.referrerSource || null,
        p_time_on_page: this.getTimeOnPage(),
      };
      if (this.legacyData) {
        await this.supabase.rpc('fn_visitor_heartbeat', { p_visitor_id: this.visitorId, ...args });
      } else {
        await this.widgetRpc('fn_widget_heartbeat', args);
      }
    } catch {}
  }

  /** One page of the visitor's browsing trail (also marks them online on it). */
  private async recordPage(url: string, title: string | null, durationSeconds: number) {
    try {
      if (this.legacyData) {
        await this.supabase.rpc('fn_record_visitor_page', {
          p_visitor_id: this.visitorId,
          p_url: url,
          p_title: title,
          p_referrer: this.referrerSource || null,
          p_duration_seconds: durationSeconds,
          p_workspace_id: this.config.workspaceId || null,
        });
      } else {
        await this.widgetRpc('fn_widget_record_page', {
          p_url: url,
          p_title: title,
          p_referrer: this.referrerSource || null,
          p_duration_seconds: durationSeconds,
        });
      }
    } catch {}
  }

  // 5. SPA Navigation Tracking: monitors client-side route changes with 500ms debounce
  private initSPANavigationTracking() {
    const handleRouteChange = () => {
      const currentUrl = window.location.href;
      if (currentUrl === this.lastReportedUrl) return;

      if (this.routeChangeDebounceTimer) {
        clearTimeout(this.routeChangeDebounceTimer);
      }

      // Throttle updates: wait 500ms for SPA framework to update document.title
      this.routeChangeDebounceTimer = setTimeout(async () => {
        const newUrl = window.location.href;
        if (newUrl === this.lastReportedUrl) return;

        const previousDuration = this.getTimeOnPage();
        const previousUrl = this.lastReportedUrl;

        // Reset page timer for the newly navigated page
        this.pageEnteredAt = Date.now();
        this.referrerSource = previousUrl || this.referrerSource;
        this.lastReportedUrl = newUrl;
        const title = document.title || null;

        await this.recordPage(newUrl, title, previousDuration);
      }, 500);
    };

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      handleRouteChange();
      return result;
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      handleRouteChange();
      return result;
    };

    window.addEventListener('popstate', handleRouteChange);
    window.addEventListener('hashchange', handleRouteChange);
  }

  // 6. Sound chime
  private playIncomingSound() {
    try {
      if (!this.audioCtx) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(784, now);
      osc.frequency.setValueAtTime(1046.5, now + 0.1);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    } catch {}
  }

  // 7. Live updates
  private subscribeToRealtime() {
    if (!this.conversationId) return;

    if (this.realtimeChannel) {
      try { this.supabase.removeChannel(this.realtimeChannel); } catch {}
      this.realtimeChannel = null;
    }
    this.subscribeToTyping();

    if (!this.legacyData) {
      this.startLiveUpdates();
      return;
    }

    this.realtimeChannel = this.supabase
      .channel(`chatify-widget-${this.conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${this.conversationId}`,
        },
        (payload) => this.receiveMessage(payload.new as MessageItem)
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${this.conversationId}`,
        },
        (payload) => this.updateMessage(payload.new as MessageItem)
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${this.conversationId}`,
        },
        (payload) => this.removeMessage((payload.old as { id?: string })?.id)
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'conversations',
          filter: `id=eq.${this.conversationId}`,
        },
        (payload) => this.updateConversationStatus((payload.new as { status?: string }).status)
      )
      .subscribe();
  }

  /** A new message in the open conversation, from realtime or a poll. */
  private receiveMessage(newMsg: MessageItem) {
    // CRITICAL SECURITY: Never render team internal notes to visitor!
    if (newMsg.is_internal) return;

    if (this.messages.some((m) => m.id === newMsg.id)) return;

    // Replace pending message if content or attachment matches
    const tempIdx = this.messages.findIndex(
      (m) =>
        (m.id.startsWith('temp-') || m.pending) &&
        m.sender_type === newMsg.sender_type &&
        (m.content === newMsg.content || m.attachment_url === newMsg.attachment_url)
    );

    if (tempIdx !== -1) {
      this.messages[tempIdx] = newMsg;
      this.renderMessages();
      return;
    }

    if (newMsg.sender_type !== 'visitor') {
      // The reply has landed: whoever was typing is done.
      this.botTyping = false;
      this.agentTyping = false;
    }
    this.messages.push(newMsg);
    this.renderMessages();

    if (newMsg.sender_type !== 'visitor') {
      this.playIncomingSound();
      if (!this.isOpen || this.activeTab !== 'messages') {
        this.unreadCount += 1;
        this.updateUnreadBadge();
        // It reached this browser, so it is delivered — but the visitor
        // has not looked at it, so it is not read.
        this.markMessagesAsDelivered();
        if (!this.isOpen) {
          this.showMessagePopup(newMsg);
        }
      } else {
        this.markMessagesAsRead();
      }
    }
  }

  /** Receipts and edits: the agent's read receipts turn the visitor's ticks blue. */
  private updateMessage(updated: MessageItem) {
    const i = this.messages.findIndex((m) => m.id === updated.id);
    if (i === -1) return;
    const merged = { ...this.messages[i], ...updated };
    if (this.sameMessage(this.messages[i], merged)) return;
    this.messages[i] = merged;
    this.renderMessages();
  }

  /** Same on screen: text, picture, edit/translation, and the ticks. */
  private sameMessage(a: MessageItem, b: MessageItem): boolean {
    const time = (v: string | null | undefined) => (v ? Date.parse(v) || v : null);
    return (
      a.content === b.content &&
      (a.attachment_url || null) === (b.attachment_url || null) &&
      time(a.read_at) === time(b.read_at) &&
      time(a.delivered_at) === time(b.delivered_at) &&
      JSON.stringify(a.metadata || null) === JSON.stringify(b.metadata || null)
    );
  }

  private removeMessage(id: string | undefined) {
    if (!id) return;
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.id !== id);
    if (this.messages.length !== before) this.renderMessages();
  }

  private updateConversationStatus(status: string | undefined) {
    if (!status || status === this.conversationStatus) return;
    this.conversationStatus = status;
    this.renderMessages();
  }

  /**
   * Session mode: one broadcast channel per visitor (its topic is a secret
   * only this browser was told), plus a poll. The broadcast makes replies
   * instant; the poll catches anything it missed, and carries everything on
   * a project where public broadcast is switched off.
   */
  private startLiveUpdates() {
    if (this.legacyData) return;
    if (this.sessionTopic && !this.liveChannel) {
      this.liveChannel = this.supabase
        .channel(this.sessionTopic, { config: { private: false } })
        .on('broadcast', { event: 'message' }, ({ payload }) => this.onLiveMessage(payload as LiveMessagePayload))
        .on('broadcast', { event: 'conversation' }, ({ payload }) => this.onLiveConversation(payload as LiveConversationPayload))
        .subscribe((status: string) => {
          this.liveConnected = status === 'SUBSCRIBED';
        });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.pollSoon();
      });
    }
    this.schedulePoll();
  }

  private onLiveMessage(payload: LiveMessagePayload | null) {
    const msg = payload?.message;
    if (!msg?.id) return;
    if (msg.conversation_id && msg.conversation_id !== this.conversationId) {
      // One of the visitor's other conversations: the Home tab list changed.
      if (payload?.op === 'INSERT') this.loadPreviousConversations();
      return;
    }
    if (payload?.op === 'DELETE') this.removeMessage(msg.id);
    else if (payload?.op === 'UPDATE') this.updateMessage(msg);
    else this.receiveMessage(msg);
  }

  private onLiveConversation(payload: LiveConversationPayload | null) {
    const conv = payload?.conversation;
    if (!conv?.id) return;
    if (conv.id === this.conversationId) {
      this.updateConversationStatus(conv.status);
    } else if (!this.conversationId && !this.forceNewConversation && conv.status !== 'closed') {
      // The team started a conversation with this visitor.
      this.adoptConversation(conv.id, conv.status);
    }
  }

  private async adoptConversation(id: string, status: string) {
    this.conversationId = id;
    this.conversationStatus = status || 'open';
    try {
      localStorage.setItem(`zentry_conversation_id${this.storageSuffix}`, id);
      localStorage.setItem(`chatify_conversation_id${this.storageSuffix}`, id);
    } catch {}
    await this.loadMessageHistory();
    this.subscribeToRealtime();
  }

  private schedulePoll() {
    if (this.legacyData) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const watching = this.isOpen && this.activeTab === 'messages';
    const delay = hidden
      ? 60000
      : !this.conversationId
      ? 45000
      : this.liveConnected
      ? 30000
      : watching
      ? 4000
      : 12000;
    this.pollTimer = setTimeout(() => this.poll(), delay);
  }

  /** Check now (the page came back, or the visitor opened the chat). */
  private pollSoon() {
    if (this.legacyData || !this.sessionTopic) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.poll(), 300);
  }

  private async poll() {
    this.pollTimer = null;
    try {
      if (this.conversationId) {
        await this.syncMessages();
      } else if (!this.forceNewConversation && this.visitorToken) {
        const { data, error } = await this.supabase.rpc('fn_widget_session', {
          p_workspace_id: this.config.workspaceId,
          p_visitor_id: this.visitorId,
          p_token: this.visitorToken,
        });
        if (error && /workspace_unavailable/.test(ZentryWidget.errorText(error))) {
          if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
          }
          return;
        }
        const conv = data?.conversation;
        if (conv?.id && conv.status !== 'closed' && !this.conversationId) {
          await this.adoptConversation(conv.id, conv.status);
        }
      }
    } catch {}
    this.schedulePoll();
  }

  /** Brings the open conversation up to date without losing messages still being sent. */
  private async syncMessages() {
    const convId = this.conversationId;
    if (!convId || this.legacyData) return;
    let res: { conversation?: { status?: string }; messages?: MessageItem[] };
    try {
      res = await this.widgetRpc('fn_widget_messages', { p_conversation_id: convId });
    } catch (e) {
      if (/conversation_not_found/.test(ZentryWidget.errorText(e))) {
        this.forgetConversation();
        this.renderMessages();
      }
      return;
    }
    if (convId !== this.conversationId) return;
    const server = Array.isArray(res?.messages) ? res.messages : [];
    const byId = new Map(server.map((m) => [m.id, m]));
    const oldest = server.length ? server[0].created_at : null;
    // Gone on the server (deleted, or turned into a note) within the window it returned.
    for (const m of [...this.messages]) {
      if (m.id.startsWith('temp-') || m.pending || byId.has(m.id)) continue;
      if (oldest && m.created_at < oldest) continue;
      this.removeMessage(m.id);
    }
    for (const m of server) {
      const known = this.messages.find((x) => x.id === m.id);
      if (!known) this.receiveMessage(m);
      else if (!this.sameMessage(known, { ...known, ...m })) this.updateMessage(m);
    }
    this.updateConversationStatus(res?.conversation?.status);
  }

  // 8. Message History (Filters out internal notes)
  private async loadMessageHistory() {
    if (!this.conversationId) return;

    let data: MessageItem[] | null = null;
    if (this.legacyData) {
      const res = await this.supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', this.conversationId)
        .or('is_internal.is.null,is_internal.eq.false')
        .order('created_at', { ascending: true });
      data = res.data as MessageItem[] | null;
    } else {
      try {
        const res = await this.widgetRpc<{
          conversation?: { status?: string; csat_rating?: number | null };
          messages?: MessageItem[];
        }>('fn_widget_messages', { p_conversation_id: this.conversationId });
        data = Array.isArray(res?.messages) ? res.messages : [];
        if (res?.conversation?.status) this.conversationStatus = res.conversation.status;
        if (res?.conversation?.csat_rating != null) this.csatRated = true;
      } catch (e) {
        if (/conversation_not_found/.test(ZentryWidget.errorText(e))) {
          // Stored by an earlier visitor identity in this browser.
          this.forgetConversation();
          this.renderMessages();
        }
        return;
      }
    }

    if (data) {
      this.messages = data as MessageItem[];
      this.renderMessages();
      if (this.isOpen && this.activeTab === 'messages') {
        this.unreadCount = 0;
        this.markMessagesAsRead();
      } else {
        this.unreadCount = this.messages.filter(
          (m) => m.sender_type !== 'visitor' && !m.read_at
        ).length;
        if (!this.isOpen && this.unreadCount > 0) {
          const lastAdminMsg = [...this.messages]
            .reverse()
            .find((m) => m.sender_type !== 'visitor' && !m.read_at);
          if (lastAdminMsg) {
            try {
              const dismissed = sessionStorage.getItem(`chatify_popup_dismissed_${lastAdminMsg.id}`);
              if (!dismissed) {
                this.showMessagePopup(lastAdminMsg);
              }
            } catch {}
          }
        }
      }
      this.updateUnreadBadge();
    }
  }

  /** Receipt only — the visitor has received these but not necessarily seen them. */
  private async markMessagesAsDelivered() {
    if (!this.conversationId) return;
    if (!this.legacyData) {
      try {
        await this.widgetRpc('fn_widget_mark', { p_conversation_id: this.conversationId, p_read: false });
      } catch {}
      return;
    }
    try {
      await this.supabase.rpc('fn_mark_messages_delivered', {
        p_conversation_id: this.conversationId,
        p_exclude_sender: 'visitor',
      });
    } catch {
      // Project has not run the receipts migration yet; ticks stay at "sent".
    }
  }

  private async markMessagesAsRead() {
    if (!this.conversationId) return;
    // Every call writes receipts that come back as updates (and re-renders);
    // with nothing unread there is nothing to say.
    if (!this.messages.some((m) => m.sender_type !== 'visitor' && !m.read_at && !String(m.id).startsWith('temp-'))) return;
    if (!this.legacyData) {
      try {
        await this.widgetRpc('fn_widget_mark', { p_conversation_id: this.conversationId, p_read: true });
      } catch {}
      return;
    }
    try {
      // Backfills delivered_at too, so a read receipt never exists on its own.
      await this.supabase.rpc('fn_mark_messages_read', {
        p_conversation_id: this.conversationId,
        p_exclude_sender: 'visitor',
      });
    } catch {
      // ignored
    }

    try {
      await this.supabase.rpc('fn_mark_conversation_messages_as_read', {
        p_conversation_id: this.conversationId,
        p_reader_type: 'visitor',
      });
    } catch {
      // ignored
    }
  }

  // 9. Conversation Management
  private async ensureConversation(): Promise<string> {
    if (this.conversationId) return this.conversationId;

    const suffix = this.config.workspaceId ? `_${this.config.workspaceId.slice(0, 8)}` : '';
    let data: any = null;
    let error: any = null;
    if (!this.legacyData) {
      // "Start a new conversation" (forceNewConversation) skips get-or-create,
      // which could hand back the conversation that was just closed.
      const conv = await this.widgetRpc<{ id: string; status: string }>('fn_widget_start_conversation', {
        p_force_new: this.forceNewConversation,
      });
      this.forceNewConversation = false;
      this.conversationId = conv.id;
      this.conversationStatus = conv.status || 'open';
      try {
        localStorage.setItem(`zentry_conversation_id${suffix}`, conv.id);
        localStorage.setItem(`chatify_conversation_id${suffix}`, conv.id);
      } catch {}
      this.subscribeToRealtime();
      return conv.id;
    }
    if (this.forceNewConversation) {
      // "Start a new conversation": skip get-or-create, which could hand back
      // the conversation that was just closed.
      error = new Error('forced new conversation');
    } else {
      const res = await this.supabase.rpc('fn_get_or_create_conversation', {
        p_visitor_id: this.visitorId,
        p_workspace_id: this.config.workspaceId || null,
      });
      data = res.data;
      error = res.error;
    }
    this.forceNewConversation = false;

    if (error || !data) {
      console.warn('[Zen-try] fn_get_or_create_conversation fallback:', error);
      try {
        await this.supabase.from('visitors').upsert({
          id: this.visitorId,
          workspace_id: this.config.workspaceId || null,
          last_seen: new Date().toISOString(),
          is_online: true,
        });

        const { data: convData, error: convErr } = await this.supabase
          .from('conversations')
          .insert({
            visitor_id: this.visitorId,
            workspace_id: this.config.workspaceId || null,
            status: 'open',
            ai_mode: 'autopilot',
          })
          .select()
          .single();

        if (convData) {
          data = convData;
        } else {
          throw convErr || new Error('Failed to create conversation');
        }
      } catch (fallbackErr) {
        throw new Error('Failed to create conversation: ' + (error?.message || String(fallbackErr)));
      }
    }

    this.conversationId = data.id;
    this.conversationStatus = data.status || 'open';
    localStorage.setItem(`chatify_conversation_id${suffix}`, data.id);
    this.subscribeToRealtime();
    return data.id;
  }

  public async sendMessage(content: string, attachmentUrl?: string) {
    if (!content.trim() && !attachmentUrl) return;

    const convId = await this.ensureConversation();

    const tempMsg: MessageItem = {
      id: 'temp-' + Date.now(),
      sender_type: 'visitor',
      content: content.trim() || (attachmentUrl ? 'Sent a picture' : ''),
      attachment_url: attachmentUrl || null,
      created_at: new Date().toISOString(),
      pending: true,
    };
    this.messages.push(tempMsg);
    this.renderMessages();

    let data: MessageItem | null = null;
    let error: unknown = null;
    if (!this.legacyData) {
      // The function also reopens a closed or snoozed conversation.
      this.conversationStatus = 'open';
      try {
        data = await this.widgetRpc<MessageItem>('fn_widget_send_message', {
          p_conversation_id: convId,
          p_content: content.trim(),
          p_attachment_url: attachmentUrl || null,
        });
      } catch (e) {
        error = e;
      }
    } else {
      if (this.conversationStatus !== 'open') {
        this.conversationStatus = 'open';
        this.supabase
          .from('conversations')
          .update({
            status: 'open',
            closed_at: null,
            snoozed_until: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', convId)
          .then(() => {});
      }

      const res = await this.supabase.from('messages').insert({
        conversation_id: convId,
        sender_type: 'visitor',
        content: content.trim() || (attachmentUrl ? 'Sent a picture' : ''),
        attachment_url: attachmentUrl || null,
        is_internal: false,
      }).select().single();
      data = res.data as MessageItem | null;
      error = res.error;
    }

    if (error) {
      console.error('[Zen-try] Error sending message:', error);
      const errStr = String((error as any)?.message || error || '');
      // Only our own refusal: P0001 is every plain RAISE, not just this one.
      const isRateLimited = errStr.includes('rate_limited');

      if (isRateLimited) {
        this.messages = this.messages.filter((m) => m.id !== tempMsg.id);

        const textarea = this.shadow?.getElementById('chatifyInput') as HTMLTextAreaElement | null;
        if (textarea) {
          if (!textarea.value || !textarea.value.trim()) {
            textarea.value = content;
          }
          this.adjustTextareaHeight();
          textarea.focus();
        }

        this.messages.push({
          id: 'rate-limit-' + Date.now(),
          sender_type: 'agent',
          content: "You're sending messages too fast. Please wait a moment.",
          created_at: new Date().toISOString(),
          metadata: { system_event: 'rate_limit' },
        });
        this.renderMessages();
        return;
      }

      tempMsg.pending = false;
      this.renderMessages();
      return;
    }

    if (data) {
      const idx = this.messages.findIndex((m) => m.id === tempMsg.id);
      if (idx !== -1) {
        this.messages[idx] = data as MessageItem;
        this.renderMessages();
      }
    }

    // Auto-translation trigger disabled per user request

    // Every visitor message gets a chance at an AI reply. The route decides
    // whether the assistant is on for this conversation, and skips it when not.
    if (this.config.workspaceId) {
      // Show the typing indicator only if the reply takes a moment, so a
      // skipped (human-handled) conversation does not flash it.
      const typingTimer = setTimeout(() => this.setBotTyping(true), 700);
      const body = JSON.stringify({
        conversation_id: convId,
        workspace_id: this.config.workspaceId,
        message_id: data?.id,
      });
      const ask = (base: string) =>
        fetch(`${base}/api/ai/auto-respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const base = this.config.apiUrl || '';
      // A failed call is a network or CORS failure (an embed pointing at a
      // host that redirects, a stale data-api-url), not the route saying no:
      // the route answers 200 even when the bot stays quiet. The app's own
      // host gets the message instead, and fn_deliver_ai_reply keeps a
      // second call from ever producing a second reply.
      ask(base)
        .catch((err) => {
          if (base === DEFAULT_API_URL) throw err;
          console.warn('[Zen-try] Reply service unreachable at', base || window.location.origin, '- retrying', DEFAULT_API_URL);
          return ask(DEFAULT_API_URL);
        })
        .catch((err) => console.error('[Zen-try] Could not reach the reply service:', err))
        .finally(() => {
          clearTimeout(typingTimer);
          this.setBotTyping(false);
        });
    }
  }

  private setBotTyping(value: boolean) {
    if (this.botTyping === value) return;
    this.botTyping = value;
    this.renderMessages();
  }

  /** Agents broadcast a 'typing' event on the conversation's channel. */
  private subscribeToTyping() {
    if (this.typingChannel) {
      try { this.supabase.removeChannel(this.typingChannel); } catch {}
      this.typingChannel = null;
    }
    if (!this.conversationId) return;
    this.typingChannel = this.supabase
      .channel(`chatify-typing-${this.conversationId}`)
      .on('broadcast', { event: 'typing' }, (payload: any) => {
        if (payload?.payload?.sender === 'visitor') return;
        this.agentTyping = true;
        if (this.agentTypingTimer) clearTimeout(this.agentTypingTimer);
        this.agentTypingTimer = setTimeout(() => {
          this.agentTyping = false;
          this.renderMessages();
        }, 4000);
        this.renderMessages();
      })
      .subscribe();
  }

  /** Closed conversation: forget it locally so the next message opens a fresh one. */
  private startNewConversation() {
    const suffix = this.config.workspaceId ? `_${this.config.workspaceId.slice(0, 8)}` : '';
    if (this.realtimeChannel) {
      try { this.supabase.removeChannel(this.realtimeChannel); } catch {}
      this.realtimeChannel = null;
    }
    this.conversationId = null;
    this.conversationStatus = 'open';
    this.forceNewConversation = true;
    this.csatRated = false;
    this.messages = [];
    this.unreadCount = 0;
    this.botTyping = false;
    this.agentTyping = false;
    try {
      localStorage.removeItem(`chatify_conversation_id${suffix}`);
      localStorage.removeItem(`zentry_conversation_id${suffix}`);
      sessionStorage.removeItem(`chatify_conversation_id${suffix}`);
      sessionStorage.removeItem(`zentry_conversation_id${suffix}`);
    } catch {}
    this.subscribeToTyping();
    this.updateUnreadBadge();
    this.renderMessages();
    this.loadPreviousConversations();
    setTimeout(() => {
      (this.shadow?.getElementById('chatifyTextarea') as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
    }, 100);
  }

  // Previous conversations (Home tab)
  private async loadPreviousConversations() {
    if (!this.visitorId) return;
    try {
      const data = this.legacyData
        ? (
            await this.supabase.rpc('fn_get_visitor_conversations', {
              p_visitor_id: this.visitorId,
              p_workspace_id: this.config.workspaceId || null,
            })
          ).data
        : await this.widgetRpc('fn_widget_conversations');
      this.previousConversations = Array.isArray(data) ? data : [];
    } catch {}
    this.renderPreviousConversations();
  }

  private renderPreviousConversations() {
    const card = this.shadow?.getElementById('cardPrevConvs') as HTMLElement | null;
    const list = this.shadow?.getElementById('prevConvsList') as HTMLElement | null;
    if (!card || !list) return;

    const items = this.previousConversations
      .filter((c) => c.id !== this.conversationId && c.last_message)
      .slice(0, 5);
    if (items.length === 0) {
      card.style.display = 'none';
      return;
    }
    card.style.display = 'block';

    list.innerHTML = items
      .map((c) => {
        const raw = (c.last_message?.content || '')
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/\*\*|__|`/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const snippet = raw || (c.last_message?.attachment_url ? 'Sent a picture' : 'Conversation');
        const when = this.formatRelativeTime(new Date(c.updated_at || c.created_at));
        const closed = c.status === 'closed';
        return `<button type="button" class="chatify-prev-item" data-id="${this.escapeHTML(c.id)}">` +
          `<span class="chatify-prev-text"><span class="chatify-prev-snippet">${this.escapeHTML(
            snippet.length > 70 ? snippet.slice(0, 70) + '…' : snippet
          )}</span>` +
          `<span class="chatify-prev-meta">${this.escapeHTML(when)} · ${closed ? 'Closed' : 'Open'}</span></span>` +
          `<span class="chatify-prev-chevron">›</span></button>`;
      })
      .join('');

    list.querySelectorAll('.chatify-prev-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.openPreviousConversation((btn as HTMLElement).getAttribute('data-id') || '');
      });
    });
  }

  private async openPreviousConversation(id: string) {
    if (!id) return;
    const conv = this.previousConversations.find((c) => c.id === id);
    const suffix = this.config.workspaceId ? `_${this.config.workspaceId.slice(0, 8)}` : '';
    this.conversationId = id;
    this.conversationStatus = conv?.status || 'open';
    this.csatRated = Boolean(conv?.csat_rating);
    this.messages = [];
    this.botTyping = false;
    this.agentTyping = false;
    try {
      localStorage.setItem(`zentry_conversation_id${suffix}`, id);
      localStorage.setItem(`chatify_conversation_id${suffix}`, id);
    } catch {}
    this.subscribeToRealtime();
    this.switchTab('messages');
    await this.loadMessageHistory();
    this.renderPreviousConversations();
  }

  // Post-chat CSAT Rating
  public async submitCSAT(rating: 'good' | 'bad' | number, comment?: string) {
    if (!this.conversationId) return;
    this.csatRated = true;

    const ratingVal = typeof rating === 'number' ? (rating >= 4 ? 'good' : 'bad') : rating;
    const numRating = ratingVal === 'good' ? 5 : 1;

    try {
      // Our API, not the customer's site the widget is embedded on.
      const res = await fetch(`${this.config.apiUrl || ''}/api/csat/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: this.conversationId,
          visitor_id: this.visitorId,
          visitor_token: this.visitorToken,
          rating: ratingVal,
          comment: comment ? comment.trim() : undefined,
        }),
      });
      if (!res.ok) throw new Error(`CSAT ${res.status}`);
    } catch {
      // Only the older direct access can write it from here.
      if (this.legacyData) try {
        await this.supabase
          .from('conversations')
          .update({ csat_rating: numRating, csat_feedback: comment ? comment.trim() : null })
          .eq('id', this.conversationId);
      } catch {}
    }

    this.renderMessages();
  }

  private renderLauncherIconHTML(): string {
    const isCustom =
      this.config.widgetIcon === 'custom_logo' ||
      (!this.config.widgetIcon && this.config.showLauncherLogo !== false && Boolean(this.config.logoUrl));
    const safeLogo = this.safeUrl(this.config.logoUrl, true);
    if (isCustom && safeLogo) {
      const fallbackIcon = this.safeUrl(ZENTRY_ICON_DATA_URI || CHATIFY_ICON_DATA_URI, true);
      return `<img src="${safeLogo}" alt="Chat" class="chatify-launcher-icon chatify-custom-logo" onerror="this.src='${fallbackIcon}';this.classList.remove('chatify-custom-logo');" />`;
    }
    // Presets come from src/lib/widget/launcher-icons.ts (shared with the
    // settings preview); static markup painted with currentColor.
    return `<span class="chatify-launcher-icon chatify-preset-icon">${launcherIcon(this.config.widgetIcon).svg}</span>`;
  }

  /**
   * Dark window colours. "auto" follows the visitor's system so the
   * messenger never looks pasted onto a dark page; the workspace can also
   * force light or dark (Settings → Chat widget → Appearance).
   */
  private darkModeCSS(): string {
    const vars = `
          --w-surface: #101013;
          --w-surface-2: #17171b;
          --w-surface-3: #202026;
          --w-canvas: #0b0b0e;
          --w-ink: #f5f5f3;
          --w-ink-2: #b4b4bc;
          --w-ink-3: #8b8b95;
          --w-line: #232329;
          --w-line-2: #2f2f37;
          --w-success: #34d9a7;
          --w-glass: rgba(16, 16, 19, 0.84);
          --w-glass-line: rgba(255, 255, 255, 0.08);
          --w-focus: #7a99ff;
          --w-shadow-sm: 0 1px 3px rgba(0,0,0,.5);
          --w-shadow-md: 0 6px 18px rgba(0,0,0,.55);
          --w-shadow-xl: 0 32px 68px rgba(0,0,0,.7), 0 12px 26px rgba(0,0,0,.5);
          color-scheme: dark;`;
    const mode = this.config.colorMode || 'auto';
    if (mode === 'light') return '';
    if (mode === 'dark') return `:host { ${vars} }`;
    return `@media (prefers-color-scheme: dark) { :host { ${vars} } }`;
  }

  /**
   * Overrides for the window design (Settings → Chat widget → Design).
   * Classic is the base stylesheet; each other design only restates what
   * differs, so all four share one layout and one set of behaviours.
   */
  private designCSS(): string {
    const design = this.config.widgetDesign || 'classic';
    if (design === 'minimal') {
      return `
      .chatify-home-hero { background: var(--w-surface); color: var(--w-ink); padding-bottom: 18px; border-bottom: 1px solid var(--w-line); }
      .chatify-home-hero::before, .chatify-home-hero::after { display: none; }
      .chatify-home-title { color: var(--w-ink); text-shadow: none; font-size: 24px; }
      .chatify-home-sub { color: var(--w-ink-2); }
      .chatify-home-avatar { background: var(--w-surface-2); border: 1px solid var(--w-line); box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; color: var(--w-ink); }
      .chatify-icon-btn { background: transparent; border-color: var(--w-line); color: var(--w-ink-3); backdrop-filter: none; -webkit-backdrop-filter: none; }
      .chatify-icon-btn:hover { background: var(--w-surface-3); color: var(--w-ink); transform: none; }
      .chatify-home-content { margin-top: 0; border-radius: 0; }
      .chatify-card { border: 1px solid var(--w-line); border-radius: 12px; box-shadow: none; }
      .chatify-card-action:hover { transform: none; box-shadow: none; border-color: var(--w-line-2); }
      .chatify-primary-cta { border-radius: 10px; box-shadow: none; }
      .chatify-primary-cta:hover { transform: none; box-shadow: none; filter: brightness(1.06); }
      .chatify-window { border-radius: 16px; }
      .chatify-launcher { box-shadow: 0 6px 16px rgba(11,11,15,.16); }
      `;
    }
    if (design === 'solid') {
      return `
      .chatify-home-hero { background: var(--w-brand); color: var(--w-on-brand); }
      .chatify-home-hero::before, .chatify-home-hero::after { display: none; }
      .chatify-home-title, .chatify-home-sub { color: var(--w-on-brand); text-shadow: none; }
      .chatify-home-avatar { border-radius: 14px; box-shadow: none; }
      .chatify-card { border-radius: 16px; box-shadow: 0 2px 10px rgba(11,11,15,.06); }
      .chatify-primary-cta { border-radius: 999px; box-shadow: none; }
      .chatify-header { background: var(--w-brand); border-bottom-color: transparent; }
      .chatify-header-text h3, .chatify-header-text p { color: var(--w-on-brand); }
      .chatify-header .chatify-back-btn, .chatify-header .chatify-close-btn { color: var(--w-on-brand); }
      .chatify-header .chatify-back-btn:hover, .chatify-header .chatify-close-btn:hover { background: rgba(255,255,255,.16); color: var(--w-on-brand); }
      .chatify-header .chatify-avatar { background: rgba(255,255,255,.18); color: var(--w-on-brand); }
      .chatify-launcher, .chatify-launcher::after, .chatify-launcher.is-loading, .chatify-launcher.is-loading::before { border-radius: 18px; }
      `;
    }
    if (design === 'midnight') {
      return `
      .chatify-home-hero { background: radial-gradient(120% 90% at 85% 0%, var(--w-brand-a28), transparent 60%), #0d0d12; color: #ffffff; }
      .chatify-home-hero::before { display: none; }
      .chatify-home-avatar { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.14); }
      .chatify-icon-btn { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.14); }
      .chatify-card { border-radius: 14px; }
      .chatify-primary-cta { border-radius: 10px; }
      .chatify-launcher { background: #0d0d12; color: #ffffff; box-shadow: 0 0 0 2px var(--w-brand), 0 10px 26px rgba(11,11,15,.32); }
      .chatify-launcher:hover { box-shadow: 0 0 0 2px var(--w-brand), 0 16px 34px rgba(11,11,15,.4); }
      `;
    }
    if (design === 'compact') {
      // Zendesk-like: straight into the chat, a slim solid header, square
      // corners, a labelled pill launcher.
      return `
      .chatify-window { border-radius: 10px; width: 376px; }
      #navHome, .chatify-back-btn, .chatify-bottom-nav { display: none !important; }
      .chatify-header { background: var(--w-brand); border-bottom: none; padding: 14px 16px; }
      .chatify-header-text h3 { color: var(--w-on-brand); font-size: 15px; }
      .chatify-header-text p { color: var(--w-on-brand); opacity: .85; }
      .chatify-header .chatify-close-btn { color: var(--w-on-brand); }
      .chatify-header .chatify-close-btn:hover { background: rgba(255,255,255,.16); color: var(--w-on-brand); }
      .chatify-header .chatify-avatar { background: rgba(255,255,255,.2); color: var(--w-on-brand); }
      .chatify-msg-visitor { background: var(--w-brand); border-radius: 8px; box-shadow: none; }
      .chatify-msg-agent { background: var(--w-surface-3); border: none; border-radius: 8px; box-shadow: none; }
      .chatify-send-btn { border-radius: 6px; }
      .chatify-launcher {
        width: auto; min-width: 56px; height: 50px; padding: 0 20px 0 16px; gap: 8px;
        border-radius: 999px; box-shadow: 0 6px 18px rgba(11,11,15,.18);
      }
      .chatify-launcher::after { border-radius: 999px; }
      .chatify-launcher .chatify-launcher-label { display: inline; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
      .chatify-launcher.widget-is-open { width: 50px; min-width: 50px; padding: 0; }
      .chatify-launcher.widget-is-open .chatify-launcher-label { display: none; }
      .chatify-launcher-icon.chatify-preset-icon, .chatify-preset-icon svg { width: 22px; height: 22px; }
      `;
    }
    if (design === 'livechat') {
      // Tawk.to-like: straight into the chat, a tall brand header with the
      // team's faces and status, round bubbles, a status dot on the launcher.
      return `
      .chatify-window { border-radius: 16px; }
      #navHome, .chatify-back-btn { display: none !important; }
      .chatify-header { background: var(--w-brand); border-bottom: none; padding: 18px 16px 20px; align-items: flex-start; }
      .chatify-header-info { flex-wrap: wrap; row-gap: 10px; }
      .chatify-header .chatify-avatar { display: none; }
      .chatify-header-text { order: 1; flex: 1 0 100%; }
      .chatify-header-text h3 { color: var(--w-on-brand); font-size: 17px; font-weight: 700; }
      .chatify-header-text p { color: var(--w-on-brand); opacity: .9; white-space: normal; }
      .chatify-header .chatify-header-avatars { display: flex; order: 0; }
      .chatify-header-avatars .chatify-mini-avatar { width: 34px; height: 34px; border-color: var(--w-brand); }
      .chatify-header .chatify-close-btn { color: var(--w-on-brand); }
      .chatify-header .chatify-close-btn:hover { background: rgba(255,255,255,.18); color: var(--w-on-brand); }
      .chatify-msg-visitor { background: var(--w-brand); border-radius: 20px 20px 4px 20px; box-shadow: none; }
      .chatify-msg-agent { border-radius: 20px 20px 20px 4px; background: var(--w-surface-2); border: none; box-shadow: none; }
      .chatify-send-btn { border-radius: 50%; }
      .chatify-launcher-status {
        display: block; position: absolute; right: 2px; bottom: 2px; width: 14px; height: 14px;
        border-radius: 50%; background: #a1a1aa; border: 2.5px solid #ffffff;
      }
      .chatify-launcher-status.is-online { background: #22c55e; }
      .chatify-launcher.widget-is-open .chatify-launcher-status { display: none; }
      `;
    }
    if (design === 'modern') {
      // Chatway-like: a two-colour gradient, very round surfaces, a rounded
      // square launcher in the same gradient.
      return `
      .chatify-window { border-radius: 24px; }
      .chatify-home-hero { background: linear-gradient(135deg, var(--w-brand) 0%, var(--w-brand-2) 100%); padding-bottom: 64px; }
      .chatify-home-hero::after { display: none; }
      .chatify-home-title { font-size: 29px; }
      .chatify-home-avatar { width: 46px; height: 46px; border-radius: 50%; padding: 0; overflow: hidden; }
      .chatify-home-content { margin-top: -40px; border-radius: 24px 24px 0 0; }
      .chatify-card { border-radius: 22px; border: none; box-shadow: 0 10px 30px -8px rgba(15,23,42,.18); }
      .chatify-primary-cta { border-radius: 999px; background: linear-gradient(135deg, var(--w-brand), var(--w-brand-2)); box-shadow: 0 8px 20px var(--w-brand-a28); }
      .chatify-header { background: linear-gradient(135deg, var(--w-brand) 0%, var(--w-brand-2) 100%); border-bottom: none; }
      .chatify-header-text h3, .chatify-header-text p { color: var(--w-on-brand); }
      .chatify-header .chatify-back-btn, .chatify-header .chatify-close-btn { color: var(--w-on-brand); }
      .chatify-header .chatify-back-btn:hover, .chatify-header .chatify-close-btn:hover { background: rgba(255,255,255,.18); color: var(--w-on-brand); }
      .chatify-header .chatify-avatar { background: rgba(255,255,255,.22); color: var(--w-on-brand); }
      .chatify-msg-visitor { background: linear-gradient(135deg, var(--w-brand), var(--w-brand-2)); border-radius: 22px 22px 6px 22px; }
      .chatify-msg-agent { border-radius: 22px 22px 22px 6px; border: none; background: var(--w-surface-2); box-shadow: none; }
      .chatify-send-btn { border-radius: 50%; background: linear-gradient(135deg, var(--w-brand), var(--w-brand-2)); }
      .chatify-launcher { border-radius: 20px; background: linear-gradient(135deg, var(--w-brand), var(--w-brand-2)); }
      .chatify-launcher::after, .chatify-launcher.is-loading, .chatify-launcher.is-loading::before { border-radius: 20px; }
      `;
    }
    return '';
  }

  // 10. DOM & Shadow Root Initialization (Intercom Messenger 2.0)
  private initDOM() {
    this.container = document.createElement('div');
    this.container.id = 'zentry-widget-root';
    this.container.className = 'zentry-widget-root chatify-widget-root';
    this.container.setAttribute('data-zentry-root', 'true');
    document.body.appendChild(this.container);

    this.shadow = this.container.attachShadow({ mode: 'open' });

    // On phones the panel is full-screen. Track the *visual* viewport so the
    // composer rides above the on-screen keyboard instead of hiding behind it.
    const vv = window.visualViewport;
    if (vv && this.container) {
      const root = this.container;
      const syncViewport = () => {
        root.style.setProperty('--w-vvh', `${Math.round(vv.height)}px`);
        root.style.setProperty('--w-vv-top', `${Math.round(vv.offsetTop)}px`);
      };
      syncViewport();
      vv.addEventListener('resize', syncViewport);
      vv.addEventListener('scroll', syncViewport);
    }

    // 1. Stop keyboard events that originate inside the widget from reaching the host page
    ['keydown', 'keyup', 'keypress'].forEach((eventType) => {
      this.shadow?.addEventListener(eventType, (e: Event) => {
        e.stopPropagation();
      });
      this.container?.addEventListener(eventType, (e: Event) => {
        e.stopPropagation();
      });
    });

    // 2. Pressing Escape inside the widget closes the emoji picker first, then the widget
    this.shadow.addEventListener('keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Escape') {
        const picker = this.shadow?.getElementById('chatifyEmojiPicker');
        const isEmojiOpen = Boolean(
          picker &&
          picker.style.display !== 'none' &&
          picker.style.display !== ''
        );

        if (isEmojiOpen) {
          ke.preventDefault();
          this.closeEmojiPicker();
          const textarea = this.shadow?.getElementById('chatifyTextarea') as HTMLTextAreaElement | null;
          textarea?.focus();
          return;
        }

        const lightbox = this.shadow?.getElementById('chatifyImageLightbox');
        const isLightboxOpen = Boolean(lightbox && lightbox.style.display === 'flex');
        if (isLightboxOpen) {
          ke.preventDefault();
          this.closeLightbox();
          return;
        }

        if (this.isOpen) {
          ke.preventDefault();
          this.close();
        }
      }
    });

    const style = document.createElement('style');
    style.id = 'chatify-theme-style';
    style.textContent = this.generateCSS();
    this.shadow.appendChild(style);

    // Launcher HTML
    const launcher = document.createElement('button');
    // Shimmers until workspace branding arrives, so the default colour never flashes.
    launcher.className = this.config.workspaceId ? 'chatify-launcher is-loading' : 'chatify-launcher';
    launcher.id = 'chatifyLauncherBtn';
    launcher.setAttribute('aria-label', 'Open chat');
    launcher.innerHTML = `
      <div class="chatify-badge" id="chatifyBadge">0</div>
      <span id="chatifyIconOpen" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;">
        ${this.renderLauncherIconHTML()}
      </span>
      <svg id="chatifyIconClose" style="display:none;" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
      <span class="chatify-launcher-label" aria-hidden="true">Chat</span>
      <span class="chatify-launcher-status" id="chatifyLauncherStatus" aria-hidden="true"></span>
    `;
    launcher.onclick = () => this.toggleWindow();
    this.shadow.appendChild(launcher);

    // Incoming message popup preview (Intercom-style 2-card popup)
    const popup = document.createElement('div');
    popup.className = 'chatify-message-popup';
    popup.id = 'chatifyMessagePopup';
    popup.style.display = 'none';
    popup.innerHTML = `
      <div class="chatify-popup-card" id="chatifyPopupCard" title="Click to view conversation">
        <div class="chatify-popup-avatar-wrap">
          <div class="chatify-popup-avatar" id="chatifyPopupAvatar">TD</div>
          <span class="chatify-popup-status-dot"></span>
        </div>
        <div class="chatify-popup-content">
          <div class="chatify-popup-header">
            <span class="chatify-popup-title" id="chatifyPopupTitle">Trader Care Desk</span>
            <button type="button" class="chatify-popup-close" id="chatifyPopupCloseBtn" title="Dismiss" aria-label="Close message preview">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <p class="chatify-popup-message" id="chatifyPopupMessageText">Hi, how can we help?</p>
        </div>
      </div>
      <div class="chatify-popup-reply-bar" id="chatifyPopupReplyBar">
        <input type="text" class="chatify-popup-input" id="chatifyPopupInput" placeholder="Write your message..." autocomplete="off" />
        <button type="button" class="chatify-popup-send" id="chatifyPopupSendBtn" title="Send message" aria-label="Send message">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    `;
    this.shadow.appendChild(popup);

    // Intercom Messenger 2.0 Multi-Tab Window
    const chatWindow = document.createElement('div');
    chatWindow.className = 'chatify-window';
    chatWindow.id = 'chatifyWindow';
    chatWindow.innerHTML = `
      <!-- TAB 1: HOME TAB -->
      <div class="chatify-tab-pane" id="tabHome" style="display: flex;">
        <div class="chatify-home-hero">
          <div class="chatify-brand-row">
            <div class="chatify-home-avatar" id="homeBrandAvatar">
              ${this.renderBrandAvatarHTML(false)}
            </div>
            <button class="chatify-icon-btn" id="homeCloseBtn" title="Close Messenger">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <h2 class="chatify-home-title" id="homeGreetingTitle">Hello there 👋</h2>
          <p class="chatify-home-sub" id="homeGreetingSub">How can our support team help you today?</p>
        </div>

        <div class="chatify-home-content">
          <!-- Active Open Conversation Card (shown when opened conversation exists) -->
          <div class="chatify-card chatify-card-action chatify-open-conv-card" id="cardOpenConv" style="display: none;">
            <div class="chatify-card-head">
              <span class="chatify-status-pill chatify-conv-status-pill" id="openConvStatusPill">
                <span class="chatify-pulse-dot online"></span>
                <span>Active conversation</span>
              </span>
              <span class="chatify-conv-time" id="openConvTime">Just now</span>
            </div>
            <div class="chatify-open-conv-preview">
              <div class="chatify-open-conv-avatar-col">
                <div class="chatify-mini-avatar" id="openConvAvatar" style="background:var(--w-brand); width:34px; height:34px; font-size:13px; margin-left:0; color:var(--w-on-brand); font-weight:700; display:flex; align-items:center; justify-content:center; border-radius:50%; overflow:hidden;">
                  ${this.renderBrandAvatarHTML(false)}
                </div>
              </div>
              <div class="chatify-open-conv-text-col">
                <div class="chatify-open-conv-sender-row">
                  <span class="chatify-open-conv-sender" id="openConvSender">Support Team</span>
                  <span class="chatify-home-unread-pill" id="openConvUnreadPill" style="display:none;">1 new</span>
                </div>
                <p class="chatify-open-conv-snippet" id="openConvSnippet">Click to view messages...</p>
              </div>
            </div>
            <button class="chatify-primary-cta" id="btnContinueConversation">
              <span id="btnContinueConvText">Continue conversation</span>
              <span class="chatify-cta-badge" id="openConvCtaBadge" style="display:none;">1</span>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </button>
            <button type="button" class="chatify-new-conv-link" id="btnStartNewChat">
              <span>+ Send a new message</span>
            </button>
          </div>

          <!-- Start Chat Card (shown when no conversation exists yet) -->
          <div class="chatify-card chatify-card-action" id="cardStartChat">
            <div class="chatify-card-head">
              <div class="chatify-avatars-stack" id="homeAvatarsStack"></div>
              <span class="chatify-status-pill" id="homeStatusPill">
                <span class="chatify-pulse-dot away"></span>
                <span>We're away, leave a message and we'll reply by email</span>
              </span>
              <span class="chatify-home-unread-pill" id="homeCardUnreadPill" style="display:none;">1 new message</span>
            </div>
            <h4 class="chatify-card-title" id="homeCardTitle">Chat with us</h4>
            <p class="chatify-card-sub" id="homeCardSub">Ask us anything, or share your feedback.</p>
            <button class="chatify-primary-cta" id="btnGoToMessages">
              <span id="btnGoToMessagesText">Chat with us</span>
              <span class="chatify-cta-badge" id="homeCardCtaBadge" style="display:none;">1</span>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </button>
          </div>

          <!-- Previous conversations (shown only when the visitor has others) -->
          <div class="chatify-card chatify-card-prev" id="cardPrevConvs" style="display: none;">
            <div class="chatify-section-title">Previous conversations</div>
            <div class="chatify-prev-list" id="prevConvsList"></div>
          </div>

          <!-- Help Center Quick Search (shown only when workspace has published articles) -->
          <div class="chatify-card chatify-card-help" id="cardHelpSearch" style="display: none;">
            <div class="chatify-section-title" id="homeHelpSectionTitle">Knowledge Base</div>
            <p class="chatify-card-sub" style="margin-bottom:12px;">Search self-service answers and guides:</p>
            <div class="chatify-search-trigger" id="homeSearchTrigger">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <span>Search for help articles...</span>
              <span class="chatify-search-kbd">Search</span>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 2: MESSAGES TAB (Active Chat Thread) -->
      <div class="chatify-tab-pane" id="tabMessages" style="display: none;">
        <div class="chatify-header">
          <div class="chatify-header-info">
            <button class="chatify-back-btn" id="btnBackToHome" title="Back to Home">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
            </button>
            <div class="chatify-avatar" id="chatifyHeaderAvatar">
              ${this.renderBrandAvatarHTML(true)}
            </div>
            <div class="chatify-header-text">
              <h3 id="chatifyHeaderTitle">${this.escapeHTML(this.config.title)}</h3>
              <p id="chatifyHeaderSubtitle">${this.escapeHTML(this.config.subtitle)}</p>
            </div>
            <div class="chatify-header-avatars chatify-avatars-stack" id="chatHeaderAvatars" aria-hidden="true"></div>
          </div>
          <div style="display:flex; align-items:center; gap:4px;">
            <button class="chatify-close-btn" id="chatifyNewChatBtn" title="New conversation" style="padding:5px;">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
            </button>
            <button class="chatify-close-btn" id="chatifyCloseBtn" title="Close">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        <div class="chatify-body" id="chatifyBody">
          ${
            !this.isPreChatCompleted
              ? `
            <div class="chatify-prechat" id="chatifyPreChat">
              <h4>👋 Welcome to Live Support</h4>
              <p>Please introduce yourself so our support team can best assist you.</p>
              <div class="chatify-form-group">
                <label>Your Name <span class="chatify-optional-tag">(Optional)</span></label>
                <input type="text" id="chatifyInputName" class="chatify-input" placeholder="e.g. Sarah Connor" />
              </div>
              <div class="chatify-form-group">
                <label>Email Address <span class="chatify-required-tag" style="color:#ef4444; font-weight:700;">*</span></label>
                <input type="email" id="chatifyInputEmail" class="chatify-input" placeholder="sarah@example.com" autocomplete="email" inputmode="email" required aria-required="true" aria-describedby="chatifyEmailError" />
                <div id="chatifyEmailError" class="chatify-field-error" role="alert" aria-live="polite" style="display:none;"></div>
              </div>
              <button class="chatify-start-btn" id="chatifyStartBtn">Start Live Conversation</button>
            </div>
          `
              : ''
          }
        </div>

        <!-- Attachment preview container -->
        <div id="chatifyAttachmentPreview" class="chatify-attachment-preview" style="display:none;">
          <img id="chatifyPreviewImg" class="chatify-preview-thumb" src="" alt="Preview" />
          <div class="chatify-preview-info">
            <span id="chatifyPreviewName" class="chatify-preview-name">image.png</span>
            <span id="chatifyPreviewSize" class="chatify-preview-size">0 KB</span>
          </div>
          <button type="button" id="chatifyPreviewRemove" class="chatify-preview-remove" title="Remove picture">✕</button>
        </div>

        <!-- Emoji Picker Popover (WhatsApp Style) -->
        <div id="chatifyEmojiPicker" class="chatify-emoji-popover" style="display:none;">
          <div class="chatify-emoji-header">
            <input type="text" id="chatifyEmojiSearch" class="chatify-emoji-search" placeholder="Search emojis..." />
          </div>
          <div class="chatify-emoji-categories" id="chatifyEmojiCategories"></div>
          <div class="chatify-emoji-grid" id="chatifyEmojiGrid"></div>
        </div>

        <!-- Hidden input for picture upload -->
        <input type="file" id="chatifyImageInput" accept="image/*,.heic,.heif" style="display:none;" />

        <div class="chatify-footer" id="chatifyFooter" style="${!this.isPreChatCompleted ? 'display:none;' : 'display:flex;'}">
          <div class="chatify-footer-actions">
            <button type="button" id="chatifyImageBtn" class="chatify-action-btn" title="Send picture">
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
            </button>
            <button type="button" id="chatifyEmojiBtn" class="chatify-action-btn" title="Insert emoji">
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
                <line x1="9" y1="9" x2="9.01" y2="9"></line>
                <line x1="15" y1="9" x2="15.01" y2="9"></line>
              </svg>
            </button>
          </div>
          <textarea id="chatifyTextarea" class="chatify-textarea" rows="1" placeholder="Type a message..."></textarea>
          <button id="chatifySendBtn" class="chatify-send-btn" title="Send message">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>

      <!-- TAB 3: HELP TAB (Knowledge Base) -->
      <div class="chatify-tab-pane" id="tabHelp" style="display: none;">
        <div class="chatify-header">
          <div class="chatify-header-text">
            <h3>Knowledge Base</h3>
            <p>Self-service guides &amp; FAQs</p>
          </div>
          <button class="chatify-close-btn" id="helpCloseBtn" title="Close">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="chatify-help-body">
          <div class="chatify-help-search-bar">
            <input type="text" id="helpSearchInput" placeholder="Search answers..." />
          </div>

          <div class="chatify-faq-list" id="faqList"></div>
        </div>
      </div>

      <!-- Bottom Intercom Navigation Bar -->
      <nav class="chatify-bottom-nav">
        <button class="chatify-nav-item active" data-tab="home" id="navHome">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
            <polyline points="9 22 9 12 15 12 15 22"></polyline>
          </svg>
          <span>Home</span>
        </button>
        <button class="chatify-nav-item" data-tab="messages" id="navMessages">
          <div class="nav-msg-icon-wrap">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <span class="chatify-nav-badge" id="navMsgBadge" style="display:none;">1</span>
          </div>
          <span class="chatify-nav-label-wrap">
            <span id="navMessagesText">Chat</span>
          </span>
        </button>
        <button class="chatify-nav-item" data-tab="help" id="navHelp" style="display:none;">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
          <span>Help</span>
        </button>
      </nav>

      <!-- Image Lightbox Modal -->
      <div id="chatifyImageLightbox" class="chatify-lightbox" style="display:none;">
        <button type="button" id="chatifyLightboxClose" class="chatify-lightbox-close" title="Close">✕</button>
        <img id="chatifyLightboxImg" class="chatify-lightbox-img" src="" alt="Enlarged" />
        <a id="chatifyLightboxLink" class="chatify-lightbox-link" href="#" target="_blank" rel="noopener noreferrer">Open original in new tab</a>
      </div>
    `;

    this.shadow.appendChild(chatWindow);

    // Event listeners
    this.shadow.getElementById('homeCloseBtn')?.addEventListener('click', () => this.toggleWindow());
    this.shadow.getElementById('chatifyCloseBtn')?.addEventListener('click', () => this.toggleWindow());
    this.shadow.getElementById('chatifyNewChatBtn')?.addEventListener('click', () => this.startNewConversation());
    this.shadow.getElementById('helpCloseBtn')?.addEventListener('click', () => this.toggleWindow());

    // Navigation Tab Switching
    this.shadow.querySelectorAll('.chatify-nav-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tab = (e.currentTarget as HTMLElement).getAttribute('data-tab') as 'home' | 'messages' | 'help';
        this.switchTab(tab);
      });
    });

    this.shadow.getElementById('btnGoToMessages')?.addEventListener('click', () => {
      this.switchTab('messages');
    });

    this.shadow.getElementById('cardStartChat')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement)?.closest('#btnGoToMessages')) return;
      this.switchTab('messages');
    });

    this.shadow.getElementById('btnContinueConversation')?.addEventListener('click', () => {
      this.switchTab('messages');
    });

    this.shadow.getElementById('cardOpenConv')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement)?.closest('#btnContinueConversation, #btnStartNewChat')) return;
      this.switchTab('messages');
    });

    this.shadow.getElementById('btnStartNewChat')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.switchTab('messages');
      setTimeout(() => {
        (this.shadow?.getElementById('chatifyTextarea') as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
      }, 120);
    });

    this.shadow.getElementById('btnBackToHome')?.addEventListener('click', () => {
      this.switchTab('home');
    });

    // Unread Message Popup event listeners
    this.shadow.getElementById('chatifyPopupCloseBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dismissMessagePopup();
    });

    this.shadow.getElementById('chatifyPopupCard')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement)?.closest('#chatifyPopupCloseBtn')) return;
      this.hideMessagePopup(false);
      this.open('messages');
    });

    const popupInput = this.shadow.getElementById('chatifyPopupInput') as HTMLInputElement | null;
    const popupSendBtn = this.shadow.getElementById('chatifyPopupSendBtn');

    popupInput?.addEventListener('input', () => {
      popupSendBtn?.classList.toggle('active', Boolean(popupInput.value.trim()));
    });

    popupInput?.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await this.sendPopupReply();
      }
    });

    popupSendBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.sendPopupReply();
    });

    this.shadow.getElementById('homeSearchTrigger')?.addEventListener('click', () => {
      this.switchTab('help');
      setTimeout(() => {
        (this.shadow?.getElementById('helpSearchInput') as HTMLInputElement)?.focus({ preventScroll: true });
      }, 100);
    });

    // FAQ Accordion & Reactions
    this.bindFaqListeners();

    // FAQ Search Input
    const faqSearch = this.shadow.getElementById('helpSearchInput') as HTMLInputElement | null;
    faqSearch?.addEventListener('input', (e) => {
      this.faqSearchQuery = (e.target as HTMLInputElement).value;
      this.renderFaqList();
    });

    this.bindPrechatHandlers();

    const sendBtn = this.shadow.getElementById('chatifySendBtn');
    const textarea = this.shadow.getElementById('chatifyTextarea') as HTMLTextAreaElement | null;
    const imageBtn = this.shadow.getElementById('chatifyImageBtn');
    const imageInput = this.shadow.getElementById('chatifyImageInput') as HTMLInputElement | null;
    const emojiBtn = this.shadow.getElementById('chatifyEmojiBtn');
    const previewRemoveBtn = this.shadow.getElementById('chatifyPreviewRemove');
    const lightboxCloseBtn = this.shadow.getElementById('chatifyLightboxClose');
    const lightbox = this.shadow.getElementById('chatifyImageLightbox');

    imageBtn?.addEventListener('click', () => {
      imageInput?.click();
    });

    imageInput?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.handleSelectImage(file);
    });

    previewRemoveBtn?.addEventListener('click', () => {
      this.clearPendingAttachment();
    });

    emojiBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleEmojiPicker();
    });

    this.renderEmojiGrid();

    this.shadow.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (!target.closest('#chatifyEmojiPicker') && !target.closest('#chatifyEmojiBtn')) {
        this.closeEmojiPicker();
      }
    });

    textarea?.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            this.handleSelectImage(file);
            break;
          }
        }
      }
    });

    lightboxCloseBtn?.addEventListener('click', () => this.closeLightbox());
    lightbox?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'chatifyImageLightbox') {
        this.closeLightbox();
      }
    });

    sendBtn?.addEventListener('click', () => this.handleSendMessage());

    textarea?.addEventListener('input', () => {
      this.adjustTextareaHeight();
    });

    textarea?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSendMessage();
      } else if (e.key === 'Enter' && e.shiftKey) {
        // Shift+Enter adds a new line; trigger auto-grow on next tick
        setTimeout(() => this.adjustTextareaHeight(), 0);
      }
    });

    this.renderAvatarsStack(this.workspaceAgents);
    this.updatePresenceAndTexts();
    if (!this.presenceInterval) {
      this.presenceInterval = setInterval(() => {
        this.updatePresenceAndTexts();
      }, 60000);
    }
  }

  private handleSelectImage(file: File) {
    // Large camera photos are fine: they are shrunk on the device before
    // upload. This only stops files no phone photo comes close to.
    if (file.size > 40 * 1024 * 1024) {
      alert('This picture is too large. Please choose a smaller one.');
      return;
    }
    // Accepts HEIC and photos that arrive with no MIME type (some Android galleries).
    if (!looksLikeImage(file)) {
      alert('Please select a picture (JPEG, PNG, HEIC, WEBP or GIF).');
      return;
    }
    if (this.pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(this.pendingAttachment.previewUrl);
    }
    const previewUrl = URL.createObjectURL(file);
    this.pendingAttachment = { file, previewUrl };

    const previewContainer = this.shadow?.getElementById('chatifyAttachmentPreview');
    const previewImg = this.shadow?.getElementById('chatifyPreviewImg') as HTMLImageElement | null;
    const previewName = this.shadow?.getElementById('chatifyPreviewName');
    const previewSize = this.shadow?.getElementById('chatifyPreviewSize');

    if (previewContainer && previewImg) {
      previewImg.src = previewUrl;
      if (previewName) previewName.textContent = file.name;
      if (previewSize) previewSize.textContent = `${(file.size / 1024).toFixed(0)} KB · Ready to send`;
      previewContainer.style.display = 'flex';
    }
  }

  private clearPendingAttachment() {
    if (this.pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(this.pendingAttachment.previewUrl);
    }
    this.pendingAttachment = null;
    const previewContainer = this.shadow?.getElementById('chatifyAttachmentPreview');
    if (previewContainer) previewContainer.style.display = 'none';
    const input = this.shadow?.getElementById('chatifyImageInput') as HTMLInputElement | null;
    if (input) input.value = '';
  }

  private toggleEmojiPicker() {
    const picker = this.shadow?.getElementById('chatifyEmojiPicker');
    if (!picker) return;
    const isVisible = picker.style.display === 'block';
    picker.style.display = isVisible ? 'none' : 'block';
  }

  private closeEmojiPicker() {
    const picker = this.shadow?.getElementById('chatifyEmojiPicker');
    if (picker) picker.style.display = 'none';
  }

  private renderEmojiGrid() {
    const grid = this.shadow?.getElementById('chatifyEmojiGrid');
    const categoriesContainer = this.shadow?.getElementById('chatifyEmojiCategories');
    if (!grid) return;

    if (categoriesContainer && categoriesContainer.children.length === 0) {
      categoriesContainer.innerHTML = '';
      EMOJI_CATEGORIES.forEach((cat) => {
        const catBtn = document.createElement('button');
        catBtn.type = 'button';
        catBtn.className = `chatify-emoji-cat-btn ${cat.id === this.activeEmojiCategory ? 'active' : ''}`;
        catBtn.textContent = cat.icon;
        catBtn.title = cat.name;
        catBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.activeEmojiCategory = cat.id;
          this.shadow?.querySelectorAll('.chatify-emoji-cat-btn').forEach((b) => b.classList.remove('active'));
          catBtn.classList.add('active');
          const searchInput = this.shadow?.getElementById('chatifyEmojiSearch') as HTMLInputElement | null;
          if (searchInput) searchInput.value = '';
          this.emojiSearchQuery = '';
          this.renderEmojiGrid();
        });
        categoriesContainer.appendChild(catBtn);
      });

      const searchInput = this.shadow?.getElementById('chatifyEmojiSearch') as HTMLInputElement | null;
      searchInput?.addEventListener('input', (e) => {
        this.emojiSearchQuery = (e.target as HTMLInputElement).value.toLowerCase().trim();
        this.renderEmojiGrid();
      });
    }

    grid.innerHTML = '';

    let listToRender: string[] = [];
    if (this.emojiSearchQuery) {
      listToRender = ALL_EMOJIS;
    } else {
      const currentCat = EMOJI_CATEGORIES.find((c) => c.id === this.activeEmojiCategory);
      listToRender = currentCat ? currentCat.emojis : EMOJI_CATEGORIES[0].emojis;
    }

    listToRender.forEach((em) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chatify-emoji-btn';
      btn.textContent = em;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.insertEmoji(em);
      });
      grid.appendChild(btn);
    });
  }

  private adjustTextareaHeight() {
    const textarea = this.shadow?.getElementById('chatifyTextarea') as HTMLTextAreaElement | null;
    if (!textarea) return;

    // Reset height temporarily so scrollHeight reflects true content size
    textarea.style.height = 'auto';

    const computed = window.getComputedStyle(textarea);
    const lh = parseFloat(computed.lineHeight) || 19.6;
    const pt = parseFloat(computed.paddingTop) || 11;
    const pb = parseFloat(computed.paddingBottom) || 11;
    const bt = parseFloat(computed.borderTopWidth) || 1;
    const bb = parseFloat(computed.borderBottomWidth) || 1;
    const offset = pt + pb + bt + bb;

    const minH = Math.round(lh * 1 + offset);
    const maxH = Math.round(lh * 5 + offset);

    const scrollH = textarea.scrollHeight;

    if (scrollH > maxH) {
      textarea.style.height = `${maxH}px`;
      textarea.style.overflowY = 'auto';
    } else {
      const targetH = Math.max(minH, scrollH);
      textarea.style.height = `${targetH}px`;
      textarea.style.overflowY = 'hidden';
    }
  }

  private insertEmoji(emoji: string) {
    const textarea = this.shadow?.getElementById('chatifyTextarea') as HTMLTextAreaElement | null;
    if (!textarea) return;
    const start = textarea.selectionStart || textarea.value.length;
    const end = textarea.selectionEnd || textarea.value.length;
    const val = textarea.value;
    textarea.value = val.substring(0, start) + emoji + val.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
    this.adjustTextareaHeight();
    textarea.focus();
    this.closeEmojiPicker();
  }

  private openLightbox(url: string) {
    const lightbox = this.shadow?.getElementById('chatifyImageLightbox');
    const img = this.shadow?.getElementById('chatifyLightboxImg') as HTMLImageElement | null;
    const link = this.shadow?.getElementById('chatifyLightboxLink') as HTMLAnchorElement | null;
    if (lightbox && img) {
      img.src = url;
      if (link) link.href = url;
      lightbox.style.display = 'flex';
    }
  }

  private closeLightbox() {
    const lightbox = this.shadow?.getElementById('chatifyImageLightbox');
    if (lightbox) {
      lightbox.style.display = 'none';
    }
  }

  public switchTab(tab: 'home' | 'messages' | 'help') {
    if (tab === 'help' && (this.config.showHelpTab === false || this.faqs.length === 0)) {
      tab = 'home';
    }
    // Compact and Live chat have no home screen: the conversation is home.
    if (tab === 'home' && isChatFirstDesign(this.config.widgetDesign)) {
      tab = 'messages';
    }
    this.activeTab = tab;

    const tabHome = this.shadow?.getElementById('tabHome');
    const tabMessages = this.shadow?.getElementById('tabMessages');
    const tabHelp = this.shadow?.getElementById('tabHelp');

    if (tabHome) tabHome.style.display = tab === 'home' ? 'flex' : 'none';
    if (tabMessages) tabMessages.style.display = tab === 'messages' ? 'flex' : 'none';
    if (tabHelp) tabHelp.style.display = tab === 'help' ? 'flex' : 'none';

    this.shadow?.querySelectorAll('.chatify-nav-item').forEach((nav) => {
      nav.classList.toggle('active', nav.getAttribute('data-tab') === tab);
    });

    const storageKeySuffix = this.config.workspaceId ? `_${this.config.workspaceId.slice(0, 8)}` : '';
    try {
      sessionStorage.setItem(`chatify_widget_tab${storageKeySuffix}`, tab);
    } catch {}

    if (tab === 'messages') {
      this.unreadCount = 0;
      this.updateUnreadBadge();
      this.markMessagesAsRead();
      // Catch up now and poll faster while the visitor is watching.
      if (this.conversationId) this.pollSoon();
      this.scrollToBottom(false);
      this.adjustTextareaHeight();
      setTimeout(() => {
        (this.shadow?.getElementById('chatifyTextarea') as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
      }, 100);
    }
  }

  public getReplyTimeText(): string {
    if (this.config.subtitle && this.config.subtitle.trim()) {
      return this.config.subtitle.trim();
    }
    return 'Typically replies in under 5 minutes';
  }

  private checkIsOnline(): boolean {
    const hasOnlineAgent = this.workspaceAgents.some((a) => a.status === 'online');
    const bh = this.config.businessHours;
    const isBusinessHoursEnforced = Boolean(bh && bh.enabled);
    const isBusinessHoursOpen = isBusinessHoursEnforced && !this.isOutsideBusinessHours(bh);
    return Boolean(hasOnlineAgent || isBusinessHoursOpen);
  }

  private updatePresenceAndTexts() {
    const isOnline = this.checkIsOnline();
    const replyTimeText = this.getReplyTimeText();
    const offlineText = "We're away, leave a message and we'll reply by email";

    // 1. Home Card Status Pill (#homeStatusPill)
    const statusPill = this.shadow?.getElementById('homeStatusPill');
    if (statusPill) {
      statusPill.title = isOnline ? 'Online' : offlineText;
      const html = isOnline
        ? `<span class="chatify-pulse-dot online"></span> <span>${this.escapeHTML(replyTimeText)}</span>`
        : `<span class="chatify-pulse-dot away"></span> <span>${this.escapeHTML(offlineText)}</span>`;
      // Runs every minute; rewriting an unchanged pill restarted its animation.
      if (statusPill.dataset.rendered !== html) {
        statusPill.innerHTML = html;
        statusPill.dataset.rendered = html;
      }
    }

    // 2. Home Card Subtitle (#homeCardSub)
    const cardSub = this.shadow?.getElementById('homeCardSub');
    if (cardSub) {
      cardSub.textContent = isOnline
        ? 'Ask us anything, or share your feedback.'
        : offlineText;
    }

    // 3. Home CTA Button Text
    const btnCta = this.shadow?.querySelector('#btnGoToMessages span');
    if (btnCta) {
      btnCta.textContent = isOnline ? 'Send us a message' : 'Leave us a message';
    }

    // 4. Chat Header Subtitle (#chatifyHeaderSubtitle)
    const chatHeaderSub = this.shadow?.getElementById('chatifyHeaderSubtitle');
    if (chatHeaderSub) {
      chatHeaderSub.textContent = isOnline ? replyTimeText : offlineText;
    }

    // 5. Chat Header Avatar Dot (.chatify-online-dot inside #chatifyHeaderAvatar)
    const headerOnlineDot = this.shadow?.querySelector('#chatifyHeaderAvatar .chatify-online-dot') as HTMLElement | null;
    if (headerOnlineDot) {
      headerOnlineDot.style.display = isOnline ? 'block' : 'none';
    }

    // 6. Launcher status dot (shown by the Live chat design)
    this.shadow?.getElementById('chatifyLauncherStatus')?.classList.toggle('is-online', isOnline);

    // 7. Popup Status Dot (.chatify-popup-status-dot inside #chatifyPopupCard)
    const popupStatusDot = this.shadow?.querySelector('.chatify-popup-status-dot') as HTMLElement | null;
    if (popupStatusDot) {
      popupStatusDot.style.display = isOnline ? 'block' : 'none';
    }
  }

  private renderAvatarsStack(agents: Array<{ id: string; name?: string; avatar_url?: string | null }>) {
    const container = this.shadow?.getElementById('homeAvatarsStack');
    if (!container) return;

    container.innerHTML = '';

    const gradients = [
      'linear-gradient(135deg, #3b82f6, #1d4ed8)',
      'linear-gradient(135deg, #8b5cf6, #6d28d9)',
      'linear-gradient(135deg, #10b981, #047857)',
      'linear-gradient(135deg, #f59e0b, #d97706)',
      'linear-gradient(135deg, #ec4899, #be185d)',
    ];

    const displayAgents = agents && agents.length > 0 ? agents.slice(0, 3) : [];

    if (displayAgents.length === 0) {
      const fallbackDiv = document.createElement('div');
      fallbackDiv.className = 'chatify-mini-avatar';
      fallbackDiv.style.background = gradients[0];
      const safeLogo = this.safeUrl(this.config.logoUrl, true);
      if (safeLogo) {
        fallbackDiv.innerHTML = `<img src="${safeLogo}" alt="Support" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" />`;
      } else {
        const initials = this.getSenderInitials(this.config.businessName || this.config.title || 'Support');
        fallbackDiv.textContent = initials;
      }
      container.appendChild(fallbackDiv);
      this.mirrorHeaderAvatars(container);
      return;
    }

    displayAgents.forEach((agent, idx) => {
      const avatarDiv = document.createElement('div');
      avatarDiv.className = 'chatify-mini-avatar';
      avatarDiv.style.background = gradients[idx % gradients.length];
      avatarDiv.title = agent.name || 'Agent';

      const safeAvatar = this.safeUrl(agent.avatar_url, true);
      if (safeAvatar) {
        const img = document.createElement('img');
        img.src = safeAvatar;
        img.alt = agent.name || 'Agent';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;';
        img.onerror = () => {
          avatarDiv.innerHTML = '';
          avatarDiv.textContent = this.getSenderInitials(agent.name || 'Agent');
        };
        avatarDiv.appendChild(img);
      } else {
        avatarDiv.textContent = this.getSenderInitials(agent.name || 'Agent');
      }

      container.appendChild(avatarDiv);
    });
    this.mirrorHeaderAvatars(container);
  }

  /** The Live chat design shows the same team faces in the chat header. */
  private mirrorHeaderAvatars(source: HTMLElement) {
    const header = this.shadow?.getElementById('chatHeaderAvatars');
    if (!header) return;
    header.innerHTML = '';
    source.childNodes.forEach((n) => header.appendChild(n.cloneNode(true)));
  }

  /**
   * Team presence for the header. Agent rows are not readable with the public
   * key, so it is fetched from fn_widget_agents (names, avatars, status; no
   * emails) every minute while the page is visible.
   */
  private subscribeToAgentsRealtime() {
    if (!this.config.workspaceId || this.agentsPollTimer) return;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      const { data, error } = await this.supabase.rpc('fn_widget_agents', { p_workspace_id: this.config.workspaceId });
      if (error) {
        if (ZentryWidget.isMissingFunction(error) && this.agentsPollTimer) {
          clearInterval(this.agentsPollTimer);
          this.subscribeToLegacyAgentsRealtime();
        }
        return;
      }
      if (Array.isArray(data)) {
        this.workspaceAgents = data;
        this.renderAvatarsStack(this.workspaceAgents);
        this.updatePresenceAndTexts();
      }
    };
    this.agentsPollTimer = setInterval(() => {
      refresh().catch(() => {});
    }, 60000);
  }

  /** A project without the session migration: agent rows over realtime, as before. */
  private subscribeToLegacyAgentsRealtime() {
    if (!this.config.workspaceId) return;

    this.supabase
      .channel(`chatify-agents-${this.config.workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agents',
          filter: `workspace_id=eq.${this.config.workspaceId}`,
        },
        async () => {
          try {
            const { data } = await this.supabase
              .from('agents')
              .select('id, name, avatar_url, status')
              .eq('workspace_id', this.config.workspaceId);
            if (data) {
              this.workspaceAgents = data;
              this.renderAvatarsStack(this.workspaceAgents);
              this.updatePresenceAndTexts();
            }
          } catch (e) {
            console.warn('[Zen-try] Error updating agent presence:', e);
          }
        }
      )
      .subscribe();
  }

  private updateThemeAndTexts() {
    const styleEl = this.shadow?.getElementById('chatify-theme-style');
    if (styleEl) {
      styleEl.textContent = this.generateCSS();
    }
    const titleEl = this.shadow?.getElementById('chatifyHeaderTitle');
    if (titleEl) titleEl.textContent = this.config.title;
    const subEl = this.shadow?.getElementById('chatifyHeaderSubtitle');
    if (subEl) subEl.textContent = this.config.subtitle;

    const popupTitleEl = this.shadow?.getElementById('chatifyPopupTitle');
    if (popupTitleEl) {
      const popupTitle = this.config.businessName || this.config.title || 'Trader Care Desk';
      popupTitleEl.textContent = popupTitle;
      const avatarEl = this.shadow?.getElementById('chatifyPopupAvatar');
      if (avatarEl) {
        const safeLogo = this.safeUrl(this.config.logoUrl, true);
        if (safeLogo) {
          const safeInitials = this.escapeHTML(this.getSenderInitials(popupTitle).replace(/['\\<>\r\n]/g, '').slice(0, 10));
          avatarEl.innerHTML = `<img src="${safeLogo}" alt="Logo" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.parentElement.textContent='${safeInitials}'" />`;
        } else if (!avatarEl.querySelector('img')) {
          avatarEl.textContent = this.getSenderInitials(popupTitle);
        }
      }
    }

    // Update Launcher Icon with custom logo or selected preset icon
    const openIcon = this.shadow?.getElementById('chatifyIconOpen');
    if (openIcon) {
      openIcon.innerHTML = this.renderLauncherIconHTML();
    }

    // Update Header Avatar in Messages Tab
    const headerAvatar = this.shadow?.getElementById('chatifyHeaderAvatar');
    if (headerAvatar) {
      headerAvatar.innerHTML = this.renderBrandAvatarHTML(true);
    }

    const brandAvatar = this.shadow?.getElementById('homeBrandAvatar');
    if (brandAvatar) {
      brandAvatar.innerHTML = this.renderBrandAvatarHTML(false);
    }

    const openConvAvatar = this.shadow?.getElementById('openConvAvatar');
    if (openConvAvatar) {
      openConvAvatar.innerHTML = this.renderBrandAvatarHTML(false);
    }

    const homeGreeting = this.shadow?.getElementById('homeGreetingTitle');
    if (homeGreeting && this.config.title) {
      // Strip a trailing emoji as well as the boilerplate: workspace titles
      // often already end in a wave, which produced "Hello from Chatify 👋 👋".
      const cleanTitle = this.config.title
        .replace(/^Welcome to\s+/i, '')
        .replace(/Support!?/i, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]+\s*$/u, '')
        .trim();
      homeGreeting.textContent = cleanTitle ? `Hello from ${cleanTitle} 👋` : 'Hello there 👋';
    }

    // Carry the workspace's own greeting through to the Home tab
    const homeSub = this.shadow?.getElementById('homeGreetingSub');
    if (homeSub && this.config.subtitle) homeSub.textContent = this.config.subtitle;

    // Apply custom Help Tab label, header title, and search placeholder
    const navHelpText = this.shadow?.querySelector('#navHelp span');
    if (navHelpText && this.config.helpTabLabel) {
      navHelpText.textContent = this.config.helpTabLabel;
    }

    const helpTabTitle = this.shadow?.querySelector('#tabHelp .chatify-header-text h3');
    if (helpTabTitle && this.config.helpTabLabel) {
      helpTabTitle.textContent = this.config.helpTabLabel;
    }

    const homeHelpCardTitle = this.shadow?.querySelector('#cardHelpSearch .chatify-section-title');
    if (homeHelpCardTitle && this.config.helpTabLabel) {
      homeHelpCardTitle.textContent = this.config.helpTabLabel;
    }

    const homeSearchSpan = this.shadow?.querySelector('#homeSearchTrigger span');
    if (homeSearchSpan && this.config.helpTabLabel) {
      homeSearchSpan.textContent = `🔍 Search for ${this.config.helpTabLabel.toLowerCase()} articles...`;
    }

    // Toggle Help Tab & Home Card Visibility based on showHelpTab setting and whether published articles exist
    const navHelpBtn = this.shadow?.getElementById('navHelp') as HTMLElement | null;
    const cardHelpSearch = this.shadow?.getElementById('cardHelpSearch') as HTMLElement | null;
    const tabHelp = this.shadow?.getElementById('tabHelp') as HTMLElement | null;
    const hasPublishedArticles = this.faqs.length > 0;
    if (this.config.showHelpTab === false || !hasPublishedArticles) {
      if (navHelpBtn) navHelpBtn.style.display = 'none';
      if (cardHelpSearch) cardHelpSearch.style.display = 'none';
      if (tabHelp) tabHelp.style.display = 'none';
      if (this.activeTab === 'help') {
        this.switchTab('home');
      }
    } else {
      if (navHelpBtn) navHelpBtn.style.display = 'flex';
      if (cardHelpSearch) cardHelpSearch.style.display = 'block';
    }

    this.renderAvatarsStack(this.workspaceAgents);
    this.updatePresenceAndTexts();
  }

  /* ---------------------------------------------------------------- theme */

  /** Parses #rgb / #rrggbb into an [r,g,b] triple. Falls back to the default blue. */
  private rgb(hex: string): [number, number, number] {
    let h = (hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '2e5bff';
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }

  /** Relative luminance, used to decide black-vs-white text on the brand colour. */
  private luminance(hex: string): number {
    const [r, g, b] = this.rgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** Mixes the brand colour toward black (amount < 0) or white (amount > 0). */
  private shade(hex: string, amount: number): string {
    const [r, g, b] = this.rgb(hex);
    const target = amount > 0 ? 255 : 0;
    const t = Math.abs(amount);
    const mix = (c: number) => Math.round(c + (target - c) * t);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }

  private alpha(hex: string, a: number): string {
    const [r, g, b] = this.rgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  private generateCSS(): string {
    const brand = this.config.primaryColor || '#2e5bff';
    // White text on anything but a very light brand colour.
    const onBrand = this.luminance(brand) > 0.62 ? '#0b0b0f' : '#ffffff';
    const brandDeep = this.shade(brand, -0.34);
    const left = this.config.position === 'bottom-left';
    const offsetBottom = typeof this.config.offsetBottom === 'number' ? this.config.offsetBottom : 20;
    const offsetSide = typeof this.config.offsetSide === 'number' ? this.config.offsetSide : 20;
    const zIndex = typeof this.config.zIndex === 'number' ? this.config.zIndex : 2147483000;
    const popupBottom = offsetBottom + 66;
    const windowBottom = offsetBottom + 68;

    return `
      :host {
        --w-brand: ${brand};
        --w-brand-deep: ${brandDeep};
        /* Second colour for gradients (Settings → Chat widget); a darker brand by default. */
        --w-brand-2: ${this.config.secondaryColor || brandDeep};
        --w-on-brand: ${onBrand};
        --w-brand-a08: ${this.alpha(brand, 0.08)};
        --w-brand-a16: ${this.alpha(brand, 0.16)};
        --w-brand-a28: ${this.alpha(brand, 0.28)};

        --w-surface: #ffffff;
        --w-surface-2: #f7f7f5;
        --w-surface-3: #efefec;
        --w-canvas: #fbfbf9;

        --w-ink: #0b0b0f;
        --w-ink-2: #4f5057;
        --w-ink-3: #64656c;

        --w-line: #e7e7e3;
        --w-line-2: #d6d6d1;

        --w-success: #0b7a5c;

        /* Glass window (Zentry design system: the widget is one of the three
           places glass is allowed). Kept mostly opaque so text contrast holds
           over any host page. */
        --w-glass: rgba(255, 255, 255, 0.86);
        --w-glass-line: rgba(11, 11, 15, 0.08);
        --w-focus: #2850e8;

        --w-r-sm: 10px;
        --w-r-md: 14px;
        --w-r-lg: 18px;
        --w-r-xl: 22px;

        --w-shadow-sm: 0 1px 3px rgba(11,11,15,.07), 0 1px 2px rgba(11,11,15,.04);
        --w-shadow-md: 0 6px 18px rgba(11,11,15,.09), 0 2px 6px rgba(11,11,15,.05);
        --w-shadow-xl: 0 32px 68px rgba(11,11,15,.18), 0 12px 26px rgba(11,11,15,.10);

        --w-ease: cubic-bezier(.22,.61,.36,1);
        --w-ease-out: cubic-bezier(.16,1,.3,1);
        --w-spring: cubic-bezier(.34,1.4,.64,1);

        color-scheme: light;
      }

      ${this.darkModeCSS()}

      /* Visible keyboard focus everywhere inside the widget. */
      :focus-visible {
        outline: 2px solid var(--w-focus);
        outline-offset: 2px;
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      button { font: inherit; cursor: pointer; }

      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb {
        background: var(--w-line-2);
        border-radius: 999px;
        border: 2px solid transparent;
        background-clip: content-box;
      }

      /* ── Launcher ─────────────────────────────────────────────────── */

      .chatify-launcher {
        position: fixed;
        ${left ? `left: ${offsetSide}px;` : `right: ${offsetSide}px;`}
        bottom: ${offsetBottom}px;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        border: none;
        background: var(--w-brand);
        color: var(--w-on-brand);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 8px 24px var(--w-brand-a28), 0 2px 8px rgba(11,11,15,.16);
        z-index: ${zIndex};
        transition: transform .28s var(--w-spring), box-shadow .2s var(--w-ease);
      }

      .chatify-launcher:hover {
        transform: scale(1.07) translateY(-1px);
        box-shadow: 0 16px 38px var(--w-brand-a28), 0 6px 14px rgba(11,11,15,.22);
      }

      .chatify-launcher:active { transform: scale(.95); }

      .chatify-launcher.is-loading {
        background: #e7e9ef;
        box-shadow: 0 6px 18px rgba(11,11,15,.10);
        overflow: hidden;
        animation: w-launcher-in .3s var(--w-ease) both;
      }
      .chatify-launcher.is-loading > * { opacity: 0; }
      .chatify-launcher.is-loading::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: linear-gradient(100deg, transparent 20%, rgba(255,255,255,.75) 50%, transparent 80%);
        transform: translateX(-100%);
        animation: w-launcher-shimmer 1.4s infinite;
      }
      .chatify-launcher-icon,
      .chatify-launcher svg { transition: opacity .2s var(--w-ease); }
      @keyframes w-launcher-shimmer { to { transform: translateX(100%); } }
      @keyframes w-launcher-in { from { opacity: 0; transform: scale(.85); } to { opacity: 1; transform: none; } }

      /* An expanding ring, drawn only while messages are waiting. A launcher
         that pulses permanently is just noise the visitor learns to ignore. */
      .chatify-launcher::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid var(--w-brand);
        opacity: 0;
        pointer-events: none;
      }

      .chatify-launcher.has-unread::after {
        animation: w-halo 2.4s var(--w-ease-out) infinite;
      }

      .chatify-launcher-icon {
        width: 36px;
        height: 36px;
        object-fit: contain;
        display: block;
        pointer-events: none;
        transition: transform .25s var(--w-ease), opacity .18s var(--w-ease);
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.22));
      }

      /* Launcher label (Compact) and online dot (Live chat): hidden unless a design shows them. */
      .chatify-launcher-label, .chatify-launcher-status { display: none; }

      /* Header team photos: shown by the Live chat design only. */
      .chatify-header .chatify-header-avatars { display: none; }

      /* A preset icon: crisp at 28px, no shadow (it blurred the edges). */
      .chatify-launcher-icon.chatify-preset-icon {
        width: 28px;
        height: 28px;
        filter: none;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .chatify-preset-icon svg { display: block; width: 28px; height: 28px; }

      /* A workspace logo fills the whole launcher on white, so any logo
         (square, round, transparent) reads as a finished button. */
      .chatify-launcher-icon.chatify-custom-logo {
        width: 100%;
        height: 100%;
        border-radius: inherit;
        object-fit: cover;
        background: #ffffff;
        padding: 0;
        filter: none;
      }
      /* White behind the logo, so the close cross switches to dark ink. */
      .chatify-launcher:has(.chatify-custom-logo) { background: #ffffff; color: #0b0b0f; }
      .chatify-launcher:has(.chatify-custom-logo) .chatify-badge { z-index: 1; }

      .chatify-launcher:hover .chatify-launcher-icon {
        transform: scale(1.1);
      }

      .chatify-launcher svg {
        width: 25px;
        height: 25px;
        fill: currentColor;
        transition: transform .25s var(--w-ease), opacity .18s var(--w-ease);
      }

      .chatify-badge {
        position: absolute;
        top: -2px;
        ${left ? 'left: -2px;' : 'right: -2px;'}
        min-width: 20px;
        height: 20px;
        padding: 0 5px;
        border-radius: 999px;
        background: #e11d48;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        display: none;
        align-items: center;
        justify-content: center;
        border: 2px solid var(--w-surface);
        animation: w-pop .28s var(--w-spring);
      }

      /* ── Unread Message Popup (Intercom-style Preview) ─────────────── */

      .chatify-message-popup {
        position: fixed;
        ${left ? `left: ${offsetSide}px;` : `right: ${offsetSide}px;`}
        bottom: ${popupBottom}px;
        width: 350px;
        max-width: calc(100vw - 40px);
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: ${zIndex - 5};
        pointer-events: auto;
        animation: chatifyPopupSlideIn 0.32s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }

      @keyframes chatifyPopupSlideIn {
        0% {
          opacity: 0;
          transform: translateY(16px) scale(0.96);
        }
        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      .chatify-message-popup.closing {
        animation: chatifyPopupSlideOut 0.2s cubic-bezier(0.4, 0, 1, 1) forwards;
      }

      @keyframes chatifyPopupSlideOut {
        0% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        100% {
          opacity: 0;
          transform: translateY(12px) scale(0.96);
        }
      }

      /* Card 1: Top Message Card */
      .chatify-popup-card {
        background: #ffffff;
        border-radius: 18px;
        padding: 14px 16px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
        display: flex;
        align-items: flex-start;
        gap: 12px;
        cursor: pointer;
        transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        border: 1px solid rgba(0, 0, 0, 0.05);
        color: #111827;
      }

      .chatify-popup-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.16), 0 4px 12px rgba(0, 0, 0, 0.08);
      }

      .chatify-popup-avatar-wrap {
        position: relative;
        width: 44px;
        height: 44px;
        flex-shrink: 0;
      }

      .chatify-popup-avatar {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: #5c5be5;
        color: #ffffff;
        font-weight: 700;
        font-size: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        letter-spacing: 0.5px;
        box-shadow: 0 2px 8px rgba(92, 91, 229, 0.32);
        overflow: hidden;
      }

      .chatify-popup-avatar img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .chatify-popup-status-dot {
        position: absolute;
        bottom: 0px;
        right: 0px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #22c55e;
        border: 2.5px solid #ffffff;
      }

      .chatify-popup-content {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }

      .chatify-popup-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 3px;
      }

      .chatify-popup-title {
        font-size: 13.5px;
        font-weight: 600;
        color: #475569;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .chatify-popup-close {
        background: transparent;
        border: none;
        color: #9ca3af;
        cursor: pointer;
        padding: 2px;
        margin-right: -4px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        transition: color 0.15s, background-color 0.15s;
      }

      .chatify-popup-close:hover {
        color: #374151;
        background-color: #f1f5f9;
      }

      .chatify-popup-message {
        font-size: 15px;
        font-weight: 500;
        color: #111827;
        line-height: 1.38;
        word-break: break-word;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      /* Card 2: Bottom Reply Bar */
      .chatify-popup-reply-bar {
        background: #ffffff;
        border-radius: 9999px;
        padding: 5px 6px 5px 18px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.10), 0 2px 6px rgba(0, 0, 0, 0.05);
        border: 1px solid rgba(0, 0, 0, 0.05);
        display: flex;
        align-items: center;
        gap: 8px;
        transition: box-shadow 0.2s, border-color 0.2s;
      }

      .chatify-popup-reply-bar:focus-within {
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14), 0 0 0 2px var(--w-brand, #5c5be5);
        border-color: transparent;
      }

      .chatify-popup-input {
        flex: 1;
        border: none;
        outline: none;
        background: transparent;
        font-size: 14px;
        color: #111827;
        min-width: 0;
        padding: 7px 0;
        font-family: inherit;
      }

      .chatify-popup-input::placeholder {
        color: #9ca3af;
      }

      .chatify-popup-send {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: none;
        background: #e2e8f0;
        color: #64748b;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        transition: background-color 0.2s, color 0.2s, transform 0.15s;
      }

      .chatify-popup-send.active {
        background: var(--w-brand, #5c5be5);
        color: #ffffff;
      }

      .chatify-popup-send:hover {
        transform: scale(1.05);
      }

      .chatify-popup-send:active {
        transform: scale(0.95);
      }

      /* ── Window ───────────────────────────────────────────────────── */

      .chatify-window {
        position: fixed;
        ${left ? `left: ${offsetSide}px;` : `right: ${offsetSide}px;`}
        bottom: ${windowBottom}px;
        width: 396px;
        max-width: calc(100vw - 40px);
        height: 640px;
        max-height: calc(100vh - 120px);
        background: var(--w-glass);
        backdrop-filter: saturate(160%) blur(18px);
        -webkit-backdrop-filter: saturate(160%) blur(18px);
        border: 1px solid var(--w-glass-line);
        border-radius: var(--w-r-xl);
        box-shadow: var(--w-shadow-xl);
        display: none;
        flex-direction: column;
        overflow: hidden;
        z-index: ${zIndex};
        animation: w-window-in .34s var(--w-ease) both;
      }

      .chatify-avatar-initial {
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        text-transform: uppercase;
        border-radius: inherit;
        background: var(--w-brand);
        color: var(--w-on-brand);
        user-select: none;
      }

      .chatify-system-line {
        align-self: center;
        text-align: center;
        max-width: 88%;
        margin: 8px auto;
        padding: 8px 12px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--w-ink-2);
        background: var(--w-surface-2);
        border: 1px solid var(--w-line);
        border-radius: 12px;
      }

      .chatify-closed-notice {
        align-self: center;
        margin: 14px auto 6px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--w-ink-2);
        text-align: center;
      }

      .chatify-new-conversation-btn {
        align-self: center;
        margin: 10px auto 14px;
        padding: 10px 18px;
        border: none;
        border-radius: 999px;
        background: var(--w-brand);
        color: var(--w-on-brand);
        font-size: 13px;
        font-weight: 600;
      }

      /* ── Quick Reply Chips ──────────────────────────────────────────── */

      .chatify-quick-replies {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        padding: 2px 0 8px;
        max-width: 82%;
        /* Left-aligned like agent bubbles */
        margin-right: auto;
        animation: w-bubble-in .25s var(--w-ease-out) both;
      }

      .chatify-qr-btn {
        padding: 6px 13px;
        border: 1.5px solid var(--w-brand);
        border-radius: 999px;
        background: var(--w-surface);
        color: var(--w-brand);
        font-size: 12.5px;
        font-weight: 500;
        line-height: 1.4;
        cursor: pointer;
        white-space: nowrap;
        transition:
          background 0.14s ease,
          color 0.14s ease,
          transform 0.12s ease,
          box-shadow 0.14s ease;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
      }

      .chatify-qr-btn:hover {
        background: var(--w-brand);
        color: var(--w-on-brand);
        transform: translateY(-1px);
        box-shadow: 0 3px 8px var(--w-brand-a28);
      }

      .chatify-qr-btn:active {
        transform: translateY(0);
        opacity: 0.88;
      }

      .chatify-typing {
        display: inline-flex !important;
        align-items: center;
        gap: 4px;
        padding: 12px 14px !important;
      }

      .chatify-typing span {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--w-ink-3);
        animation: w-typing 1.2s infinite ease-in-out;
      }

      .chatify-typing span:nth-child(2) { animation-delay: .15s; }
      .chatify-typing span:nth-child(3) { animation-delay: .3s; }

      @keyframes w-typing {
        0%, 60%, 100% { transform: translateY(0); opacity: .4; }
        30% { transform: translateY(-4px); opacity: 1; }
      }

      .chatify-prev-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }

      .chatify-prev-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        width: 100%;
        padding: 10px 12px;
        text-align: left;
        background: var(--w-surface-2);
        border: 1px solid var(--w-line);
        border-radius: 12px;
        color: var(--w-ink);
      }

      .chatify-prev-item:hover { background: var(--w-surface-3); }
      .chatify-prev-text { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
      .chatify-prev-snippet { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chatify-prev-meta { font-size: 11.5px; color: var(--w-ink-3); }
      .chatify-prev-chevron { font-size: 18px; color: var(--w-ink-3); }

      @media (max-width: 480px) {
        .chatify-window {
          inset: 0 !important;
          left: 0 !important;
          right: 0 !important;
          top: var(--w-vv-top, 0px) !important;
          bottom: auto !important;
          width: 100vw !important;
          max-width: 100vw !important;
          height: 100% !important;
          height: var(--w-vvh, 100dvh) !important;
          max-height: var(--w-vvh, 100dvh) !important;
          border-radius: 0 !important;
          border: none !important;
          box-shadow: none !important;
          z-index: ${zIndex + 1} !important;
        }

        .chatify-launcher.widget-is-open {
          display: none !important;
        }

        .chatify-message-popup {
          left: 12px !important;
          right: 12px !important;
          width: auto !important;
          max-width: calc(100vw - 24px) !important;
          bottom: ${offsetBottom + 64}px !important;
        }

        /* 16px stops iOS from zooming the page when a field is focused. */
        .chatify-textarea,
        .chatify-input {
          font-size: 16px !important;
        }

        .chatify-messages,
        .chatify-body {
          overscroll-behavior: contain;
        }

        .chatify-close-btn,
        .chatify-icon-btn#homeCloseBtn {
          width: 44px !important;
          height: 44px !important;
          min-width: 44px !important;
          min-height: 44px !important;
          border-radius: 50% !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          cursor: pointer !important;
          touch-action: manipulation !important;
        }

        .chatify-close-btn {
          background: var(--w-surface-2) !important;
          color: var(--w-ink) !important;
          border: 1px solid var(--w-line-2) !important;
        }

        .chatify-icon-btn#homeCloseBtn {
          background: rgba(255, 255, 255, 0.25) !important;
          color: #ffffff !important;
          border: 1px solid rgba(255, 255, 255, 0.35) !important;
        }
      }

      .chatify-tab-pane {
        flex: 1;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        animation: w-fade .22s var(--w-ease);
      }

      /* ── Home tab ─────────────────────────────────────────────────── */

      .chatify-home-hero {
        position: relative;
        isolation: isolate;
        overflow: hidden;
        padding: 24px 22px 56px;
        background: linear-gradient(150deg, var(--w-brand) 0%, var(--w-brand-2) 100%);
        color: #ffffff;
        flex-shrink: 0;
      }

      /* Two offset colour pools that drift against each other. The movement is
         slow and low-contrast on purpose — it should read as depth, not as an
         animation demanding attention. */
      .chatify-home-hero::before {
        content: '';
        position: absolute;
        inset: -40%;
        z-index: -1;
        background:
          radial-gradient(38% 42% at 22% 26%, rgba(255, 255, 255, 0.30), transparent 62%),
          radial-gradient(34% 38% at 78% 12%, rgba(255, 255, 255, 0.18), transparent 60%),
          radial-gradient(44% 46% at 62% 88%, var(--w-brand-a28), transparent 64%);
        animation: w-aurora 22s var(--w-ease) infinite alternate;
      }

      /* A whisper of grain stops the gradient from banding on wide screens. */
      .chatify-home-hero::after {
        content: '';
        position: absolute;
        inset: 0;
        z-index: -1;
        opacity: 0.055;
        pointer-events: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
      }

      .chatify-brand-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 22px;
      }

      .chatify-home-avatar {
        width: 38px;
        height: 38px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.2);
        border: 1.5px solid rgba(255, 255, 255, 0.32);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 7px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }

      .chatify-home-avatar img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .chatify-icon-btn {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: rgba(255, 255, 255, 0.16);
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        transition: all .2s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .chatify-icon-btn:hover {
        background: rgba(255, 255, 255, 0.3);
        transform: scale(1.06);
      }

      .chatify-home-title {
        font-size: 27px;
        font-weight: 700;
        letter-spacing: -0.032em;
        line-height: 1.18;
        color: #ffffff;
        text-wrap: balance;
        text-shadow: 0 1px 12px rgba(0, 0, 0, 0.14);
      }

      .chatify-home-sub {
        margin-top: 6px;
        font-size: 14px;
        line-height: 1.45;
        color: rgba(255, 255, 255, 0.9);
        font-weight: 400;
      }

      /* Each block rises a beat after the one above it. The whole sequence is
         under a third of a second, so it reads as the panel settling rather
         than as something the visitor has to wait for. */
      .chatify-home-content > * {
        animation: w-rise .34s var(--w-ease-out) both;
      }
      .chatify-home-content > *:nth-child(1) { animation-delay: .04s; }
      .chatify-home-content > *:nth-child(2) { animation-delay: .10s; }
      .chatify-home-content > *:nth-child(3) { animation-delay: .16s; }
      .chatify-home-content > *:nth-child(4) { animation-delay: .22s; }

      .chatify-home-content {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        margin-top: -30px;
        padding: 16px;
        background: var(--w-canvas);
        border-radius: 20px 20px 0 0;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .chatify-card {
        background: var(--w-surface);
        border: 1px solid rgba(0, 0, 0, 0.07);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 4px 18px -2px rgba(15, 23, 42, 0.06), 0 10px 28px -4px rgba(15, 23, 42, 0.08);
      }

      .chatify-card-action {
        transition: box-shadow .24s var(--w-ease), transform .24s var(--w-ease);
      }

      .chatify-card-action:hover {
        box-shadow: 0 8px 28px -2px rgba(15, 23, 42, 0.10), 0 18px 42px -6px rgba(15, 23, 42, 0.14);
        transform: translateY(-2px);
        border-color: var(--w-brand-a28);
      }

      .chatify-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }

      .chatify-avatars-stack {
        display: flex;
        align-items: center;
      }

      .chatify-mini-avatar {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        color: #ffffff;
        font-size: 11px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px solid var(--w-surface);
        margin-left: -8px;
        box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
      }

      .chatify-mini-avatar:first-child {
        margin-left: 0;
      }

      .chatify-status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 24px;
        padding: 0 10px;
        border-radius: 999px;
        background: var(--w-surface-2);
        border: 1px solid var(--w-line);
        font-size: 11.5px;
        font-weight: 600;
        color: var(--w-ink-2);
        max-width: calc(100% - 70px);
      }

      .chatify-status-pill span:not(.chatify-pulse-dot) {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .chatify-pulse-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        display: inline-block;
      }

      .chatify-pulse-dot.online {
        background: #10b981;
        box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.25);
      }

      .chatify-pulse-dot.away {
        background: #f59e0b;
        box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.25);
      }

      .chatify-card-title {
        font-size: 17px;
        font-weight: 700;
        color: var(--w-ink);
        letter-spacing: -0.015em;
        margin-bottom: 4px;
      }

      .chatify-card-sub {
        font-size: 13px;
        color: var(--w-ink-2);
        line-height: 1.45;
        margin-bottom: 16px;
      }

      .chatify-primary-cta {
        width: 100%;
        height: 44px;
        border-radius: 12px;
        background: var(--w-brand);
        color: #ffffff;
        font-weight: 600;
        font-size: 14px;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        box-shadow: 0 4px 14px var(--w-brand-a28);
        transition: all .2s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .chatify-primary-cta:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px var(--w-brand-a28);
        filter: brightness(1.04);
      }

      .chatify-primary-cta:active {
        transform: translateY(0);
        filter: brightness(0.98);
      }

      .chatify-home-unread-pill {
        display: none;
        align-items: center;
        gap: 5px;
        height: 24px;
        padding: 0 10px;
        border-radius: 999px;
        background: #ffe4e6;
        color: #e11d48;
        border: 1px solid #fecdd3;
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
        animation: w-pop .28s var(--w-spring);
      }

      .chatify-cta-badge {
        min-width: 19px;
        height: 19px;
        line-height: 19px;
        padding: 0 6px;
        border-radius: 999px;
        background: #ffffff;
        color: var(--w-brand);
        font-size: 11.5px;
        font-weight: 800;
        display: none;
        align-items: center;
        justify-content: center;
        margin-left: 4px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.15);
      }

      .chatify-open-conv-card {
        cursor: pointer;
        transition: transform .2s var(--w-spring), box-shadow .2s var(--w-ease);
      }

      .chatify-open-conv-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      }

      .chatify-conv-status-pill {
        background: #ecfdf5 !important;
        border-color: #a7f3d0 !important;
        color: #047857 !important;
      }

      .chatify-conv-time {
        font-size: 11.5px;
        color: var(--w-ink-3);
        font-weight: 500;
        margin-left: auto;
      }

      .chatify-open-conv-preview {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        margin: 10px 0 14px;
        background: var(--w-surface-2);
        border: 1px solid var(--w-line);
        border-radius: 12px;
        text-align: left;
      }

      .chatify-open-conv-avatar-col {
        flex-shrink: 0;
      }

      .chatify-open-conv-text-col {
        flex: 1;
        min-width: 0;
      }

      .chatify-open-conv-sender-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        margin-bottom: 3px;
      }

      .chatify-open-conv-sender {
        font-size: 13px;
        font-weight: 700;
        color: var(--w-ink);
      }

      .chatify-open-conv-snippet {
        font-size: 12.5px;
        color: var(--w-ink-2);
        line-height: 1.45;
        margin: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .chatify-new-conv-link {
        width: 100%;
        background: transparent;
        border: none;
        padding: 8px 0 0;
        margin-top: 6px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--w-brand);
        cursor: pointer;
        text-align: center;
        transition: opacity .15s;
        display: block;
      }

      .chatify-new-conv-link:hover {
        opacity: 0.8;
        text-decoration: underline;
      }

      .chatify-chips-section {
        margin-top: 4px;
      }

      .chatify-section-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--w-ink-3);
        margin-bottom: 8px;
        padding-left: 2px;
      }

      .chatify-chips-grid {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .chatify-chip {
        width: 100%;
        padding: 11px 14px;
        border-radius: 12px;
        background: var(--w-surface);
        border: 1px solid var(--w-line);
        color: var(--w-ink);
        font-size: 13px;
        font-weight: 500;
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
        transition: all .18s var(--w-ease);
      }

      .chatify-chip:hover {
        background: var(--w-brand-a08);
        border-color: var(--w-brand-a28);
        transform: translateX(3px);
        box-shadow: 0 3px 12px rgba(0, 0, 0, 0.06);
      }

      .chatify-chip-arrow {
        color: var(--w-ink-3);
        font-size: 16px;
        font-weight: 600;
        transition: transform .18s var(--w-ease), color .18s var(--w-ease);
      }

      .chatify-chip:hover .chatify-chip-arrow {
        color: var(--w-brand);
        transform: translateX(3px);
      }

      .chatify-search-trigger {
        background: var(--w-surface-2);
        border: 1px solid var(--w-line);
        border-radius: 12px;
        padding: 11px 14px;
        color: var(--w-ink-3);
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 10px;
        cursor: pointer;
        transition: all .18s var(--w-ease);
      }

      .chatify-search-trigger:hover {
        background: var(--w-surface);
        border-color: var(--w-brand-a28);
        color: var(--w-ink);
      }

      .chatify-search-kbd {
        margin-left: auto;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 7px;
        border-radius: 6px;
        background: var(--w-surface);
        border: 1px solid var(--w-line);
        color: var(--w-ink-3);
      }

      /* ── Thread header ────────────────────────────────────────────── */

      .chatify-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 13px 16px;
        border-bottom: 1px solid var(--w-line);
        background: var(--w-surface);
        flex-shrink: 0;
      }

      .chatify-header-info { display: flex; align-items: center; gap: 10px; min-width: 0; }

      .chatify-back-btn,
      .chatify-close-btn {
        width: 30px;
        height: 30px;
        border-radius: var(--w-r-sm);
        border: none;
        background: transparent;
        color: var(--w-ink-3);
        font-size: 15px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background .16s var(--w-ease), color .16s var(--w-ease);
      }

      .chatify-back-btn:hover,
      .chatify-close-btn:hover { background: var(--w-surface-3); color: var(--w-ink); }

      .chatify-avatar {
        position: relative;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: var(--w-brand);
        color: var(--w-on-brand);
        font-size: 14px;
        font-weight: 700;
        text-transform: uppercase;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .chatify-online-dot {
        position: absolute;
        right: -1px;
        bottom: -1px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--w-success);
        border: 2px solid var(--w-surface);
      }

      .chatify-header-text { min-width: 0; }

      .chatify-header-text h3 {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -.012em;
        color: var(--w-ink);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .chatify-header-text p {
        font-size: 12px;
        color: var(--w-ink-3);
        margin-top: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* ── Message body ─────────────────────────────────────────────── */

      .chatify-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 16px;
        background: var(--w-canvas);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .chatify-prechat {
        margin: auto 0;
        background: var(--w-surface);
        border: 1px solid var(--w-line);
        border-radius: var(--w-r-md);
        padding: 20px;
        box-shadow: var(--w-shadow-sm);
        animation: w-rise .35s var(--w-ease) both;
      }

      .chatify-prechat h4 {
        font-size: 16px;
        font-weight: 600;
        letter-spacing: -.014em;
        color: var(--w-ink);
      }

      .chatify-prechat p {
        margin: 5px 0 18px;
        font-size: 13px;
        line-height: 1.55;
        color: var(--w-ink-2);
      }

      .chatify-form-group { margin-bottom: 12px; }

      .chatify-form-group label {
        display: block;
        font-size: 12px;
        font-weight: 600;
        color: var(--w-ink-2);
        margin-bottom: 6px;
      }

      .chatify-input {
        width: 100%;
        height: 42px;
        padding: 0 12px;
        border-radius: var(--w-r-sm);
        border: 1px solid var(--w-line-2);
        background: var(--w-surface);
        color: var(--w-ink);
        font-size: 13.5px;
        outline: none;
        transition: border-color .16s var(--w-ease), box-shadow .16s var(--w-ease);
      }

      .chatify-input::placeholder { color: var(--w-ink-3); }

      .chatify-input.chatify-input-invalid,
      .chatify-input.chatify-input-invalid:focus {
        border-color: #ef4444;
        box-shadow: 0 0 0 3px rgba(239, 68, 68, .14);
      }

      .chatify-field-error {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.4;
        font-weight: 500;
        color: #dc2626;
      }

      .chatify-input:focus {
        border-color: var(--w-brand);
        box-shadow: 0 0 0 3px var(--w-brand-a16);
      }

      .chatify-start-btn {
        width: 100%;
        height: 44px;
        margin-top: 6px;
        border: none;
        border-radius: var(--w-r-sm);
        background: var(--w-brand);
        color: var(--w-on-brand);
        font-size: 14px;
        font-weight: 600;
        box-shadow: var(--w-shadow-sm);
        transition: filter .16s var(--w-ease), transform .12s var(--w-ease);
      }

      .chatify-start-btn:hover { filter: brightness(1.08); }
      .chatify-start-btn:active { transform: scale(.985); }

      .chatify-optional-tag {
        font-size: 11px;
        font-weight: 400;
        color: var(--w-ink-3);
        margin-left: 4px;
      }

      .chatify-skip-btn {
        width: 100%;
        height: 38px;
        margin-top: 8px;
        background: transparent;
        border: 1px solid var(--w-line-2);
        border-radius: var(--w-r-sm);
        color: var(--w-ink-2);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: background .16s var(--w-ease), color .16s var(--w-ease), border-color .16s var(--w-ease);
      }

      .chatify-skip-btn:hover {
        background: var(--w-surface-2);
        color: var(--w-brand);
        border-color: var(--w-brand);
      }

      .chatify-message-row {
        display: flex;
        animation: w-bubble-in .3s var(--w-ease-out) both;
      }

      .chatify-msg-visitor,
      .chatify-msg-agent {
        max-width: 82%;
        padding: 10px 13px;
        font-size: 13.5px;
        line-height: 1.55;
      }

      /* pre-wrap belongs on the text node only — on the bubble it would also
         render the markup's own indentation as blank lines. */
      .chatify-msg-quote {
        display: flex;
        flex-direction: column;
        gap: 1px;
        margin-bottom: 6px;
        padding: 5px 8px;
        border-left: 2px solid currentColor;
        border-radius: 6px;
        background: rgba(127, 127, 127, 0.14);
        opacity: 0.85;
        font-size: 12px;
        line-height: 1.35;
      }
      .chatify-msg-quote-who {
        font-weight: 600;
        font-size: 11px;
        opacity: 0.9;
      }
      .chatify-msg-quote-text {
        /* Two lines is enough to identify the message without burying the
           reply underneath the thing it is replying to. */
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        opacity: 0.85;
      }
      .chatify-msg-text {
        white-space: pre-wrap;
        word-wrap: break-word;
        overflow-wrap: anywhere;
      }

      /* Formatted replies: structure comes from the markup, not whitespace. */
      .chatify-msg-rich { white-space: normal; }
      .chatify-msg-rich > :first-child { margin-top: 0; }
      .chatify-msg-rich > :last-child { margin-bottom: 0; }
      .chatify-msg-rich p { margin: 0 0 8px; }
      .chatify-msg-rich h3, .chatify-msg-rich h4, .chatify-msg-rich h5, .chatify-msg-rich h6 {
        margin: 12px 0 6px;
        font-size: 14px;
        line-height: 1.35;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--w-ink);
      }
      .chatify-msg-rich h5, .chatify-msg-rich h6 { font-size: 13px; }
      .chatify-msg-rich ul, .chatify-msg-rich ol { margin: 4px 0 8px; padding-left: 18px; }
      .chatify-msg-rich li { margin: 0 0 4px; }
      .chatify-msg-rich li::marker { color: var(--w-brand); }
      .chatify-msg-rich strong { font-weight: 650; color: var(--w-ink); }
      .chatify-msg-text a { color: inherit; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
      .chatify-msg-rich a { color: var(--w-brand); text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
      .chatify-msg-rich hr { border: 0; border-top: 1px solid var(--w-line); margin: 10px 0; }
      .chatify-msg-rich code { font-size: 12px; padding: 1px 4px; border-radius: 4px; background: var(--w-surface-2, rgba(15,23,42,.06)); }

      .chatify-msg-visitor {
        margin-left: auto;
        background: linear-gradient(145deg, var(--w-brand) 0%, var(--w-brand-deep) 130%);
        color: var(--w-on-brand);
        border-radius: 18px 18px 5px 18px;
        box-shadow: 0 2px 10px var(--w-brand-a28), 0 1px 2px rgba(11, 11, 15, 0.10);
      }

      .chatify-msg-agent {
        margin-right: auto;
        background: var(--w-surface);
        color: var(--w-ink);
        border-radius: 18px 18px 18px 5px;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
        border: 1px solid var(--w-line);
      }

      .chatify-msg-time {
        margin-top: 4px;
        font-size: 10.5px;
        color: var(--w-ink-3);
        text-align: right;
      }

      .chatify-msg-visitor .chatify-msg-time {
        color: inherit;
        opacity: .78;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
      }

      .chatify-tick {
        display: inline-flex;
        align-items: center;
        color: currentColor;
        opacity: .85;
      }

      /* The single place colour carries meaning instead of decoration. */
      .chatify-tick-read {
        color: #53bdeb;
        opacity: 1;
      }

      /* ── CSAT ─────────────────────────────────────────────────────── */

      .chatify-csat-box {
        margin-top: 6px;
        background: var(--w-surface);
        border: 1px solid var(--w-line);
        border-radius: var(--w-r-md);
        padding: 16px;
        text-align: center;
        box-shadow: var(--w-shadow-sm);
        animation: w-rise .3s var(--w-ease) both;
      }

      .chatify-csat-title {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -.012em;
        color: var(--w-ink);
      }

      .chatify-csat-sub {
        margin-top: 3px;
        font-size: 12px;
        color: var(--w-ink-3);
      }

      .chatify-csat-emojis {
        margin-top: 12px;
        display: flex;
        justify-content: center;
        gap: 6px;
      }

      .chatify-csat-btn {
        width: 42px;
        height: 42px;
        border-radius: var(--w-r-sm);
        border: 1px solid var(--w-line);
        background: var(--w-surface-2);
        font-size: 20px;
        line-height: 1;
        transition: transform .18s var(--w-spring), border-color .16s var(--w-ease),
          background .16s var(--w-ease);
      }

      .chatify-csat-btn:hover {
        transform: scale(1.16) translateY(-2px);
        border-color: var(--w-brand);
        background: var(--w-brand-a08);
      }

      .chatify-csat-choices {
        margin-top: 12px;
        display: flex;
        gap: 8px;
        justify-content: center;
      }

      .chatify-csat-choice-btn {
        flex: 1;
        padding: 8px 12px;
        border-radius: var(--w-r-sm);
        border: 1px solid var(--w-line);
        background: var(--w-surface-2);
        color: var(--w-ink);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: all .16s var(--w-ease);
      }

      .chatify-csat-choice-btn:hover {
        border-color: var(--w-line-3);
        background: var(--w-surface-3);
      }

      .chatify-csat-choice-btn.selected-good {
        border-color: var(--w-success);
        background: var(--w-success-soft);
        color: var(--w-success);
      }

      .chatify-csat-choice-btn.selected-bad {
        border-color: var(--w-danger);
        background: var(--w-danger-soft);
        color: var(--w-danger);
      }

      .chatify-csat-comment-wrap {
        margin-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .chatify-csat-comment-input {
        width: 100%;
        box-sizing: border-box;
        border-radius: var(--w-r-sm);
        border: 1px solid var(--w-line);
        padding: 8px 10px;
        font-size: 12px;
        resize: none;
        height: 56px;
        background: var(--w-surface);
        color: var(--w-ink);
        font-family: inherit;
        outline: none;
      }

      .chatify-csat-comment-input:focus {
        border-color: var(--w-brand);
      }

      .chatify-csat-submit-btn {
        width: 100%;
        padding: 8px 12px;
        border-radius: var(--w-r-sm);
        background: var(--w-brand);
        color: #ffffff;
        border: none;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        transition: opacity .16s var(--w-ease);
      }

      .chatify-csat-submit-btn:hover {
        opacity: 0.9;
      }

      /* ── Composer ─────────────────────────────────────────────────── */

      .chatify-footer {
        display: flex;
        align-items: flex-end;
        gap: 8px;
        padding: 12px 14px;
        border-top: 1px solid var(--w-line);
        background: var(--w-surface);
        flex-shrink: 0;
      }

      .chatify-textarea {
        flex: 1;
        box-sizing: border-box;
        height: 44px;
        min-height: 44px;
        max-height: 122px;
        padding: 11px 13px;
        border-radius: var(--w-r-md);
        border: 1px solid var(--w-line-2);
        background: var(--w-surface-2);
        color: var(--w-ink);
        font-size: 13.5px;
        line-height: 1.45;
        resize: none;
        outline: none;
        overflow-y: hidden;
        transition: border-color .16s var(--w-ease), box-shadow .16s var(--w-ease);
      }

      .chatify-textarea::placeholder { color: var(--w-ink-3); }

      .chatify-textarea:focus {
        border-color: var(--w-brand);
        box-shadow: 0 0 0 3px var(--w-brand-a16);
      }

      .chatify-send-btn {
        width: 42px;
        height: 42px;
        flex-shrink: 0;
        border: none;
        border-radius: var(--w-r-md);
        background: var(--w-brand);
        color: var(--w-on-brand);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: var(--w-shadow-sm);
        transition: filter .16s var(--w-ease), transform .12s var(--w-ease);
      }

      .chatify-send-btn:hover {
        filter: brightness(1.08);
        transform: translateY(-1px) scale(1.04);
        box-shadow: 0 6px 16px var(--w-brand-a28);
      }
      .chatify-send-btn:active { transform: scale(.94); }

      .chatify-send-btn svg { width: 19px; height: 19px; fill: currentColor; }

      .chatify-footer-actions {
        display: flex;
        align-items: center;
        gap: 3px;
        padding-bottom: 5px;
      }

      .chatify-action-btn {
        width: 34px;
        height: 34px;
        border: none;
        border-radius: var(--w-r-sm);
        background: transparent;
        color: var(--w-ink-2);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: background .15s var(--w-ease), color .15s var(--w-ease), transform .12s var(--w-ease);
      }

      .chatify-action-btn:hover {
        background: var(--w-surface-2);
        color: var(--w-brand);
        transform: scale(1.08);
      }

      .chatify-action-btn svg {
        width: 19px;
        height: 19px;
      }

      .chatify-attachment-preview {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        background: var(--w-surface-2);
        border-top: 1px solid var(--w-line);
        flex-shrink: 0;
        animation: chatifyFadeIn .15s var(--w-ease);
      }

      .chatify-preview-thumb {
        width: 38px;
        height: 38px;
        border-radius: 8px;
        object-fit: cover;
        border: 1px solid var(--w-line);
      }

      .chatify-preview-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }

      .chatify-preview-name {
        font-size: 12px;
        font-weight: 600;
        color: var(--w-ink);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .chatify-preview-size {
        font-size: 10.5px;
        color: var(--w-ink-3);
      }

      .chatify-preview-remove {
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: none;
        background: var(--w-line);
        color: var(--w-ink-2);
        font-size: 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background .15s;
      }

      .chatify-preview-remove:hover {
        background: var(--w-line-2);
        color: var(--w-ink);
      }

      .chatify-emoji-popover {
        position: absolute;
        bottom: 66px;
        left: 14px;
        z-index: 35;
        background: var(--w-surface);
        border: 1px solid var(--w-line);
        border-radius: 14px;
        padding: 8px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.18);
        width: 295px;
        box-sizing: border-box;
        animation: chatifyFadeIn .15s var(--w-ease);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .chatify-emoji-header {
        width: 100%;
      }

      .chatify-emoji-search {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 10px;
        font-size: 12.5px;
        border: 1px solid var(--w-line);
        border-radius: 8px;
        background: var(--w-surface-2);
        color: var(--w-ink);
        outline: none;
      }

      .chatify-emoji-search:focus {
        border-color: var(--w-brand);
      }

      .chatify-emoji-categories {
        display: flex;
        align-items: center;
        gap: 2px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--w-line);
        overflow-x: auto;
      }

      .chatify-emoji-cat-btn {
        background: transparent;
        border: none;
        border-radius: 6px;
        padding: 4px 6px;
        font-size: 15px;
        cursor: pointer;
        opacity: 0.65;
        transition: opacity .15s, background .15s;
        line-height: 1;
      }

      .chatify-emoji-cat-btn:hover {
        opacity: 1;
        background: var(--w-surface-2);
      }

      .chatify-emoji-cat-btn.active {
        opacity: 1;
        background: var(--w-surface-2);
        box-shadow: inset 0 -2px 0 var(--w-brand);
      }

      .chatify-emoji-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 2px;
        max-height: 190px;
        overflow-y: auto;
        padding-right: 2px;
      }

      .chatify-emoji-btn {
        font-size: 19px;
        padding: 5px 2px;
        border: none;
        background: transparent;
        border-radius: 6px;
        cursor: pointer;
        transition: transform .12s, background .15s;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .chatify-emoji-btn:hover {
        background: var(--w-surface-2);
        transform: scale(1.22);
      }

      .chatify-msg-attachment {
        margin-bottom: 6px;
      }

      .chatify-msg-img {
        max-width: 100%;
        max-height: 190px;
        border-radius: 10px;
        object-fit: cover;
        cursor: pointer;
        display: block;
        border: 1px solid rgba(0,0,0,.08);
        transition: opacity .15s, transform .15s;
      }

      .chatify-msg-img:hover {
        opacity: .94;
        transform: scale(1.01);
      }

      .chatify-msg-doc {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: rgba(0,0,0,0.06);
        border-radius: 8px;
        font-size: 12px;
        text-decoration: underline;
        color: inherit;
      }

      .chatify-lightbox {
        position: absolute;
        inset: 0;
        z-index: 9999;
        background: rgba(0, 0, 0, 0.88);
        backdrop-filter: blur(4px);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 18px;
        animation: chatifyFadeIn .15s var(--w-ease);
      }

      .chatify-lightbox-img {
        max-width: 90%;
        max-height: 80%;
        border-radius: 12px;
        object-fit: contain;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      }

      .chatify-lightbox-close {
        position: absolute;
        top: 14px;
        right: 14px;
        background: rgba(255,255,255,0.18);
        border: none;
        color: #fff;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background .15s;
      }

      .chatify-lightbox-close:hover {
        background: rgba(255,255,255,0.35);
      }

      .chatify-lightbox-link {
        margin-top: 12px;
        color: #93c5fd;
        font-size: 12px;
        text-decoration: underline;
      }

      @keyframes chatifySpin {
        to { transform: rotate(360deg); }
      }

      /* ── Help tab ─────────────────────────────────────────────────── */

      .chatify-help-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 14px;
        background: var(--w-canvas);
      }

      .chatify-help-search-bar { margin-bottom: 12px; }

      .chatify-help-search-bar input {
        width: 100%;
        height: 42px;
        padding: 0 13px;
        border-radius: var(--w-r-sm);
        border: 1px solid var(--w-line-2);
        background: var(--w-surface);
        color: var(--w-ink);
        font-size: 13.5px;
        outline: none;
        transition: border-color .16s var(--w-ease), box-shadow .16s var(--w-ease);
      }

      .chatify-help-search-bar input::placeholder { color: var(--w-ink-3); }

      .chatify-help-search-bar input:focus {
        border-color: var(--w-brand);
        box-shadow: 0 0 0 3px var(--w-brand-a16);
      }

      .chatify-section-list {
        display: flex;
        flex-direction: column;
        gap: 9px;
      }

      .chatify-section-card {
        display: flex;
        align-items: center;
        gap: 12px;
        background: var(--w-surface);
        border: 1px solid var(--w-line);
        border-radius: var(--w-r-md);
        padding: 13px 14px;
        cursor: pointer;
        transition: border-color .16s var(--w-ease), box-shadow .16s var(--w-ease), transform .16s var(--w-ease);
      }

      .chatify-section-card:hover {
        border-color: var(--w-line-2);
        box-shadow: var(--w-shadow-sm);
        transform: translateY(-1px);
      }

      .chatify-section-card-icon {
        width: 36px;
        height: 36px;
        border-radius: 9px;
        background: var(--w-surface-2);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        flex-shrink: 0;
      }

      .chatify-section-card-info {
        flex: 1;
        min-width: 0;
      }

      .chatify-section-card-title {
        margin: 0;
        font-size: 13.5px;
        font-weight: 600;
        color: var(--w-ink);
        line-height: 1.35;
      }

      .chatify-section-card-desc {
        margin: 3px 0 0;
        font-size: 12px;
        color: var(--w-ink-3);
        line-height: 1.4;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .chatify-section-card-arrow {
        color: var(--w-ink-3);
        font-size: 18px;
        line-height: 1;
        flex-shrink: 0;
        transition: transform .18s var(--w-ease), color .18s var(--w-ease);
      }

      .chatify-section-card:hover .chatify-section-card-arrow {
        color: var(--w-brand);
        transform: translateX(2px);
      }

      .chatify-section-back-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background: none;
        border: none;
        padding: 0 0 12px 0;
        color: var(--w-brand);
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity .16s var(--w-ease);
      }

      .chatify-section-back-btn:hover {
        opacity: 0.8;
      }

      .chatify-section-view-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--w-line);
      }

      .chatify-section-view-icon {
        font-size: 24px;
        flex-shrink: 0;
      }

      .chatify-section-view-text h3 {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        color: var(--w-ink);
      }

      .chatify-section-view-text p {
        margin: 2px 0 0;
        font-size: 12px;
        color: var(--w-ink-3);
      }

      .chatify-faq-list { display: flex; flex-direction: column; gap: 8px; }

      .chatify-faq-item {
        background: var(--w-surface);
        border: 1px solid var(--w-line);
        border-radius: var(--w-r-md);
        padding: 13px 14px;
        cursor: pointer;
        transition: border-color .16s var(--w-ease), box-shadow .16s var(--w-ease);
      }

      .chatify-faq-item:hover { border-color: var(--w-line-2); box-shadow: var(--w-shadow-sm); }
      .chatify-faq-item.open { border-color: var(--w-brand); }

      .chatify-faq-q {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-size: 13.5px;
        font-weight: 600;
        line-height: 1.4;
        color: var(--w-ink);
      }

      .chatify-faq-arrow {
        color: var(--w-ink-3);
        font-size: 17px;
        line-height: 1;
        flex-shrink: 0;
        transition: transform .22s var(--w-ease), color .16s var(--w-ease);
      }

      .chatify-faq-item.open .chatify-faq-arrow {
        transform: rotate(90deg);
        color: var(--w-brand);
      }

      .chatify-faq-a {
        max-height: 0;
        overflow: hidden;
        opacity: 0;
        font-size: 13px;
        line-height: 1.6;
        color: var(--w-ink-2);
        transition: max-height .28s var(--w-ease), opacity .22s var(--w-ease),
          margin-top .28s var(--w-ease);
      }

      .chatify-faq-item.open .chatify-faq-a {
        max-height: 480px;
        overflow-y: auto;
        opacity: 1;
        margin-top: 9px;
        padding-right: 4px;
      }

      .chatify-faq-markdown {
        font-size: 12.5px;
        line-height: 1.6;
        color: var(--w-ink-2);
      }
      .chatify-faq-markdown p { margin: 0 0 8px 0; }
      .chatify-faq-markdown p:last-child { margin-bottom: 0; }
      .chatify-faq-markdown pre {
        background: var(--w-surface-2, #f1f5f9);
        border: 1px solid var(--w-line);
        border-radius: 6px;
        padding: 8px 10px;
        overflow-x: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11.5px;
        margin: 8px 0;
      }
      .chatify-faq-markdown code {
        background: var(--w-surface-2, #f1f5f9);
        border-radius: 4px;
        padding: 2px 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11.5px;
      }
      .chatify-faq-markdown a {
        color: var(--w-brand);
        text-decoration: underline;
      }
      .chatify-faq-markdown ul, .chatify-faq-markdown ol {
        margin: 6px 0 8px 18px;
        padding: 0;
      }
      .chatify-faq-markdown li { margin-bottom: 3px; }
      .chatify-faq-markdown blockquote {
        border-left: 3px solid var(--w-brand);
        margin: 8px 0;
        padding-left: 8px;
        color: var(--w-ink-3);
        font-style: italic;
      }
      .chatify-article-ext-link {
        font-size: 11.5px;
        color: var(--w-brand);
        text-decoration: none;
        font-weight: 600;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        transition: opacity .15s;
      }
      .chatify-article-ext-link:hover {
        opacity: 0.8;
        text-decoration: underline;
      }

      /* ── Bottom navigation ────────────────────────────────────────── */

      .chatify-bottom-nav {
        display: flex;
        border-top: 1px solid rgba(0, 0, 0, 0.07);
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        padding: 6px 10px calc(8px + env(safe-area-inset-bottom, 0px));
        flex-shrink: 0;
        height: 64px;
        box-sizing: border-box;
      }

      .chatify-nav-item {
        position: relative;
        flex: 1;
        border: none;
        background: transparent;
        color: #64748b;
        padding: 6px 0 4px;
        border-radius: 12px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 3px;
        font-size: 11.5px;
        font-weight: 500;
        cursor: pointer;
        transition: all .18s var(--w-ease);
      }

      .chatify-nav-item svg {
        transition: transform .2s var(--w-spring), color .18s var(--w-ease);
      }

      .chatify-nav-item:hover {
        color: #1e293b;
        background: rgba(0, 0, 0, 0.03);
      }

      .chatify-nav-item.active {
        color: var(--w-brand);
        font-weight: 700;
      }

      .chatify-nav-item.active svg {
        transform: translateY(-1px) scale(1.08);
      }

      .chatify-nav-item.active::after {
        content: '';
        position: absolute;
        bottom: 2px;
        width: 16px;
        height: 3px;
        border-radius: 999px;
        background: var(--w-brand);
      }

      .nav-msg-icon-wrap { position: relative; display: flex; }

      .chatify-nav-badge {
        position: absolute;
        top: -3px;
        right: -6px;
        min-width: 15px;
        height: 15px;
        padding: 0 4px;
        border-radius: 999px;
        background: #e11d48;
        color: #fff;
        font-size: 9.5px;
        font-weight: 700;
        display: none;
        align-items: center;
        justify-content: center;
        border: 2px solid var(--w-surface);
      }

      .chatify-nav-label-wrap {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
      }

      .chatify-nav-inline-badge {
        min-width: 17px;
        height: 17px;
        line-height: 17px;
        padding: 0 5px;
        border-radius: 999px;
        background: #e11d48;
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        display: none;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 3px rgba(225, 29, 72, 0.35);
        animation: w-pop .28s var(--w-spring);
      }

      /* ── Motion ───────────────────────────────────────────────────── */

      @keyframes w-bubble-in {
        from { opacity: 0; transform: translateY(8px) scale(.97); }
        to   { opacity: 1; transform: none; }
      }

      @keyframes w-aurora {
        from { transform: translate3d(-4%, -3%, 0) scale(1); }
        to   { transform: translate3d(5%, 4%, 0) scale(1.12); }
      }

      @keyframes w-halo {
        0%        { transform: scale(1);   opacity: .5; }
        70%, 100% { transform: scale(1.7); opacity: 0; }
      }

      @keyframes w-window-in {
        from { opacity: 0; transform: translateY(14px) scale(.985); }
        to   { opacity: 1; transform: none; }
      }

      @keyframes w-rise {
        from { opacity: 0; transform: translateY(7px); }
        to   { opacity: 1; transform: none; }
      }

      @keyframes w-fade { from { opacity: 0; } to { opacity: 1; } }

      @keyframes w-pop {
        from { opacity: 0; transform: scale(.6); }
        to   { opacity: 1; transform: none; }
      }

      /* ── Handover Card & Agent Sender ─────────────────────────────── */
      .chatify-handover-card {
        margin: 10px 0;
        padding: 12px 14px;
        background: var(--w-surface);
        border: 1px solid var(--w-line);
        border-radius: var(--w-r-md);
        box-shadow: 0 2px 8px rgba(11, 11, 15, 0.05);
        display: flex;
        align-items: center;
        gap: 12px;
        animation: w-rise .3s var(--w-ease) both;
        position: relative;
        overflow: hidden;
      }

      .chatify-handover-card.connecting {
        border-left: 3.5px solid var(--w-brand);
        background: linear-gradient(to right, var(--w-brand-a08), var(--w-surface));
      }

      .chatify-handover-card.connected {
        border-left: 3.5px solid #10b981;
        background: linear-gradient(to right, rgba(16, 185, 129, 0.08), var(--w-surface));
      }

      .chatify-handover-avatar-wrap {
        position: relative;
        width: 38px;
        height: 38px;
        flex-shrink: 0;
      }

      .chatify-handover-avatar {
        width: 38px;
        height: 38px;
        border-radius: 50%;
        background: var(--w-brand);
        color: var(--w-on-brand);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 700;
        text-transform: uppercase;
        overflow: hidden;
      }

      .chatify-handover-avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .chatify-handover-spinner {
        width: 38px;
        height: 38px;
        border: 2.5px solid var(--w-brand-a28);
        border-top-color: var(--w-brand);
        border-radius: 50%;
        animation: chatifySpin 0.9s linear infinite;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .chatify-handover-spinner-inner {
        font-size: 16px;
      }

      .chatify-handover-badge {
        position: absolute;
        bottom: -1px;
        right: -1px;
        width: 11px;
        height: 11px;
        border-radius: 50%;
        border: 2px solid var(--w-surface);
        background: #10b981;
      }

      .chatify-handover-content {
        flex: 1;
        min-width: 0;
      }

      .chatify-handover-title-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      .chatify-handover-title {
        font-size: 13px;
        font-weight: 650;
        color: var(--w-ink);
        letter-spacing: -0.01em;
      }

      .chatify-handover-tag {
        font-size: 9.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 1.5px 6px;
        border-radius: 999px;
        background: rgba(16, 185, 129, 0.14);
        color: #047857;
      }

      .chatify-handover-sub {
        margin-top: 2px;
        font-size: 11.5px;
        color: var(--w-ink-2);
        line-height: 1.35;
      }

      .chatify-agent-sender-name {
        font-size: 11px;
        font-weight: 600;
        color: var(--w-ink-2);
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 5px;
      }

      .chatify-agent-sender-name .chatify-human-tag {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--w-brand-a08);
        color: var(--w-brand);
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: .01ms !important;
          transition-duration: .01ms !important;
        }
      }
      ${this.designCSS()}
    `;
  }

  private bindPrechatHandlers() {
    const startBtn = this.shadow?.getElementById('chatifyStartBtn');
    startBtn?.addEventListener('click', () => this.handleStartPreChat());

    const prechatEmail = this.shadow?.getElementById('chatifyInputEmail') as HTMLInputElement | null;
    const prechatName = this.shadow?.getElementById('chatifyInputName') as HTMLInputElement | null;
    const handlePrechatEnter = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleStartPreChat();
      }
    };
    prechatEmail?.addEventListener('keydown', handlePrechatEnter);
    prechatName?.addEventListener('keydown', handlePrechatEnter);
    // Validate when the visitor leaves the field (once they've typed), and
    // re-check live while an error is showing so it clears as soon as it's fixed.
    prechatEmail?.addEventListener('blur', () => {
      if (prechatEmail.value.trim()) this.validatePrechatEmail();
    });
    prechatEmail?.addEventListener('input', () => {
      if (prechatEmail.getAttribute('aria-invalid') === 'true') this.validatePrechatEmail();
    });
  }

  /**
   * Applies Settings → Chat widget → Pre-chat form once the workspace config
   * has arrived (the window is built before it). Off, or nothing to ask: the
   * visitor goes straight to the composer. Otherwise the form is rebuilt with
   * the workspace's wording, fields and topics.
   */
  private applyPrechatConfig() {
    const c = this.prechat;
    if (!c.enabled || prechatAsksNothing(c)) {
      if (!this.isPreChatCompleted) {
        this.isPreChatCompleted = true;
        this.shadow?.getElementById('chatifyPreChat')?.remove();
        const footer = this.shadow?.getElementById('chatifyFooter');
        if (footer) footer.style.display = 'flex';
      }
      return;
    }
    const form = this.shadow?.getElementById('chatifyPreChat');
    if (!form || this.isPreChatCompleted) return;
    const tag = (mode: PrechatFieldMode) =>
      mode === 'required'
        ? '<span class="chatify-required-tag" style="color:#ef4444; font-weight:700;">*</span>'
        : '<span class="chatify-optional-tag">(Optional)</span>';
    form.innerHTML = `
      <h4>${this.escapeHTML(c.title)}</h4>
      <p>${this.escapeHTML(c.intro)}</p>
      ${c.name !== 'off' ? `
      <div class="chatify-form-group">
        <label for="chatifyInputName">Your name ${tag(c.name)}</label>
        <input type="text" id="chatifyInputName" class="chatify-input" placeholder="e.g. Sarah Khan" autocomplete="name" ${c.name === 'required' ? 'required aria-required="true"' : ''} aria-describedby="chatifyNameError" />
        <div id="chatifyNameError" class="chatify-field-error" role="alert" aria-live="polite" style="display:none;"></div>
      </div>` : ''}
      ${c.email !== 'off' ? `
      <div class="chatify-form-group">
        <label for="chatifyInputEmail">Email address ${tag(c.email)}</label>
        <input type="email" id="chatifyInputEmail" class="chatify-input" placeholder="sarah@example.com" autocomplete="email" inputmode="email" ${c.email === 'required' ? 'required aria-required="true"' : ''} aria-describedby="chatifyEmailError" />
        <div id="chatifyEmailError" class="chatify-field-error" role="alert" aria-live="polite" style="display:none;"></div>
      </div>` : ''}
      ${c.topics.length ? `
      <div class="chatify-form-group">
        <label for="chatifyInputTopic">What is it about? ${tag(c.topic_required ? 'required' : 'optional')}</label>
        <select id="chatifyInputTopic" class="chatify-input" ${c.topic_required ? 'required aria-required="true"' : ''} aria-describedby="chatifyTopicError">
          <option value="">Choose a topic</option>
          ${c.topics.map((t) => `<option value="${this.escapeHTML(t)}">${this.escapeHTML(t)}</option>`).join('')}
        </select>
        <div id="chatifyTopicError" class="chatify-field-error" role="alert" aria-live="polite" style="display:none;"></div>
      </div>` : ''}
      <button class="chatify-start-btn" id="chatifyStartBtn">Start conversation</button>
    `;
    this.bindPrechatHandlers();
  }

  /** Shows or clears the inline error under one pre-chat field. */
  private setPrechatError(inputId: string, errorId: string, message: string) {
    const input = this.shadow?.getElementById(inputId);
    const error = this.shadow?.getElementById(errorId);
    input?.classList.toggle('chatify-input-invalid', Boolean(message));
    input?.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (error) {
      error.textContent = message;
      error.style.display = message ? 'block' : 'none';
    }
  }

  /** Shows or clears the inline error under the pre-chat email field. */
  private validatePrechatEmail(): boolean {
    const emailInput = this.shadow?.getElementById('chatifyInputEmail') as HTMLInputElement | null;
    if (!emailInput || this.prechat.email === 'off') return true;
    const emailError = this.shadow?.getElementById('chatifyEmailError');
    const email = (emailInput?.value || '').trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    const message = !email
      ? this.prechat.email === 'required'
        ? 'Please enter your email so we can follow up.'
        : ''
      : !emailRegex.test(email)
      ? 'That doesn\'t look like a valid email — try name@company.com.'
      : '';

    if (emailInput) {
      emailInput.classList.toggle('chatify-input-invalid', Boolean(message));
      emailInput.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
    if (emailError) {
      emailError.textContent = message;
      emailError.style.display = message ? 'block' : 'none';
    }
    return !message;
  }

  // 11. Handlers
  private async handleStartPreChat() {
    const nameInput = this.shadow?.getElementById('chatifyInputName') as HTMLInputElement | null;
    const emailInput = this.shadow?.getElementById('chatifyInputEmail') as HTMLInputElement | null;
    const topicInput = this.shadow?.getElementById('chatifyInputTopic') as HTMLSelectElement | null;

    const email = (emailInput?.value || '').trim();
    const name = (nameInput?.value || '').trim();
    const topic = (topicInput?.value || '').trim();

    // Required fields, in the order they appear, so focus lands on the first gap.
    const nameMissing = Boolean(nameInput) && this.prechat.name === 'required' && !name;
    this.setPrechatError('chatifyInputName', 'chatifyNameError', nameMissing ? 'Please tell us your name.' : '');
    const emailOk = this.validatePrechatEmail();
    const topicMissing = Boolean(topicInput) && this.prechat.topic_required && !topic;
    this.setPrechatError('chatifyInputTopic', 'chatifyTopicError', topicMissing ? 'Please choose a topic.' : '');
    if (nameMissing) return nameInput?.focus();
    if (!emailOk) return emailInput?.focus();
    if (topicMissing) return topicInput?.focus();

    this.visitorName = name || this.visitorName;
    this.visitorEmail = email || this.visitorEmail;

    const suffix = this.config.workspaceId ? `_${this.config.workspaceId.slice(0, 8)}` : '';
    try {
      if (this.visitorName) {
        localStorage.setItem(`zentry_visitor_name${suffix}`, this.visitorName);
        localStorage.setItem(`chatify_visitor_name${suffix}`, this.visitorName);
      }
      if (this.visitorEmail) {
        localStorage.setItem(`zentry_visitor_email${suffix}`, this.visitorEmail);
        localStorage.setItem(`chatify_visitor_email${suffix}`, this.visitorEmail);
      }
      // Remembered so a form without an email field is not asked again.
      localStorage.setItem(`zentry_prechat_done${suffix}`, '1');
    } catch {}

    try {
      await this.saveVisitorDetails(null);
    } catch (e) {
      console.warn('[Zen-try] Visitor details not saved:', ZentryWidget.errorText(e));
    }

    this.isPreChatCompleted = true;

    this.shadow?.getElementById('chatifyPreChat')?.remove();
    const footer = this.shadow?.getElementById('chatifyFooter');
    if (footer) footer.style.display = 'flex';

    const convId = await this.ensureConversation();

    // The chosen topic becomes a tag on the new ticket, so the team (and
    // their triggers) can route it.
    if (topic && convId) {
      try {
        if (this.legacyData) {
          await this.supabase.rpc('fn_set_conversation_topic', {
            p_conversation_id: convId,
            p_visitor_id: this.visitorId,
            p_topic: topic,
          });
        } else {
          await this.widgetRpc('fn_widget_set_topic', { p_conversation_id: convId, p_topic: topic });
        }
      } catch {}
    }

    // Send auto welcome message immediately before visitor types/sends any message
    // (the session function writes it only on an empty conversation).
    let isEmpty = !this.legacyData;
    if (this.legacyData) {
      const { data: existingMsgs } = await this.supabase
        .from('messages')
        .select('id')
        .eq('conversation_id', convId)
        .limit(1);
      isEmpty = !existingMsgs || existingMsgs.length === 0;
    }

    if (isEmpty) {
      const rawName = (this.config.businessName || this.config.title || 'our company')
        .replace(/^Welcome to\s+/i, '')
        .replace(/\s*Support\s*$/i, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]+\s*$/u, '')
        .replace(/^the\s+/i, '')
        .trim() || (this.config.businessName || this.config.title || 'our company');

      const customWelcome = this.config.welcomeText?.trim();
      const welcomeContent = customWelcome
        ? customWelcome.charAt(0).toUpperCase() + customWelcome.slice(1)
        : `Welcome to ${rawName}`;
      let savedMsg: MessageItem | null = null;
      if (this.legacyData) {
        const res = await this.supabase
          .from('messages')
          .insert({
            conversation_id: convId,
            sender_type: 'agent',
            content: welcomeContent,
            is_internal: false,
            metadata: { is_welcome: true },
          })
          .select()
          .single();
        savedMsg = res.data as MessageItem | null;
      } else {
        try {
          savedMsg = await this.widgetRpc<MessageItem | null>('fn_widget_welcome', {
            p_conversation_id: convId,
            p_content: welcomeContent,
          });
        } catch {}
      }

      if (savedMsg && !this.messages.some((m) => m.id === savedMsg!.id)) {
        this.messages.push(savedMsg);
      }
    }

    this.renderMessages();
  }

  private async handleSendMessage() {
    const textarea = this.shadow?.getElementById('chatifyTextarea') as HTMLTextAreaElement | null;
    const sendBtn = this.shadow?.getElementById('chatifySendBtn') as HTMLButtonElement | null;
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text && !this.pendingAttachment) return;

    let attachmentUrl: string | null = null;

    if (this.pendingAttachment) {
      if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.innerHTML = `<span style="width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;display:inline-block;animation:chatifySpin 0.8s linear infinite;"></span>`;
      }

      try {
        // Shrinks the photo on the device and uploads it straight to
        // Cloudinary, so camera photos are not stopped by a size limit.
        attachmentUrl = await uploadChatImage(this.pendingAttachment.file, this.config.apiUrl || '', {
          visitorId: this.visitorId,
          visitorToken: this.visitorToken,
        });
      } catch (err: any) {
        alert(err?.message || "Couldn't send the picture. Please try again.");
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
        }
        return;
      } finally {
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
        }
      }
    }

    textarea.value = '';
    this.adjustTextareaHeight();
    this.clearPendingAttachment();

    await this.sendMessage(text, attachmentUrl || undefined);
  }

  private renderMessages() {
    const body = this.shadow?.getElementById('chatifyBody');
    if (!body || !this.isPreChatCompleted) return;

    // Built off-screen; commitMessages puts it on screen only if it changed.
    const stage = document.createElement('div');

    if (this.messages.length === 0) {
      stage.innerHTML = `
        <div style="text-align:center; margin:auto 0; padding:0 18px;">
          <p style="color:var(--w-ink); font-size:15px; font-weight:600; letter-spacing:-.012em; margin-bottom:5px;">How can we help?</p>
          <p style="color:var(--w-ink-2); font-size:13px; line-height:1.55;">Send a message below and someone from our team will pick it up.</p>
        </div>
      `;
      this.commitMessages(body, stage);
      this.renderRecentConversation();
      return;
    }

    this.messages.forEach((msg) => {
      // Security: never render internal notes to visitor!
      if (msg.is_internal) return;

      // System event / Handover: the bot handed this over to the team.
      const isHandover =
        (msg as any).metadata?.system_event === 'handover' ||
        (msg as any).metadata?.system_event?.type === 'handover' ||
        Boolean((msg as any).metadata?.handover);

      if (isHandover) {
        // If there's AI explanation content, render the AI bubble first so visitor sees it.
        if (msg.content && msg.content !== "We've passed this to our team.") {
          const row = document.createElement('div');
          row.className = 'chatify-message-row';
          const bubble = document.createElement('div');
          bubble.className = 'chatify-msg-agent';
          const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          bubble.innerHTML =
            `<div class="chatify-msg-text chatify-msg-rich">${this.formatChatMarkdown(msg.content)}</div>` +
            `<div class="chatify-msg-time">${timeStr}</div>`;
          row.appendChild(bubble);
          stage.appendChild(row);
        }

        // Render the professional animated Handover Card
        const agentName =
          (msg as any).metadata?.assigned_agent_name ||
          ((msg as any).metadata?.assigned_agent_id
            ? this.workspaceAgents.find((a: any) => a.id === (msg as any).metadata?.assigned_agent_id)?.name
            : null) ||
          'Support Specialist';
        const agentAvatar =
          (msg as any).metadata?.assigned_agent_avatar ||
          ((msg as any).metadata?.assigned_agent_id
            ? this.workspaceAgents.find((a: any) => a.id === (msg as any).metadata?.assigned_agent_id)?.avatar_url
            : null);
        const agentInitials = this.getSenderInitials(agentName);
        const email = (this.visitorEmail || '').trim();
        const followUpText = email ? ` We'll also email you at ${this.escapeHTML(email)}.` : '';

        const card = document.createElement('div');
        card.setAttribute('data-handover-msg-id', msg.id);

        const ageMs = Date.now() - new Date(msg.created_at).getTime();
        const shouldAnimateConnecting = ageMs < 6000;

        const renderConnectedContent = () => {
          card.className = 'chatify-handover-card connected';
          const avatarHtml = agentAvatar
            ? `<img src="${this.safeUrl(agentAvatar, true)}" alt="${this.escapeHTML(agentName)}" />`
            : this.escapeHTML(agentInitials);
          card.innerHTML = `
            <div class="chatify-handover-avatar-wrap">
              <div class="chatify-handover-avatar">${avatarHtml}</div>
              <span class="chatify-handover-badge" title="Online"></span>
            </div>
            <div class="chatify-handover-content">
              <div class="chatify-handover-title-row">
                <span class="chatify-handover-title">Connected with ${this.escapeHTML(agentName)}</span>
                <span class="chatify-handover-tag">Human Agent</span>
              </div>
              <p class="chatify-handover-sub">Our team usually replies in a few minutes.${followUpText}</p>
            </div>
          `;
        };

        if (shouldAnimateConnecting) {
          card.className = 'chatify-handover-card connecting';
          card.innerHTML = `
            <div class="chatify-handover-avatar-wrap">
              <div class="chatify-handover-spinner">
                <span class="chatify-handover-spinner-inner">🧑‍💼</span>
              </div>
            </div>
            <div class="chatify-handover-content">
              <div class="chatify-handover-title-row">
                <span class="chatify-handover-title">Connecting to ${this.escapeHTML(agentName)}...</span>
              </div>
              <p class="chatify-handover-sub">Transferring conversation to an available human support agent...</p>
            </div>
          `;
          setTimeout(() => {
            renderConnectedContent();
          }, 2400);
        } else {
          renderConnectedContent();
        }

        stage.appendChild(card);
        return;
      }

      // System event: rate limiting warning.
      if ((msg as any).metadata?.system_event === 'rate_limit') {
        const line = document.createElement('div');
        line.className = 'chatify-system-line';
        line.textContent = msg.content || "You're sending messages too fast. Please wait a moment.";
        stage.appendChild(line);
        return;
      }

      const isVisitor = msg.sender_type === 'visitor';
      const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const row = document.createElement('div');
      row.className = 'chatify-message-row';

      const bubble = document.createElement('div');
      bubble.className = isVisitor ? 'chatify-msg-visitor' : 'chatify-msg-agent';

      // Agent sender name badge
      let senderTagHtml = '';
      if (!isVisitor && msg.sender_type === 'agent' && !(msg as any).metadata?.is_welcome) {
        const agentSenderName =
          (msg as any).metadata?.sender_name ||
          (msg.sender_id ? this.workspaceAgents.find((a: any) => a.id === msg.sender_id)?.name : null) ||
          (msg as any).metadata?.assigned_agent_name;
        if (agentSenderName) {
          senderTagHtml = `<div class="chatify-agent-sender-name"><span>${this.escapeHTML(agentSenderName)}</span><span class="chatify-human-tag">Agent</span></div>`;
        }
      }

      // Kept on one line: the text element preserves whitespace, so any
      // indentation in this template would be rendered as blank lines.
      // Ticks only on the visitor's own messages: a receipt for something the
      // other side sent you is meaningless.
      const ticks = isVisitor ? this.renderTicks(msg) : '';

      // When the agent replied to a particular message, show which one. The
      // visitor otherwise has to guess which of their questions was answered.
      const quoted = msg.reply_to_message_id && msg.sender_type !== 'ai'
        ? this.messages.find((m) => m.id === msg.reply_to_message_id)
        : null;
      const quoteHtml = quoted
        ? `<div class="chatify-msg-quote"><span class="chatify-msg-quote-who">${
            quoted.sender_type === 'visitor' ? 'You' : 'Support'
          }</span><span class="chatify-msg-quote-text">${this.escapeHTML(
            quoted.content.length > 120
              ? `${quoted.content.slice(0, 120)}…`
              : quoted.content
          )}</span></div>`
        : '';

      let attachmentHtml = '';
      if (msg.attachment_url) {
        const safeAttachment = this.safeUrl(msg.attachment_url);
        if (safeAttachment) {
          if (this.isImageAttachment(msg.attachment_url)) {
            attachmentHtml = `<div class="chatify-msg-attachment"><img src="${safeAttachment}" alt="Attachment" class="chatify-msg-img" /></div>`;
          } else {
            attachmentHtml = `<div class="chatify-msg-attachment"><a href="${safeAttachment}" target="_blank" rel="noopener noreferrer" class="chatify-msg-doc">📄 <span>View Document</span></a></div>`;
          }
        }
      }

      const isEdited = Boolean((msg as any).metadata?.is_edited);
      const editedTag = isEdited
        ? `<span style="font-size:10px;font-style:italic;opacity:0.75;margin-left:4px;">(edited)</span>`
        : '';

      const displayContent =
        !isVisitor && (msg as any).metadata?.translation?.translated_text
          ? (msg as any).metadata.translation.translated_text
          : !isVisitor && (msg as any).metadata?.translated_text
          ? (msg as any).metadata.translated_text
          : msg.content;

      bubble.innerHTML =
        senderTagHtml +
        quoteHtml +
        attachmentHtml +
        (displayContent
          ? isVisitor
            ? `<div class="chatify-msg-text">${this.linkifyHTML(displayContent)}</div>`
            : `<div class="chatify-msg-text chatify-msg-rich">${this.formatChatMarkdown(displayContent)}</div>`
          : '') +
        `<div class="chatify-msg-time">${timeStr}${editedTag}${ticks}</div>`;

      const imgEl = bubble.querySelector('.chatify-msg-img') as HTMLImageElement | null;
      if (imgEl && msg.attachment_url) {
        imgEl.addEventListener('click', () => {
          this.openLightbox(msg.attachment_url!);
        });
      }

      row.appendChild(bubble);
      stage.appendChild(row);

      // Quick reply chips — shown below AI/agent bubbles when the message
      // carries them, and only until the visitor has replied (they disappear
      // automatically once the user sends anything after this message).
      if (!isVisitor) {
        const quickReplies = (msg.metadata?.quick_replies as Array<{ label: string; value?: string }> | null | undefined);
        if (quickReplies && quickReplies.length > 0) {
          // Hide chips once the visitor has sent any message after this one.
          const hasVisitorReplyAfter = this.messages.some(
            (m) => m.sender_type === 'visitor' && !m.pending && m.created_at > msg.created_at
          );
          if (!hasVisitorReplyAfter) {
            const chipsRow = document.createElement('div');
            chipsRow.className = 'chatify-quick-replies';
            quickReplies.slice(0, 4).forEach((qr) => {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'chatify-qr-btn';
              btn.textContent = qr.label;
              btn.addEventListener('click', () => {
                // Clear the textarea and send — gives the natural feel of
                // the visitor having chosen an option.
                const textarea = this.shadow?.getElementById('chatifyTextarea') as HTMLTextAreaElement | null;
                if (textarea) {
                  textarea.value = '';
                  this.adjustTextareaHeight();
                }
                this.sendMessage(qr.value || qr.label);
              });
              chipsRow.appendChild(btn);
            });
            stage.appendChild(chipsRow);
          }
        }
      }
    });

    const isClosed = this.conversationStatus === 'closed';
    if (isClosed) {
      const closedNotice = document.createElement('div');
      closedNotice.className = 'chatify-closed-notice';
      closedNotice.textContent = 'This conversation was closed';
      stage.appendChild(closedNotice);
    }

    // If conversation is closed, render CSAT Satisfaction Rating Box
    if (this.conversationStatus === 'closed' && !this.csatRated) {
      const csatCard = document.createElement('div');
      csatCard.className = 'chatify-csat-box';
      csatCard.innerHTML = `
        <div class="chatify-csat-title">How was your support experience?</div>
        <div class="chatify-csat-sub">Please rate the support you received:</div>
        <div class="chatify-csat-choices">
          <button type="button" class="chatify-csat-choice-btn" data-rating="good">
            <span>👍</span><span>Good</span>
          </button>
          <button type="button" class="chatify-csat-choice-btn" data-rating="bad">
            <span>👎</span><span>Bad</span>
          </button>
        </div>
        <div class="chatify-csat-comment-wrap" style="display: none;">
          <textarea class="chatify-csat-comment-input" placeholder="Add an optional comment..."></textarea>
          <button type="button" class="chatify-csat-submit-btn">Submit feedback</button>
        </div>
      `;

      let selectedRating: 'good' | 'bad' | null = null;
      const choices = csatCard.querySelectorAll('.chatify-csat-choice-btn');
      const commentWrap = csatCard.querySelector('.chatify-csat-comment-wrap') as HTMLElement;
      const commentInput = csatCard.querySelector('.chatify-csat-comment-input') as HTMLTextAreaElement;
      const submitBtn = csatCard.querySelector('.chatify-csat-submit-btn') as HTMLButtonElement;

      choices.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const r = (e.currentTarget as HTMLElement).getAttribute('data-rating') as 'good' | 'bad';
          selectedRating = r;
          choices.forEach((b) => {
            b.classList.remove('selected-good', 'selected-bad');
          });
          btn.classList.add(r === 'good' ? 'selected-good' : 'selected-bad');
          if (commentWrap) commentWrap.style.display = 'flex';
        });
      });

      if (submitBtn) {
        submitBtn.addEventListener('click', () => {
          if (!selectedRating) return;
          const commentText = commentInput ? commentInput.value.trim() : '';
          this.submitCSAT(selectedRating, commentText);
        });
      }

      stage.appendChild(csatCard);
    } else if (this.csatRated) {
      const thankYou = document.createElement('div');
      thankYou.style.cssText = 'text-align:center; padding:12px; font-size:12.5px; color:var(--w-success); font-weight:600;';
      thankYou.textContent = '✓ Thank you for rating our support!';
      stage.appendChild(thankYou);
    }

    if (isClosed) {
      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.className = 'chatify-new-conversation-btn';
      newBtn.textContent = 'Start a new conversation';
      newBtn.addEventListener('click', () => this.startNewConversation());
      stage.appendChild(newBtn);
    }

    if (this.botTyping || this.agentTyping) {
      const typingRow = document.createElement('div');
      typingRow.className = 'chatify-message-row';
      typingRow.innerHTML =
        '<div class="chatify-msg-agent chatify-typing" aria-label="Typing"><span></span><span></span><span></span></div>';
      stage.appendChild(typingRow);
    }

    // Dynamically update Messages tab header to reflect the assigned human agent
    let assignedHeaderAgent: { name: string; avatar?: string | null } | null = null;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if ((m as any).metadata?.assigned_agent_name) {
        assignedHeaderAgent = {
          name: (m as any).metadata.assigned_agent_name,
          avatar: (m as any).metadata.assigned_agent_avatar || null,
        };
        break;
      }
      if (m.sender_type === 'agent' && !(m as any).metadata?.is_welcome) {
        const name =
          (m as any).metadata?.sender_name ||
          (m.sender_id ? this.workspaceAgents.find((a: any) => a.id === m.sender_id)?.name : null);
        if (name) {
          assignedHeaderAgent = { name, avatar: null };
          break;
        }
      }
    }
    if (assignedHeaderAgent) {
      const titleEl = this.shadow?.getElementById('chatifyHeaderTitle');
      const subEl = this.shadow?.getElementById('chatifyHeaderSubtitle');
      const avatarEl = this.shadow?.getElementById('chatifyHeaderAvatar');
      if (titleEl) titleEl.textContent = assignedHeaderAgent.name;
      if (subEl) subEl.textContent = 'Support Specialist · Online';
      if (avatarEl && assignedHeaderAgent.avatar) {
        const safeAvatar = this.safeUrl(assignedHeaderAgent.avatar, true);
        if (safeAvatar) {
          avatarEl.innerHTML = `<img src="${safeAvatar}" alt="${this.escapeHTML(assignedHeaderAgent.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
        }
      }
    }

    this.commitMessages(body, stage);
    this.renderRecentConversation();
  }

  private lastMessagesHtml = '';
  private lastMessagesTail: ChildNode | null = null;
  private lastMessageId: string | null = null;

  /**
   * Puts a freshly built message list on screen, only when it differs from
   * what is already there. Polls, receipts and typing indicators re-render
   * often; replacing an identical list every time made the window flicker,
   * jump to the bottom, reload pictures and wipe a CSAT comment being typed.
   *
   * Scrolling: follow the conversation when the visitor is at (or near) the
   * bottom, or has just sent something; otherwise leave their place alone.
   */
  private commitMessages(body: HTMLElement, stage: HTMLElement) {
    const html = stage.innerHTML;
    // The tail node tells whether the list on screen is still ours (the
    // pre-chat form, for one, lives in the same box until it is done).
    if (html === this.lastMessagesHtml && this.lastMessagesTail && this.lastMessagesTail.parentNode === body) return;

    const last = this.messages[this.messages.length - 1];
    const lastId = last ? last.id : null;
    const visitorJustSent = Boolean(last && last.sender_type === 'visitor' && lastId !== this.lastMessageId);
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    const firstPaint = !this.lastMessagesTail;
    const keepAt = body.scrollTop;

    body.replaceChildren(...Array.from(stage.childNodes));
    this.lastMessagesHtml = html;
    this.lastMessagesTail = body.lastChild;
    this.lastMessageId = lastId;

    body.scrollTop = firstPaint || nearBottom || visitorJustSent ? body.scrollHeight : keepAt;
  }

  /**
   * WhatsApp's four states, each backed by a fact rather than a guess:
   *   pending   clock    not yet stored on the server
   *   sent      one tick stored, nobody has acknowledged it
   *   delivered two ticks the agent's client received it
   *   read      two blue the agent opened the conversation
   */
  private renderTicks(msg: MessageItem): string {
    const single =
      '<path d="M1 5.2 3.4 7.6 9 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
    const double =
      '<path d="M1 5.2 3.4 7.6 9 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M5.5 5.2 7.9 7.6 13.5 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';

    if (msg.pending) {
      return (
        '<span class="chatify-tick" title="Sending">' +
        '<svg viewBox="0 0 14 10" width="15" height="11">' +
        '<circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
        '<path d="M5 3v2.2l1.5.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
        '</svg></span>'
      );
    }

    if (msg.read_at) {
      return (
        '<span class="chatify-tick chatify-tick-read" title="Read">' +
        '<svg viewBox="0 0 14 10" width="15" height="11">' + double + '</svg></span>'
      );
    }

    if (msg.delivered_at) {
      return (
        '<span class="chatify-tick" title="Delivered">' +
        '<svg viewBox="0 0 14 10" width="15" height="11">' + double + '</svg></span>'
      );
    }

    return (
      '<span class="chatify-tick" title="Sent">' +
      '<svg viewBox="0 0 14 10" width="15" height="11">' + single + '</svg></span>'
    );
  }

  private unescapeHTML(str: string) {
    return str
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /** Escaped text with its links (URLs, www./bare domains, emails) as anchors. */
  private linkifyHTML(raw: string): string {
    return splitLinks(raw)
      .map((part) =>
        part.href
          ? `<a href="${this.escapeHTML(part.href)}"${part.href.startsWith('mailto:') ? '' : ' target="_blank"'} rel="noopener noreferrer">${this.escapeHTML(part.text)}</a>`
          : this.escapeHTML(part.text)
      )
      .join('');
  }

  private escapeHTML(str: string) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Validates URLs for HTML attributes (AUDIT H-7).
   * Allows only http:, https: (or data:image/ for image attributes like the built-in icon).
   * Rejects javascript:, data:text/html, vbscript: and any other dangerous schemes.
   */
  private safeUrl(url?: string | null, allowDataImage: boolean = false): string {
    if (!url) return '';
    const trimmed = url.trim();
    if (/^https?:\/\/[^\s"'<>]+/i.test(trimmed)) {
      return this.escapeHTML(trimmed);
    }
    if (/^\/help\/[a-zA-Z0-9_.\-\/]+$/i.test(trimmed)) {
      return this.escapeHTML(trimmed);
    }
    if (allowDataImage && /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
      return this.escapeHTML(trimmed);
    }
    return '';
  }

  public toggleWindow() {
    this.isOpen = !this.isOpen;
    const suffix = this.config.workspaceId ? `_${this.config.workspaceId.slice(0, 8)}` : '';
    try {
      sessionStorage.setItem(`zentry_widget_open${suffix}`, this.isOpen ? '1' : '0');
      sessionStorage.setItem(`chatify_widget_open${suffix}`, this.isOpen ? '1' : '0');
    } catch {}

    const win = this.shadow?.getElementById('chatifyWindow');
    const openIcon = this.shadow?.getElementById('chatifyIconOpen');
    const closeIcon = this.shadow?.getElementById('chatifyIconClose');

    const launcher = this.shadow?.getElementById('chatifyLauncherBtn');
    if (launcher) {
      launcher.classList.toggle('widget-is-open', this.isOpen);
    }
    if (this.container) {
      this.container.classList.toggle('widget-is-open', this.isOpen);
    }

    if (win && openIcon && closeIcon) {
      if (this.isOpen) {
        this.hideMessagePopup(false);
        win.style.display = 'flex';
        this.loadPreviousConversations();
        openIcon.style.display = 'none';
        closeIcon.style.display = 'block';
        if (this.activeTab === 'home' && isChatFirstDesign(this.config.widgetDesign)) {
          this.switchTab('messages');
        }

        if (this.activeTab === 'messages') {
          this.unreadCount = 0;
          this.updateUnreadBadge();
          this.markMessagesAsRead();
          this.scrollToBottom(false);
          this.adjustTextareaHeight();
          setTimeout(() => {
            (this.shadow?.getElementById('chatifyTextarea') as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
          }, 100);
        } else {
          this.updateUnreadBadge();
        }
      } else {
        win.style.display = 'none';
        openIcon.style.display = 'flex';
        closeIcon.style.display = 'none';
        this.closeEmojiPicker();
        this.updateUnreadBadge();
      }
    }
  }

  private updateUnreadBadge() {
    const badge = this.shadow?.getElementById('chatifyBadge');
    const navBadge = this.shadow?.getElementById('navMsgBadge');
    const homePill = this.shadow?.getElementById('homeCardUnreadPill');
    const homeCtaBadge = this.shadow?.getElementById('homeCardCtaBadge');
    const homeTitle = this.shadow?.getElementById('homeCardTitle');
    const launcher = this.shadow?.getElementById('chatifyLauncherBtn');

    // The halo ring only runs while something is actually waiting.
    launcher?.classList.toggle('has-unread', this.unreadCount > 0);

    if (this.unreadCount > 0) {
      const text = this.unreadCount > 9 ? '9+' : this.unreadCount.toString();
      if (badge) {
        badge.textContent = text;
        badge.style.display = 'flex';
      }
      if (navBadge) {
        navBadge.textContent = text;
        navBadge.style.display = 'flex';
      }
      if (homePill) {
        homePill.textContent = `${this.unreadCount} new ${this.unreadCount === 1 ? 'message' : 'messages'}`;
        homePill.style.display = 'inline-flex';
      }
      if (homeCtaBadge) {
        homeCtaBadge.textContent = text;
        homeCtaBadge.style.display = 'inline-flex';
      }
      if (homeTitle) {
        homeTitle.textContent = this.unreadCount === 1 ? 'You have 1 new reply' : `You have ${this.unreadCount} new replies`;
      }
    } else {
      if (badge) badge.style.display = 'none';
      if (navBadge) navBadge.style.display = 'none';
      if (homePill) homePill.style.display = 'none';
      if (homeCtaBadge) homeCtaBadge.style.display = 'none';
      if (homeTitle) homeTitle.textContent = 'Chat with us';
    }

    this.renderRecentConversation();
  }

  private formatRelativeTime(date: Date): string {
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  public renderRecentConversation() {
    const cardOpenConv = this.shadow?.getElementById('cardOpenConv');
    const cardStartChat = this.shadow?.getElementById('cardStartChat');
    const openConvSnippet = this.shadow?.getElementById('openConvSnippet');
    const openConvSender = this.shadow?.getElementById('openConvSender');
    const openConvTime = this.shadow?.getElementById('openConvTime');
    const openConvUnreadPill = this.shadow?.getElementById('openConvUnreadPill');
    const openConvCtaBadge = this.shadow?.getElementById('openConvCtaBadge');

    const hasMessages = Boolean(this.messages && this.messages.length > 0);
    if (!this.conversationId || !hasMessages) {
      if (cardOpenConv) cardOpenConv.style.display = 'none';
      if (cardStartChat) cardStartChat.style.display = 'block';
      return;
    }

    // Opened conversation exists! Show it here on the Home screen
    if (cardOpenConv) cardOpenConv.style.display = 'block';
    if (cardStartChat) cardStartChat.style.display = 'none';

    // Find the latest non-internal message
    const lastMsg = [...this.messages].reverse().find((m) => !m.is_internal);

    if (lastMsg) {
      // A one-line preview: the reply's markdown symbols are noise here.
      let snippet = (lastMsg.content || '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*•]\s+/gm, '')
        .replace(/\*\*|__|`/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (lastMsg.attachment_url) {
        snippet = snippet ? `📷 ${snippet}` : '📷 Sent a picture';
      }
      if (openConvSnippet) {
        openConvSnippet.textContent = snippet || 'Active conversation';
      }

      if (openConvSender) {
        if (lastMsg.sender_type === 'visitor') {
          openConvSender.textContent = 'You';
        } else if (lastMsg.sender_type === 'ai') {
          openConvSender.textContent = 'AI Assistant';
        } else {
          openConvSender.textContent = this.config.title || 'Support Team';
        }
      }

      if (openConvTime && lastMsg.created_at) {
        openConvTime.textContent = this.formatRelativeTime(new Date(lastMsg.created_at));
      }
    }

    if (this.unreadCount > 0) {
      if (openConvUnreadPill) {
        openConvUnreadPill.textContent = `${this.unreadCount} new`;
        openConvUnreadPill.style.display = 'inline-flex';
      }
      if (openConvCtaBadge) {
        openConvCtaBadge.textContent = this.unreadCount > 9 ? '9+' : this.unreadCount.toString();
        openConvCtaBadge.style.display = 'inline-flex';
      }
    } else {
      if (openConvUnreadPill) openConvUnreadPill.style.display = 'none';
      if (openConvCtaBadge) openConvCtaBadge.style.display = 'none';
    }
  }

  public scrollToBottom(smooth: boolean = false) {
    const body = this.shadow?.getElementById('chatifyBody');
    if (!body) return;

    // Only the chat box scrolls. scrollIntoView also scrolled the website
    // around the widget, which made the customer's page jump.
    const performScroll = () => {
      if (smooth && typeof body.scrollTo === 'function') body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
      else body.scrollTop = body.scrollHeight;
    };

    // 1. Immediate scroll
    performScroll();

    // 2. Next animation frame (after browser layout reflow)
    requestAnimationFrame(() => performScroll());

    // 3. 50ms timeout for DOM paint
    setTimeout(performScroll, 50);

    // 4. 200ms timeout for layout stabilization
    setTimeout(performScroll, 200);

    // 5. If any images inside body are still loading, re-scroll when they load
    const imgs = body.querySelectorAll('img');
    imgs.forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', () => performScroll(), { once: true });
        img.addEventListener('error', () => performScroll(), { once: true });
      }
    });
  }

  public open(tab?: 'home' | 'messages' | 'help') {
    this.hideMessagePopup(false);
    if (!this.isOpen) {
      this.toggleWindow();
    }
    if (tab) {
      this.switchTab(tab);
    }
    if (this.activeTab === 'messages') {
      this.scrollToBottom(false);
    }
  }

  public close() {
    if (this.isOpen) {
      this.toggleWindow();
    }
  }

  public toggle() {
    this.toggleWindow();
  }

  public openHelp() {
    if (this.config.showHelpTab === false || this.faqs.length === 0) {
      this.open('home');
      return;
    }
    this.open('help');
    setTimeout(() => {
      (this.shadow?.getElementById('helpSearchInput') as HTMLInputElement)?.focus({ preventScroll: true });
    }, 120);
  }

  public openMessages() {
    this.open('messages');
  }

  public getIsOpen(): boolean {
    return this.isOpen;
  }

  // ── Brand Avatar & Overlay Helpers ─────────────────────────────────────
  public getBrandInitial(): string {
    const raw = (this.config.businessName || this.config.title || 'Support')
      .replace(/^Welcome to\s+/i, '')
      .replace(/\s*Support\s*$/i, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]+\s*$/u, '')
      .replace(/^the\s+/i, '')
      .trim();
    return (raw.charAt(0) || 'S').toUpperCase();
  }

  public renderBrandAvatarHTML(includeOnlineDot: boolean = false): string {
    const initial = this.getBrandInitial();
    const dotHTML = includeOnlineDot ? '<span class="chatify-online-dot"></span>' : '';

    const safeLogo = this.safeUrl(this.config.logoUrl, true);
    if (safeLogo) {
      return `
        <img src="${safeLogo}" alt="Logo" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" onerror="this.style.display='none';if(this.nextElementSibling){this.nextElementSibling.style.display='flex';}" />
        <span class="chatify-avatar-initial" style="display:none;width:100%;height:100%;border-radius:inherit;background:var(--w-brand);color:var(--w-on-brand);align-items:center;justify-content:center;font-weight:700;font-size:inherit;">${this.escapeHTML(initial)}</span>
        ${dotHTML}
      `;
    }

    return `
      <span class="chatify-avatar-initial" style="display:flex;width:100%;height:100%;border-radius:inherit;background:var(--w-brand);color:var(--w-on-brand);align-items:center;justify-content:center;font-weight:700;font-size:inherit;">${initial}</span>
      ${dotHTML}
    `;
  }

  public hasHostModalOrOverlay(): boolean {
    if (typeof document === 'undefined') return false;
    try {
      // 1. Check native <dialog open> or ARIA dialog/alertdialog elements
      const dialogElements = document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      for (let i = 0; i < dialogElements.length; i++) {
        const el = dialogElements[i] as HTMLElement;
        if (this.container && (el === this.container || this.container.contains(el))) continue;
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return true;
          }
        }
      }

      // 2. Check for fixed or absolute full-screen overlays covering >= 70% viewport
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (vw > 0 && vh > 0) {
        const candidates = document.querySelectorAll('div, section, aside, [class*="modal"], [class*="overlay"], [class*="backdrop"]');
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i] as HTMLElement;
          if (this.container && (el === this.container || this.container.contains(el))) continue;

          const style = window.getComputedStyle(el);
          if ((style.position === 'fixed' || style.position === 'absolute') &&
              style.display !== 'none' &&
              style.visibility !== 'hidden') {
            const opacity = parseFloat(style.opacity || '1');
            if (opacity > 0.05) {
              const rect = el.getBoundingClientRect();
              if (rect.width >= vw * 0.7 && rect.height >= vh * 0.7) {
                return true;
              }
            }
          }
        }
      }
    } catch {
      // Fail safely without throwing
    }
    return false;
  }

  private initProactiveWelcome() {
    if (this.config.enableProactiveWelcome === false) return;
    const delay = Math.max(8, this.config.proactiveDelaySeconds || 8);

    setTimeout(() => {
      if (this.isOpen || this.messages.length > 0) return;
      try {
        if (
          sessionStorage.getItem('zentry_proactive_welcome_dismissed') === '1' ||
          sessionStorage.getItem('chatify_proactive_welcome_dismissed') === '1'
        ) return;
      } catch {}

      if (this.hasHostModalOrOverlay()) return;

      const rawName = (this.config.businessName || this.config.title || 'Support')
        .replace(/^Welcome to\s+/i, '')
        .replace(/\s*Support\s*$/i, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]+\s*$/u, '')
        .replace(/^the\s+/i, '')
        .trim() || 'Support';
      const customWelcome = this.config.welcomeText?.trim();
      const welcomeContent = customWelcome
        ? customWelcome.charAt(0).toUpperCase() + customWelcome.slice(1)
        : `Welcome to ${rawName}`;

      this.showMessagePopup({
        id: 'proactive-welcome',
        content: welcomeContent,
      }, rawName);
    }, delay * 1000);
  }

  // ── Unread Message Popup Helpers ─────────────────────────────────────
  private getSenderInitials(name: string): string {
    if (!name) return 'TD';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'TD';
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  public showMessagePopup(message: { id?: string; content?: string; attachment_url?: string | null }, senderName?: string) {
    if (this.isOpen) return;
    if (this.hasHostModalOrOverlay()) return;
    const popup = this.shadow?.getElementById('chatifyMessagePopup');
    if (!popup) return;

    if (this.popupCloseTimer) {
      clearTimeout(this.popupCloseTimer);
      this.popupCloseTimer = null;
    }

    this.currentPopupMsgId = message.id || null;

    const title = senderName || this.config.businessName || this.config.title || 'Trader Care Desk';
    const initials = this.getSenderInitials(title);

    const titleEl = this.shadow?.getElementById('chatifyPopupTitle');
    if (titleEl) titleEl.textContent = title;

    const avatarEl = this.shadow?.getElementById('chatifyPopupAvatar');
    if (avatarEl) {
      const safeLogo = this.safeUrl(this.config.logoUrl, true);
      if (safeLogo) {
        const safeInitials = this.escapeHTML(initials.replace(/['\\<>\r\n]/g, '').slice(0, 10));
        avatarEl.innerHTML = `<img src="${safeLogo}" alt="Avatar" onerror="this.parentElement.textContent='${safeInitials}'" />`;
      } else {
        avatarEl.textContent = initials;
      }
    }

    const textEl = this.shadow?.getElementById('chatifyPopupMessageText');
    if (textEl) {
      textEl.textContent = message.content || (message.attachment_url ? 'Sent an attachment 📎' : 'New message');
    }

    popup.classList.remove('closing');
    popup.style.display = 'flex';
  }

  public hideMessagePopup(animate: boolean = true) {
    const popup = this.shadow?.getElementById('chatifyMessagePopup');
    if (!popup || popup.style.display === 'none') return;

    if (!animate) {
      popup.style.display = 'none';
      popup.classList.remove('closing');
      return;
    }

    popup.classList.add('closing');
    if (this.popupCloseTimer) clearTimeout(this.popupCloseTimer);
    this.popupCloseTimer = setTimeout(() => {
      popup.style.display = 'none';
      popup.classList.remove('closing');
      this.popupCloseTimer = null;
    }, 200);
  }

  public dismissMessagePopup() {
    if (this.currentPopupMsgId) {
      try {
        sessionStorage.setItem(`zentry_popup_dismissed_${this.currentPopupMsgId}`, '1');
        sessionStorage.setItem(`chatify_popup_dismissed_${this.currentPopupMsgId}`, '1');
      } catch {}
    }
    try {
      sessionStorage.setItem('zentry_proactive_welcome_dismissed', '1');
      sessionStorage.setItem('chatify_proactive_welcome_dismissed', '1');
    } catch {}
    this.hideMessagePopup(true);
  }

  private async sendPopupReply() {
    const input = this.shadow?.getElementById('chatifyPopupInput') as HTMLInputElement | null;
    const sendBtn = this.shadow?.getElementById('chatifyPopupSendBtn');
    const text = input?.value.trim() || '';
    if (!text) return;

    if (input) input.value = '';
    sendBtn?.classList.remove('active');

    this.hideMessagePopup(false);
    this.open('messages');
    await this.sendMessage(text);
  }

  public showPopup(text?: string, senderTitle?: string) {
    this.showMessagePopup(
      {
        id: 'test-' + Date.now(),
        content: text || 'Hi, how can we help?',
      },
      senderTitle || 'Trader Care Desk'
    );
  }

  public hidePopup() {
    this.hideMessagePopup(true);
  }

  private subscribeToVisitorConversations(storageKeySuffix: string) {
    if (!this.visitorId) return;
    if (!this.legacyData) {
      // A conversation the team starts arrives on the session topic (or the poll).
      this.startLiveUpdates();
      return;
    }
    this.supabase
      .channel(`zen-try-visitor-convs-${this.visitorId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'conversations',
          filter: `visitor_id=eq.${this.visitorId}`,
        },
        async (payload) => {
          const conv = payload.new as { id?: string; status?: string; workspace_id?: string };
          if (conv?.id && (!this.config.workspaceId || conv.workspace_id === this.config.workspaceId)) {
            this.conversationId = conv.id;
            this.conversationStatus = conv.status || 'open';
            localStorage.setItem(`zentry_conversation_id${storageKeySuffix}`, conv.id);
            localStorage.setItem(`chatify_conversation_id${storageKeySuffix}`, conv.id);
            await this.loadMessageHistory();
            this.subscribeToRealtime();
          }
        }
      )
      .subscribe();
  }

  public search(query: string) {
    this.open('help');
    this.activeSectionId = null;
    this.faqSearchQuery = (query || '').trim();
    setTimeout(() => {
      const faqSearch = this.shadow?.getElementById('helpSearchInput') as HTMLInputElement | null;
      if (faqSearch) {
        faqSearch.value = query;
        faqSearch.focus();
      }
      this.renderFaqList();
    }, 100);
  }

  public async openArticle(idOrSlug: string) {
    if (!idOrSlug) return;
    this.open('help');

    const clean = idOrSlug.trim().toLowerCase();
    const targetFaq = this.faqs.find(
      (f) => (f.id && f.id.toLowerCase() === clean) || (f.slug && f.slug.toLowerCase() === clean)
    );

    if (targetFaq) {
      this.activeSectionId = targetFaq.sectionId || (this.sections.length > 0 ? this.sections[0].id : null);
      this.faqSearchQuery = '';
      const faqSearch = this.shadow?.getElementById('helpSearchInput') as HTMLInputElement | null;
      if (faqSearch) faqSearch.value = '';
      this.renderFaqList();

      setTimeout(() => {
        const items = this.shadow?.querySelectorAll<HTMLElement>('.chatify-faq-item');
        let targetItem: HTMLElement | null = null;

        if (items) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const id = (item.getAttribute('data-id') || '').toLowerCase();
            const slug = (item.getAttribute('data-slug') || '').toLowerCase();
            if (id === clean || slug === clean) {
              targetItem = item;
              break;
            }
          }
        }

        if (targetItem) {
          const targetEl = targetItem as HTMLElement;
          if (!targetEl.classList.contains('open')) {
            targetEl.classList.add('open');
          }
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);
    }
  }

  private bindGlobalTriggers() {
    if (typeof document === 'undefined') return;

    document.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // 1. Help tab trigger: [data-zentry-help], [data-chatify-help], .zentry-help-trigger, .chatify-help-trigger
      const helpTrigger = target.closest('[data-zentry-help], [data-chatify-help], .zentry-help-trigger, .chatify-help-trigger');
      if (helpTrigger) {
        e.preventDefault();
        if (this.config.showHelpTab === false || this.faqs.length === 0) {
          return;
        }
        this.openHelp();
        return;
      }

      // 2. Open specific article: [data-zentry-article], [data-chatify-article]
      const articleTrigger = target.closest('[data-zentry-article], [data-chatify-article]');
      if (articleTrigger) {
        e.preventDefault();
        const articleIdOrSlug = articleTrigger.getAttribute('data-zentry-article') || articleTrigger.getAttribute('data-chatify-article') || '';
        if (articleIdOrSlug) {
          this.openArticle(articleIdOrSlug);
        } else {
          this.openHelp();
        }
        return;
      }

      // 3. General open trigger: [data-zentry-open], [data-chatify-open], .zentry-open-trigger, .chatify-open-trigger
      const openTrigger = target.closest('[data-zentry-open], [data-chatify-open], .zentry-open-trigger, .chatify-open-trigger');
      if (openTrigger) {
        e.preventDefault();
        const targetTab = (openTrigger.getAttribute('data-zentry-tab') || openTrigger.getAttribute('data-chatify-tab')) as 'home' | 'messages' | 'help' | null;
        this.open(targetTab || 'home');
        return;
      }

      // 4. Close trigger: [data-zentry-close], [data-chatify-close]
      const closeTrigger = target.closest('[data-zentry-close], [data-chatify-close]');
      if (closeTrigger) {
        e.preventDefault();
        this.close();
        return;
      }

      // 5. Toggle trigger: [data-zentry-toggle], [data-chatify-toggle]
      const toggleTrigger = target.closest('[data-zentry-toggle], [data-chatify-toggle]');
      if (toggleTrigger) {
        e.preventDefault();
        this.toggle();
        return;
      }
    });
  }

  /**
   * Navbar "Help" button, added to the customer's own site menu with no code
   * (Settings → Help center → Website navbar button).
   *
   * Rules:
   * 1. Only ADD a link; never change an existing link on the host site.
   * 2. Only in the site's top navigation: never in a footer, sidebar or the
   *    widget. Busy footers used to win because they have the most links.
   * 3. Put it next to the menu's own links (after the last, or before the
   *    first), not after the "Log in" buttons that often close a header.
   * 4. Look like the menu's links (their classes and type), minus "active"
   *    state classes, or as a pill in the brand colour.
   * 5. Once in the desktop menu and once in the mobile menu (when the site
   *    has one), each re-added on its own after the site re-renders (SPA
   *    route changes rebuild headers).
   * 6. Nothing when: the feature is off; the page opts out with
   *    data-zentry-no-nav; the site already links its help center or has a
   *    manual data-zentry-help button; we are on the help center itself; or
   *    no navigation is found with confidence. The help panel needs
   *    published articles; "open chat" does not.
   */
  private initNavbarAutoTrigger() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const navConfig = this.config.navbarTriggerConfig;
    const OUR_ROOT = '#zentry-widget-root, #chatify-widget-root, #chatifyWidgetContainer, [data-zentry-root]';
    const MARK = '[data-zentry-nav], [data-chatify-nav]';

    const removeInjectedNodes = () => {
      document.querySelectorAll(MARK).forEach((el) => el.remove());
      // Leftovers from older widget versions.
      ['zentryNavTriggerBtn', 'zentryNavTriggerBtnMobile', 'chatifyNavTriggerBtn', 'chatifyNavTriggerBtnMobile'].forEach((id) =>
        document.getElementById(id)?.remove()
      );
      document.querySelectorAll('[data-zentry-hooked], [data-chatify-hooked]').forEach((el) => {
        el.removeAttribute('data-zentry-hooked');
        el.removeAttribute('data-chatify-hooked');
      });
    };
    const stopObserver = () => {
      const self = this as unknown as { __navObserver?: MutationObserver };
      self.__navObserver?.disconnect();
      self.__navObserver = undefined;
    };

    if (!navConfig || navConfig.enabled !== true || document.querySelector('[data-zentry-no-nav]')) {
      stopObserver();
      removeInjectedNodes();
      return;
    }

    const action = navConfig.action || 'help';
    // The help panel (and the help center) are empty without articles; chat is not.
    if (action !== 'messages' && !(Array.isArray(this.faqs) && this.faqs.length > 0)) {
      stopObserver();
      removeInjectedNodes();
      return;
    }

    // The help center itself never gets the button.
    const cleanHost = (h: string) => h.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    const currentHost = cleanHost(window.location.hostname);
    const customDomain = this.config.customDomain ? cleanHost(this.config.customDomain) : '';
    if ((customDomain && currentHost === customDomain) || /(^|\.)(zentryhelp|chatifyhelp)\.com$/.test(currentHost) || window.location.pathname.toLowerCase().startsWith('/help/')) {
      stopObserver();
      removeInjectedNodes();
      return;
    }

    // Where "redirect" goes: the live custom domain, else the platform's own
    // help-center route, which works for every workspace (a bare /help/<id>
    // would point at the customer's site, where it does not exist).
    const apiBase = (this.config.apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
    const helpCenterUrl = customDomain
      ? `https://${customDomain}`
      : this.config.workspaceId
      ? `${apiBase}/help/${encodeURIComponent(this.config.workspaceId)}`
      : '';

    // The site already links its help center, or placed our button by hand.
    const linksHelpCenter = (a: HTMLAnchorElement) => {
      if (a.closest(MARK)) return false;
      const href = (a.getAttribute('href') || '').toLowerCase();
      if (!href || href === '#' || href.startsWith('javascript:')) return false;
      return (
        (customDomain !== '' && href.includes(customDomain)) ||
        (this.config.workspaceId !== null && href.includes(`/help/${this.config.workspaceId.toLowerCase()}`)) ||
        /zentryhelp\.com|chatifyhelp\.com/.test(href)
      );
    };
    if (
      document.querySelector('[data-zentry-help]:not([data-zentry-nav]), [data-chatify-help]:not([data-chatify-nav]), .zentry-help-trigger, header [data-zentry-open], nav [data-zentry-open]') ||
      Array.from(document.querySelectorAll<HTMLAnchorElement>('header a, nav a, [role="navigation"] a')).some(linksHelpCenter)
    ) {
      stopObserver();
      removeInjectedNodes();
      return;
    }

    const label = (navConfig.label || 'Help').trim().slice(0, 40);
    if (!label) return;
    const position = navConfig.position === 'start' ? 'start' : 'end';
    const style = navConfig.style === 'pill' ? 'pill' : 'navbar_link';

    const outside = (el: Element) =>
      Boolean(el.closest(`${OUR_ROOT}, footer, aside, [role="contentinfo"], [class*="footer" i], [id*="footer" i], [class*="sidebar" i]`));

    /** Links a visitor would read as menu items (not icons, not empty). */
    const menuLinks = (root: Element): HTMLAnchorElement[] =>
      Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(
        (a) => !a.closest(MARK) && (a.textContent || '').trim().length > 0 && (a.textContent || '').trim().length <= 40
      );

    const isHidden = (el: Element) => {
      const cs = window.getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden';
    };

    /** In the site header: a header element, or a pinned (sticky/fixed) bar. */
    const inHeaderBar = (el: Element) => {
      if (el.closest('header, [role="banner"]')) return true;
      let n: Element | null = el;
      while (n && n !== document.body) {
        const pos = window.getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky') return true;
        n = n.parentElement;
      }
      return false;
    };
    /** The header, or anything near the top of the page. */
    const isTopArea = (el: Element) => inHeaderBar(el) || el.getBoundingClientRect().top + window.scrollY < 260;

    /**
     * Inside a chosen navigation, the element that holds the menu items as
     * its direct children: a <ul> of <li>s, or a flex row of <a>s.
     */
    const itemGroup = (root: HTMLElement): { group: HTMLElement; items: HTMLElement[] } | null => {
      let best: { group: HTMLElement; items: HTMLElement[] } | null = null;
      const consider = (el: HTMLElement) => {
        const items = Array.from(el.children).filter((c): c is HTMLElement => {
          if (!(c instanceof HTMLElement) || c.matches(MARK)) return false;
          const tag = c.tagName.toLowerCase();
          if (tag === 'a') return menuLinks(el).includes(c as HTMLAnchorElement);
          if (tag === 'li') return Boolean(c.querySelector('a[href]'));
          return false;
        });
        if (items.length >= 2 && (!best || items.length > best.items.length)) best = { group: el, items };
      };
      consider(root);
      root.querySelectorAll<HTMLElement>('ul, ol, div, span').forEach((el) => {
        if (!el.closest('ul ul, ol ol, li ul, li ol')) consider(el); // skip dropdown submenus
      });
      return best;
    };

    const findDesktop = (): HTMLElement | null => {
      const explicit = navConfig.target_selector?.trim();
      if (explicit) {
        try {
          const el = document.querySelector<HTMLElement>(explicit);
          if (el && !el.closest(OUR_ROOT)) return el;
        } catch {
          // An invalid selector falls back to detection.
        }
      }
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('header nav, nav, [role="navigation"], header ul, .navbar, .navbar-nav, [class*="menu" i], [class*="nav" i]')
      ).filter((el) => !outside(el) && !isHidden(el) && isTopArea(el));
      // Utility-class sites (Tailwind) mark nothing as a menu: a row of three
      // or more sibling links in the header bar (or the very top of the page)
      // counts too. Siblings only, so a whole header or a hero's two
      // call-to-action buttons never do.
      const seen = new Set<HTMLElement>(candidates);
      document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
        const row = a.parentElement;
        if (!row || seen.has(row) || row === document.body) return;
        seen.add(row);
        if (outside(row) || isHidden(row)) return;
        const own = menuLinks(row).filter((l) => l.parentElement === row && !isHidden(l));
        if (own.length >= 3 && (inHeaderBar(row) || row.getBoundingClientRect().top + window.scrollY < 160)) candidates.push(row);
      });

      let best: HTMLElement | null = null;
      let bestScore = -1;
      for (const el of candidates) {
        const links = menuLinks(el).filter((a) => !isHidden(a));
        if (links.length < 2 || links.length > 30) continue;
        let score = Math.min(links.length, 12) * 3;
        if (el.tagName === 'NAV' || el.getAttribute('role') === 'navigation') score += 10;
        if (el.closest('header, [role="banner"]')) score += 15;
        if (/mobile|drawer|offcanvas/i.test(`${el.className} ${el.id}`)) score -= 25;
        // The smallest element that still holds the menu wins ties.
        if (score > bestScore || (score === bestScore && best && best.contains(el))) {
          best = el;
          bestScore = score;
        }
      }
      return best;
    };

    const findMobile = (desktop: HTMLElement | null): HTMLElement | null => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[class*="mobile" i], [id*="mobile" i], [class*="drawer" i], [id*="drawer" i], [class*="offcanvas" i], [class*="off-canvas" i], [class*="hamburger" i] + *, [class*="responsive-menu" i]'
        )
      ).filter((el) => {
        if (outside(el) || (desktop && (el === desktop || el.contains(desktop) || desktop.contains(el)))) return false;
        // A menu, not any block that mentions "mobile" (app banners, promos).
        const named = `${typeof el.className === 'string' ? el.className : ''} ${el.id}`;
        if (!el.closest('header, nav, [role="navigation"], [role="dialog"]') && !/menu|nav|drawer|offcanvas|off-canvas/i.test(named)) return false;
        const links = menuLinks(el);
        return links.length >= 2 && links.length <= 30;
      });
      // The innermost one: the menu itself rather than its whole panel.
      return candidates.find((el) => !candidates.some((other) => other !== el && el.contains(other))) || null;
    };

    const STATE_CLASS = /^(active|is-active|current|current-menu-item|current_page_item|selected|router-link-active|router-link-exact-active|aria-current)$/i;
    const copyClasses = (from: Element | null) =>
      from ? Array.from(from.classList).filter((c) => !STATE_CLASS.test(c) && !/active|current/i.test(c)).join(' ') : '';

    const makeLink = (sample: HTMLAnchorElement | null, kind: 'desktop' | 'mobile') => {
      const a = document.createElement('a');
      a.textContent = label;
      a.setAttribute('data-zentry-nav', kind);
      a.setAttribute('data-chatify-nav', kind);
      if (action === 'redirect' && /^https?:\/\/[^\s"'<>]+$/i.test(helpCenterUrl)) {
        a.href = helpCenterUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      } else {
        a.href = '#';
        a.setAttribute('role', 'button');
        a.addEventListener('click', (e) => {
          e.preventDefault();
          if (action === 'messages') this.openMessages();
          else this.openHelp();
        });
      }

      if (style === 'pill') {
        const bg = /^#[0-9a-f]{3,8}$/i.test(this.config.primaryColor || '') ? this.config.primaryColor : '#2563eb';
        a.style.cssText =
          `display:inline-flex;align-items:center;justify-content:center;padding:${kind === 'mobile' ? '6px 14px' : '6px 16px'};` +
          `font-size:14px;font-weight:600;line-height:1.4;border-radius:9999px;background:${bg};color:#fff;` +
          'text-decoration:none;cursor:pointer;white-space:nowrap;align-self:center;';
      } else if (sample) {
        a.className = copyClasses(sample);
        try {
          const cs = window.getComputedStyle(sample);
          // Type and colour from the menu; layout comes with its classes.
          a.style.color = cs.color;
          a.style.fontFamily = cs.fontFamily;
          a.style.fontSize = cs.fontSize;
          a.style.fontWeight = cs.fontWeight;
          a.style.letterSpacing = cs.letterSpacing;
          a.style.textTransform = cs.textTransform;
          a.style.textDecoration = 'none';
          a.style.cursor = 'pointer';
        } catch {
          // Styles are a nicety.
        }
      } else {
        a.style.cssText = 'display:inline-flex;align-items:center;font-size:14px;font-weight:500;color:inherit;text-decoration:none;cursor:pointer;padding:6px 12px;';
      }
      return a;
    };

    const injectInto = (root: HTMLElement, kind: 'desktop' | 'mobile') => {
      if (document.querySelector(`[data-zentry-nav="${kind}"]`)) return;
      const found = itemGroup(root);
      const group = found?.group ?? root;
      const items = found?.items ?? [];
      const anchorItem = position === 'start' ? items[0] : items[items.length - 1];
      const sampleLink =
        (anchorItem && (anchorItem.tagName === 'A' ? (anchorItem as HTMLAnchorElement) : anchorItem.querySelector<HTMLAnchorElement>('a[href]'))) ||
        menuLinks(root)[0] ||
        null;
      const link = makeLink(sampleLink, kind);

      let node: HTMLElement = link;
      if (anchorItem && anchorItem.tagName === 'LI') {
        const li = document.createElement('li');
        li.className = copyClasses(anchorItem);
        li.setAttribute('data-zentry-nav', kind);
        li.setAttribute('data-chatify-nav', kind);
        li.appendChild(link);
        node = li;
      } else if (group.tagName === 'UL' || group.tagName === 'OL') {
        const li = document.createElement('li');
        li.setAttribute('data-zentry-nav', kind);
        li.setAttribute('data-chatify-nav', kind);
        li.appendChild(link);
        node = li;
      }

      if (anchorItem && anchorItem.parentElement === group) {
        if (position === 'start') group.insertBefore(node, anchorItem);
        else anchorItem.after(node);
      } else if (position === 'start' && group.firstChild) {
        group.insertBefore(node, group.firstChild);
      } else {
        group.appendChild(node);
      }
    };

    const inject = () => {
      const desktop = findDesktop();
      const mobile = findMobile(desktop);
      if (desktop) injectInto(desktop, 'desktop');
      if (mobile) injectInto(mobile, 'mobile');
    };

    inject();

    // Sites that rebuild their header (SPA navigation, cookie banners, late
    // menus) get the button back; each menu is checked on its own.
    if (typeof MutationObserver !== 'undefined' && document.body) {
      stopObserver();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const observer = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (!document.querySelector('[data-zentry-nav="desktop"]') || !document.querySelector('[data-zentry-nav="mobile"]')) inject();
        }, 300);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      (this as unknown as { __navObserver?: MutationObserver }).__navObserver = observer;
    }
  }
}

if (typeof window !== 'undefined') {
  // If window.Zentry or window.Chatify not defined, initialize placeholder queue so early calls don't crash
  const makeStub = () => {
    const queue: any[] = [];
    const stub: any = {
      q: queue,
      open: (...args: any[]) => queue.push(['open', args]),
      close: (...args: any[]) => queue.push(['close', args]),
      toggle: (...args: any[]) => queue.push(['toggle', args]),
      openHelp: (...args: any[]) => queue.push(['openHelp', args]),
      openMessages: (...args: any[]) => queue.push(['openMessages', args]),
      openArticle: (...args: any[]) => queue.push(['openArticle', args]),
      search: (...args: any[]) => queue.push(['search', args]),
      isOpen: () => false,
      resetSession: () => {},
      switchTab: (...args: any[]) => queue.push(['switchTab', args]),
      showPopup: (...args: any[]) => queue.push(['showPopup', args]),
      hidePopup: (...args: any[]) => queue.push(['hidePopup', args]),
    };
    return stub;
  };

  const initialStub =
    (window as any).Zentry ||
    (window as any)['Zen-try'] ||
    (window as any).Chatify ||
    makeStub();

  (window as any).Zentry = initialStub;
  (window as any)['Zen-try'] = initialStub;
  (window as any).Chatify = initialStub;

  const init = () => {
    const widget = new ZentryWidget();
    (window as any).__ZentryInstance = widget;
    (window as any).__ChatifyInstance = widget;

    // Check if window.Zentry or window.Chatify had a queue of pre-invoked commands
    const existingQueueSource = (window as any).Zentry || (window as any)['Zen-try'] || (window as any).Chatify;
    const queue = Array.isArray(existingQueueSource?.q)
      ? existingQueueSource.q
      : Array.isArray(existingQueueSource)
      ? existingQueueSource
      : [];

    const api: ZentryAPI = {
      open: (tab) => widget.open(tab),
      close: () => widget.close(),
      toggle: () => widget.toggle(),
      openHelp: () => widget.openHelp(),
      openMessages: () => widget.openMessages(),
      openArticle: (idOrSlug) => widget.openArticle(idOrSlug),
      search: (query) => widget.search(query),
      isOpen: () => widget.getIsOpen(),
      resetSession: () => widget.resetSession(),
      switchTab: (tab) => widget.switchTab(tab),
      showPopup: (text, senderTitle) => widget.showPopup(text, senderTitle),
      hidePopup: () => widget.hidePopup(),
      instance: widget,
    };

    (window as any).Zentry = api;
    (window as any)['Zen-try'] = api;
    (window as any).Chatify = api;

    // Flush any queued method calls if callers pushed items like ['openHelp', []]
    if (queue.length > 0) {
      for (const item of queue) {
        if (Array.isArray(item)) {
          const [method, args = []] = item;
          if (typeof (api as any)[method] === 'function') {
            (api as any)[method](...args);
          }
        } else if (typeof item === 'function') {
          try {
            item(api);
          } catch (e) {}
        }
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

export { ZentryWidget, ZentryWidget as ChatifyWidget };
