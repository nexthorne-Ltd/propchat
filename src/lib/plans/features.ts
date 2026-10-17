/**
 * ============================================================================
 * Central Plan Feature Registry & Limit Keys
 * ============================================================================
 * Defines all plan features, categories, descriptions, and standard presets.
 * All UI feature switches and server enforcement derive from this registry.
 */

export type PlanFeatureCategory =
  | 'channels'
  | 'ai_automation'
  | 'help_center'
  | 'analytics_support'
  | 'customization'
  | 'developer';

export type PlanFeatureKey =
  | 'channel_whatsapp'
  | 'channel_instagram'
  | 'channel_email'
  | 'channel_x'
  | 'channel_linkedin'
  | 'channel_tiktok'
  | 'channel_threads'
  | 'ai_bot'
  | 'sla'
  | 'macros'
  | 'automations'
  | 'csat_reports'
  | 'custom_help_center_domain'
  | 'visitor_tracking'
  | 'roles_groups'
  | 'remove_branding'
  | 'api_webhooks';

export type PlanLimitKey =
  | 'max_agents'
  | 'max_tickets_per_month'
  | 'max_ai_bot_replies_per_month'
  | 'max_channels_connected'
  | 'max_articles'
  | 'max_automations'
  | 'max_storage_mb'
  | 'max_api_requests_per_month';

export interface PlanFeatureDefinition {
  id: PlanFeatureKey;
  name: string;
  description: string;
  category: PlanFeatureCategory;
  highlight?: boolean;
}

export interface PlanLimitDefinition {
  id: PlanLimitKey;
  name: string;
  description: string;
  unit: string;
  isMeteredPeriod: boolean; // Reset monthly vs static capacity
}

export const PLAN_FEATURE_CATEGORIES: Record<PlanFeatureCategory, { label: string; description: string }> = {
  channels: {
    label: 'Omnichannel Messaging',
    description: 'Connect native customer communication channels directly to the unified inbox.',
  },
  ai_automation: {
    label: 'AI & Automations',
    description: 'Autonomous customer support, smart workflows, and triage rules.',
  },
  help_center: {
    label: 'Help Center & Knowledge Base',
    description: 'Self-service customer portal, published articles, and custom domain routing.',
  },
  analytics_support: {
    label: 'SLA & Intelligence',
    description: 'Customer satisfaction metrics, SLA policies, and agent performance tracking.',
  },
  customization: {
    label: 'Team & Branding',
    description: 'Custom roles, ticket assignment groups, and unbranded client experiences.',
  },
  developer: {
    label: 'Developer & API',
    description: 'Programmatic integrations, webhooks, and REST API access.',
  },
};

export const PLAN_FEATURES: PlanFeatureDefinition[] = [
  // Channels
  {
    id: 'channel_email',
    name: 'Email Channel',
    description: 'Receive and respond to customer emails directly in the ticket inbox.',
    category: 'channels',
  },
  {
    id: 'channel_whatsapp',
    name: 'WhatsApp Channel',
    description: 'Official WhatsApp Business Cloud API integration.',
    category: 'channels',
    highlight: true,
  },
  {
    id: 'channel_instagram',
    name: 'Instagram Direct',
    description: 'Connect professional Instagram accounts for DMs and story mentions.',
    category: 'channels',
  },
  {
    id: 'channel_x',
    name: 'X (Twitter) Channel',
    description: 'Public replies, mentions, and direct messages on X.',
    category: 'channels',
  },
  {
    id: 'channel_linkedin',
    name: 'LinkedIn Channel',
    description: 'Company page comments and messaging integration.',
    category: 'channels',
  },
  {
    id: 'channel_tiktok',
    name: 'TikTok Channel',
    description: 'Direct customer engagement and comment handling.',
    category: 'channels',
  },
  {
    id: 'channel_threads',
    name: 'Threads Channel',
    description: 'Instagram Threads conversations and mentions dispatch.',
    category: 'channels',
  },

  // AI & Automations
  {
    id: 'ai_bot',
    name: 'Autonomous AI Bot & Copilot',
    description: 'Multi-provider AI auto-replies, help-article citations, sentiment, and handover.',
    category: 'ai_automation',
    highlight: true,
  },
  {
    id: 'macros',
    name: 'Macros & Canned Responses',
    description: 'Team-wide saved reply shortcuts and quick response macros.',
    category: 'ai_automation',
  },
  {
    id: 'automations',
    name: 'Triggers & Event Automations',
    description: 'Event-driven triggers, hourly automations, webhook dispatches, and auto-tagging.',
    category: 'ai_automation',
    highlight: true,
  },

  // Help Center
  {
    id: 'custom_help_center_domain',
    name: 'Custom Help Center Domain',
    description: 'Host your public knowledge base on your own custom domain (e.g. help.yourcompany.com).',
    category: 'help_center',
    highlight: true,
  },

  // Analytics & Support
  {
    id: 'sla',
    name: 'SLA Policies & Tracking',
    description: 'Business hours calendars, target reply and resolution thresholds, and breach notifications.',
    category: 'analytics_support',
  },
  {
    id: 'csat_reports',
    name: 'CSAT Surveys & Reports',
    description: 'Automated post-resolution feedback surveys and deep analytics reporting.',
    category: 'analytics_support',
  },
  {
    id: 'visitor_tracking',
    name: 'Live Visitor Radar',
    description: 'Real-time online visitor presence tracking, geo analytics, and device inspection.',
    category: 'analytics_support',
  },

  // Customization
  {
    id: 'roles_groups',
    name: 'Custom Roles & Ticket Groups',
    description: 'Round-robin ticket groups, agent capacity limits, and light agent roles.',
    category: 'customization',
  },
  {
    id: 'remove_branding',
    name: 'Remove ZenTry Branding',
    description: 'White-label widget and public portal by hiding "Powered by ZenTry".',
    category: 'customization',
    highlight: true,
  },

  // Developer
  {
    id: 'api_webhooks',
    name: 'REST API & Webhooks',
    description: 'Full programmatic ticket and visitor API access with real-time webhook subscriptions.',
    category: 'developer',
  },
];

