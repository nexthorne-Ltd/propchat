import { describe, expect, it } from 'vitest';
import {
  friendlyReason,
  handoverHandled,
  handoverState,
  pendingHandoverIn,
  isWaitingForPerson,
  parseHandoverNote,
  sortHandovers,
  type HandoverItem,
} from './handovers';

describe('handoverHandled (the handover ring stops)', () => {
  const since = '2026-11-14T10:00:00.000Z';
  const waiting = {
    status: 'open' as const,
    ai_paused_reason: null,
    ai_needs_attention_at: since,
    channel_metadata: {},
    updated_at: since,
  };

  it('keeps ringing while the customer waits', () => {
    expect(handoverHandled(waiting, since)).toBe(false);
  });

  it('stops when a person replies after the handover', () => {
    expect(handoverHandled({ ...waiting, channel_metadata: { last_human_reply_at: '2026-11-14T10:01:00.000Z' } }, since)).toBe(true);
  });

  it('does not stop for a reply from before the handover', () => {
    expect(handoverHandled({ ...waiting, channel_metadata: { last_human_reply_at: '2026-11-14T09:00:00.000Z' } }, since)).toBe(false);
  });

  it('stops on Connect or Take over', () => {
    expect(
      handoverHandled(
        { ...waiting, ai_paused_reason: 'agent_paused', ai_needs_attention_at: null, updated_at: '2026-11-14T10:02:00.000Z' },
        since
      )
    ).toBe(true);
  });

  it('does not stop for an older takeover row that arrives late', () => {
    expect(
      handoverHandled(
        { ...waiting, ai_paused_reason: 'agent_paused', ai_needs_attention_at: null, updated_at: '2026-11-14T09:30:00.000Z' },
        since
      )
    ).toBe(false);
  });

  it('stops when the chat is closed', () => {
    expect(handoverHandled({ ...waiting, status: 'closed' }, since)).toBe(true);
  });
});

describe('parseHandoverNote', () => {
  it('reads the note buildHandoverSummary writes', () => {
    const note = parseHandoverNote(
      [
        '🤖 Bot handover: Account-specific',
        'Why: Not in the help center: Articles retrieved, but they do not answer the question',
        'Visitor said: "mera payout 3 din se nahi aaya"',
        'Summary: Payout delayed',
        'Earlier: "hi" / "account 5k"',
        'Given: account 123456, email a@b.co',
        'Tone: frustrated / complaint',
        'Language: Roman Urdu',
        '',
        'Assigned to Sara (on shift).',
      ].join('\n')
    );
    expect(note).toEqual({
      topic: 'Account-specific',
      reason: 'Not in the help center: Articles retrieved, but they do not answer the question',
      question: 'mera payout 3 din se nahi aaya',
      summary: 'Payout delayed',
      earlier: '"hi" / "account 5k"',
      given: 'account 123456, email a@b.co',
      frustrated: true,
      language: 'Roman Urdu',
    });
  });

  it('reads the older one-line note', () => {
    const note = parseHandoverNote('🤖 The bot could not answer this, so it needs a person.\nReason: AI unavailable\nNobody is on shift');
    expect(note.reason).toBe('AI unavailable');
    expect(note.question).toBeNull();
  });

  it('copes with nothing', () => {
    expect(parseHandoverNote(null).reason).toBeNull();
  });
});

describe('handoverState', () => {
  const at = '2026-10-24T10:00:00.000Z';
  const base = { status: 'open' as const, ai_paused_reason: null, ai_needs_attention_at: null, channel_metadata: null };

  it('is waiting while the conversation needs a person', () => {
    expect(handoverState({ ...base, ai_needs_attention_at: at }, at)).toBe('waiting');
    expect(handoverState({ ...base, ai_paused_reason: 'human_requested' }, at)).toBe('waiting');
    expect(handoverState({ ...base, ai_paused_reason: 'needs_attention' }, at)).toBe('waiting');
  });

  it('is answered once a person replied after the handover', () => {
    const conv = { ...base, ai_paused_reason: 'human_reply' as const, channel_metadata: { last_human_reply_at: '2026-10-24T10:05:00.000Z' } };
    expect(handoverState(conv, at)).toBe('answered');
  });

  it('a reply from before the handover does not answer it', () => {
    const conv = { ...base, ai_needs_attention_at: at, channel_metadata: { last_human_reply_at: '2026-10-24T09:00:00.000Z' } };
    expect(handoverState(conv, at)).toBe('waiting');
  });

  it('is closed when resolved without a reply', () => {
    expect(handoverState({ ...base, status: 'closed', ai_needs_attention_at: at }, at)).toBe('closed');
  });

  it('the badge ignores closed conversations', () => {
    expect(isWaitingForPerson({ ...base, status: 'closed', ai_paused_reason: 'human_requested' })).toBe(false);
    expect(isWaitingForPerson({ ...base, ai_paused_reason: 'human_requested' })).toBe(true);
    expect(isWaitingForPerson({ ...base, ai_paused_reason: 'human_reply' })).toBe(false);
  });
});

describe('friendlyReason', () => {
  it.each([
    ['Customer expressed anger or strong frustration. Immediate handover.', 'Customer is upset'],
    ['Help center has no article that fits (low retrieval confidence)', 'Not in the help center'],
    ['Partly answered. Not in the help center: refund time', 'Partly answered'],
    ['Customer repeated inquiry or indicated previous response did not help (2 failures).', "Bot's answer didn't help"],
    ['Payouts specialist is switched off: the team answers these', 'Topic handled by the team'],
  ])('%s', (reason, label) => {
    expect(friendlyReason(reason)).toBe(label);
  });
});

describe('sortHandovers', () => {
  const item = (id: string, state: HandoverItem['state'], priority: HandoverItem['priority'], at: string) =>
    ({ id, state, priority, at }) as HandoverItem;

  it('puts waiting first, urgent first, longest wait first', () => {
    const sorted = sortHandovers([
      item('done', 'answered', 'urgent', '2026-10-24T12:00:00Z'),
      item('normal-old', 'waiting', 'normal', '2026-10-24T08:00:00Z'),
      item('urgent', 'waiting', 'urgent', '2026-10-24T11:00:00Z'),
      item('normal-new', 'waiting', 'normal', '2026-10-24T10:00:00Z'),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(['urgent', 'normal-old', 'normal-new', 'done']);
  });
});

describe('pendingHandoverIn (the Connect banner)', () => {
  const note = { created_at: '2026-11-14T10:00:00Z', sender_type: 'agent', sender_id: null, is_internal: true, metadata: { is_handover: true } };
  const bot = { created_at: '2026-11-14T10:01:00Z', sender_type: 'ai', sender_id: null, is_internal: false, metadata: {} };
  const person = { created_at: '2026-11-14T10:02:00Z', sender_type: 'agent', sender_id: 'agent-1', is_internal: false, metadata: {} };
  const visitor = { created_at: '2026-11-14T09:59:00Z', sender_type: 'visitor', sender_id: null, is_internal: false, metadata: {} };

  it('is waiting after a handover, even if the bot spoke since', () => {
    expect(pendingHandoverIn([visitor, note, bot])).toBe(true);
  });

  it('is not waiting once a person replied after it', () => {
    expect(pendingHandoverIn([person, visitor, note, bot])).toBe(false);
  });

  it('is not waiting without a handover', () => {
    expect(pendingHandoverIn([visitor, bot])).toBe(false);
  });

  it('ignores the widget welcome', () => {
    const welcome = { ...person, sender_id: 'agent-1', metadata: { is_welcome: true } };
    expect(pendingHandoverIn([note, welcome])).toBe(true);
  });
});
