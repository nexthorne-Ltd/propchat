/**
 * The rule model the admin screens edit, and the checks that mirror the
 * database's own validation (fn_validate_conditions / fn_validate_actions in
 * 20261014090000_macros_triggers_automations.sql) so a form can show a
 * problem inline instead of waiting for the save to be refused. The database
 * stays the authority; automation.db.test.ts covers evaluation itself.
 */

export type RuleKind = 'trigger' | 'automation';
export type MatchMode = 'all' | 'any';

export interface Condition {
  field: string;
  op: string;
  value?: string | string[] | number;
}

export interface RuleAction {
  type: string;
  value?: string | string[];
  subject?: string;
  body?: string;
  url?: string;
  secret?: string;
}

export interface RuleDraft {
  id?: string;
  kind: RuleKind;
  name: string;
  description: string;
  is_active: boolean;
  match_mode: MatchMode;
  conditions: Condition[];
  actions: RuleAction[];
}

export interface RuleRow extends RuleDraft {
  id: string;
  position: number;
  workspace_id: string;
  created_at: string;
  updated_at: string;
}

export type ValueKind = 'enum' | 'entity' | 'text' | 'tags' | 'number' | 'none';

export interface FieldDef {
  id: string;
  label: string;
  kinds: RuleKind[];
  ops: { id: string; label: string }[];
  value: ValueKind;
  options?: { value: string; label: string }[];
}

const IS_OPS = [
  { id: 'is', label: 'is' },
  { id: 'is_not', label: 'is not' },
  { id: 'in', label: 'is one of' },
  { id: 'not_in', label: 'is none of' },
];
const ENTITY_OPS = [
  { id: 'is', label: 'is' },
  { id: 'is_not', label: 'is not' },
  { id: 'is_empty', label: 'is empty' },
  { id: 'is_not_empty', label: 'is not empty' },
];
const TEXT_OPS = [
  { id: 'contains', label: 'contains any of' },
  { id: 'not_contains', label: 'contains none of' },
  { id: 'is', label: 'is exactly' },
  { id: 'is_not', label: 'is not' },
  { id: 'is_empty', label: 'is empty' },
  { id: 'is_not_empty', label: 'is not empty' },
];
const TAG_OPS = [
  { id: 'contains', label: 'has any of' },
  { id: 'not_contains', label: 'has none of' },
  { id: 'contains_all', label: 'has all of' },
  { id: 'is_empty', label: 'has no tags' },
  { id: 'is_not_empty', label: 'has tags' },
];
const HOUR_OPS = [
  { id: 'gte', label: 'is at least' },
  { id: 'lte', label: 'is at most' },
];

export const CHANGED_OPTIONS = [
  { value: 'created', label: 'The ticket is created' },
  { value: 'message', label: 'The customer sends a message' },
  { value: 'reply', label: 'An agent replies' },
  { value: 'status', label: 'Status changes' },
  { value: 'priority', label: 'Priority changes' },
  { value: 'assignee', label: 'Assignee changes' },
  { value: 'group', label: 'Group changes' },
  { value: 'tags', label: 'Tags change' },
  { value: 'subject', label: 'Subject changes' },
  { value: 'type', label: 'Type changes' },
  { value: 'sla_warning', label: 'An SLA is about to be breached' },
  { value: 'sla_breach', label: 'An SLA is breached' },
];

export const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'solved', label: 'Solved' },
  { value: 'closed', label: 'Closed' },
];
export const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];
export const TYPE_OPTIONS = [
  { value: 'question', label: 'Question' },
  { value: 'incident', label: 'Incident' },
  { value: 'problem', label: 'Problem' },
  { value: 'task', label: 'Task' },
];
export const YES_NO_OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];
export const CHANNEL_OPTIONS = [
  { value: 'chat', label: 'Chat' },
  { value: 'email', label: 'Email' },
  { value: 'web_form', label: 'Web form' },
];

