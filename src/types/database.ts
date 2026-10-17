export type AgentStatus = 'online' | 'away' | 'offline';
export type AgentRole = 'owner' | 'admin' | 'agent' | 'light_agent';
export type ConversationStatus = 'open' | 'closed' | 'snoozed' | 'pending';
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SenderType = 'visitor' | 'agent' | 'system' | 'ai';
export type ChannelType = 'web' | 'whatsapp' | 'facebook' | 'instagram' | 'threads' | 'linkedin';
export type AiMode = 'autopilot' | 'copilot' | 'disabled';

// ============================================================================
// 1. Visitors
// ============================================================================
export interface Visitor {
  id: string;
  name: string | null;
  email: string | null;
  first_seen_at: string;
  last_seen_at: string;
  current_page_url: string;
  current_page_title: string | null;
  ip_location_city: string | null;
  ip_location_country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  referrer_source: string | null;
  /** When the visitor landed on the current page. */
  current_page_entered_at?: string | null;
  /** Time spent on current page in seconds, updated during heartbeats. */
  time_on_page_seconds?: number;
  /** IANA zone, populated once the visitor timezone/language migration runs. */
  timezone?: string | null;
  /** BCP-47 tag from the visitor's browser, e.g. "en-IN". */
  language?: string | null;
  visit_count: number;
  is_online: boolean;

  // Backwards compatibility aliases
  first_seen: string;
  last_seen: string;
  current_url: string;
  location: string | null;
  user_agent: string | null;
  ip_address: string | null;
  workspace_id?: string | null;
  channel?: ChannelType;
  channel_user_id?: string | null;
  channel_metadata?: Record<string, any> | null;
}

export type VisitorInsert = Partial<Visitor>;

// ============================================================================
// 2. Agents
// ============================================================================
export interface Agent {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  role: AgentRole;
  status: AgentStatus;
  created_at: string;
  workspace_id?: string | null;
  is_super_admin?: boolean;
  is_platform_owner?: boolean;
  platform_staff_role?: 'owner' | 'support' | 'finance' | null;
  /** False once an admin has deactivated them: no access, history kept. */
  is_active?: boolean;
  deactivated_at?: string | null;
  /** Most New + Open tickets round-robin and auto-assignment will give them; null for no limit. */
  max_open_tickets?: number | null;
}

export interface SuperAdminAuditLog {
  id: string;
  admin_id: string;
  admin_email: string;
  admin_name: string | null;
  action: string;
  workspace_id: string | null;
  workspace_name: string | null;
  details: Record<string, any>;
  created_at: string;
}

export type PlatformAccessRole = 'owner' | 'admin';

export interface PlatformAccess {
  id: string;
  user_id: string;
  role: PlatformAccessRole;
  granted_by: string | null;
  granted_at: string;
}

export interface PlatformAccessMember {
  id: string;
  user_id: string;
  email: string;
  name: string;
  role: PlatformAccessRole;
  granted_by: string | null;
  granted_by_email: string | null;
  granted_at: string;
}

