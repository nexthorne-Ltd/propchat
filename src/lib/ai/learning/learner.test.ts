import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
  writes: [] as { table: string; op: string; values?: unknown }[],
}));

/** Just enough of the query builder for approveCandidate. */
function fakeSupabase() {
  return {
    from: (table: string) => {
      let op = 'select';
      let values: unknown;
      const builder: Record<string, unknown> = {};
      for (const m of ['eq', 'in', 'order', 'limit']) builder[m] = () => builder;
      builder.select = () => builder;
      builder.update = (v: unknown) => ((op = 'update'), (values = v), builder);
      builder.insert = (v: unknown) => ((op = 'insert'), (values = v), builder);
      const done = () => {
        if (op !== 'select') db.writes.push({ table, op, values });
        if (op === 'update' && table === 'bot_learning_candidates') return { data: [{ id: 'c1' }], error: null };
        if (op === 'insert' && table === 'bot_knowledge') return { data: { id: 'k1' }, error: null };
        return { data: table === 'bot_learning_candidates' ? db.candidate : null, error: null };
      };
      builder.maybeSingle = () => Promise.resolve(done());
      builder.single = () => Promise.resolve(done());
      builder.then = (resolve: (v: unknown) => unknown) => resolve(done());
      return builder;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => fakeSupabase(), hasServiceRole: () => true }));
vi.mock('@/lib/ai/bot-knowledge', () => ({ embedBotKnowledge: vi.fn(async () => ({ status: 'ready' })) }));
vi.mock('@/lib/ai/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/provider')>();
  return { ...actual, chat: vi.fn() };
});

import { approveCandidate } from './learner';

const base = {
  id: 'c1',
  question: 'How long do refunds take?',
  answer: 'Approved refunds arrive within 5 business days.',
  status: 'pending_review',
  grounding: 'grounded',
};

beforeEach(() => {
  db.candidate = { ...base };
  db.writes = [];
});

describe('approveCandidate', () => {
  it('creates a learned Bot knowledge entry and links it', async () => {
    const res = await approveCandidate('ws1', 'c1', { auto: true });
    expect(res).toEqual({ ok: true, knowledgeId: 'k1', embedded: true });
    const insert = db.writes.find((w) => w.table === 'bot_knowledge');
    expect(insert?.values).toMatchObject({ workspace_id: 'ws1', origin: 'learned', learning_candidate_id: 'c1' });
    expect(db.writes[0]).toMatchObject({ table: 'bot_learning_candidates', op: 'update', values: { status: 'auto_approved' } });
  });

  it('never approves a contradiction', async () => {
    db.candidate = { ...base, grounding: 'contradicts' };
    const res = await approveCandidate('ws1', 'c1', { reviewerId: 'u1' });
    expect(res.ok).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it('refuses an edit that adds personal data', async () => {
    const res = await approveCandidate('ws1', 'c1', { reviewerId: 'u1', answer: 'Email refunds@acme.com with your order #AB12345.' });
    expect(res.ok).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it('an automatic approval cannot change the checked text', async () => {
    const res = await approveCandidate('ws1', 'c1', { auto: true, answer: 'Refunds are instant.' });
    expect(res.ok).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it('a person may edit, and is recorded as the reviewer', async () => {
    const res = await approveCandidate('ws1', 'c1', { reviewerId: 'u1', answer: 'Approved refunds arrive within 5 to 7 business days.' });
    expect(res.ok).toBe(true);
    expect(db.writes[0].values).toMatchObject({ status: 'approved', reviewed_by: 'u1' });
  });
});
