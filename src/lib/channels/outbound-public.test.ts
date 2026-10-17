import { describe, expect, it, vi } from 'vitest';

/**
 * Which public item a reply is posted under. The outbound worker asks the
 * database; here the database is a fake that answers the two questions it
 * asks (the message the agent chose, and the customer's recent messages).
 */

interface Row {
  metadata: Record<string, unknown> | null;
}
let chosen: Row | null = null;
let recent: Row[] = [];

vi.mock('@/lib/supabase/service', () => {
  const chain = (kind: 'one' | 'list') => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q;
    q.maybeSingle = async () => ({ data: chosen });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: kind === 'list' ? recent : null });
    return q;
  };
  return {
    serviceClient: () => ({
      from: () => ({
        select: () => {
          // A single-row lookup ends in maybeSingle(); the list ends in limit().
          const q = chain('list') as Record<string, (...a: unknown[]) => unknown>;
          return q;
        },
      }),
    }),
    hasServiceRole: () => true,
  };
});

import { resolvePublicTarget } from './outbound';

const item = (itemId: string) => ({ metadata: { channel_public: { kind: 'mention', itemId, rootId: itemId } } });

describe('resolvePublicTarget', () => {
  it('answers the message the agent chose, when it is a public item', async () => {
    chosen = item('chosen');
    recent = [item('newest')];
    expect(await resolvePublicTarget('conv', 'msg-1')).toMatchObject({ itemId: 'chosen' });
  });

  it('otherwise answers the newest public item from the customer', async () => {
    chosen = null;
    recent = [{ metadata: { channel_type: 'text' } }, item('newest'), item('older')];
    expect(await resolvePublicTarget('conv', null)).toMatchObject({ itemId: 'newest' });
  });

  it('falls back to the newest item when the chosen message is not public', async () => {
    chosen = { metadata: { channel_type: 'text' } };
    recent = [item('newest')];
    expect(await resolvePublicTarget('conv', 'msg-1')).toMatchObject({ itemId: 'newest' });
  });

  it('is null when the conversation holds nothing public to answer', async () => {
    chosen = null;
    recent = [{ metadata: null }, { metadata: { channel_type: 'text' } }];
    expect(await resolvePublicTarget('conv', null)).toBeNull();
    recent = [];
    expect(await resolvePublicTarget('conv', null)).toBeNull();
  });
});
