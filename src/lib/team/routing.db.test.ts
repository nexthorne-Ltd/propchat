/**
 * Groups, assignment and round-robin, and what deactivation does to an
 * agent's open tickets. Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { addMember, createWorkspace, hasDatabase, startChat, ticket, useTestDatabase, type WorkspaceFixture } from '@/test/db';

describe.skipIf(!hasDatabase)('groups and assignment (database)', () => {
  const { db } = useTestDatabase();

  async function group(ws: WorkspaceFixture, name: string, members: string[], roundRobin = false) {
    const [g] = await db().q<{ id: string }>(
      `INSERT INTO ticket_groups (workspace_id, name, round_robin) VALUES ($1, $2, $3) RETURNING id`,
      [ws.id, name, roundRobin]
    );
    for (const m of members) {
      await db().q('INSERT INTO ticket_group_members (group_id, agent_id) VALUES ($1, $2)', [g.id, m]);
    }
    return g.id;
  }

  const admin = (ws: WorkspaceFixture) => ({ kind: 'user' as const, id: ws.adminId });

  /** A new ticket routed into `groupId` by an admin; returns who got it. */
  async function routeNew(ws: WorkspaceFixture, groupId: string, text = 'Help please') {
    const { ticket: t } = await startChat(db(), ws, text);
    await db().as(admin(ws), 'UPDATE tickets SET group_id = $1 WHERE id = $2', [groupId, t.id]);
    return (await ticket(db(), t.id)).assignee_id;
  }

  describe('group membership', () => {
    it('a ticket in a group can only be assigned to a member of that group', async () => {
      const ws = await createWorkspace(db());
      const billing = await group(ws, 'Billing', [ws.agentId]);
      const { ticket: t } = await startChat(db(), ws, 'Refund?');
      await db().as(admin(ws), 'UPDATE tickets SET group_id = $1 WHERE id = $2', [billing, t.id]);
      expect(
        await db().rejects(admin(ws), 'UPDATE tickets SET assignee_id = $1 WHERE id = $2', [ws.ownerId, t.id])
      ).toMatch(/not in the ticket's group/);
      await db().as(admin(ws), 'UPDATE tickets SET assignee_id = $1 WHERE id = $2', [ws.agentId, t.id]);
      const after = await ticket(db(), t.id);
      expect(after.assignee_id).toBe(ws.agentId);
      expect(after.status).toBe('open');
    });

    it('moving a ticket to a group its assignee is not in sends it back to the group’s queue', async () => {
      const ws = await createWorkspace(db());
      const technical = await group(ws, 'Technical', [ws.ownerId]);
      const { ticket: t } = await startChat(db(), ws, 'Bug report');
      await db().as(admin(ws), 'UPDATE tickets SET assignee_id = $1 WHERE id = $2', [ws.agentId, t.id]);
      await db().as(admin(ws), 'UPDATE tickets SET group_id = $1 WHERE id = $2', [technical, t.id]);
      expect((await ticket(db(), t.id)).assignee_id).toBeNull();
    });

    it('group and assignee set together are checked together', async () => {
      const ws = await createWorkspace(db());
      const billing = await group(ws, 'Billing', [ws.agentId]);
      const { ticket: t } = await startChat(db(), ws, 'Invoice');
      await db().as(admin(ws), 'UPDATE tickets SET group_id = $1, assignee_id = $2 WHERE id = $3', [billing, ws.agentId, t.id]);
      expect((await ticket(db(), t.id)).assignee_id).toBe(ws.agentId);
      const { ticket: t2 } = await startChat(db(), ws, 'Invoice 2');
      expect(
        await db().rejects(admin(ws), 'UPDATE tickets SET group_id = $1, assignee_id = $2 WHERE id = $3', [billing, ws.ownerId, t2.id])
      ).toMatch(/not in the ticket's group/);
    });

    it('light agents and deactivated agents cannot be assigned tickets', async () => {
      const ws = await createWorkspace(db());
      const light = await addMember(db(), ws.id, 'light_agent');
      const gone = await addMember(db(), ws.id, 'agent', { active: false });
      const { ticket: t } = await startChat(db(), ws, 'Hello');
      for (const who of [light, gone]) {
        expect(await db().rejects(admin(ws), 'UPDATE tickets SET assignee_id = $1 WHERE id = $2', [who, t.id])).toMatch(
          /cannot be assigned/
        );
      }
    });

    it('making someone a light agent hands their open tickets back', async () => {
      const ws = await createWorkspace(db());
      const { ticket: t } = await startChat(db(), ws, 'Hello');
      await db().as(admin(ws), 'UPDATE tickets SET assignee_id = $1 WHERE id = $2', [ws.agentId, t.id]);
      await db().as(admin(ws), `SELECT public.fn_set_member_role($1, $2, 'light_agent')`, [ws.id, ws.agentId]);
      expect((await ticket(db(), t.id)).assignee_id).toBeNull();
    });
  });

  describe('round-robin', () => {
    it('rotates through the group’s online members in turn', async () => {
      const ws = await createWorkspace(db());
      const a = await addMember(db(), ws.id, 'agent', { status: 'online' });
      const b = await addMember(db(), ws.id, 'agent', { status: 'online' });
      const c = await addMember(db(), ws.id, 'agent', { status: 'online' });
      const g = await group(ws, 'Support', [a, b, c], true);
      const got = [];
      for (let i = 0; i < 6; i++) got.push(await routeNew(ws, g, `Q${i}`));
      const order = [a, b, c].sort();
      expect(got).toEqual([...order, ...order]);
    });

    it('skips members who are offline, away, at capacity, light agents or deactivated', async () => {
      const ws = await createWorkspace(db());
      const ready = await addMember(db(), ws.id, 'agent', { status: 'online', name: 'Ready' });
      const offline = await addMember(db(), ws.id, 'agent', { status: 'offline' });
      const away = await addMember(db(), ws.id, 'agent', { status: 'away' });
      const full = await addMember(db(), ws.id, 'agent', { status: 'online', maxOpen: 1 });
      const light = await addMember(db(), ws.id, 'light_agent', { status: 'online' });
      const gone = await addMember(db(), ws.id, 'agent', { status: 'online', active: false });
      // `full` already has one open ticket.
      const { ticket: busy } = await startChat(db(), ws, 'Earlier');
      await db().q('UPDATE tickets SET assignee_id = $1 WHERE id = $2', [full, busy.id]);
      const g = await group(ws, 'Support', [ready, offline, away, full, light, gone], true);

      for (let i = 0; i < 4; i++) expect(await routeNew(ws, g, `Q${i}`)).toBe(ready);
    });

    it('capacity counts new and open tickets, not pending or solved ones', async () => {
      const ws = await createWorkspace(db());
      const agent = await addMember(db(), ws.id, 'agent', { status: 'online', maxOpen: 1 });
      const g = await group(ws, 'Support', [agent], true);
      const first = await routeNew(ws, g, 'One');
      expect(first).toBe(agent);
      expect(await routeNew(ws, g, 'Two')).toBeNull(); // at capacity: waits in the group
      await db().q(`UPDATE tickets SET status = 'pending' WHERE assignee_id = $1`, [agent]);
      expect(await routeNew(ws, g, 'Three')).toBe(agent);
    });

    it('leaves the ticket unassigned in the group when nobody is available', async () => {
      const ws = await createWorkspace(db());
      const g = await group(ws, 'Night shift', [ws.agentId], true); // offline
      const { ticket: t } = await startChat(db(), ws, 'Anyone?');
      await db().as(admin(ws), 'UPDATE tickets SET group_id = $1 WHERE id = $2', [g, t.id]);
      const after = await ticket(db(), t.id);
      expect(after.assignee_id).toBeNull();
      expect(after.status).toBe('new');
    });

    it('does nothing for groups without round-robin', async () => {
      const ws = await createWorkspace(db());
      const a = await addMember(db(), ws.id, 'agent', { status: 'online' });
      const g = await group(ws, 'Manual', [a], false);
      expect(await routeNew(ws, g)).toBeNull();
    });

    it('the round-robin pick also assigns the chat', async () => {
      const ws = await createWorkspace(db());
      const a = await addMember(db(), ws.id, 'agent', { status: 'online' });
      const g = await group(ws, 'Support', [a], true);
      const { conversationId, ticket: t } = await startChat(db(), ws, 'Sync me');
      await db().as(admin(ws), 'UPDATE tickets SET group_id = $1 WHERE id = $2', [g, t.id]);
      const conv = await db().one<{ assigned_agent_id: string }>('SELECT assigned_agent_id FROM conversations WHERE id = $1', [
        conversationId,
      ]);
      expect(conv.assigned_agent_id).toBe(a);
    });
  });

  describe('chat auto-assignment', () => {
    it('skips light agents, deactivated agents and agents at capacity', async () => {
      const ws = await createWorkspace(db());
      await db().q(`UPDATE workspaces SET auto_assignment = '{"enabled": true}' WHERE id = $1`, [ws.id]);
      await addMember(db(), ws.id, 'light_agent', { status: 'online' });
      await addMember(db(), ws.id, 'agent', { status: 'online', active: false });
      const full = await addMember(db(), ws.id, 'agent', { status: 'online', maxOpen: 1 });
      const { ticket: earlier } = await startChat(db(), ws, 'first');
      expect(earlier.assignee_id).toBe(full);
      const { conversationId } = await startChat(db(), ws, 'second');
      const conv = await db().one<{ assigned_agent_id: string | null }>(
        'SELECT assigned_agent_id FROM conversations WHERE id = $1',
        [conversationId]
      );
      expect(conv.assigned_agent_id).toBeNull();
    });
  });

  describe('deactivating an agent with open tickets', () => {
    async function setup() {
      const ws = await createWorkspace(db());
      const leaving = await addMember(db(), ws.id, 'agent', { name: 'Leaving' });
      const taker = await addMember(db(), ws.id, 'agent', { name: 'Taker', status: 'online' });
      const billing = await group(ws, 'Billing', [leaving, taker], true);
      const tickets: string[] = [];
      for (const text of ['one', 'two', 'three']) {
        const { ticket: t } = await startChat(db(), ws, text);
        await db().q('UPDATE tickets SET assignee_id = $1 WHERE id = $2', [leaving, t.id]);
        tickets.push(t.id);
      }
      await db().q('UPDATE tickets SET group_id = $1 WHERE id = $2', [billing, tickets[0]]);
      // A solved ticket stays with them as history.
      const { ticket: done } = await startChat(db(), ws, 'done');
      await db().q(`UPDATE tickets SET assignee_id = $1, status = 'solved' WHERE id = $2`, [leaving, done.id]);
      return { ws, leaving, taker, billing, tickets, done: done.id };
    }

    it('hands every open ticket to the chosen agent, leaving solved ones alone', async () => {
      const { ws, leaving, taker, tickets, done } = await setup();
      const [{ moved }] = await db().as<{ moved: number }>(admin(ws), `SELECT public.fn_deactivate_member($1, $2, 'agent', $3) AS moved`, [
        ws.id,
        leaving,
        taker,
      ]);
      expect(moved).toBe(3);
      for (const id of tickets) expect((await ticket(db(), id)).assignee_id).toBe(taker);
      expect((await ticket(db(), done)).assignee_id).toBe(leaving);
    });

    it('sends them back to their groups’ round-robin, or unassigns ungrouped ones', async () => {
      const { ws, leaving, taker, billing, tickets } = await setup();
      await db().as(admin(ws), `SELECT public.fn_deactivate_member($1, $2, 'round_robin')`, [ws.id, leaving]);
      const first = await ticket(db(), tickets[0]);
      expect(first.assignee_id).toBe(taker);
      expect((first as Record<string, unknown>).group_id).toBe(billing);
      expect((await ticket(db(), tickets[1])).assignee_id).toBeNull();
    });

    it('can just unassign them', async () => {
      const { ws, leaving, tickets } = await setup();
      await db().as(admin(ws), `SELECT public.fn_deactivate_member($1, $2, 'unassign')`, [ws.id, leaving]);
      for (const id of tickets) expect((await ticket(db(), id)).assignee_id).toBeNull();
    });

    it('records the admin, not the system, as who moved them', async () => {
      const { ws, leaving, taker, tickets } = await setup();
      await db().as(admin(ws), `SELECT public.fn_deactivate_member($1, $2, 'agent', $3)`, [ws.id, leaving, taker]);
      const events = await db().q<{ actor_type: string; actor_id: string }>(
        `SELECT actor_type, actor_id FROM ticket_events WHERE ticket_id = $1 AND field = 'assignee_id' ORDER BY created_at DESC LIMIT 1`,
        [tickets[1]]
      );
      expect(events[0]).toEqual({ actor_type: 'agent', actor_id: ws.adminId });
    });

    it('refuses a light agent or the leaving agent as the new owner of the tickets', async () => {
      const { ws, leaving } = await setup();
      const light = await addMember(db(), ws.id, 'light_agent');
      for (const to of [light, leaving]) {
        expect(
          await db().rejects(admin(ws), `SELECT public.fn_deactivate_member($1, $2, 'agent', $3)`, [ws.id, leaving, to])
        ).toMatch(/Pick an active agent/);
      }
    });
  });
});
