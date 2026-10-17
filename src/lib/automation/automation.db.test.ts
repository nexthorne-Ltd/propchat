/**
 * Triggers, automations, macros and the loop guard, against a real Postgres.
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { addMember, createWorkspace, startChat, ticket, useTestDatabase, visitorSays, hasDatabase, type WorkspaceFixture } from '@/test/db';

describe.skipIf(!hasDatabase)('triggers, automations and macros (database)', () => {
  const { db } = useTestDatabase();

  type Cond = { field: string; op: string; value?: unknown };
  type Action = Record<string, unknown>;

  async function rule(
    ws: WorkspaceFixture,
    kind: 'trigger' | 'automation',
    name: string,
    conditions: Cond[],
    actions: Action[],
    opts: { match?: 'all' | 'any'; position?: number; active?: boolean } = {}
  ) {
    const [r] = await db().q<{ id: string }>(
      `INSERT INTO automation_rules (workspace_id, kind, name, match_mode, position, is_active, conditions, actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [ws.id, kind, name, opts.match ?? 'all', opts.position ?? 0, opts.active ?? true, JSON.stringify(conditions), JSON.stringify(actions)]
    );
    return r.id;
  }

  /** A workspace with the seeded defaults removed, so each test states its own rules. */
  async function bareWorkspace() {
    const ws = await createWorkspace(db());
    await db().q('DELETE FROM automation_rules WHERE workspace_id = $1', [ws.id]);
    await db().q('DELETE FROM macros WHERE workspace_id = $1', [ws.id]);
    return ws;
  }

  const runs = (ws: WorkspaceFixture) =>
    db().q<{ rule_name: string; outcome: string; event: string; error: string | null }>(
      'SELECT rule_name, outcome, event, error FROM automation_rule_runs WHERE workspace_id = $1 ORDER BY created_at, id',
      [ws.id]
    );

  describe('default rules', () => {
    it('a new workspace gets recommended rules and macros; emailing ones start off', async () => {
      const ws = await createWorkspace(db());
      const rules = await db().q<{ kind: string; is_active: boolean; actions: Action[] }>(
        'SELECT kind, is_active, actions FROM automation_rules WHERE workspace_id = $1',
        [ws.id]
      );
      expect(rules.length).toBeGreaterThanOrEqual(5);
      for (const r of rules) {
        const emails = r.actions.some((a) => String(a.type).startsWith('email') || a.type === 'webhook');
        if (emails) expect(r.is_active).toBe(false);
      }
      expect(await db().q('SELECT 1 FROM macros WHERE workspace_id = $1 AND owner_id IS NULL', [ws.id])).not.toHaveLength(0);
    });

    it('the urgent-wording default raises priority on a customer message', async () => {
      const ws = await createWorkspace(db());
      const { ticket: t } = await startChat(db(), ws, 'This is urgent, our checkout is down for everyone');
      const after = await ticket(db(), t.id);
      expect(after.priority).toBe('urgent');
      expect(after.tags).toContain('urgent');
    });
  });

  describe('triggers', () => {
    it('ALL needs every condition, ANY needs one', async () => {
      const ws = await bareWorkspace();
      await rule(ws, 'trigger', 'all', [{ field: 'changed', op: 'is', value: 'message' }, { field: 'message', op: 'contains', value: 'refund' }, { field: 'channel', op: 'is', value: 'email' }], [{ type: 'add_tags', value: ['all-hit'] }]);
      await rule(ws, 'trigger', 'any', [{ field: 'message', op: 'contains', value: 'refund' }, { field: 'channel', op: 'is', value: 'email' }], [{ type: 'add_tags', value: ['any-hit'] }], { match: 'any' });
      const { ticket: t } = await startChat(db(), ws, 'I want a refund');
      const after = await ticket(db(), t.id);
      expect(after.tags).toContain('any-hit');
      expect(after.tags).not.toContain('all-hit');
    });

    it('matches on subject, tags, priority and keywords case-insensitively', async () => {
      const ws = await bareWorkspace();
      await rule(
        ws, 'trigger', 'combo',
        [{ field: 'subject', op: 'contains', value: 'LOGIN' }, { field: 'tags', op: 'not_contains', value: ['done'] }, { field: 'priority', op: 'in', value: ['normal'] }],
        [{ type: 'set_priority', value: 'high' }, { type: 'set_status', value: 'open' }]
      );
      const { ticket: t } = await startChat(db(), ws, 'Cannot login to my account');
      const after = await ticket(db(), t.id);
      expect(after.priority).toBe('high');
      expect(after.status).toBe('open');
    });

    it('"what changed" conditions only fire on that change', async () => {
      const ws = await bareWorkspace();
      await rule(ws, 'trigger', 'on solve', [{ field: 'changed', op: 'is', value: 'status' }, { field: 'status', op: 'is', value: 'solved' }], [{ type: 'add_tags', value: ['was-solved'] }]);
      const { ticket: t } = await startChat(db(), ws, 'Hello');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET priority = 'high' WHERE id = $1`, [t.id]);
      expect((await ticket(db(), t.id)).tags).not.toContain('was-solved');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'solved' WHERE id = $1`, [t.id]);
      expect((await ticket(db(), t.id)).tags).toContain('was-solved');
    });

    it('assigns, and runs rules in position order', async () => {
      const ws = await bareWorkspace();
      await rule(ws, 'trigger', 'second', [{ field: 'tags', op: 'contains', value: ['first'] }], [{ type: 'set_priority', value: 'low' }], { position: 2 });
      await rule(ws, 'trigger', 'first', [{ field: 'changed', op: 'is', value: 'message' }], [{ type: 'add_tags', value: ['first'] }, { type: 'set_assignee', value: ws.agentId }], { position: 1 });
      const { ticket: t } = await startChat(db(), ws, 'Hi');
      const after = await ticket(db(), t.id);
      expect(after.assignee_id).toBe(ws.agentId);
      expect(after.priority).toBe('low');
    });

    it('skips disabled rules', async () => {
      const ws = await bareWorkspace();
      await rule(ws, 'trigger', 'off', [{ field: 'changed', op: 'is', value: 'message' }], [{ type: 'add_tags', value: ['nope'] }], { active: false });
      const { ticket: t } = await startChat(db(), ws, 'Hi');
      expect((await ticket(db(), t.id)).tags).toEqual([]);
    });

    it('rules never leak across workspaces', async () => {
      const a = await bareWorkspace();
      const b = await bareWorkspace();
      await rule(a, 'trigger', 'a only', [{ field: 'changed', op: 'is', value: 'message' }], [{ type: 'add_tags', value: ['from-a'] }]);
      const { ticket: t } = await startChat(db(), b, 'Hi');
      expect((await ticket(db(), t.id)).tags).toEqual([]);
    });

    it('queues emails with placeholders filled in, and a webhook', async () => {
      const ws = await bareWorkspace();
      await db().q(`UPDATE visitors SET name = 'Sam Rivera', email = 'sam@example.test' WHERE id = $1`, [ws.visitorId]);
      await rule(
        ws, 'trigger', 'notify', [{ field: 'changed', op: 'is', value: 'created' }],
        [
          { type: 'email_requester', subject: 'Re #{{ticket.id}}', body: 'Hi {{ ticket.requester.first_name }}, from {{workspace.name}}' },
          { type: 'webhook', url: 'https://hooks.example.test/in', secret: 's3cret' },
        ]
      );
      const { ticket: t } = await startChat(db(), ws, 'Hello');
      const rows = await db().q<{ kind: string; payload: Record<string, unknown> }>('SELECT kind, payload FROM automation_outbox WHERE ticket_id = $1 ORDER BY kind', [t.id]);
      expect(rows.map((r) => r.kind)).toEqual(['email_requester', 'webhook']);
      expect(rows[0].payload.to).toBe('sam@example.test');
      expect(rows[0].payload.subject).toBe(`Re #${t.number}`);
      expect(String(rows[0].payload.body)).toMatch(/^Hi Sam, from Workspace \d+$/);
      expect((rows[1].payload.ticket as { number: number }).number).toBe(t.number);
    });

    it('an email rule with no requester email sends nothing and logs nothing', async () => {
      const ws = await bareWorkspace();
      await db().q(`UPDATE visitors SET email = NULL WHERE id = $1`, [ws.visitorId]);
      await rule(ws, 'trigger', 'mail', [{ field: 'changed', op: 'is', value: 'created' }], [{ type: 'email_requester', subject: 's', body: 'b' }]);
      await startChat(db(), ws, 'Hello');
      expect(await db().q('SELECT 1 FROM automation_outbox WHERE workspace_id = $1', [ws.id])).toHaveLength(0);
      expect(await runs(ws)).toHaveLength(0);
    });

    it('logs which rule fired on which ticket, and visible to agents who can view tickets', async () => {
      const ws = await bareWorkspace();
      await rule(ws, 'trigger', 'tagger', [{ field: 'changed', op: 'is', value: 'message' }], [{ type: 'add_tags', value: ['x'] }]);
      await startChat(db(), ws, 'Hi');
      expect(await runs(ws)).toEqual([expect.objectContaining({ rule_name: 'tagger', outcome: 'fired', event: 'message' })]);
      expect(await db().as({ kind: 'user', id: ws.agentId }, 'SELECT 1 FROM automation_rule_runs')).toHaveLength(1);
      expect(await db().as({ kind: 'anon' }, 'SELECT 1 FROM automation_rule_runs')).toHaveLength(0);
    });

    it('a failing rule is logged and does not block the ticket write', async () => {
      const ws = await bareWorkspace();
      // Light agents cannot be assigned tickets, so the ticketing rules refuse this.
      const light = await addMember(db(), ws.id, 'light_agent');
      await rule(ws, 'trigger', 'bad', [{ field: 'changed', op: 'is', value: 'message' }], [{ type: 'add_tags', value: ['half-done'] }, { type: 'set_assignee', value: light }]);
      const { ticket: t } = await startChat(db(), ws, 'Hi');
      // The whole rule is undone together: no half-applied tag.
      expect(await ticket(db(), t.id)).toMatchObject({ assignee_id: null, tags: [] });
      expect((await runs(ws))[0]).toMatchObject({ outcome: 'failed' });
    });
  });

  describe('loop guard', () => {
    it('two rules that undo each other stop, and the stop is logged', async () => {
      const ws = await bareWorkspace();
      await rule(ws, 'trigger', 'low to high', [{ field: 'changed', op: 'is', value: 'priority' }, { field: 'priority', op: 'is', value: 'low' }], [{ type: 'set_priority', value: 'high' }], { position: 1 });
      await rule(ws, 'trigger', 'high to low', [{ field: 'changed', op: 'is', value: 'priority' }, { field: 'priority', op: 'is', value: 'high' }], [{ type: 'set_priority', value: 'low' }], { position: 2 });
      const { ticket: t } = await startChat(db(), ws, 'Hi');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET priority = 'low' WHERE id = $1`, [t.id]);
      expect(['low', 'high']).toContain((await ticket(db(), t.id)).priority);
      const log = await runs(ws);
      expect(log.some((r) => r.outcome === 'skipped_loop')).toBe(true);
      expect(log.length).toBeLessThan(20);
    });

    it('a rule that retriggers itself fires once per change', async () => {
      const ws = await bareWorkspace();
      // Adds a different tag each time it runs, so it would never settle on its own.
      await rule(ws, 'trigger', 'self', [{ field: 'changed', op: 'is', value: 'tags' }], [{ type: 'add_tags', value: ['a'] }, { type: 'set_priority', value: 'high' }]);
      const { ticket: t } = await startChat(db(), ws, 'Hi');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET tags = ARRAY['manual'] WHERE id = $1`, [t.id]);
      const fired = (await runs(ws)).filter((r) => r.outcome === 'fired');
      expect(fired).toHaveLength(1);
    });

    it('a rule is paused after 5 firings in 10 minutes on one ticket', async () => {
      const ws = await bareWorkspace();
      await rule(ws, 'trigger', 'every message', [{ field: 'changed', op: 'is', value: 'message' }], [{ type: 'add_tags', value: ['touched'] }, { type: 'set_priority', value: 'low' }]);
      const { conversationId, ticket: t } = await startChat(db(), ws, 'one');
      for (const n of ['two', 'three', 'four', 'five', 'six', 'seven']) {
        await db().q(`UPDATE tickets SET priority = 'normal' WHERE id = $1`, [t.id]);
        await visitorSays(db(), conversationId, n);
      }
      const log = await runs(ws);
      expect(log.filter((r) => r.outcome === 'fired')).toHaveLength(5);
      expect(log.filter((r) => r.outcome === 'skipped_loop')).toHaveLength(1);
    });
  });

  describe('automations', () => {
    async function backdate(ticketId: string, column: string, hours: number) {
      await db().q(`SELECT set_config('zentry.ticket_internal', 'on', true)`); // created_at is otherwise immutable
      await db().q(`UPDATE tickets SET ${column} = now() - ($2 || ' hours')::interval WHERE id = $1`, [ticketId, String(hours)]);
    }

    it('raises priority on an unassigned ticket after an hour, once', async () => {
      const ws = await bareWorkspace();
      await rule(
        ws, 'automation', 'unassigned 1h',
        [{ field: 'assignee_id', op: 'is_empty' }, { field: 'priority', op: 'in', value: ['low', 'normal'] }, { field: 'hours_since_created', op: 'gte', value: 1 }],
        [{ type: 'set_priority', value: 'high' }]
      );
      const { ticket: t } = await startChat(db(), ws, 'Hi');
      expect(await db().q('SELECT fn_run_automations($1) AS n', [ws.id])).toEqual([{ n: 0 }]);

      await backdate(t.id, 'created_at', 2);
      expect(await db().q('SELECT fn_run_automations($1) AS n', [ws.id])).toEqual([{ n: 1 }]);
      expect((await ticket(db(), t.id)).priority).toBe('high');
      expect(await db().q('SELECT fn_run_automations($1) AS n', [ws.id])).toEqual([{ n: 0 }]);
      expect((await runs(ws)).filter((r) => r.event === 'hourly')).toHaveLength(1);
    });

    it('a reminder for a ticket pending 3 days is sent once, even if nothing else changes', async () => {
      const ws = await bareWorkspace();
      await rule(
        ws, 'automation', 'remind',
        [{ field: 'status', op: 'is', value: 'pending' }, { field: 'hours_since_status_change', op: 'gte', value: 72 }],
        [{ type: 'email_requester', subject: 'Still there?', body: 'Hi {{ticket.requester.name}}' }]
      );
      const { ticket: t } = await startChat(db(), ws, 'Hi');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'pending' WHERE id = $1`, [t.id]);
      await backdate(t.id, 'status_changed_at', 80);
      await db().q('SELECT fn_run_automations($1)', [ws.id]);
      await db().q('SELECT fn_run_automations($1)', [ws.id]);
      expect(await db().q('SELECT 1 FROM automation_outbox WHERE ticket_id = $1', [t.id])).toHaveLength(1);

      // The customer answers, the ticket changes, and stays quiet again: it may fire again.
      await backdate(t.id, 'status_changed_at', 80);
      // (Inside one test transaction now() never advances, so age the log entry instead.)
      await db().q(`UPDATE automation_rule_runs SET ticket_version = ticket_version - interval '1 hour' WHERE ticket_id = $1`, [t.id]);
      await db().q('SELECT fn_run_automations($1)', [ws.id]);
      expect(await db().q('SELECT 1 FROM automation_outbox WHERE ticket_id = $1', [t.id])).toHaveLength(2);
    });

    it('closes solved tickets after 4 days and leaves closed ones alone', async () => {
      const ws = await bareWorkspace();
      await rule(ws, 'automation', 'close', [{ field: 'status', op: 'is', value: 'solved' }, { field: 'hours_since_solved', op: 'gte', value: 96 }], [{ type: 'set_status', value: 'closed' }]);
      const { ticket: t } = await startChat(db(), ws, 'Hi');
      await db().as({ kind: 'user', id: ws.agentId }, `UPDATE tickets SET status = 'solved' WHERE id = $1`, [t.id]);
      await db().q('SELECT fn_run_automations($1)', [ws.id]);
      expect((await ticket(db(), t.id)).status).toBe('solved');
      await backdate(t.id, 'solved_at', 100);
      await db().q('SELECT fn_run_automations($1)', [ws.id]);
      expect((await ticket(db(), t.id)).status).toBe('closed');
    });

    it('cannot be run by a signed-in user', async () => {
      const ws = await bareWorkspace();
      expect(await db().rejects({ kind: 'user', id: ws.adminId }, 'SELECT fn_run_automations($1)', [ws.id])).toMatch(/permission denied/);
    });
  });

  describe('rule validation and access', () => {
    it('refuses malformed rules with a readable message', async () => {
      const ws = await bareWorkspace();
      const admin = { kind: 'user' as const, id: ws.adminId };
      const insert = (conditions: unknown, actions: unknown, kind = 'trigger') =>
        db().rejects(admin, `INSERT INTO automation_rules (workspace_id, kind, name, conditions, actions) VALUES ($1, $2, 'x', $3, $4)`, [ws.id, kind, JSON.stringify(conditions), JSON.stringify(actions)]);

      expect(await insert([], [{ type: 'add_tags', value: ['a'] }])).toMatch(/between 1 and 15 conditions/);
      expect(await insert([{ field: 'status', op: 'is', value: 'open' }], [])).toMatch(/at least one action/);
      expect(await insert([{ field: 'status', op: 'contains', value: 'open' }], [{ type: 'add_tags', value: ['a'] }])).toMatch(/accepts is/);
      expect(await insert([{ field: 'hours_since_created', op: 'gte', value: 1 }], [{ type: 'add_tags', value: ['a'] }])).toMatch(/only for automations/);
      expect(await insert([{ field: 'changed', op: 'is', value: 'status' }], [{ type: 'add_tags', value: ['a'] }], 'automation')).toMatch(/only for triggers/);
      expect(await insert([{ field: 'status', op: 'is', value: 'open' }], [{ type: 'webhook', url: 'http://insecure.test' }])).toMatch(/https/);
      expect(await insert([{ field: 'status', op: 'is', value: 'open' }], [{ type: 'set_assignee', value: 'me' }])).toMatch(/only makes sense in a macro/);
      expect(await insert([{ field: 'status', op: 'is', value: 'open' }], [{ type: 'delete_ticket' }])).toMatch(/Unknown or not allowed action/);
    });

    it('only owners and admins can read or change rules', async () => {
      const ws = await bareWorkspace();
      await rule(ws, 'trigger', 'r', [{ field: 'status', op: 'is', value: 'open' }], [{ type: 'add_tags', value: ['a'] }]);
      expect(await db().as({ kind: 'user', id: ws.adminId }, 'SELECT 1 FROM automation_rules')).toHaveLength(1);
      expect(await db().as({ kind: 'user', id: ws.agentId }, 'SELECT 1 FROM automation_rules')).toHaveLength(0);
      expect(
        await db().rejects({ kind: 'user', id: ws.agentId }, `INSERT INTO automation_rules (workspace_id, kind, name, conditions, actions) VALUES ($1, 'trigger', 'x', '[{"field":"status","op":"is","value":"open"}]', '[{"type":"add_tags","value":["a"]}]')`, [ws.id])
      ).toMatch(/row-level security/);
    });

    it('the outbox is closed to every signed-in role', async () => {
      const ws = await bareWorkspace();
      const { ticket: t } = await startChat(db(), ws, 'Hi');
      await db().q(`INSERT INTO automation_outbox (workspace_id, ticket_id, kind) VALUES ($1, $2, 'webhook')`, [ws.id, t.id]);
      // No policy exists, so RLS shows signed-in users nothing (the test database also grants every table to every role).
      for (const id of [ws.ownerId, ws.adminId, ws.agentId]) {
        expect(await db().as({ kind: 'user', id }, 'SELECT 1 FROM automation_outbox')).toHaveLength(0);
      }
      expect(await db().rejects({ kind: 'user', id: ws.ownerId }, `INSERT INTO automation_outbox (workspace_id, ticket_id, kind) VALUES ($1, $2, 'webhook')`, [ws.id, t.id])).toMatch(/row-level security/);
    });

    it('testing a rule reports each condition and previews emails, without changing the ticket', async () => {
      const ws = await bareWorkspace();
      const { ticket: t } = await startChat(db(), ws, 'My invoice is wrong');
      const [{ result }] = await db().as<{ result: { matches: boolean; conditions: { holds: boolean }[]; email_previews: { subject: string }[] } }>(
        { kind: 'user', id: ws.adminId },
        `SELECT fn_test_rule($1, 'trigger', 'all', $2::jsonb, $3::jsonb, $4) AS result`,
        [
          ws.id,
          JSON.stringify([{ field: 'message', op: 'contains', value: 'invoice' }, { field: 'priority', op: 'is', value: 'urgent' }]),
          JSON.stringify([{ type: 'email_requester', subject: 'About #{{ticket.id}}', body: 'x' }, { type: 'set_priority', value: 'low' }]),
          t.number,
        ]
      );
      expect(result.matches).toBe(false);
      expect(result.conditions.map((c) => c.holds)).toEqual([true, false]);
      expect(result.email_previews[0].subject).toBe(`About #${t.number}`);
      expect((await ticket(db(), t.id)).priority).toBe('normal');
      expect(await db().rejects({ kind: 'user', id: ws.agentId }, `SELECT fn_test_rule($1, 'trigger', 'all', '[{"field":"status","op":"is","value":"open"}]', '[{"type":"add_tags","value":["a"]}]', $2)`, [ws.id, t.number])).toMatch(/Only owners and admins/);
    });

    it('reorders rules in one call', async () => {
      const ws = await bareWorkspace();
      const cond = [{ field: 'status', op: 'is', value: 'open' }];
      const act = [{ type: 'add_tags', value: ['a'] }];
      const a = await rule(ws, 'trigger', 'A', cond, act, { position: 1 });
      const b = await rule(ws, 'trigger', 'B', cond, act, { position: 2 });
      await db().as({ kind: 'user', id: ws.adminId }, 'SELECT fn_reorder_rules($1, $2, $3::uuid[])', [ws.id, 'trigger', [b, a]]);
      const rows = await db().q<{ name: string }>('SELECT name FROM automation_rules WHERE workspace_id = $1 ORDER BY position', [ws.id]);
      expect(rows.map((r) => r.name)).toEqual(['B', 'A']);
    });
  });

  describe('macros', () => {
    async function macro(ws: WorkspaceFixture, owner: string | null, title: string, content: string, actions: Action[] = []) {
      const [m] = await db().q<{ id: string }>(
        `INSERT INTO macros (workspace_id, owner_id, title, content, actions) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [ws.id, owner, title, content, JSON.stringify(actions)]
      );
      return m.id;
    }

    it('renders placeholders with the ticket, requester and the agent using it', async () => {
      const ws = await bareWorkspace();
      await db().q(`UPDATE visitors SET name = 'Ada Lovelace' WHERE id = $1`, [ws.visitorId]);
      const { ticket: t } = await startChat(db(), ws, 'Help');
      const m = await macro(ws, null, 'Hello', 'Hi {{ticket.requester.name}}, ticket #{{ticket.id}} — {{agent.name}}');
      const [{ text }] = await db().as<{ text: string }>({ kind: 'user', id: ws.agentId }, 'SELECT fn_render_macro($1, $2) AS text', [m, t.id]);
      expect(text).toBe(`Hi Ada Lovelace, ticket #${t.number} — agent of ${(await db().one<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [ws.id])).name}`);
    });

    it('applies status, priority, tags and assignee as the agent, and the audit log names them', async () => {
      const ws = await bareWorkspace();
      const { ticket: t } = await startChat(db(), ws, 'Help');
      const m = await macro(ws, null, 'Escalate', 'Passing this on', [
        { type: 'set_status', value: 'pending' },
        { type: 'set_priority', value: 'high' },
        { type: 'add_tags', value: ['Escalated'] },
        { type: 'set_assignee', value: 'me' },
      ]);
      await db().as({ kind: 'user', id: ws.agentId }, 'SELECT fn_apply_macro($1, $2)', [m, t.id]);
      const after = await ticket(db(), t.id);
      expect(after).toMatchObject({ status: 'pending', priority: 'high', assignee_id: ws.agentId, tags: ['escalated'] });
      const ev = await db().q<{ actor_type: string; actor_id: string }>(`SELECT actor_type, actor_id FROM ticket_events WHERE ticket_id = $1 AND field = 'priority'`, [t.id]);
      expect(ev[0]).toMatchObject({ actor_type: 'agent', actor_id: ws.agentId });
    });

    it('personal macros are private; shared macros are visible to everyone in the workspace', async () => {
      const ws = await bareWorkspace();
      await macro(ws, ws.agentId, 'Mine', 'x');
      await macro(ws, null, 'Shared', 'y');
      const titles = async (id: string) => (await db().as<{ title: string }>({ kind: 'user', id }, 'SELECT title FROM macros ORDER BY title')).map((r) => r.title);
      expect(await titles(ws.agentId)).toEqual(['Mine', 'Shared']);
      expect(await titles(ws.adminId)).toEqual(['Shared']);
    });

    it('agents manage only their own macros; shared ones need an admin; light agents cannot use them', async () => {
      const ws = await bareWorkspace();
      const agent = { kind: 'user' as const, id: ws.agentId };
      const ins = (owner: string | null) => db().rejects(agent, `INSERT INTO macros (workspace_id, owner_id, title, content) VALUES ($1, $2, 't', 'c')`, [ws.id, owner]);
      expect(await ins(null)).toMatch(/row-level security/);
      expect(await ins(ws.adminId)).toMatch(/row-level security/);
      await db().as(agent, `INSERT INTO macros (workspace_id, owner_id, title, content) VALUES ($1, $2, 'ok', 'c')`, [ws.id, ws.agentId]);
      await db().as({ kind: 'user', id: ws.adminId }, `INSERT INTO macros (workspace_id, owner_id, title, content) VALUES ($1, NULL, 'team', 'c')`, [ws.id]);

      const light = await addMember(db(), ws.id, 'light_agent');
      const { ticket: t } = await startChat(db(), ws, 'Help');
      const m = await macro(ws, null, 'S', 'c', [{ type: 'set_status', value: 'solved' }]);
      expect(await db().rejects({ kind: 'user', id: light }, 'SELECT fn_apply_macro($1, $2)', [m, t.id])).toMatch(/cannot change/);
    });

    it('cannot apply another workspace\'s macro or reach another workspace\'s ticket', async () => {
      const a = await bareWorkspace();
      const b = await bareWorkspace();
      const { ticket: t } = await startChat(db(), a, 'Help');
      const foreign = await macro(b, null, 'B macro', 'c', [{ type: 'set_status', value: 'solved' }]);
      expect(await db().rejects({ kind: 'user', id: a.agentId }, 'SELECT fn_apply_macro($1, $2)', [foreign, t.id])).toMatch(/Macro not found/);
      expect(await db().rejects({ kind: 'user', id: b.agentId }, 'SELECT fn_render_macro($1, $2)', [foreign, t.id])).toMatch(/Ticket not found/);
    });

    it('a macro must do something', async () => {
      const ws = await bareWorkspace();
      expect(await db().rejects({ kind: 'user', id: ws.adminId }, `INSERT INTO macros (workspace_id, title, content, actions) VALUES ($1, 't', '', '[]')`, [ws.id])).toMatch(/macros_content_or_actions/);
    });
  });
});
