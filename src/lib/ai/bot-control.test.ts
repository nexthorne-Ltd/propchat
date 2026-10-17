/**
 * The conversation states the inbox and the auto-responder read from a
 * conversation row. The rules that set the row are in the database
 * (bot-control.db.test.ts); this is the reading side.
 */
import { describe, expect, it } from 'vitest';
import { botControlState, botMayReply, type BotControlState } from '@/lib/ai/bot-control';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

describe('botControlState', () => {
  it.each<[string, Parameters<typeof botControlState>[0], string | null, BotControlState]>([
    ['bot on, nothing special', { ai_mode: 'autopilot' }, null, 'ai_active'],
    ['copilot counts as on', { ai_mode: 'copilot' }, null, 'ai_active'],
    ['a person replied', { ai_mode: 'disabled', ai_paused_reason: 'human_reply' }, null, 'human_handling'],
    ['an agent paused it', { ai_mode: 'disabled', ai_paused_reason: 'agent_paused' }, null, 'ai_paused'],
    ['off with no reason (older rows)', { ai_mode: 'disabled' }, null, 'ai_paused'],
    ['the visitor asked for a person', { ai_mode: 'disabled', ai_paused_reason: 'human_requested' }, null, 'human_requested'],
    ['off because the bot could not help', { ai_mode: 'disabled', ai_paused_reason: 'needs_attention' }, null, 'needs_attention'],
    ['on, but a question went to the team', { ai_mode: 'autopilot', ai_needs_attention_at: at(1) }, null, 'needs_attention'],
    ['switched back on, bot has not answered since', { ai_mode: 'autopilot', ai_resumed_at: at(5) }, at(30), 'ai_resuming'],
    ['switched back on, bot answered since', { ai_mode: 'autopilot', ai_resumed_at: at(30) }, at(5), 'ai_active'],
  ])('%s → %s', (_label, conv, lastBotReplyAt, expected) => {
    expect(botControlState(conv, lastBotReplyAt)).toBe(expected);
  });
});

describe('botMayReply', () => {
  it('lets the bot answer only while it is on', () => {
    expect(botMayReply({ ai_mode: 'autopilot' })).toBe(true);
    expect(botMayReply({ ai_mode: 'autopilot', ai_resumed_at: at(1) })).toBe(true);
    expect(botMayReply({ ai_mode: 'disabled', ai_paused_reason: 'human_reply' })).toBe(false);
    expect(botMayReply({ ai_mode: 'disabled', ai_paused_reason: 'agent_paused' })).toBe(false);
    expect(botMayReply({ ai_mode: 'disabled', ai_paused_reason: 'human_requested' })).toBe(false);
  });

  it('"needs attention" with the bot still on answers; with the bot stepped aside it does not', () => {
    const on = { ai_mode: 'autopilot', ai_needs_attention_at: at(1) };
    const off = { ai_mode: 'disabled', ai_paused_reason: 'needs_attention' };
    expect(botControlState(on)).toBe('needs_attention');
    expect(botControlState(off)).toBe('needs_attention');
    expect(botMayReply(on)).toBe(true);
    expect(botMayReply(off)).toBe(false);
  });
});
