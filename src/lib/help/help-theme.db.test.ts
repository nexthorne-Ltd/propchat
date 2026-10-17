/**
 * The help center design (20261116090000_help_center_theme.sql): anyone can
 * read a workspace's design through fn_help_center_theme, and only that.
 *
 * Run with `npm run test:db`.
 */
import { describe, expect, it } from 'vitest';
import { createWorkspace, hasDatabase, useTestDatabase } from '@/test/db';

const anon = { kind: 'anon' } as const;

describe.skipIf(!hasDatabase)('help center design (database)', () => {
  const { db } = useTestDatabase();

  it('the public page reads the saved design', async () => {
    const ws = await createWorkspace(db());
    await db().q(`UPDATE workspaces SET help_center_theme = '{"preset":"ocean","accent":"#ff0000"}' WHERE id = $1`, [ws.id]);
    const [{ t }] = await db().as<{ t: Record<string, string> }>(anon, 'SELECT fn_help_center_theme($1) AS t', [ws.id]);
    expect(t).toEqual({ preset: 'ocean', accent: '#ff0000' });
  });

  it('a workspace that never designed one reads as empty', async () => {
    const ws = await createWorkspace(db());
    const [{ t }] = await db().as<{ t: unknown }>(anon, 'SELECT fn_help_center_theme($1) AS t', [ws.id]);
    expect(t).toEqual({});
  });

  it('a deleted workspace has no design', async () => {
    const ws = await createWorkspace(db());
    await db().q('UPDATE workspaces SET deleted_at = now() WHERE id = $1', [ws.id]);
    const [{ t }] = await db().as<{ t: unknown }>(anon, 'SELECT fn_help_center_theme($1) AS t', [ws.id]);
    expect(t).toBeNull();
  });

  it('an article page gets its author name and avatar, and nothing for drafts or outsiders', async () => {
    // articles predates the repo's migrations; build what the function reads.
    await db().q(`CREATE TABLE IF NOT EXISTS public.articles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID, author_id UUID, status TEXT, title TEXT)`);
    const ws = await createWorkspace(db());
    const other = await createWorkspace(db());
    const add = async (status: string, author: string) =>
      (
        await db().one<{ id: string }>(
          `INSERT INTO articles (workspace_id, author_id, status, title) VALUES ($1, $2, $3, 'A') RETURNING id`,
          [ws.id, author, status]
        )
      ).id;
    const author = (id: string) =>
      db().as<{ a: Record<string, unknown> | null }>(anon, 'SELECT fn_help_article_author($1) AS a', [id]).then((r) => r[0].a);

    const published = await author(await add('published', ws.agentId));
    expect(Object.keys(published ?? {}).sort()).toEqual(['avatar_url', 'id', 'name']);
    expect(published?.id).toBe(ws.agentId);
    expect(await author(await add('draft', ws.agentId))).toBeNull();
    expect(await author(await add('published', other.agentId))).toBeNull();
  });

  it('only an object of reasonable size can be stored', async () => {
    const ws = await createWorkspace(db());
    expect(await db().rejects({ kind: 'superuser' }, `UPDATE workspaces SET help_center_theme = '[]' WHERE id = $1`, [ws.id])).toMatch(
      /help_center_theme_size/
    );
    expect(
      await db().rejects({ kind: 'superuser' }, `UPDATE workspaces SET help_center_theme = jsonb_build_object('custom_css', repeat(md5(random()::text), 2000)) WHERE id = $1`, [ws.id])
    ).toMatch(/help_center_theme_size/);
  });
});
