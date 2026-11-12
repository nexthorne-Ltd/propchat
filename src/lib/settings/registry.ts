/**
 * What the Settings area contains and who may open each part. Kept free of
 * React so the permission and search rules can be unit-tested; the screen
 * (components/settings/SettingsHub.tsx) maps `icon` names to components.
 *
 * Access follows src/lib/team/permissions.ts, which mirrors the database
 * matrix. This only decides what to *show*; every server action and RLS
 * policy behind a page still checks the caller itself.
 */
import { roleCan, type Capability, type Role } from '@/lib/team/permissions';

export type SettingsStatus = 'ready' | 'soon';

export interface SettingsTab {
  id: string;
  label: string;
  description: string;
  /** Capability the role needs; null means every member. */
  capability: Capability | null;
  /** Only the workspace owner (billing). */
  ownerOnly?: boolean;
  /** 'soon' pages render a "coming soon" state instead of a form. */
  status?: SettingsStatus;
  keywords?: string[];
}

export interface SettingsSection {
  id: string;
  label: string;
  description: string;
  group: string;
  icon: string;
  keywords: string[];
  tabs: SettingsTab[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    group: 'General',
    icon: 'building',
    description: 'Name, logo, timezone, language and business hours.',
    keywords: ['company', 'organisation', 'organization', 'name', 'logo', 'timezone', 'language', 'hours', 'schedule', 'profile'],
    tabs: [
      { id: 'general', label: 'General', description: 'How your workspace is named and what defaults it uses.', capability: 'manage_settings', keywords: ['name', 'logo', 'timezone', 'language', 'locale', 'profile', 'company'] },
      { id: 'hours', label: 'Business hours', description: 'When your team is available. Outside these hours the widget shows you as away.', capability: 'manage_settings', keywords: ['hours', 'schedule', 'availability', 'offline', 'open'] },
    ],
  },
  {
    id: 'team',
    label: 'Team',
    group: 'General',
    icon: 'users',
    description: 'Members, roles and groups.',
    keywords: ['agents', 'invite', 'permissions', 'teammates', 'capacity', 'round robin', 'user', 'profile', 'account', 'email', 'owner'],
    tabs: [
      { id: 'members', label: 'Members', description: 'Invite people, set what they can do and deactivate access.', capability: 'manage_team', keywords: ['invite', 'member', 'agent', 'deactivate', 'capacity', 'email', 'user', 'profile', 'account', 'owner'] },
      { id: 'roles', label: 'Roles', description: 'What each role can do in this workspace.', capability: 'manage_team', keywords: ['role', 'permission', 'admin', 'light agent', 'owner'] },
      { id: 'groups', label: 'Groups', description: 'Billing, Technical and other groups, and who is in them.', capability: 'manage_groups', keywords: ['group', 'queue', 'routing', 'round robin', 'billing', 'technical'] },
    ],
  },
  {
    id: 'channels',
    label: 'Channels',
    group: 'Customer-facing',
    icon: 'share',
    description: 'Where customers reach you: widget install, email and social.',
    keywords: ['whatsapp', 'instagram', 'messenger', 'meta', 'linkedin', 'slack', 'smtp', 'embed', 'install', 'omnichannel'],
    tabs: [
      { id: 'website', label: 'Website widget', description: 'Copy the embed script for your site and check that it is live.', capability: null, keywords: ['install', 'embed', 'script', 'snippet', 'wordpress', 'shopify', 'html', 'nextjs'] },
      { id: 'email', label: 'SMTP', description: 'Your own mail server, used for alerts and for replies to tickets logged by hand. For the email support channel, see Messaging & email channels.', capability: 'manage_settings', keywords: ['smtp', 'email', 'mail', 'gmail', 'outlook', 'zoho', 'unread', 'alerts'] },
      { id: 'social', label: 'Messaging & email channels', description: 'Email support, WhatsApp, Instagram, X, Threads, LinkedIn, TikTok and Slack alerts.', capability: 'manage_settings', keywords: ['email', 'support address', 'forwarding', 'dns', 'dkim', 'whatsapp', 'instagram', 'facebook', 'messenger', 'meta', 'linkedin', 'slack', 'social', 'x', 'twitter', 'threads', 'tiktok', 'comments', 'mentions'] },
      { id: 'mobile', label: 'Mobile app', description: 'Add Zentry to your phone’s home screen.', capability: null, keywords: ['mobile', 'pwa', 'android', 'iphone', 'ios', 'home screen', 'qr'] },
    ],
  },
  {
    id: 'widget',
    label: 'Chat widget',
    group: 'Customer-facing',
    icon: 'palette',
    description: 'Colors, position, greeting and the pre-chat form, with a live preview.',
    keywords: ['brand', 'color', 'colour', 'logo', 'launcher', 'theme', 'position', 'greeting', 'welcome', 'help tab'],
    tabs: [
      { id: 'appearance', label: 'Appearance', description: 'Brand color, launcher, position and greeting. The preview updates as you type.', capability: 'manage_settings', keywords: ['color', 'position', 'greeting', 'launcher', 'logo', 'preview', 'welcome', 'proactive'] },
      { id: 'prechat', label: 'Pre-chat form', description: 'Ask visitors for their name, email or a topic before they start a chat.', capability: 'manage_settings', keywords: ['pre-chat', 'prechat', 'form', 'email', 'name', 'lead'] },
    ],
  },
  {
    id: 'tickets',
    label: 'Tickets',
    group: 'Support',
    icon: 'ticket',
    description: 'Fields, tags, customer satisfaction and saved views.',
    keywords: ['custom fields', 'tags', 'views', 'filters', 'priority', 'status', 'csat', 'satisfaction'],
    tabs: [
      { id: 'views', label: 'Views', description: 'Saved filters for your ticket list. They are managed from the Tickets screen.', capability: null, keywords: ['view', 'filter', 'saved', 'sort'] },
      { id: 'csat', label: 'Satisfaction (CSAT)', description: 'Survey customers with a good/bad question and optional comment when their ticket is solved.', capability: 'manage_settings', keywords: ['csat', 'satisfaction', 'survey', 'rating', 'feedback', 'good', 'bad', 'solved'] },
      { id: 'fields', label: 'Ticket fields', description: 'Add your own fields, such as order number or plan, to every ticket.', capability: 'manage_settings', keywords: ['field', 'custom', 'form'] },
      { id: 'tags', label: 'Tags', description: 'Rename, merge and retire the tags your team uses.', capability: 'manage_settings', keywords: ['tag', 'label'] },
    ],
  },
  {
    id: 'automation',
    label: 'Automation',
    group: 'Support',
    icon: 'zap',
    description: 'Macros, triggers, automations, assignment and SLAs.',
    keywords: ['macros', 'canned', 'saved replies', 'shortcuts', 'assignment', 'auto close', 'sla', 'rules'],
    tabs: [
      { id: 'macros', label: 'Macros', description: 'One-click actions that insert a reply and change status, priority, tags or assignee. Shared macros are managed by admins; everyone with reply access keeps their own.', capability: 'reply', keywords: ['macro', 'one-click', 'action', 'reply template', 'placeholder'] },
      { id: 'triggers', label: 'Triggers', description: 'Rules that run instantly when a ticket is created or updated.', capability: 'manage_settings', keywords: ['trigger', 'rule', 'instant', 'condition', 'webhook', 'workflow'] },
      { id: 'automations', label: 'Automations', description: 'Time-based rules that run every hour, such as reminders and escalations.', capability: 'manage_settings', keywords: ['automation', 'hourly', 'reminder', 'escalate', 'pending', 'schedule', 'time'] },
      { id: 'log', label: 'Rule log', description: 'Which triggers and automations fired on which ticket, and what they did.', capability: 'manage_settings', keywords: ['log', 'history', 'fired', 'rule', 'debug'] },
      { id: 'replies', label: 'Saved replies', description: 'Plain pre-written replies your team inserts with a shortcut.', capability: 'manage_settings', keywords: ['canned', 'saved replies', 'templates', 'shortcut', 'quick response'] },
      { id: 'assignment', label: 'Assignment & auto-close', description: 'Who new chats go to, and when quiet conversations are resolved.', capability: 'manage_settings', keywords: ['assignment', 'auto assign', 'round robin', 'auto close', 'inactive', 'resolve'] },
      { id: 'sla', label: 'SLA policies', description: 'Set first-reply, next-reply and resolution targets per priority, and get warned before they are missed.', capability: 'manage_settings', keywords: ['sla', 'target', 'breach', 'response time', 'first reply', 'resolution', 'policy', 'priority'] },
      { id: 'sla-calendar', label: 'SLA calendar', description: 'The business hours and holidays that business-hour SLAs count against.', capability: 'manage_settings', keywords: ['sla', 'holiday', 'business hours', 'calendar', 'closed', 'timezone', 'day off'] },
    ],
  },
  {
    id: 'ai',
    label: 'AI bot',
    group: 'Support',
    icon: 'bot',
    description: 'Knowledge sources, tone and when the bot hands over to a person.',
    keywords: ['ai', 'bot', 'copilot', 'llm', 'model', 'gpt', 'claude', 'autopilot', 'knowledge', 'tone', 'handoff', 'handover', 'langgraph', 'learning', 'train'],
    tabs: [
      { id: 'assistant', label: 'Assistant & tone', description: 'Turn the bot on, choose the model and tell it how to sound. Hand-over rules live here too.', capability: 'manage_settings', keywords: ['tone', 'prompt', 'model', 'provider', 'api key', 'autopilot', 'handoff', 'handover', 'human'] },
      { id: 'sub-agents', label: 'Sub-agents', description: 'The prop-firm specialists (pricing, rules, payouts, account, platform, KYC…), how messages flow to them, and their switches.', capability: 'manage_settings', keywords: ['sub-agents', 'subagents', 'specialist', 'router', 'routing', 'flow', 'pricing', 'offers', 'rules', 'payouts', 'account', 'kyc', 'greeting', 'prop firm'] },
      { id: 'trader-data', label: 'Trader data', description: 'Connect your prop-firm backend so the bot can look up account status, KYC, orders, coupons and affiliate numbers, after the trader proves their email.', capability: 'manage_settings', keywords: ['trader data', 'lookup', 'backend', 'crm', 'account status', 'kyc status', 'orders', 'coupon', 'affiliate', 'verification', 'otp', 'api'] },
      { id: 'knowledge', label: 'Knowledge sources', description: 'The bot answers from your published help center articles and the Bot knowledge entries in the Help Center.', capability: 'manage_settings', keywords: ['knowledge', 'articles', 'notes', 'gaps', 'sources'] },
      { id: 'learning', label: 'Self-learning', description: 'The bot learns answers your team gave, checked against your help center. Review what it learned.', capability: 'manage_settings', keywords: ['learning', 'self-learning', 'train', 'training', 'reinforcement', 'learned answers', 'review', 'approve', 'feedback'] },
      { id: 'advanced', label: 'LangGraph', description: 'Connect your own multi-agent workflow.', capability: 'manage_settings', keywords: ['langgraph', 'pipeline', 'webhook', 'custom llm'] },
      { id: 'health', label: 'Health check', description: 'Check whether the bot can reply right now, why recent messages were not answered, and ask it a test question.', capability: 'view', keywords: ['test', 'health', 'check', 'diagnose', 'not replying', 'not working', 'status', 'debug', 'reply'] },
    ],
  },
  {
    id: 'helpcenter',
    label: 'Help center',
    group: 'Customer-facing',
    icon: 'book',
    description: 'Branding, address and custom domain of your public help center.',
    keywords: ['help center', 'branding', 'domain', 'cname', 'dns', 'ssl', 'subdomain', 'slug', 'footer', 'layout'],
    tabs: [
      { id: 'branding', label: 'Branding', description: 'Title, logo, links and layout of the help center.', capability: 'manage_settings', keywords: ['title', 'logo', 'footer', 'layout', 'links', 'header'] },
      { id: 'domain', label: 'Domain', description: 'Your help center address and an optional custom domain.', capability: 'manage_settings', keywords: ['domain', 'cname', 'dns', 'ssl', 'subdomain', 'slug', 'url'] },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    group: 'Account',
    icon: 'bell',
    description: 'Your own email and in-app alerts. Not shared with the team.',
    keywords: ['email', 'alerts', 'sound', 'mentions', 'digest', 'in-app'],
    tabs: [
      { id: 'preferences', label: 'My preferences', description: 'Choose what you are told about, and where.', capability: null, keywords: ['email', 'in-app', 'sound', 'mention', 'assigned', 'digest'] },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    group: 'Account',
    icon: 'shield',
    description: 'Sign-in protection and workspace activity history.',
    keywords: ['password', '2fa', 'mfa', 'authenticator', 'sessions', 'sign out', 'account', 'profile', 'login'],
    tabs: [
      { id: 'sessions', label: 'Sessions', description: 'Where you are signed in, and a way to sign out everywhere else.', capability: null, keywords: ['session', 'sign out', 'devices', 'logout', 'account', 'profile', 'login'] },
      { id: 'twofactor', label: 'Two-factor authentication', description: 'Protect your sign-in with an authenticator app.', capability: null, keywords: ['2fa', 'mfa', 'totp', 'authenticator', 'two factor', 'security'] },
      { id: 'audit', label: 'Audit log', description: 'Who changed workspace settings and roles, and when.', capability: 'manage_settings', keywords: ['audit', 'log', 'history', 'changes', 'activity'] },
    ],
  },
  {
    id: 'billing',
    label: 'Billing',
    group: 'Account',
    icon: 'card',
    description: 'Your plan, usage and invoices.',
    keywords: ['plan', 'invoice', 'payment', 'subscription', 'seats', 'usage'],
    tabs: [
      { id: 'plan', label: 'Plan & usage', description: 'Your current plan and what it includes.', capability: 'manage_settings', ownerOnly: true, keywords: ['plan', 'seats', 'usage', 'limits', 'invoice', 'payment'] },
    ],
  },
  {
    id: 'api',
    label: 'API & webhooks',
    group: 'Account',
    icon: 'key',
    description: 'API keys and outgoing webhooks for your own systems.',
    keywords: ['api', 'key', 'token', 'webhook', 'developer', 'rest'],
    tabs: [
      { id: 'keys', label: 'API keys', description: 'Create keys so your own systems can start chats, send messages and get the bot’s and your team’s replies.', capability: 'manage_settings', keywords: ['api', 'key', 'token', 'integration', 'rest', 'chat api', 'headless', 'mobile app', 'backend'] },
      { id: 'webhooks', label: 'Webhooks', description: 'Send ticket and message events to your own endpoint.', capability: 'manage_settings', keywords: ['webhook', 'events', 'endpoint', 'callback'] },
    ],
  },
];

/**
 * Old ids that other screens and bookmarks still use (Instagram login returns
 * to `channels`; the checklist opens `widget` and `team`), mapped to where
 * that setting lives now.
 */
const LEGACY_TARGETS: Record<string, string> = {
  install: 'channels:website',
  mobile: 'channels:mobile',
  email: 'channels:email',
  domains: 'helpcenter:domain',
  groups: 'team:groups',
  routing: 'workspace:hours',
  replies: 'automation:replies',
};

export const DEFAULT_TARGET = 'workspace';

/** True when `role` may open `tab`. `null` role (not a member) opens nothing. */
export function canOpenTab(tab: SettingsTab, role: Role | null | undefined): boolean {
  if (!role) return false;
  if (tab.ownerOnly && role !== 'owner') return false;
  return tab.capability === null || roleCan(role, tab.capability);
}

/** Tabs of `section` the role may open. */
export function visibleTabs(section: SettingsSection, role: Role | null | undefined): SettingsTab[] {
  return section.tabs.filter((t) => canOpenTab(t, role));
}

/** Sections with at least one tab the role may open, with only those tabs. */
export function visibleSections(role: Role | null | undefined): SettingsSection[] {
  return SETTINGS_SECTIONS.map((s) => ({ ...s, tabs: visibleTabs(s, role) })).filter((s) => s.tabs.length > 0);
}

export interface SettingsLocation {
  section: string;
  tab: string;
}

/**
 * Turns "section", "section:tab" or a legacy id into a page the role may
 * open. Anything unknown or not allowed falls back to the first allowed page,
 * so a stale link never lands on an empty screen.
 */
export function resolveTarget(target: string | null | undefined, role: Role | null | undefined): SettingsLocation | null {
  const sections = visibleSections(role);
  if (sections.length === 0) return null;
  const raw = (target && LEGACY_TARGETS[target]) || target || DEFAULT_TARGET;
  const [sectionId, tabId] = raw.split(':');
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];
  const tab = section.tabs.find((t) => t.id === tabId) ?? section.tabs[0];
  return { section: section.id, tab: tab.id };
}

export interface SettingsMatch {
  section: SettingsSection;
  tab: SettingsTab;
  score: number;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Finds pages for a search box. Every word typed must match something on the
 * page (label, description or keyword, as a word prefix); label matches rank
 * above description and keyword matches. Only pages the role can open are
 * ever returned.
 */
export function searchSettings(query: string, role: Role | null | undefined): SettingsMatch[] {
  const isEmail = query.includes('@');
  const terms = isEmail ? ['email'] : words(query);
  if (terms.length === 0) return [];
  const out: SettingsMatch[] = [];
  for (const section of visibleSections(role)) {
    for (const tab of section.tabs) {
      const title = words(`${section.label} ${tab.label}`);
      const body = words(`${section.description} ${tab.description}`);
      const tabKeys = words((tab.keywords ?? []).join(' '));
      const sectionKeys = words(section.keywords.join(' '));
      let score = 0;
      let all = true;
      for (const term of terms) {
        if (title.some((w) => w.startsWith(term))) score += 10;
        else if (tabKeys.some((w) => w.startsWith(term))) score += 6;
        else if (sectionKeys.some((w) => w.startsWith(term))) score += 3;
        else if (body.some((w) => w.startsWith(term))) score += 2;
        else {
          all = false;
          break;
        }
      }
      if (all) out.push({ section, tab, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** One entry per page the role can open, for the command palette. */
export function settingsPages(role: Role | null | undefined) {
  return visibleSections(role).flatMap((s) =>
    s.tabs.map((t) => ({
      id: `${s.id}:${t.id}`,
      label: s.tabs.length > 1 ? `${s.label}: ${t.label}` : s.label,
      description: t.description,
      keywords: [...s.keywords, ...(t.keywords ?? [])],
      group: s.group,
    }))
  );
}
