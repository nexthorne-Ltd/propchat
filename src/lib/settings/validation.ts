/**
 * Rules for the settings forms, shared by the screen (inline errors) and the
 * server actions (the real check), so the two cannot disagree.
 */

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ur', label: 'Urdu' },
  { code: 'ar', label: 'Arabic' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'tr', label: 'Turkish' },
  { code: 'id', label: 'Indonesian' },
];

export const NAME_MAX = 80;

export interface WorkspaceGeneralInput {
  name: string;
  logo_url: string;
  timezone: string;
  language: string;
}

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Returns an error message per invalid field; empty object means valid. */
export function validateWorkspaceGeneral(input: WorkspaceGeneralInput): FieldErrors<WorkspaceGeneralInput> {
  const errors: FieldErrors<WorkspaceGeneralInput> = {};
  const name = input.name.trim();
  if (!name) errors.name = 'Enter a workspace name.';
  else if (name.length > NAME_MAX) errors.name = `Keep the name under ${NAME_MAX} characters.`;

  if (input.logo_url.trim() && !isHttpUrl(input.logo_url.trim())) {
    errors.logo_url = 'Use a full link starting with https://, or upload an image.';
  }
  if (!isValidTimezone(input.timezone)) errors.timezone = 'Choose a timezone from the list, such as Asia/Karachi.';
  if (!LANGUAGES.some((l) => l.code === input.language)) errors.language = 'Choose a language from the list.';
  return errors;
}

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

export const NOTIFICATION_EVENTS = [
  { id: 'handover', label: 'The bot hands a conversation to the team', description: 'When a customer needs a person. With shift hours set, only the people on shift are emailed.' },
  { id: 'assigned', label: 'A conversation is assigned to me', description: 'When someone, or round-robin, gives you a ticket.' },
  { id: 'mentioned', label: 'I am mentioned in a note', description: 'When a teammate @-mentions you in an internal note.' },
  { id: 'customer_reply', label: 'A customer replies to my ticket', description: 'When a customer writes back on a ticket assigned to you.' },
  { id: 'new_conversation', label: 'A new conversation starts', description: 'Every new chat, including ones that are not yours.' },
] as const;

export type NotificationEventId = (typeof NOTIFICATION_EVENTS)[number]['id'];
export type NotificationChannel = 'email' | 'in_app';
export type ChannelPrefs = Record<NotificationEventId, boolean>;
export interface NotificationPrefs {
  email: ChannelPrefs;
  in_app: ChannelPrefs;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  email: { handover: true, assigned: true, mentioned: true, customer_reply: true, new_conversation: false },
  in_app: { handover: true, assigned: true, mentioned: true, customer_reply: true, new_conversation: true },
};

/**
 * Fills in anything missing and drops anything unknown, so a row written by an
 * older or newer version of the app never breaks the screen or the save.
 */
export function normalizeNotificationPrefs(raw: unknown): NotificationPrefs {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<NotificationChannel, unknown>>;
  const channel = (name: NotificationChannel): ChannelPrefs => {
    const given = (src[name] && typeof src[name] === 'object' ? src[name] : {}) as Record<string, unknown>;
    const out = { ...DEFAULT_NOTIFICATION_PREFS[name] };
    for (const e of NOTIFICATION_EVENTS) {
      if (typeof given[e.id] === 'boolean') out[e.id] = given[e.id] as boolean;
    }
    return out;
  };
  return { email: channel('email'), in_app: channel('in_app') };
}

export function sameNotificationPrefs(a: NotificationPrefs, b: NotificationPrefs): boolean {
  return NOTIFICATION_EVENTS.every((e) => a.email[e.id] === b.email[e.id] && a.in_app[e.id] === b.in_app[e.id]);
}

// ---------------------------------------------------------------------------
// Audit log wording
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  logo_url: 'logo',
  timezone: 'timezone',
  language: 'language',
  business_hours: 'business hours',
  brand_color: 'brand color',
  greeting_title: 'greeting',
  greeting_message: 'greeting',
  widget_position: 'widget position',
  ai_settings: 'AI bot settings',
  smtp_settings: 'email (SMTP) settings',
  auto_assignment: 'assignment rules',
  auto_close_days: 'auto-close rule',
  slug: 'help center address',
  custom_domain: 'custom domain',
  plan: 'plan',
  is_suspended: 'suspension',
};

/** One readable line for an audit row, e.g. "changed timezone, language". */
export function describeAuditEntry(entry: { action: string; target: string | null; details: Record<string, unknown> | null }): string {
  const d = entry.details ?? {};
  switch (entry.action) {
    case 'workspace.updated': {
      const fields = Array.isArray(d.fields) ? (d.fields as string[]) : [];
      const labels = Array.from(new Set(fields.map((f) => FIELD_LABELS[f] ?? f.replace(/_/g, ' '))));
      return labels.length ? `Changed ${labels.join(', ')}` : 'Changed workspace settings';
    }
    case 'member.role_changed':
      return `Changed ${entry.target ?? 'a member'}’s role from ${String(d.from)} to ${String(d.to)}`;
    case 'member.deactivated':
      return `Deactivated ${entry.target ?? 'a member'}`;
    case 'member.reactivated':
      return `Reactivated ${entry.target ?? 'a member'}`;
    default:
      return entry.action;
  }
}
