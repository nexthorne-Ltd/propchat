'use client';

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import {
  ACTION_TYPES,
  CONDITION_FIELDS,
  MACRO_ACTION_TYPES,
  PLACEHOLDERS,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
  blankAction,
  blankCondition,
  fieldDef,
  needsValue,
  parseTags,
  type Condition,
  type RuleAction,
  type RuleKind,
} from '@/lib/automation/rules';
import { cn } from '@/lib/utils';

export interface Lookups {
  groups: { id: string; name: string }[];
  people: { id: string; name: string }[];
}

function RowError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-2xs font-medium text-danger mt-1">
      {message}
    </p>
  ) : null;
}

/** Value input for one condition, shaped by the field and operator. */
function ConditionValue({ cond, lookups, onChange, label }: { cond: Condition; lookups: Lookups; onChange: (value: Condition['value']) => void; label: string }) {
  const def = fieldDef(cond.field);
  if (!def || !needsValue(cond)) return <span className="text-xs text-ink-3 px-1">No value needed</span>;
  const multi = cond.op === 'in' || cond.op === 'not_in';

  if (def.value === 'enum') {
    const options = def.options ?? [];
    if (multi) {
      const picked = Array.isArray(cond.value) ? cond.value : cond.value ? [String(cond.value)] : [];
      return (
        <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
          {options.map((o) => {
            const on = picked.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? picked.filter((v) => v !== o.value) : [...picked, o.value])}
                className={cn('pill cursor-pointer', on ? 'pill-accent' : 'pill-neutral')}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <Select aria-label={label} value={Array.isArray(cond.value) ? String(cond.value[0] ?? '') : String(cond.value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  if (def.value === 'entity') {
    const options = cond.field === 'group_id' ? lookups.groups : lookups.people;
    return (
      <Select aria-label={label} value={String(cond.value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
    );
  }
  if (def.value === 'number') {
    return <Input aria-label={label} type="number" min={def.id === 'hours_until_breach' ? -8760 : 0} max={8760} className="w-28" value={String(cond.value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <Input
      aria-label={label}
      value={Array.isArray(cond.value) ? cond.value.join(', ') : String(cond.value ?? '')}
      placeholder={def.value === 'tags' ? 'billing, vip' : 'comma-separated, any can match'}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ConditionRows({
  kind,
  conditions,
  errors,
  lookups,
  onChange,
}: {
  kind: RuleKind;
  conditions: Condition[];
  errors: Record<number, string>;
  lookups: Lookups;
  onChange: (next: Condition[]) => void;
}) {
  const fields = CONDITION_FIELDS.filter((f) => f.kinds.includes(kind));
  const update = (i: number, patch: Partial<Condition>) => onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  return (
    <div className="space-y-2">
      {conditions.map((c, i) => {
        const def = fieldDef(c.field);
        return (
          <div key={i} className="rounded-md border border-line bg-surface-2 p-2.5">
            <div className="flex flex-wrap items-start gap-2">
              <Select
                aria-label={`Condition ${i + 1} field`}
                className="w-full sm:w-52"
                value={c.field}
                onChange={(e) => {
                  const next = fieldDef(e.target.value)!;
                  update(i, { field: next.id, op: next.ops[0].id, value: next.value === 'number' ? 1 : next.options?.[0]?.value ?? '' });
                }}
              >
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={`Condition ${i + 1} operator`}
                className="w-full sm:w-44"
                value={c.op}
                onChange={(e) => {
                  const op = e.target.value;
                  const multi = op === 'in' || op === 'not_in';
                  const value = def?.value === 'enum' ? (multi ? (Array.isArray(c.value) ? c.value : c.value ? [String(c.value)] : []) : Array.isArray(c.value) ? c.value[0] ?? '' : c.value) : c.value;
                  update(i, { op, value });
                }}
              >
                {(def?.ops ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <div className="flex-1 min-w-[10rem]">
                <ConditionValue cond={c} lookups={lookups} label={`Condition ${i + 1} value`} onChange={(value) => update(i, { value })} />
              </div>
              <Button iconOnly variant="ghost" size="sm" aria-label={`Remove condition ${i + 1}`} onClick={() => onChange(conditions.filter((_, idx) => idx !== i))}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
            <RowError message={errors[i]} />
          </div>
        );
      })}
      <Button size="sm" onClick={() => onChange([...conditions, blankCondition(kind)])} disabled={conditions.length >= 15}>
        <Plus className="w-3.5 h-3.5" /> Add condition
      </Button>
    </div>
  );
}

/** Shared by rules and macros. Macros cannot send email or call webhooks. */
export function ActionRows({
  actions,
  errors,
  lookups,
  onChange,
  macro,
}: {
  actions: RuleAction[];
  errors: Record<number, string>;
  lookups: Lookups;
  onChange: (next: RuleAction[]) => void;
  macro?: boolean;
}) {
  const types = macro ? MACRO_ACTION_TYPES : ACTION_TYPES;
  const update = (i: number, next: RuleAction) => onChange(actions.map((a, idx) => (idx === i ? next : a)));

  return (
    <div className="space-y-2">
      {actions.map((a, i) => (
        <div key={i} className="rounded-md border border-line bg-surface-2 p-2.5">
          <div className="flex flex-wrap items-start gap-2">
            <Select aria-label={`Action ${i + 1} type`} className="w-full sm:w-52" value={a.type} onChange={(e) => update(i, blankAction(e.target.value))}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
            <div className="flex-1 min-w-[10rem]">
              <ActionValue action={a} lookups={lookups} macro={macro} label={`Action ${i + 1}`} onChange={(next) => update(i, next)} />
            </div>
            <Button iconOnly variant="ghost" size="sm" aria-label={`Remove action ${i + 1}`} onClick={() => onChange(actions.filter((_, idx) => idx !== i))}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
          <RowError message={errors[i]} />
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...actions, blankAction(macro ? 'set_status' : 'add_tags')])} disabled={actions.length >= 10}>
        <Plus className="w-3.5 h-3.5" /> Add action
      </Button>
    </div>
  );
}

const NOTIFICATION_OPTIONS = [
  { value: 'received', label: 'Ticket received' },
  { value: 'replied', label: 'Agent replied' },
  { value: 'solved', label: 'Ticket solved' },
];

function ActionValue({ action, lookups, macro, label, onChange }: { action: RuleAction; lookups: Lookups; macro?: boolean; label: string; onChange: (a: RuleAction) => void }) {
  const choose = (options: { value: string; label: string }[]) => (
    <Select aria-label={`${label} value`} value={String(action.value ?? '')} onChange={(e) => onChange({ ...action, value: e.target.value })}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
  switch (action.type) {
    case 'set_status':
      return choose(STATUS_OPTIONS.filter((o) => o.value !== 'new'));
    case 'set_priority':
      return choose(PRIORITY_OPTIONS);
    case 'set_type':
      return choose(TYPE_OPTIONS);
    case 'set_group':
      return choose([{ value: 'none', label: 'No group' }, ...lookups.groups.map((g) => ({ value: g.id, label: g.name }))]);
    case 'set_assignee':
      return choose([
        { value: 'none', label: 'Unassigned' },
        ...(macro ? [{ value: 'me', label: 'Me (the agent using the macro)' }] : []),
        ...lookups.people.map((p) => ({ value: p.id, label: p.name })),
      ]);
    case 'add_tags':
    case 'remove_tags':
      return (
        <Input
          key={action.type}
          aria-label={`${label} tags`}
          placeholder="billing, vip"
          defaultValue={Array.isArray(action.value) ? action.value.join(', ') : ''}
          onChange={(e) => onChange({ ...action, value: parseTags(e.target.value) })}
        />
      );
    case 'notify_requester':
      return (
        <div className="space-y-1">
          {choose(NOTIFICATION_OPTIONS)}
          <p className="text-2xs text-ink-3">Sent as a branded email from your support address. Needs the email channel (Settings → Channels).</p>
        </div>
      );
    case 'email_requester':
    case 'email_agent':
      return (
        <div className="space-y-2">
          <Input aria-label={`${label} subject`} placeholder="Subject" value={action.subject ?? ''} onChange={(e) => onChange({ ...action, subject: e.target.value })} />
          <Textarea aria-label={`${label} message`} rows={4} placeholder="Message. Placeholders like {{ticket.requester.name}} are filled in." value={action.body ?? ''} onChange={(e) => onChange({ ...action, body: e.target.value })} />
          <PlaceholderHelp />
        </div>
      );
    case 'webhook':
      return (
        <div className="space-y-2">
          <Input aria-label={`${label} URL`} inputMode="url" placeholder="https://example.com/hooks/zentry" value={action.url ?? ''} onChange={(e) => onChange({ ...action, url: e.target.value })} />
          <Input aria-label={`${label} signing secret`} placeholder="Signing secret (optional)" value={action.secret ?? ''} onChange={(e) => onChange({ ...action, secret: e.target.value })} />
          <p className="text-2xs text-ink-3">We POST the ticket as JSON. With a secret, the body is signed in the X-Zentry-Signature header (HMAC-SHA256).</p>
        </div>
      );
    default:
      return null;
  }
}

export function PlaceholderHelp({ onInsert }: { onInsert?: (token: string) => void }) {
  return (
    <details className="text-2xs text-ink-3">
      <summary className="cursor-pointer select-none text-ink-2 font-medium">Placeholders you can use</summary>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {PLACEHOLDERS.map((p) => (
          <li key={p.token}>
            {onInsert ? (
              <button type="button" className="pill pill-neutral cursor-pointer font-mono" title={p.label} onClick={() => onInsert(p.token)}>
                {p.token}
              </button>
            ) : (
              <code className="pill pill-neutral font-mono" title={p.label}>
                {p.token}
              </code>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
