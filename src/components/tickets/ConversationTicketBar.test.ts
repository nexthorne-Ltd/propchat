import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/app/actions/tickets', () => ({ updateTicketAction: vi.fn() }));

import { slaDueLabel } from './ConversationTicketBar';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString();

describe('slaDueLabel', () => {
  it('counts down to the next SLA target', () => {
    expect(slaDueLabel(at(90), NOW)).toEqual({ text: 'Due in 2h', overdue: false, soon: false });
    expect(slaDueLabel(at(20), NOW)).toEqual({ text: 'Due in 20m', overdue: false, soon: true });
    expect(slaDueLabel(at(60 * 24 * 2), NOW)?.text).toBe('Due in 2d');
  });

  it('says how late a missed target is', () => {
    expect(slaDueLabel(at(-5), NOW)).toEqual({ text: 'Overdue 5m', overdue: true, soon: false });
  });

  it('shows nothing without a target', () => {
    expect(slaDueLabel(null, NOW)).toBeNull();
    expect(slaDueLabel('not a date', NOW)).toBeNull();
  });
});