/** Fields a person can pick. `group_id` / `assignee_id` options come from the workspace. */
export const CONDITION_FIELDS: FieldDef[] = [
  { id: 'changed', label: 'What just happened', kinds: ['trigger'], ops: [{ id: 'is', label: 'is' }], value: 'enum', options: CHANGED_OPTIONS },
  { id: 'status', label: 'Status', kinds: ['trigger', 'automation'], ops: IS_OPS, value: 'enum', options: STATUS_OPTIONS },
  { id: 'priority', label: 'Priority', kinds: ['trigger', 'automation'], ops: IS_OPS, value: 'enum', options: PRIORITY_OPTIONS },
  { id: 'type', label: 'Type', kinds: ['trigger', 'automation'], ops: IS_OPS, value: 'enum', options: TYPE_OPTIONS },
  { id: 'channel', label: 'Channel', kinds: ['trigger', 'automation'], ops: IS_OPS, value: 'enum', options: CHANNEL_OPTIONS },
  { id: 'tags', label: 'Tags', kinds: ['trigger', 'automation'], ops: TAG_OPS, value: 'tags' },
  { id: 'subject', label: 'Subject', kinds: ['trigger', 'automation'], ops: TEXT_OPS, value: 'text' },
  { id: 'message', label: 'Latest customer message', kinds: ['trigger', 'automation'], ops: TEXT_OPS, value: 'text' },
  { id: 'group_id', label: 'Group', kinds: ['trigger', 'automation'], ops: ENTITY_OPS, value: 'entity' },
  { id: 'assignee_id', label: 'Assignee', kinds: ['trigger', 'automation'], ops: ENTITY_OPS, value: 'entity' },
  { id: 'requester_email', label: 'Requester email', kinds: ['trigger', 'automation'], ops: TEXT_OPS, value: 'text' },
  { id: 'requester_name', label: 'Requester name', kinds: ['trigger', 'automation'], ops: TEXT_OPS, value: 'text' },
  // Both read the SLA timers live. Hours until breach goes negative once an
  // SLA is breached, so "at most 2" also catches tickets that are already late.
  { id: 'sla_breached', label: 'SLA breached', kinds: ['trigger', 'automation'], ops: [{ id: 'is', label: 'is' }], value: 'enum', options: YES_NO_OPTIONS },
  { id: 'hours_until_breach', label: 'Hours until SLA breach', kinds: ['trigger', 'automation'], ops: HOUR_OPS, value: 'number' },
  { id: 'hours_since_created', label: 'Hours since created', kinds: ['automation'], ops: HOUR_OPS, value: 'number' },
  { id: 'hours_since_updated', label: 'Hours since last update', kinds: ['automation'], ops: HOUR_OPS, value: 'number' },
  { id: 'hours_since_status_change', label: 'Hours in current status', kinds: ['automation'], ops: HOUR_OPS, value: 'number' },
  { id: 'hours_since_customer_reply', label: 'Hours since customer reply', kinds: ['automation'], ops: HOUR_OPS, value: 'number' },
  { id: 'hours_since_agent_reply', label: 'Hours since agent reply', kinds: ['automation'], ops: HOUR_OPS, value: 'number' },
  { id: 'hours_since_solved', label: 'Hours since solved', kinds: ['automation'], ops: HOUR_OPS, value: 'number' },
];

export function fieldDef(id: string): FieldDef | undefined {
  return CONDITION_FIELDS.find((f) => f.id === id);
}

export function needsValue(cond: Pick<Condition, 'op'>): boolean {
  return cond.op !== 'is_empty' && cond.op !== 'is_not_empty';
}

/** What a new condition row starts as: the first field this kind supports. */
export function blankCondition(kind: RuleKind): Condition {
  const f = CONDITION_FIELDS.find((x) => x.kinds.includes(kind))!;
  return { field: f.id, op: f.ops[0].id, value: f.value === 'number' ? 1 : f.options?.[0]?.value ?? '' };
}

export const ACTION_TYPES: { id: string; label: string; outbound?: boolean }[] = [
  { id: 'set_status', label: 'Set status' },
  { id: 'set_priority', label: 'Set priority' },
  { id: 'set_type', label: 'Set type' },
  { id: 'set_group', label: 'Set group' },
  { id: 'set_assignee', label: 'Assign to' },
  { id: 'add_tags', label: 'Add tags' },
  { id: 'remove_tags', label: 'Remove tags' },
  { id: 'notify_requester', label: 'Send a requester notification', outbound: true },
  { id: 'email_requester', label: 'Email the requester', outbound: true },
  { id: 'email_agent', label: 'Email the assignee', outbound: true },
  { id: 'webhook', label: 'Notify a webhook', outbound: true },
];

export const MACRO_ACTION_TYPES = ACTION_TYPES.filter((a) => !a.outbound);

export function blankAction(type = 'set_status'): RuleAction {
  switch (type) {
    case 'set_status':
      return { type, value: 'solved' };
    case 'set_priority':
      return { type, value: 'high' };
    case 'set_type':
      return { type, value: 'question' };
    case 'set_group':
    case 'set_assignee':
      return { type, value: 'none' };
    case 'add_tags':
    case 'remove_tags':
      return { type, value: [] };
    case 'notify_requester':
      return { type, value: 'received' };
    case 'email_requester':
    case 'email_agent':
      return { type, subject: '', body: '' };
    default:
      return { type, url: '' };
  }
}