export const PLAN_LIMITS: PlanLimitDefinition[] = [
  {
    id: 'max_agents',
    name: 'Team Seats',
    description: 'Maximum active team members and administrators.',
    unit: 'seats',
    isMeteredPeriod: false,
  },
  {
    id: 'max_tickets_per_month',
    name: 'Tickets / Month',
    description: 'Monthly incoming customer tickets across all channels.',
    unit: 'tickets/mo',
    isMeteredPeriod: true,
  },
  {
    id: 'max_ai_bot_replies_per_month',
    name: 'AI Bot Replies / Month',
    description: 'Autonomous AI assistant responses to visitors each month.',
    unit: 'replies/mo',
    isMeteredPeriod: true,
  },
  {
    id: 'max_channels_connected',
    name: 'Connected Channels',
    description: 'Simultaneous active omnichannel connections.',
    unit: 'channels',
    isMeteredPeriod: false,
  },
  {
    id: 'max_articles',
    name: 'Knowledge Base Articles',
    description: 'Self-service articles published in your help center.',
    unit: 'articles',
    isMeteredPeriod: false,
  },
  {
    id: 'max_automations',
    name: 'Automations & Triggers',
    description: 'Active event triggers and scheduled automation rules.',
    unit: 'rules',
    isMeteredPeriod: false,
  },
  {
    id: 'max_storage_mb',
    name: 'Storage Capacity',
    description: 'Cloud storage for ticket attachments, media, and knowledge files.',
    unit: 'MB',
    isMeteredPeriod: false,
  },
  {
    id: 'max_api_requests_per_month',
    name: 'API Requests / Month',
    description: 'Rate limit for programmatic REST API calls.',
    unit: 'calls/mo',
    isMeteredPeriod: true,
  },
];

export const RESOURCE_LIMITS = PLAN_LIMITS;

export const FEATURE_MAP = new Map<PlanFeatureKey, PlanFeatureDefinition>(
  PLAN_FEATURES.map((f) => [f.id, f])
);

export const LIMIT_MAP = new Map<PlanLimitKey, PlanLimitDefinition>(
  PLAN_LIMITS.map((l) => [l.id, l])
);

/**
 * Returns clean object with all features initialized to false
 */
export function createEmptyPlanFeatures(): Record<PlanFeatureKey, boolean> {
  const result: Partial<Record<PlanFeatureKey, boolean>> = {};
  for (const feat of PLAN_FEATURES) {
    result[feat.id] = false;
  }
  return result as Record<PlanFeatureKey, boolean>;
}

/**
 * Default feature sets for pre-seeded tiers
 */
export const STARTER_FEATURES: Record<PlanFeatureKey, boolean> = {
  channel_email: true,
  channel_whatsapp: true,
  channel_instagram: false,
  channel_x: false,
  channel_linkedin: false,
  channel_tiktok: false,
  channel_threads: false,
  ai_bot: true,
  sla: false,
  macros: true,
  automations: false,
  csat_reports: false,
  custom_help_center_domain: false,
  visitor_tracking: true,
  roles_groups: false,
  remove_branding: false,
  api_webhooks: false,
};

export const PRO_FEATURES: Record<PlanFeatureKey, boolean> = {
  channel_email: true,
  channel_whatsapp: true,
  channel_instagram: true,
  channel_x: true,
  channel_linkedin: true,
  channel_tiktok: false,
  channel_threads: true,
  ai_bot: true,
  sla: true,
  macros: true,
  automations: true,
  csat_reports: true,
  custom_help_center_domain: false,
  visitor_tracking: true,
  roles_groups: true,
  remove_branding: false,
  api_webhooks: true,
};

export const ENTERPRISE_FEATURES: Record<PlanFeatureKey, boolean> = {
  channel_email: true,
  channel_whatsapp: true,
  channel_instagram: true,
  channel_x: true,
  channel_linkedin: true,
  channel_tiktok: true,
  channel_threads: true,
  ai_bot: true,
  sla: true,
  macros: true,
  automations: true,
  csat_reports: true,
  custom_help_center_domain: true,
  visitor_tracking: true,
  roles_groups: true,
  remove_branding: true,
  api_webhooks: true,
};

export const LEGACY_FEATURES: Record<PlanFeatureKey, boolean> = {
  channel_email: true,
  channel_whatsapp: true,
  channel_instagram: true,
  channel_x: true,
  channel_linkedin: true,
  channel_tiktok: true,
  channel_threads: true,
  ai_bot: true,
  sla: true,
  macros: true,
  automations: true,
  csat_reports: true,
  custom_help_center_domain: true,
  visitor_tracking: true,
  roles_groups: true,
  remove_branding: true,
  api_webhooks: true,
};
