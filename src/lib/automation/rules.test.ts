import { describe, expect, it } from 'vitest';
import {
  blankAction,
  blankCondition,
  findUnknownPlaceholders,
  hasErrors,
  isPrivateAddress,
  isSafeWebhookUrl,
  parseTags,
  toStoredRule,
  validateMacroDraft,
  validateRuleDraft,
  type RuleDraft,
} from './rules';

const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({
  kind: 'trigger',
  name: 'Tag billing',
  description: '',
  is_active: true,
  match_mode: 'all',
  conditions: [{ field: 'message', op: 'contains', value: 'refund, invoice' }],
  actions: [{ type: 'add_tags', value: ['billing'] }],
  ...over,
});

describe('rule form validation', () => {
  it('accepts a complete rule', () => {
    expect(hasErrors(validateRuleDraft(draft()))).toBe(false);
  });

  it('needs a name, a condition and an action', () => {
    expect(validateRuleDraft(draft({ name: '  ' })).name).toBeTruthy();
    expect(validateRuleDraft(draft({ conditions: [] })).form).toMatch(/condition/);
    expect(validateRuleDraft(draft({ actions: [] })).form).toMatch(/action/);
  });

  it('flags the exact row that is wrong', () => {
    const e = validateRuleDraft(
      draft({
        conditions: [{ field: 'status', op: 'is', value: 'open' }, { field: 'message', op: 'contains', value: '' }],
        actions: [{ type: 'add_tags', value: ['ok'] }, { type: 'add_tags', value: [] }, { type: 'webhook', url: 'http://x.test' }],
      })
    );
    expect(Object.keys(e.conditions)).toEqual(['1']);
    expect(Object.keys(e.actions)).toEqual(['1', '2']);
  });

  it('keeps time conditions to automations and "what happened" to triggers', () => {
    const time = { field: 'hours_since_created', op: 'gte', value: 1 };
    expect(validateRuleDraft(draft({ conditions: [time] })).conditions[0]).toBeTruthy();
    expect(validateRuleDraft(draft({ kind: 'automation', conditions: [time] })).conditions[0]).toBeUndefined();
    const changed = { field: 'changed', op: 'is', value: 'message' };
    expect(validateRuleDraft(draft({ kind: 'automation', conditions: [changed] })).conditions[0]).toBeTruthy();
  });

  it('rejects out-of-range hours', () => {
    const bad = { field: 'hours_since_created', op: 'gte', value: 99999 };
    expect(validateRuleDraft(draft({ kind: 'automation', conditions: [bad] })).conditions[0]).toMatch(/hours/);
  });

  it('allows empty-value operators without a value', () => {
    expect(hasErrors(validateRuleDraft(draft({ conditions: [{ field: 'assignee_id', op: 'is_empty' }] })))).toBe(false);
  });

  it('refuses "assign to me" in a rule but allows it in a macro', () => {
    expect(validateRuleDraft(draft({ actions: [{ type: 'set_assignee', value: 'me' }] })).actions[0]).toBeTruthy();
    const macro = { title: 'Mine', content: 'hi', shared: false, is_active: true, actions: [{ type: 'set_assignee', value: 'me' }] };
    expect(validateMacroDraft(macro).actions[0]).toBeUndefined();
  });

  it('checks email actions and unknown placeholders', () => {
    const e = validateRuleDraft(draft({ actions: [{ type: 'email_requester', subject: 'Hi', body: 'Dear {{ticket.requester.nmae}}' }] }));
    expect(e.actions[0]).toMatch(/Unknown placeholder/);
  });

  it('builds fresh rows that are valid once filled', () => {
    expect(blankCondition('automation').field).toBe('status');
    expect(blankCondition('trigger').field).toBe('changed');
    expect(blankAction('set_priority')).toEqual({ type: 'set_priority', value: 'high' });
  });
});

describe('requester notifications', () => {
  it('is a trigger action with three templates', () => {
    const ok = draft({ actions: [{ type: 'notify_requester', value: 'solved' }] });
    expect(hasErrors(validateRuleDraft(ok))).toBe(false);
    const bad = validateRuleDraft(draft({ actions: [{ type: 'notify_requester', value: 'spam' }] }));
    expect(bad.actions[0]).toMatch(/Choose which notification/);
  });

  it('is not available in macros, which cannot send mail', () => {
    const e = validateMacroDraft({ title: 't', content: 'x', shared: true, is_active: true, actions: [{ type: 'notify_requester', value: 'solved' }] });
    expect(e.actions[0]).toBeTruthy();
  });
});

