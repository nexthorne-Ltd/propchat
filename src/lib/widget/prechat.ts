/**
 * The pre-chat form (Settings → Chat widget → Pre-chat form), shared by the
 * embeddable widget and the settings screen. Stored in
 * workspaces.navbar_trigger_config.prechat, which the widget already reads.
 * A chosen topic is added to the new ticket as a tag
 * (fn_set_conversation_topic), so triggers can route on it.
 */

export type PrechatFieldMode = 'off' | 'optional' | 'required';

export interface PrechatConfig {
  enabled: boolean;
  title: string;
  intro: string;
  name: PrechatFieldMode;
  email: PrechatFieldMode;
  /** Empty: no topic question. */
  topics: string[];
  topic_required: boolean;
}

/** What the widget did before this setting existed: name optional, email required. */
export const DEFAULT_PRECHAT: PrechatConfig = {
  enabled: true,
  title: 'Welcome! 👋',
  intro: 'Tell us a little about yourself so the right person can help.',
  name: 'optional',
  email: 'required',
  topics: [],
  topic_required: false,
};

const MODES: PrechatFieldMode[] = ['off', 'optional', 'required'];

/** Fills in defaults and drops anything malformed (it comes from JSON). */
export function normalizePrechat(raw: unknown): PrechatConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof PrechatConfig, unknown>>;
  const mode = (v: unknown, d: PrechatFieldMode) => (MODES.includes(v as PrechatFieldMode) ? (v as PrechatFieldMode) : d);
  const text = (v: unknown, d: string, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);
  const topics = Array.isArray(r.topics)
    ? Array.from(new Set(r.topics.map((t) => String(t ?? '').trim().slice(0, 40)).filter(Boolean))).slice(0, 12)
    : [];
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_PRECHAT.enabled,
    title: text(r.title, DEFAULT_PRECHAT.title, 80),
    intro: text(r.intro, DEFAULT_PRECHAT.intro, 240),
    name: mode(r.name, DEFAULT_PRECHAT.name),
    email: mode(r.email, DEFAULT_PRECHAT.email),
    topics,
    topic_required: Boolean(r.topic_required) && topics.length > 0,
  };
}

/** True when the form has nothing to ask (every field off): it is then skipped. */
export function prechatAsksNothing(c: PrechatConfig): boolean {
  return c.name === 'off' && c.email === 'off' && c.topics.length === 0;
}
