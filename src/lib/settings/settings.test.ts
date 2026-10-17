import { describe, expect, it } from 'vitest';
import {
  canOpenTab,
  resolveTarget,
  searchSettings,
  SETTINGS_SECTIONS,
  visibleSections,
} from './registry';
import {
  DEFAULT_NOTIFICATION_PREFS,
  describeAuditEntry,
  isValidTimezone,
  normalizeNotificationPrefs,
  validateWorkspaceGeneral,
} from './validation';
import { ROLES, roleCan } from '@/lib/team/permissions';

const ids = (role: Parameters<typeof visibleSections>[0]) => visibleSections(role).map((s) => s.id);

describe('who sees which settings', () => {
  it('owners see every section', () => {
    expect(ids('owner')).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
  });

  it('admins see everything except billing', () => {
    expect(ids('admin')).not.toContain('billing');
    expect(ids('admin')).toContain('security');
    expect(ids('admin')).toContain('team');
  });

  it('agents get their account pages, the shared tools and their own macros', () => {
    expect(visibleSections('agent').find((s) => s.id === 'automation')?.tabs.map((t) => t.id)).toEqual(['macros']);
    expect(ids('light_agent')).not.toContain('automation');
    for (const role of ['agent', 'light_agent'] as const) {
      const sections = visibleSections(role).filter((s) => s.id !== 'automation');
      expect(sections.map((s) => s.id).sort()).toEqual(['channels', 'notifications', 'security', 'tickets']);
      const security = sections.find((s) => s.id === 'security')!;
      expect(security.tabs.map((t) => t.id)).toEqual(['sessions', 'twofactor']); // no audit log
    }
  });

  it('a non-member sees nothing', () => {
    expect(visibleSections(null)).toEqual([]);
    expect(resolveTarget('workspace', undefined)).toBeNull();
  });

  it('every gated tab agrees with the capability matrix', () => {
    for (const role of ROLES) {
      for (const s of SETTINGS_SECTIONS) {
        for (const t of s.tabs) {
          const expected = (t.capability === null || roleCan(role, t.capability)) && (!t.ownerOnly || role === 'owner');
          expect(canOpenTab(t, role)).toBe(expected);
        }
      }
    }
  });
});

describe('resolving a link to a page', () => {
  it('understands section and section:tab', () => {
    expect(resolveTarget('team:groups', 'admin')).toEqual({ section: 'team', tab: 'groups' });
    expect(resolveTarget('team', 'admin')).toEqual({ section: 'team', tab: 'members' });
  });

  it('keeps old ids working', () => {
    expect(resolveTarget('install', 'owner')).toEqual({ section: 'channels', tab: 'website' });
    expect(resolveTarget('domains', 'owner')).toEqual({ section: 'helpcenter', tab: 'domain' });
    expect(resolveTarget('routing', 'owner')).toEqual({ section: 'workspace', tab: 'hours' });
    expect(resolveTarget('replies', 'owner')).toEqual({ section: 'automation', tab: 'replies' });
  });

  it('falls back to a page the role may open instead of an empty screen', () => {
    expect(resolveTarget('billing', 'admin')?.section).toBe('workspace');
    const agent = resolveTarget('workspace', 'agent')!;
    expect(ids('agent')).toContain(agent.section);
    expect(resolveTarget('nonsense', 'owner')).toEqual({ section: 'workspace', tab: 'general' });
  });
});

describe('searching settings', () => {
  it('finds pages by keyword', () => {
    const top = searchSettings('smtp', 'admin')[0];
    expect(`${top.section.id}:${top.tab.id}`).toBe('channels:email');
    expect(`${searchSettings('2fa', 'agent')[0].section.id}`).toBe('security');
  });

  it('needs every word to match', () => {
    expect(searchSettings('smtp unicorn', 'admin')).toEqual([]);
    expect(searchSettings('   ', 'admin')).toEqual([]);
  });

  it('ranks a title match above a description match', () => {
    const results = searchSettings('groups', 'admin');
    expect(`${results[0].section.id}:${results[0].tab.id}`).toBe('team:groups');
  });

  it('never returns a page the role cannot open', () => {
    expect(searchSettings('audit', 'agent')).toEqual([]);
    expect(searchSettings('invoice', 'admin')).toEqual([]);
    expect(searchSettings('invoice', 'owner').length).toBeGreaterThan(0);
  });

  it('matches email-related pages when searching an email address', () => {
    const matches = searchSettings('nexthorne@gmail.com', 'owner');
    const matchedTabs = matches.map((m) => `${m.section.id}:${m.tab.id}`);
    expect(matchedTabs).toContain('team:members');
    expect(matchedTabs).toContain('channels:email');
  });
});

describe('workspace general validation', () => {
  const ok = { name: 'Acme', logo_url: '', timezone: 'Asia/Karachi', language: 'en' };

  it('accepts a good form', () => {
    expect(validateWorkspaceGeneral(ok)).toEqual({});
  });

  it('flags each bad field with a message', () => {
    const errors = validateWorkspaceGeneral({ name: '  ', logo_url: 'javascript:alert(1)', timezone: 'Mars/Base', language: 'xx' });
    expect(Object.keys(errors).sort()).toEqual(['language', 'logo_url', 'name', 'timezone']);
  });

  it('limits the name length', () => {
    expect(validateWorkspaceGeneral({ ...ok, name: 'x'.repeat(81) }).name).toMatch(/under 80/);
  });

  it('checks timezones against the real zone list', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('notification preferences', () => {
  it('fills defaults for a missing or malformed row', () => {
    expect(normalizeNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizeNotificationPrefs({ email: 'yes', in_app: [1] })).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('keeps valid booleans, ignores unknown keys and wrong types', () => {
    const prefs = normalizeNotificationPrefs({ email: { assigned: false, bogus: true, mentioned: 'no' }, in_app: { new_conversation: false } });
    expect(prefs.email.assigned).toBe(false);
    expect(prefs.email.mentioned).toBe(DEFAULT_NOTIFICATION_PREFS.email.mentioned);
    expect(prefs.in_app.new_conversation).toBe(false);
    expect('bogus' in prefs.email).toBe(false);
  });
});

describe('audit wording', () => {
  it('summarises changed fields without values and merges duplicates', () => {
    expect(describeAuditEntry({ action: 'workspace.updated', target: 'Acme', details: { fields: ['greeting_title', 'greeting_message', 'timezone'] } })).toBe(
      'Changed greeting, timezone'
    );
  });

  it('describes role changes', () => {
    expect(describeAuditEntry({ action: 'member.role_changed', target: 'Sam', details: { from: 'agent', to: 'admin' } })).toBe(
      'Changed Sam’s role from agent to admin'
    );
  });
});