describe('macro validation', () => {
  it('needs a title and a reply or an action', () => {
    expect(validateMacroDraft({ title: '', content: 'x', shared: true, is_active: true, actions: [] }).title).toBeTruthy();
    expect(validateMacroDraft({ title: 't', content: ' ', shared: true, is_active: true, actions: [] }).content).toBeTruthy();
    expect(validateMacroDraft({ title: 't', content: '', shared: true, is_active: true, actions: [{ type: 'set_status', value: 'solved' }] }).content).toBeUndefined();
  });

  it('rejects outbound actions in macros', () => {
    const e = validateMacroDraft({ title: 't', content: 'x', shared: true, is_active: true, actions: [{ type: 'webhook', url: 'https://a.test' }] });
    expect(e.actions[0]).toBeTruthy();
  });
});

describe('placeholders and tags', () => {
  it('finds typos and ignores known placeholders, with or without spaces', () => {
    expect(findUnknownPlaceholders('Hi {{ ticket.requester.name }}, #{{ticket.id}} {{agent.nam}} {{oops}}')).toEqual(['{{agent.nam}}', '{{oops}}']);
  });

  it('cleans tag input', () => {
    expect(parseTags(' Billing, VIP ,billing,, ')).toEqual(['billing', 'vip']);
    expect(parseTags('a'.repeat(60))[0]).toHaveLength(40);
  });
});

describe('webhook safety', () => {
  it('allows public https addresses', () => {
    expect(isSafeWebhookUrl('https://hooks.example.com/zentry')).toBe(true);
    expect(isSafeWebhookUrl('https://8.8.8.8/x')).toBe(true);
  });

  it('refuses http, credentials, localhost and private networks', () => {
    for (const url of [
      'http://hooks.example.com',
      'https://user:pw@hooks.example.com',
      'https://localhost/x',
      'https://api.localhost/x',
      'https://service.internal/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://172.20.0.1/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://[::ffff:10.0.0.1]/x',
      'not a url',
    ]) {
      expect(isSafeWebhookUrl(url), url).toBe(false);
    }
  });

  it('knows which addresses are private', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
  });
});

describe('what gets stored', () => {
  it('turns the form into the shapes the database validates', () => {
    const stored = toStoredRule(
      draft({
        kind: 'automation',
        name: '  Remind  ',
        conditions: [
          { field: 'status', op: 'in', value: ['pending'] },
          { field: 'hours_since_status_change', op: 'gte', value: '72' },
          { field: 'tags', op: 'not_contains', value: 'Reminded, x' },
          { field: 'requester_email', op: 'is_not_empty', value: 'ignored' },
        ],
        actions: [{ type: 'email_requester', subject: ' Hi ', body: ' Body ', url: 'ignored' }, { type: 'add_tags', value: 'Reminded' as unknown as string[] }],
      })
    );
    expect(stored.name).toBe('Remind');
    expect(stored.conditions).toEqual([
      { field: 'status', op: 'in', value: ['pending'] },
      { field: 'hours_since_status_change', op: 'gte', value: 72 },
      { field: 'tags', op: 'not_contains', value: ['reminded', 'x'] },
      { field: 'requester_email', op: 'is_not_empty' },
    ]);
    expect(stored.actions).toEqual([{ type: 'email_requester', subject: 'Hi', body: 'Body' }, { type: 'add_tags', value: ['reminded'] }]);
  });
});

describe('SLA conditions', () => {
  const sla = (conditions: RuleDraft['conditions'], kind: RuleDraft['kind'] = 'trigger') => validateRuleDraft(draft({ kind, conditions }));

  it('offers both conditions to triggers and automations', () => {
    for (const kind of ['trigger', 'automation'] as const) {
      expect(hasErrors(sla([{ field: 'sla_breached', op: 'is', value: 'yes' }], kind))).toBe(false);
      expect(hasErrors(sla([{ field: 'hours_until_breach', op: 'lte', value: 2 }], kind))).toBe(false);
    }
  });

  it('lets hours until breach go negative, but keeps the time-since conditions non-negative', () => {
    expect(hasErrors(sla([{ field: 'hours_until_breach', op: 'lte', value: -4 }]))).toBe(false);
    expect(hasErrors(sla([{ field: 'hours_until_breach', op: 'lte', value: -9000 }]))).toBe(true);
    expect(hasErrors(sla([{ field: 'hours_since_created', op: 'gte', value: -1 }], 'automation'))).toBe(true);
  });

  it('stores the number as a number', () => {
    const stored = toStoredRule(draft({ conditions: [{ field: 'hours_until_breach', op: 'lte', value: '1.5' }] }));
    expect(stored.conditions[0]).toEqual({ field: 'hours_until_breach', op: 'lte', value: 1.5 });
  });
});