export type AdminInviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface AdminInvite {
  id: string;
  email: string;
  role: PlatformAccessRole;
  token_hash: string;
  status: AdminInviteStatus;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

export interface AdminInviteItem {
  id: string;
  email: string;
  role: PlatformAccessRole;
  status: AdminInviteStatus;
  invited_by: string;
  invited_by_email: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  invite_url?: string;
}

export type AgentInsert = Partial<Agent>;

// ============================================================================
// 3. Conversations
// ============================================================================
export interface Conversation {
  id: string;
  visitor_id: string;
  assigned_agent_id: string | null;
  status: ConversationStatus;
  priority: ConversationPriority;
  created_at: string;
  updated_at: string;
  closed_at: string | null;

  // Joined relation fields
  visitor?: Visitor;
  agent?: Agent | null;
  last_message?: Message | null;
  unread_count?: number;

  // Compatibility / multi-tenant fields
  agent_id?: string | null;
  workspace_id?: string | null;
  tags?: string[] | null;
  csat_rating?: number | null;
  csat_feedback?: string | null;
  channel?: ChannelType;
  channel_user_id?: string | null;
  channel_metadata?: Record<string, any> | null;
  ai_mode?: AiMode;
  /** Goes up on every change of who answers; a bot reply written before the change is not delivered. */
  ai_control_version?: number;
  /** Why the bot is off: a person replied, an agent paused it, the visitor asked for a person, ... */
  ai_paused_reason?: 'human_reply' | 'agent_paused' | 'human_requested' | 'needs_attention' | 'system' | null;
  ai_control_changed_at?: string | null;
  /** When the bot was last switched back on. */
  ai_resumed_at?: string | null;
  /** The bot is on but handed a question to the team. */
  ai_needs_attention_at?: string | null;
  last_resolved_at?: string | null;
  snoozed_until?: string | null;
  merged_into?: string | null;
  summary?: string | null;
  sentiment?: 'positive' | 'neutral' | 'negative' | null;
  /** Where the conversation's next message goes. */
  current_ticket_id?: string | null;
  /** When the customer last wrote on an outside channel (WhatsApp's 24-hour window starts here). */
  channel_last_inbound_at?: string | null;
}

export type ConversationInsert = Partial<Conversation>;

// ============================================================================
// 4. Messages
// ============================================================================
export interface Message {
  id: string;
  conversation_id: string;
  sender_type: SenderType;
  sender_id: string | null;
  content: string;
  attachment_url: string | null;
  created_at: string;
  /** Set when the recipient's client acknowledged receipt. */
  delivered_at?: string | null;
  read_at: string | null;
  /** Client-only: true while an optimistic message is still in flight. */
  pending?: boolean;
  /** The message this one quotes, when the sender replied to a specific one. */
  reply_to_message_id?: string | null;

  // Joined or metadata
  agent?: Agent | null;
  is_internal?: boolean;
  metadata?: Record<string, any> | null;
  email_notified_at?: string | null;
  /** The ticket this message belongs to (see supabase/migrations/20261009110000_ticketing.sql). */
  ticket_id?: string | null;
  /** The provider's id for the message on an outside channel (WhatsApp "wamid"). */
  channel_message_id?: string | null;
  /** How far an outbound channel message got (supabase/migrations/20261011090000_channels.sql). */
  channel_status?: ChannelMessageStatus | null;
  channel_error?: string | null;
}

export type ChannelMessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export type ChannelConnectionStatus = 'connected' | 'needs_attention' | 'disconnected';

/** One workspace's connection to an outside channel. Credentials live in channel_secrets, server-side only. */
export interface ChannelConnection {
  id: string;
  workspace_id: string;
  channel: string;
  status: ChannelConnectionStatus;
  setup_method: 'embedded_signup' | 'manual' | null;
  display_name: string | null;
  external_account_id: string | null;
  external_business_id: string | null;
  settings: Record<string, unknown>;
  last_error: string | null;
  last_error_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  connected_at: string | null;
  connected_by: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageInsert = Partial<Message>;

// ============================================================================
// 5. Conversation Tags
// ============================================================================
export interface ConversationTag {
  id: string;
  conversation_id: string;
  tag_name: string;
  created_at: string;
}

export type ConversationTagInsert = Partial<ConversationTag>;

// ============================================================================
// 6. Internal Notes
// ============================================================================
export interface InternalNote {
  id: string;
  conversation_id: string;
  agent_id: string;
  content: string;
  mentioned_agent_ids: string[];
  created_at: string;

  // Joined relation
  agent?: Agent | null;
}

export type InternalNoteInsert = Partial<InternalNote>;

// ============================================================================
// 7. Canned Responses
// ============================================================================
export interface CannedResponse {
  id: string;
  agent_id: string | null;
  shortcut: string;
  content: string;
  created_at: string;
  title?: string;
  workspace_id?: string | null;
}

export type CannedResponseInsert = Partial<CannedResponse>;

// ============================================================================
// 8. Visitor Page History
// ============================================================================
export interface VisitorPageHistory {
  id: string;
  visitor_id: string;
  workspace_id?: string | null;
  url: string;
  title: string | null;
  referrer?: string | null;
  duration_seconds?: number;
  visited_at: string;
}

export type VisitorPageHistoryInsert = Partial<VisitorPageHistory>;

// ============================================================================
// Workspaces & Integration Models
// ============================================================================
export interface BusinessHoursScheduleDay {
  enabled: boolean;
  start: string;
  end: string;
}

export interface BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  schedule: {
    monday: BusinessHoursScheduleDay;
    tuesday: BusinessHoursScheduleDay;
    wednesday: BusinessHoursScheduleDay;
    thursday: BusinessHoursScheduleDay;
    friday: BusinessHoursScheduleDay;
    saturday: BusinessHoursScheduleDay;
    sunday: BusinessHoursScheduleDay;
  };
}

export interface AutoAssignmentConfig {
  enabled: boolean;
  max_conversations_per_agent: number;
  auto_close_inactive_days?: number;
}

export interface AISettingsConfig {
  enabled: boolean;
  auto_response_enabled: boolean;
  auto_response_delay_seconds: number;
  suggested_replies_enabled: boolean;
  auto_tagging_enabled: boolean;
  summary_enabled: boolean;
  sentiment_enabled: boolean;
  /**
   * Instructions the assistant follows on every reply — identity, tone, rules.
   * Facts still come only from the retrieved help desk articles.
   */
  system_prompt?: string | null;
  /** Whether AI autopilot answers all incoming messages continuously */
  auto_pilot?: boolean;
  /** Require admin approval before new knowledge base answers are active */
  require_approval_for_new_answers?: boolean;
  /**
   * How help-centre questions are answered. 'agent' (the default) puts the
   * whole published help centre in the prompt and lets the bot work the
   * question out like a person would, handing over only for what needs a
   * person. 'strict' is the older path: a few retrieved passages, and any
   * doubt goes to the team.
   */
  answer_mode?: 'agent' | 'strict';
  /**
   * Agent mode's specialists (src/lib/ai/sub-agents.ts), keyed by id: off
   * sends that topic to the team; instructions are added to its brief.
   */
  sub_agents?: Record<string, { enabled?: boolean; instructions?: string | null }>;
}

export interface HelpSection {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string;
  order_index: number;
  created_at: string;
  updated_at?: string;
  articles?: Article[];
  article_count?: number;
}

export interface Article {
  id: string;
  workspace_id: string;
  section_id?: string | null;
  title: string;
  slug?: string | null;
  category: string;
  summary?: string | null;
  content: string;
  status?: 'published' | 'draft';
  author_id?: string | null;
  views_count?: number;
  helpful_count?: number;
  not_helpful_count?: number;
  order_index?: number;
  created_at: string;
  updated_at?: string;

  // Joined relations
  author?: Agent | null;
  section?: HelpSection | null;
}

export interface ArticleFeedback {
  id: string;
  article_id: string;
  workspace_id: string;
  visitor_id: string | null;
  is_helpful: boolean;
  feedback_text?: string | null;
  created_at: string;
}

export interface ArticleSlugRedirect {
  id: string;
  workspace_id: string;
  article_id: string;
  old_slug: string;
  created_at: string;
}

export interface ArticleChunk {
  id: string;
  workspace_id: string;
  article_id: string;
  chunk_index: number;
  article_title: string;
  section_name?: string | null;
  article_slug?: string | null;
  content: string;
  token_count: number;
  embedding?: number[] | null;
  created_at: string;
  updated_at: string;
}

export interface RetrievedChunk {
  id: string;
  article_id: string;
  article_title: string;
  section_name?: string | null;
  article_slug?: string | null;
  chunk_index: number;
  content: string;
  similarity: number;
  keyword_score: number;
  combined_score: number;
  /**
   * 'knowledge' when the chunk is from a Bot knowledge entry rather than an
   * article: then `article_id` is the entry's id and there is nothing public
   * to link to. Missing means an article.
   */
  source?: 'article' | 'knowledge';
}

/** Material the bot answers from that is not published in the help centre. */
export interface BotKnowledge {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
  status: 'pending' | 'ready' | 'failed';
  content_version: number;
  chunk_count: number;
  embedded_count: number;
  last_error: string | null;
  embedded_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  /** 'learned': approved from the self-learning queue (src/lib/ai/learning/). */
  origin?: 'manual' | 'learned';
  learning_candidate_id?: string | null;
}

export type WidgetIconType =
  | 'smile_bubble'
  | 'double_bubble'
  | 'dots_bubble'
  | 'smile_line'
  | 'headset'
  | 'help'
  | 'custom_logo';

export interface NavbarTriggerConfig {
  enabled: boolean;
  label: string;
  action: 'help' | 'messages' | 'redirect';
  auto_inject: boolean;
  style: 'navbar_link' | 'pill';
  position?: 'start' | 'end';
  target_selector?: string;
  dismissed_prompt?: boolean;
  widget_icon?: WidgetIconType;
  /** Messenger window design: see src/lib/widget/launcher-icons.ts. */
  widget_design?: 'classic' | 'compact' | 'livechat' | 'modern' | 'minimal' | 'solid' | 'midnight';
  /** Second colour for gradients (Messenger, Modern); #rrggbb. */
  widget_secondary_color?: string;
  /** Window colours: the visitor's system setting, or always light / dark. */
  widget_color_mode?: 'auto' | 'light' | 'dark';
}

export interface PublicWorkspace {
  id: string;
  name: string;
  website_url: string | null;
  brand_color: string;
  logo_url: string | null;
  widget_position: 'right' | 'left';
  widget_icon?: WidgetIconType | null;
  greeting_title: string | null;
  greeting_message: string | null;
  help_center_tab_label: string;
  show_help_tab: boolean;
  help_center_tab_icon: string;
  slug: string | null;
  custom_domain: string | null;
  custom_domain_status: 'connecting' | 'live' | 'pending' | 'verified' | 'failed' | null;
  help_center_title: string | null;
  help_center_subtitle: string | null;
  help_center_logo_url: string | null;
  help_center_header_links: Array<{ label: string; url: string; target?: string }>;
  help_center_footer_text: string | null;
  help_center_layout?: 'grid-2' | 'grid-3' | 'grid-4' | 'list' | null;
  /** Help center design; resolved by resolveHelpTheme (src/lib/help/theme.ts). */
  help_center_theme?: Record<string, unknown> | null;
  navbar_trigger_config?: NavbarTriggerConfig | null;
  slug_changes_count?: number | null;
  created_at: string;
}

export interface SMTPSettingsConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure?: boolean;
  user: string;
  pass: string;
  from_email: string;
  from_name: string;
  unread_threshold_minutes?: number;
}

