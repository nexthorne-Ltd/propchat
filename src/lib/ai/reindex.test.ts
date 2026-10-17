/**
 * The "Re-index knowledge" button re-embeds articles one at a time. It must
 * never trade working embeddings for keyword-only chunks when the embedding
 * service fails, and an article id from another workspace must change nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  articles: [] as Record<string, unknown>[],
  ops: [] as { op: 'delete' | 'insert'; filters?: Record<string, unknown>; rows?: Record<string, unknown>[] }[],
}));

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let mode: 'select' | 'delete' = 'select';
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        delete: () => {
          mode = 'delete';
          return builder;
        },
        insert: (rows: Record<string, unknown>[]) => {
          db.ops.push({ op: 'insert', rows });
          return Promise.resolve({ error: null });
        },
        maybeSingle: () => {
          const row = table === 'articles'
            ? db.articles.find((a) => a.id === filters.id && a.workspace_id === filters.workspace_id)
            : null;
          return Promise.resolve({ data: row ?? null, error: null });
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (mode === 'delete') db.ops.push({ op: 'delete', filters: { table, ...filters } });
          return resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => fakeSupabase() }));
vi.mock('@/lib/ai/platform-gateway', () => ({
  getPlatformAiConfigServerOnly: async () => ({
    isEnabled: true,
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    config: {
      provider: 'compatible',
      apiKey: 'test-key',
      baseUrl: 'https://api.deepinfra.com/v1/openai',
      model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    },
  }),
}));

import { reindexArticleStrict } from '@/lib/ai/semantic-retrieval';

const ARTICLE = {
  id: 'art-1',
  workspace_id: 'ws-a',
  status: 'published',
  title: 'Payout methods',
  slug: 'payout-methods',
  summary: null,
  category: 'Payouts',
  section: { name: 'Payouts' },
  content: 'We support cryptocurrency, bank transfer and RisePay for payouts, subject to availability.',
};

const fetchMock = vi.fn();

beforeEach(() => {
  db.articles = [ARTICLE];
  db.ops = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('reindexArticleStrict', () => {
  it('stores the embeddings from DeepInfra and replaces the old chunks', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: Array(768).fill(0.1) }] }), { status: 200 })
    );
    const r = await reindexArticleStrict('art-1', 'ws-a');

    expect(r).toMatchObject({ status: 'embedded', chunks: 1 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepinfra.com/v1/openai/embeddings');
    const insert = db.ops.find((o) => o.op === 'insert');
    expect(insert?.rows?.[0].embedding).toHaveLength(768);
  });

  it('reports a failed embedding call and leaves the existing chunks alone', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"bad key"}', { status: 401 }));
    const r = await reindexArticleStrict('art-1', 'ws-a');

    expect(r.status).toBe('failed');
    expect(r.error).toBeTruthy();
    expect(db.ops).toHaveLength(0);
  });

  it('only clears chunks inside the caller\'s workspace for an id it does not own', async () => {
    const r = await reindexArticleStrict('art-1', 'ws-b');

    expect(r.status).toBe('removed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.ops).toEqual([
      { op: 'delete', filters: { table: 'article_chunks', article_id: 'art-1', workspace_id: 'ws-b' } },
    ]);
  });
});
