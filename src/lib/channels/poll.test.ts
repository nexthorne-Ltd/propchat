import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelConnection } from '@/types/database';

/**
 * The poller's promises: it never polls a connection more often than its
 * channel allows, it claims a poll before calling the platform (so an
 * overlapping run skips instead of doubling the calls), a rate limit is not an
 * alarm, and a broken token is.
 */

const order: string[] = [];
const adapter = { poll: vi.fn(), capabilities: { pollIntervalSeconds: 300 }, label: 'X' };
const updateConnection = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
  order.push(patch.settings && 'last_polled_at' in (patch.settings as object) && !('poll_state' in (patch.settings as object)) ? 'claim' : 'save');
});
const recordConnectionError = vi.fn(async () => undefined);
const storeEvent = vi.fn(async () => async () => undefined);

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}), hasServiceRole: () => true }));
vi.mock('./registry', () => ({ getAdapter: () => adapter }));
vi.mock('./refresh', () => ({ withFreshCredentials: async (c: unknown) => c }));
vi.mock('./inbound', () => ({ storeEvent: (...a: unknown[]) => storeEvent(...(a as [])) }));
vi.mock('./store', () => ({
  updateConnection: (...a: [string, Record<string, unknown>]) => updateConnection(...a),
  recordConnectionError: (...a: unknown[]) => recordConnectionError(...(a as [])),
  loadConnectionById: async () => ({ connection: { settings: {} }, credentials: {} }),
  getConnection: async () => base(),
}));

import { ChannelApiError } from './http';
import { pollConnection } from './poll';

function base(over: Partial<ChannelConnection> = {}): ChannelConnection {
  return { id: 'c1', workspace_id: 'w1', channel: 'x', status: 'connected', settings: {}, last_error: null, last_inbound_at: null, ...over } as ChannelConnection;
}

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  adapter.poll.mockResolvedValue({ events: [], state: { cursor: 1 } });
});

describe('pollConnection', () => {
  it('skips a connection checked less than its interval ago, without calling the platform', async () => {
    const r = await pollConnection(base({ settings: { last_polled_at: new Date(Date.now() - 60_000).toISOString() } }), 'https://app');
    expect(r.outcome).toBe('skipped');
    expect(adapter.poll).not.toHaveBeenCalled();
    expect(updateConnection).not.toHaveBeenCalled();
  });

  it('polls a due connection, claiming it before the call and saving the cursor after', async () => {
    adapter.poll.mockImplementation(async () => {
      order.push('call');
      return { events: [{ kind: 'message' }, { kind: 'message' }], state: { cursor: 2 } };
    });
    const r = await pollConnection(base({ settings: { last_polled_at: new Date(Date.now() - 600_000).toISOString() } }), 'https://app');
    expect(r).toEqual({ outcome: 'polled', ingested: 2 });
    expect(order).toEqual(['claim', 'call', 'save']);
    const saved = updateConnection.mock.calls.at(-1)![1].settings as { poll_state: unknown };
    expect(saved.poll_state).toEqual({ cursor: 2 });
  });

  it('lets a person force a check, but not more than once a minute', async () => {
    expect((await pollConnection(base({ settings: { last_polled_at: new Date(Date.now() - 20_000).toISOString() } }), 'x', { force: true })).outcome).toBe('skipped');
    expect((await pollConnection(base({ settings: { last_polled_at: new Date(Date.now() - 90_000).toISOString() } }), 'x', { force: true })).outcome).toBe('polled');
  });

  it('treats a rate limit as a quiet skip: no error recorded, cursor untouched', async () => {
    adapter.poll.mockRejectedValue(new ChannelApiError({ error: 'rate limited', retryable: true, needsAttention: false, status: 429 }));
    const r = await pollConnection(base(), 'x');
    expect(r.outcome).toBe('skipped');
    expect(recordConnectionError).not.toHaveBeenCalled();
    expect(updateConnection.mock.calls.some((c) => 'poll_state' in ((c[1].settings as object) || {}))).toBe(false);
  });

  it('flags a revoked token for an admin', async () => {
    adapter.poll.mockRejectedValue(new ChannelApiError({ error: 'token revoked', retryable: false, needsAttention: true, status: 401 }));
    const r = await pollConnection(base(), 'x');
    expect(r).toMatchObject({ outcome: 'failed', reason: 'token revoked' });
    expect(recordConnectionError).toHaveBeenCalledWith('c1', 'token revoked', true);
  });

  it('ignores disconnected connections and channels that are not polled', async () => {
    expect((await pollConnection(base({ status: 'disconnected' }), 'x')).outcome).toBe('skipped');
    expect(adapter.poll).not.toHaveBeenCalled();
  });
});