export interface PlatformSettings {
  id: string;
  platform_name: string;
  platform_url: string;
  support_email: string;
  smtp_settings: SMTPSettingsConfig | null;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  website_url: string | null;
  brand_color: string;
  greeting_title: string;
  greeting_message: string;
  owner_id: string;
  logo_url?: string | null;
  show_launcher_logo?: boolean | null;
  widget_icon?: WidgetIconType | null;
  widget_position?: 'right' | 'left';
  business_hours?: BusinessHoursConfig;
  auto_assignment?: AutoAssignmentConfig;
  ai_settings?: AISettingsConfig;
  smtp_settings?: SMTPSettingsConfig | null;
  help_center_tab_label?: string | null;
  show_help_tab?: boolean | null;
  help_center_tab_icon?: string | null;
  slug?: string | null;
  slug_changes_count?: number | null;
  slug_changed_at?: string | null;
  custom_domain?: string | null;
  custom_domain_status?: 'connecting' | 'live' | 'pending' | 'verified' | 'failed' | null;
  custom_domain_verified_at?: string | null;
  custom_domain_verification_token?: string | null;
  custom_domain_connected_at?: string | null;
  custom_domain_last_checked_at?: string | null;
  custom_domain_notification_sent?: string | null;
  help_center_title?: string | null;
  help_center_subtitle?: string | null;
  help_center_logo_url?: string | null;
  help_center_header_links?: Array<{ label: string; url: string; target?: string }> | null;
  help_center_footer_text?: string | null;
  help_center_layout?: 'grid-2' | 'grid-3' | 'grid-4' | 'list' | null;
  /** Help center design; resolved by resolveHelpTheme (src/lib/help/theme.ts). */
  help_center_theme?: Record<string, unknown> | null;
  navbar_trigger_config?: NavbarTriggerConfig | null;
  launcher_offset_bottom?: number | null;
  launcher_offset_side?: number | null;
  widget_z_index?: number | null;
  enable_proactive_welcome?: boolean | null;
  proactive_delay_seconds?: number | null;
  industry?: string | null;
  widget_installed?: boolean | null;
  is_suspended?: boolean | null;
  suspended_at?: string | null;
  suspension_reason?: string | null;
  deleted_at?: string | null;
  plan?: string | null;
  plan_limits?: {
    max_seats: number;
    max_monthly_conversations: number;
    max_ai_replies: number;
  } | null;
  merged_into_workspace_id?: string | null;
  auto_close_days?: number | null;
  /** IANA zone and language code; see 20261013090000_settings_hub.sql. */
  timezone?: string | null;
  language?: string | null;
  csat_settings?: CsatSettingsConfig;
  widget_disabled?: boolean | null;
  force_powered_by?: 'inherited' | 'force_on' | 'force_off' | null;
  help_center_enabled?: boolean | null;
  require_2fa?: boolean | null;
  data_retention_days?: number | null;
  ai_monthly_reply_cap?: number | null;
  ai_monthly_cost_cap_usd?: number | null;
  channel_disabled_overrides?: Record<string, boolean> | null;
  is_outbound_blocked?: boolean | null;
  scheduled_deletion_at?: string | null;
  deletion_requested_by?: string | null;
  created_at: string;
}

