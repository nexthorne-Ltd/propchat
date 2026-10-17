import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Op = [string, ...unknown[]];
interface Query {
  table: string;
  ops: Op[];
}

const fake = vi.hoisted(() => ({
  queries: [] as Query[],
  respond: (() => ({ data: null, error: null })) as (q: Query) => {
    data: unknown;
    error: unknown;
  },
  accessAllowed: true,
}));

function builder(table: string) {
  const q: Query = { table, ops: [] };
  fake.queries.push(q);
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => resolve(fake.respond(q));
        }
        return (...args: unknown[]) => {
          q.ops.push([prop, ...args]);
          return proxy;
        };
      },
    }
  );
  return proxy;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => builder(table),
  }),
}));

vi.mock('@/lib/team/access', () => ({
  getWorkspaceAccess: async (wsId: string, cap: string) => {
    if (!fake.accessAllowed) {
      throw new Error('Access denied');
    }
    return {
      user: { id: 'user-1' },
      agent: { id: 'agent-1', workspace_id: wsId, role: 'admin' },
      workspace: { id: wsId },
    };
  },
  AccessError: class AccessError extends Error {},
}));

import { updateCannedResponseAction, deleteCannedResponseAction } from './admin';

describe('M-5 canned response tenant isolation and not-found checks', () => {
  beforeEach(() => {
    fake.queries = [];
    fake.accessAllowed = true;
  });

  const hasOp = (q: Query, ...op: unknown[]) =>
    q.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));

  describe('updateCannedResponseAction', () => {
    it('filters by id and workspace_id on update and returns updated item', async () => {
      fake.respond = (q) => {
        if (
          q.table === 'canned_responses' &&
          hasOp(q, 'eq', 'id', CR_ID) &&
          hasOp(q, 'eq', 'workspace_id', WS)
        ) {
          return {
            data: { id: CR_ID, workspace_id: WS, shortcut: '/hello', title: 'Hello', content: 'Hi there' },
            error: null,
          };
        }
        return { data: null, error: null };
      };

      const result = await updateCannedResponseAction(WS, CR_ID, {
        title: 'Hello',
        content: 'Hi there',
      });

      expect(result.success).toBe(true);
      expect(result.cannedResponse.id).toBe(CR_ID);

      const updateQuery = fake.queries.find((q) => q.table === 'canned_responses');
      expect(updateQuery).toBeDefined();
      expect(hasOp(updateQuery!, 'eq', 'id', CR_ID)).toBe(true);
      expect(hasOp(updateQuery!, 'eq', 'workspace_id', WS)).toBe(true);
      expect(hasOp(updateQuery!, 'maybeSingle')).toBe(true);
    });

    it('throws "That saved reply was not found." when no row matches', async () => {
      fake.respond = (_q) => ({ data: null, error: null });

      await expect(
        updateCannedResponseAction(WS, 'non-existent-id', {
          title: 'Hello',
        })
      ).rejects.toThrow('That saved reply was not found.');
    });

    it('throws "That saved reply was not found." when workspace_id does not match', async () => {
      fake.respond = (q) => {
        // Only return if it matches OTHER_WS
        if (hasOp(q, 'eq', 'workspace_id', OTHER_WS)) {
          return { data: { id: CR_ID }, error: null };
        }
        return { data: null, error: null };
      };

      // Calling with WS won't match
      await expect(
        updateCannedResponseAction(WS, CR_ID, {
          title: 'Hello',
        })
      ).rejects.toThrow('That saved reply was not found.');
    });
  });

  describe('deleteCannedResponseAction', () => {
    it('filters by id and workspace_id on delete and returns success', async () => {
      fake.respond = (q) => {
        if (
          q.table === 'canned_responses' &&
          hasOp(q, 'eq', 'id', CR_ID) &&
          hasOp(q, 'eq', 'workspace_id', WS)
        ) {
          return { data: [{ id: CR_ID }], error: null };
        }
        return { data: [], error: null };
      };

      const result = await deleteCannedResponseAction(WS, CR_ID);
      expect(result.success).toBe(true);

      const delQuery = fake.queries.find((q) => q.table === 'canned_responses');
      expect(delQuery).toBeDefined();
      expect(hasOp(delQuery!, 'eq', 'id', CR_ID)).toBe(true);
      expect(hasOp(delQuery!, 'eq', 'workspace_id', WS)).toBe(true);
      expect(hasOp(delQuery!, 'select', 'id')).toBe(true);
    });

    it('throws "That saved reply was not found." when no row matches', async () => {
      fake.respond = (_q) => ({ data: [], error: null });

      await expect(deleteCannedResponseAction(WS, 'non-existent-id')).rejects.toThrow(
        'That saved reply was not found.'
      );
    });

    it('throws "That saved reply was not found." when workspace_id does not match', async () => {
      fake.respond = (q) => {
        if (hasOp(q, 'eq', 'workspace_id', OTHER_WS)) {
          return { data: [{ id: CR_ID }], error: null };
        }
        return { data: [], error: null };
      };

      await expect(deleteCannedResponseAction(WS, CR_ID)).rejects.toThrow(
        'That saved reply was not found.'
      );
    });
  });
});