/** Placeholders a reply or email may use. Kept in step with fn_render_placeholders. */
export const PLACEHOLDERS: { token: string; label: string }[] = [
  { token: '{{ticket.id}}', label: 'Ticket number' },
  { token: '{{ticket.subject}}', label: 'Subject' },
  { token: '{{ticket.status}}', label: 'Status' },
  { token: '{{ticket.priority}}', label: 'Priority' },
  { token: '{{ticket.requester.name}}', label: 'Requester name' },
  { token: '{{ticket.requester.first_name}}', label: 'Requester first name' },
  { token: '{{ticket.requester.email}}', label: 'Requester email' },
  { token: '{{ticket.assignee.name}}', label: 'Assignee name' },
  { token: '{{agent.name}}', label: 'Your name' },
  { token: '{{agent.first_name}}', label: 'Your first name' },
  { token: '{{workspace.name}}', label: 'Workspace name' },
];

const KNOWN = new Set(PLACEHOLDERS.map((p) => p.token.slice(2, -2)));

/** `{{ticket.idd}}`-style typos: placeholders that would be sent as written. */
export function findUnknownPlaceholders(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    if (!KNOWN.has(m[1])) out.add(`{{${m[1]}}}`);
  }
  return Array.from(out);
}

/** Splits "a, b ,c" into clean tags (lowercase, 40 chars, no duplicates). */
export function parseTags(input: string): string[] {
  return Array.from(new Set(input.split(',').map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))).slice(0, 10);
}

/**
 * Webhooks go to a URL the admin typed, from our server. Refuse anything that
 * is not https or that points at this machine or a private network, so a
 * rule cannot be used to probe internal services. (A hostname that resolves
 * to a private address is checked again when sending: see outbox.ts.)
 */
export function isSafeWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return !isPrivateAddress(host);
}