export interface WorkspaceSettingLock {
  id: string;
  workspace_id: string;
  setting_key: string;
  is_locked: boolean;
  locked_by?: string | null;
  locked_at: string;
  reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CsatSettingsConfig {
  enabled: boolean;
  ask_chat: boolean;
  ask_email: boolean;
  survey_prompt?: string;
}


export interface WorkspaceIntegration {
  id: string;
  workspace_id: string;
  langgraph_enabled: boolean;
  langgraph_webhook_url: string | null;
  langgraph_api_key: string | null;
  langgraph_system_prompt: string | null;
  langgraph_auto_pilot: boolean;
  whatsapp_enabled: boolean;
  whatsapp_phone_number_id: string | null;
  whatsapp_access_token: string | null;
  whatsapp_business_account_id: string | null;
  meta_enabled: boolean;
  meta_page_access_token: string | null;
  meta_verify_token: string | null;
  meta_app_secret: string | null;
  linkedin_enabled: boolean;
  linkedin_access_token: string | null;
  linkedin_organization_urn: string | null;
  slack_enabled?: boolean;
  slack_webhook_url?: string | null;
  email_offline_notifications?: boolean;
  created_at?: string;
  updated_at?: string;
}

// ============================================================================
// Full Database generic for Supabase v2 clients
// ============================================================================
export interface Database {
  public: {
    Tables: {
      visitors: {
        Row: Visitor;
        Insert: Partial<Visitor>;
        Update: Partial<Visitor>;
        Relationships: [];
      };
      agents: {
        Row: Agent;
        Insert: Partial<Agent>;
        Update: Partial<Agent>;
        Relationships: [];
      };
      conversations: {
        Row: Conversation;
        Insert: Partial<Conversation>;
        Update: Partial<Conversation>;
        Relationships: [];
      };
      messages: {
        Row: Message;
        Insert: Partial<Message>;
        Update: Partial<Message>;
        Relationships: [];
      };
      conversation_tags: {
        Row: ConversationTag;
        Insert: Partial<ConversationTag>;
        Update: Partial<ConversationTag>;
        Relationships: [];
      };
      internal_notes: {
        Row: InternalNote;
        Insert: Partial<InternalNote>;
        Update: Partial<InternalNote>;
        Relationships: [];
      };
      canned_responses: {
        Row: CannedResponse;
        Insert: Partial<CannedResponse>;
        Update: Partial<CannedResponse>;
        Relationships: [];
      };
      visitor_page_history: {
        Row: VisitorPageHistory;
        Insert: Partial<VisitorPageHistory>;
        Update: Partial<VisitorPageHistory>;
        Relationships: [];
      };
      workspaces: {
        Row: Workspace;
        Insert: Partial<Workspace>;
        Update: Partial<Workspace>;
        Relationships: [];
      };
      workspace_integrations: {
        Row: WorkspaceIntegration;
        Insert: Partial<WorkspaceIntegration>;
        Update: Partial<WorkspaceIntegration>;
        Relationships: [];
      };
      articles: {
        Row: Article;
        Insert: Partial<Article>;
        Update: Partial<Article>;
        Relationships: [];
      };
      help_sections: {
        Row: HelpSection;
        Insert: Partial<HelpSection>;
        Update: Partial<HelpSection>;
        Relationships: [];
      };
      article_feedback: {
        Row: ArticleFeedback;
        Insert: Partial<ArticleFeedback>;
        Update: Partial<ArticleFeedback>;
        Relationships: [];
      };
      article_chunks: {
        Row: ArticleChunk;
        Insert: Partial<ArticleChunk>;
        Update: Partial<ArticleChunk>;
        Relationships: [];
      };
      [key: string]: {
        Row: any;
        Insert: any;
        Update: any;
        Relationships: any[];
      };
    };
    Views: {
      public_workspaces: {
        Row: PublicWorkspace;
      };
      [key: string]: {
        Row: any;
      };
    };
    Functions: {
      [key: string]: {
        Args: any;
        Returns: any;
      };
    };
    Enums: {
      [key: string]: any;
    };
    CompositeTypes: {
      [key: string]: any;
    };
  };
}

/* ── Ticketing ────────────────────────────────────────────────────────── */

export type TicketStatus = 'new' | 'open' | 'pending' | 'on_hold' | 'solved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketType = 'question' | 'incident' | 'problem' | 'task';
export type TicketChannel = 'chat' | 'email' | 'web_form' | 'whatsapp' | 'instagram' | 'x' | 'linkedin' | 'tiktok' | 'threads';

export interface Ticket {
  id: string;
  workspace_id: string;
  number: number;
  /** Values of the workspace's custom ticket fields, keyed by field key. */
  custom_fields?: Record<string, string | number | boolean | null> | null;
  conversation_id: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  assignee_id: string | null;
  group_id: string | null;
  tags: string[];
  requester_id: string | null;
  channel: TicketChannel;
  follow_up_of_id: string | null;
  merged_into_id: string | null;
  created_at: string;
  updated_at: string;
  status_changed_at: string;
  solved_at: string | null;
  closed_at: string | null;
  first_agent_reply_at: string | null;
  last_agent_reply_at: string | null;
  last_customer_reply_at: string | null;
  status_rank: number;
  priority_rank: number;
  /** SLA cache, kept by the database (fn_sla_sync). */
  sla_policy_id?: string | null;
  sla_state?: 'running' | 'paused' | 'met' | null;
  sla_next_due_at?: string | null;
  sla_next_warn_at?: string | null;
  sla_next_metric?: 'first_reply' | 'next_reply' | 'resolution' | null;
  sla_breached_at?: string | null;
  /** CSAT satisfaction rating and comment. */
  csat_rating?: 'good' | 'bad' | null;
  csat_comment?: string | null;
  csat_rated_at?: string | null;
}

export interface TicketGroup {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  /** New tickets in the group go to its next available member. */
  round_robin?: boolean;
  created_at: string;
}

export type TicketActorType = 'agent' | 'customer' | 'system' | 'bot';

export interface TicketEvent {
  id: number;
  ticket_id: string;
  workspace_id: string;
  actor_type: TicketActorType;
  actor_id: string | null;
  action: 'created' | 'updated' | 'public_reply' | 'internal_note' | 'merged' | 'follow_up_created' | string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export interface TicketViewRow {
  id: string;
  workspace_id: string;
  owner_id: string | null;
  name: string;
  filters: Record<string, unknown>;
  sort: Record<string, unknown>;
  position: number;
  created_at: string;
  updated_at: string;
}

/* ── Reporting ───────────────────────────────────────────────────────── */

export type ReportingEventType =
  | 'ticket_created'
  | 'ticket_solved'
  | 'ticket_reopened'
  | 'first_reply'
  | 'csat_rated'
  | 'bot_resolved'
  | 'bot_handover';

export interface ReportingEvent {
  id: number;
  workspace_id: string;
  ticket_id: string | null;
  event_type: ReportingEventType;
  occurred_at: string;
  agent_id: string | null;
  group_id: string | null;
  channel: string | null;
  priority: string | null;
  tags: string[];
  duration_seconds: number | null;
  csat_rating: 'good' | 'bad' | null;
  csat_comment: string | null;
  metadata: Record<string, unknown>;
}

/* ── Platform Super Admin ────────────────────────────────────────────── */

export interface SuperAdminWorkspaceNote {
  id: string;
  workspace_id: string;
  admin_id: string;
  admin_email: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface PlatformOverviewMetrics {
  total_workspaces: number;
  active_workspaces: number;
  suspended_workspaces: number;
  total_agents: number;
  active_agents: number;
  tickets_today: number;
  tickets_this_month: number;
  total_messages: number;
  bot_resolution_rate: number | null;
  bot_resolved_count: number;
  bot_handover_count: number;
  trend_tickets: Array<{
    date: string;
    formatted_date: string;
    created: number;
    solved: number;
  }>;
  newest_workspaces: Array<{
    id: string;
    name: string;
    brand_color: string;
    created_at: string;
    is_suspended: boolean;
    plan: string;
    owner_email: string | null;
  }>;
  alerts: Array<{
    alert_type: string;
    severity: 'high' | 'medium' | 'low';
    message: string;
    workspace_id: string | null;
    workspace_name: string;
    created_at: string;
  }>;
}

export interface PlatformUserItem {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  is_active: boolean;
  is_super_admin: boolean;
  is_platform_owner?: boolean;
  workspace_id: string | null;
  workspace_name: string | null;
  created_at: string;
}

export interface SystemHealthReport {
  channel_failures: Array<{
    id: string | number;
    workspace_id: string;
    workspace_name: string;
    channel: string;
    error: string | null;
    attempts: number;
    created_at: string;
  }>;
  email_issues: Array<{
    id: string;
    workspace_id: string;
    workspace_name: string;
    error_type: string;
    created_at: string;
  }>;
  background_errors: Array<{
    id: string | number;
    workspace_id: string;
    workspace_name: string;
    action_type: string;
    status: string;
    error: string | null;
    created_at: string;
  }>;
  checked_at: string;
}

export interface PlatformSuperAdminInvitation {
  id: string;
  email: string;
  name: string;
  invited_by: string;
  invited_by_email: string;
  token: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  created_at: string;
  accepted_at: string | null;
  expires_at: string;
}

export * from './plans';
export * from './platform-management';


/* ── Team chat (migration 20261118090000_team_chat.sql) ─────────────────── */

export interface TeamMessage {
  id: string;
  thread_id: string;
  workspace_id: string;
  sender_id: string;
  content: string;
  /** A customer conversation of the same workspace the message points at. */
  conversation_id: string | null;
  mentions: string[];
  created_at: string;
  deleted_at: string | null;
}

/** One row of fn_team_inbox: a thread the caller can see, with their unread count. */
export interface TeamInboxRow {
  thread_id: string;
  kind: 'channel' | 'direct';
  name: string | null;
  other_agent_id: string | null;
  last_message_at: string | null;
  last_message: { content: string; sender_id: string; created_at: string; deleted: boolean } | null;
  unread: number;
  mentions_me: number;
}
