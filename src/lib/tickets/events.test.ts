import { describe, expect, it } from 'vitest';
import { actorLabel, describeEvent, type EventContext } from '@/lib/tickets/events';
import type { TicketEvent } from '@/types/database';

const ctx: EventContext = {
  people: { agent1: 'Sara', agent2: 'Bilal', visitor1: 'Ayesha' },
  groups: { g1: 'Billing' },
};

const event = (e: Partial<TicketEvent>): TicketEvent => ({
  id: 1,
  ticket_id: 't',
  workspace_id: 'w',
  actor_type: 'agent',
  actor_id: 'agent1',
  action: 'updated',
  field: null,
  old_value: null,
  new_value: null,
  created_at: '2026-10-09T10:00:00Z',
  ...e,
});

describe('audit log wording', () => {
  it.each([
    [{ action: 'created', field: 'status', new_value: 'new' }, 'Created the ticket as New'],
    [{ field: 'status', old_value: 'pending', new_value: 'open' }, 'Status: Pending → Open'],
    [{ field: 'status', old_value: 'open', new_value: 'on_hold' }, 'Status: Open → On-hold'],
    [{ field: 'priority', old_value: 'normal', new_value: 'urgent' }, 'Priority: Normal → Urgent'],
    [{ field: 'assignee_id', old_value: null, new_value: 'agent2' }, 'Assignee: Unassigned → Bilal'],
    [{ field: 'group_id', old_value: 'g1', new_value: null }, 'Group: Billing → No group'],
    [{ field: 'tags', old_value: '', new_value: 'vip, billing' }, 'Tags: — → vip, billing'],
    [{ field: 'assignee_id', old_value: 'gone', new_value: null }, 'Assignee: Someone no longer here → Unassigned'],
    [{ action: 'internal_note', new_value: 'secret' }, 'Added an internal note'],
    [{ action: 'follow_up_created', new_value: '#1001' }, 'Opened this ticket as a follow-up to #1001'],
  ] as [Partial<TicketEvent>, string][])('%o → %s', (e, text) => {
    expect(describeEvent(event(e), ctx)).toBe(text);
  });

  it('names the actor', () => {
    expect(actorLabel({ actor_type: 'agent', actor_id: 'agent1' }, ctx)).toBe('Sara');
    expect(actorLabel({ actor_type: 'customer', actor_id: 'visitor1' }, ctx)).toBe('Ayesha');
    expect(actorLabel({ actor_type: 'customer', actor_id: null }, ctx)).toBe('Customer');
    expect(actorLabel({ actor_type: 'system', actor_id: null }, ctx)).toBe('System');
    expect(actorLabel({ actor_type: 'bot', actor_id: null }, ctx)).toBe('Bot');
  });
});