/** True for loopback, private, link-local and other non-public IPv4/IPv6 literals. */
export function isPrivateAddress(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (host.includes(':')) {
    const h = host.toLowerCase();
    if (h === '::' || h === '::1') return true;
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    // URL parsing rewrites ::ffff:10.0.0.1 as ::ffff:a00:1.
    const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  return false;
}

export interface RuleErrors {
  name?: string;
  conditions: Record<number, string>;
  actions: Record<number, string>;
  form?: string;
}

export function hasErrors(e: RuleErrors): boolean {
  return Boolean(e.name || e.form || Object.keys(e.conditions).length || Object.keys(e.actions).length);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function conditionError(c: Condition, kind: RuleKind): string | null {
  const def = fieldDef(c.field);
  if (!def || !def.kinds.includes(kind)) return 'Choose what to check.';
  if (!def.ops.some((o) => o.id === c.op)) return 'Choose how to compare.';
  if (!needsValue(c)) return null;
  if (def.value === 'number') {
    const n = Number(c.value);
    const min = c.field === 'hours_until_breach' ? -8760 : 0;
    return Number.isFinite(n) && n >= min && n <= 8760 ? null : `Enter a number of hours from ${min} to 8760.`;
  }
  const empty = Array.isArray(c.value) ? c.value.length === 0 : String(c.value ?? '').trim() === '';
  if (empty) return def.value === 'enum' || def.value === 'entity' ? 'Choose a value.' : 'Enter at least one value.';
  return null;
}

function actionError(a: RuleAction, kind: 'rule' | 'macro'): string | null {
  const type = ACTION_TYPES.find((t) => t.id === a.type);
  if (!type || (kind === 'macro' && type.outbound)) return 'Choose an action.';
  switch (a.type) {
    case 'set_status':
    case 'set_priority':
    case 'set_type':
      return a.value ? null : 'Choose a value.';
    case 'set_group':
      return a.value === 'none' || (typeof a.value === 'string' && UUID.test(a.value)) ? null : 'Choose a group.';
    case 'set_assignee':
      if (a.value === 'me') return kind === 'macro' ? null : 'Choose a person; “me” only works in a macro.';
      return a.value === 'none' || (typeof a.value === 'string' && UUID.test(a.value)) ? null : 'Choose an assignee.';
    case 'add_tags':
    case 'remove_tags':
      return Array.isArray(a.value) && a.value.length >= 1 && a.value.length <= 10 ? null : 'Enter 1 to 10 tags.';
    case 'notify_requester':
      return a.value === 'received' || a.value === 'replied' || a.value === 'solved' ? null : 'Choose which notification to send.';
    case 'email_requester':
    case 'email_agent': {
      const subject = (a.subject ?? '').trim();
      const body = (a.body ?? '').trim();
      if (!subject || subject.length > 200) return 'Add a subject (up to 200 characters).';
      if (!body || body.length > 5000) return 'Add a message (up to 5000 characters).';
      const unknown = findUnknownPlaceholders(`${subject} ${body}`);
      return unknown.length ? `Unknown placeholder ${unknown.join(', ')}.` : null;
    }
    case 'webhook':
      return isSafeWebhookUrl((a.url ?? '').trim()) ? null : 'Use a public https:// address (not localhost or a private network).';
    default:
      return 'Choose an action.';
  }
}

export function validateRuleDraft(d: RuleDraft): RuleErrors {
  const e: RuleErrors = { conditions: {}, actions: {} };
  if (!d.name.trim()) e.name = 'Give the rule a name.';
  else if (d.name.trim().length > 100) e.name = 'Keep the name under 100 characters.';
  if (d.conditions.length === 0) e.form = 'Add at least one condition.';
  else if (d.conditions.length > 15) e.form = 'Use at most 15 conditions.';
  else if (d.actions.length === 0) e.form = 'Add at least one action.';
  else if (d.actions.length > 10) e.form = 'Use at most 10 actions.';
  d.conditions.forEach((c, i) => {
    const msg = conditionError(c, d.kind);
    if (msg) e.conditions[i] = msg;
  });
  d.actions.forEach((a, i) => {
    const msg = actionError(a, 'rule');
    if (msg) e.actions[i] = msg;
  });
  return e;
}

export interface MacroDraft {
  id?: string;
  title: string;
  content: string;
  shared: boolean;
  is_active: boolean;
  actions: RuleAction[];
}

export function validateMacroDraft(d: MacroDraft): { title?: string; content?: string; actions: Record<number, string> } {
  const e: { title?: string; content?: string; actions: Record<number, string> } = { actions: {} };
  if (!d.title.trim()) e.title = 'Give the macro a title.';
  else if (d.title.trim().length > 100) e.title = 'Keep the title under 100 characters.';
  if (d.content.length > 5000) e.content = 'Keep the reply under 5000 characters.';
  if (!d.content.trim() && d.actions.length === 0) e.content = 'Write a reply, add an action, or both.';
  const unknown = findUnknownPlaceholders(d.content);
  if (!e.content && unknown.length) e.content = `Unknown placeholder ${unknown.join(', ')}.`;
  d.actions.forEach((a, i) => {
    const msg = actionError(a, 'macro');
    if (msg) e.actions[i] = msg;
  });
  return e;
}

/** One readable line for a rule action, used in the list and the log. */
export function describeAction(a: { type: string; value?: unknown }, names?: { groups?: Record<string, string>; people?: Record<string, string> }): string {
  const v = Array.isArray(a.value) ? a.value.join(', ') : String(a.value ?? '');
  const pretty = (x: string) => x.replace(/_/g, ' ');
  switch (a.type) {
    case 'set_status': return `Set status to ${pretty(v)}`;
    case 'set_priority': return `Set priority to ${v}`;
    case 'set_type': return `Set type to ${v}`;
    case 'set_group': return v === 'none' ? 'Remove the group' : `Move to group ${names?.groups?.[v] ?? 'selected group'}`;
    case 'set_assignee': return v === 'none' ? 'Unassign' : v === 'me' ? 'Assign to me' : `Assign to ${names?.people?.[v] ?? 'selected person'}`;
    case 'add_tags': return `Add tags ${v}`;
    case 'remove_tags': return `Remove tags ${v}`;
    case 'notify_requester': return `Send the requester a “${v}” notification`;
    case 'email_requester': return `Email the requester: ${v}`;
    case 'email_agent': return `Email the assignee: ${v}`;
    case 'webhook': return `Notify webhook ${v}`;
    default: return a.type;
  }
}

/** Cleans a draft into what the database stores (trims, drops unused value shapes). */
export function toStoredRule(d: RuleDraft) {
  return {
    kind: d.kind,
    name: d.name.trim(),
    description: d.description.trim(),
    is_active: d.is_active,
    match_mode: d.match_mode,
    conditions: d.conditions.map((c) => {
      const def = fieldDef(c.field);
      if (!needsValue(c)) return { field: c.field, op: c.op };
      if (def?.value === 'number') return { field: c.field, op: c.op, value: Number(c.value) };
      if (def?.value === 'tags') return { field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value : parseTags(String(c.value ?? '')) };
      if (c.op === 'in' || c.op === 'not_in') return { field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value : [String(c.value)] };
      return { field: c.field, op: c.op, value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '').trim() };
    }),
    actions: d.actions.map((a) => toStoredAction(a)),
  };
}

export function toStoredAction(a: RuleAction): RuleAction {
  if (a.type === 'email_requester' || a.type === 'email_agent') return { type: a.type, subject: (a.subject ?? '').trim(), body: (a.body ?? '').trim() };
  if (a.type === 'webhook') return { type: a.type, url: (a.url ?? '').trim(), ...(a.secret?.trim() ? { secret: a.secret.trim() } : {}) };
  if (a.type === 'add_tags' || a.type === 'remove_tags') return { type: a.type, value: Array.isArray(a.value) ? a.value : parseTags(String(a.value ?? '')) };
  return { type: a.type, value: a.value };
}
