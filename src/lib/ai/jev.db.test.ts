/**
 * Jev's settings live on the platform row next to the DeepSeek key
 * (20261110090000_jev_platform_level.sql): a key saved on a workspace under
 * the earlier per-workspace setup is carried over, the per-workspace columns
 * go, and nobody but the service role can read the key.
 *
 * The test database has no platform_ai_settings (it comes from a migration
 * the script does not load), so each test builds it as 20261027090000 does
 * and re-runs the migration inside its rolled-back transaction.
 *
 * Run with `npm run test:db`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspace, hasDatabase, useTestDatabase } from '@/test/db';

const MIGRATION = fs.readFileSync(path.resolve('supabase/migrations/20261110090000_jev_platform_level.sql'), 'utf8');

describe.skipIf(!hasDatabase)('Jev settings on the platform row (database)', () => {
  const { db } = useTestDatabase();

  async function platformTable() {
    await db().q(`
      CREATE TABLE IF NOT EXISTS public.platform_ai_settings (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
        provider TEXT NOT NULL DEFAULT 'anthropic',
        base_url TEXT,
        model TEXT,
        api_key TEXT,
        is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by UUID
      );
      ALTER TABLE public.platform_ai_settings ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.platform_ai_settings FROM anon, authenticated;
      INSERT INTO public.platform_ai_settings (id, provider, api_key, is_enabled) VALUES (TRUE, 'deepseek', 'sk-deepseek', TRUE)
      ON CONFLICT (id) DO NOTHING;
    `);
  }

  it('carries a key saved on a workspace over to the platform, leaves Jev off, and drops the old columns', async () => {
    const ws = await createWorkspace(db());
    await platformTable();
    // The earlier per-workspace setup (20261109090000).
    await db().q(`ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS jev_settings JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await db().q(`ALTER TABLE public.workspace_secrets ADD COLUMN IF NOT EXISTS jev_api_key TEXT`);
    await db().q(`UPDATE workspaces SET jev_settings = '{"mode":"live"}' WHERE id = $1`, [ws.id]);
    await db().q(`INSERT INTO workspace_secrets (workspace_id, jev_api_key) VALUES ($1, 'ts_saved_on_workspace')`, [ws.id]);

    await db().q(MIGRATION);

    expect(await db().one(`SELECT jev_api_key, jev_settings, api_key FROM platform_ai_settings WHERE id`)).toEqual({
      jev_api_key: 'ts_saved_on_workspace',
      jev_settings: {},
      api_key: 'sk-deepseek',
    });
    const cols = await db().q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('jev_settings', 'jev_api_key')`
    );
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual([
      'platform_ai_settings.jev_api_key',
      'platform_ai_settings.jev_settings',
    ]);
  });

  it('keeps a platform key already set, and can run twice', async () => {
    await platformTable();
    await db().q(MIGRATION);
    await db().q(`UPDATE platform_ai_settings SET jev_api_key = 'ts_platform' WHERE id`);
    await db().q(MIGRATION);
    expect(await db().one(`SELECT jev_api_key FROM platform_ai_settings WHERE id`)).toEqual({ jev_api_key: 'ts_platform' });
  });

  it('only the service role reads the key', async () => {
    const ws = await createWorkspace(db());
    await platformTable();
    await db().q(MIGRATION);
    await db().q(`UPDATE platform_ai_settings SET jev_api_key = 'ts_platform' WHERE id`);
    for (const actor of [{ kind: 'anon' as const }, { kind: 'user' as const, id: ws.ownerId }]) {
      expect(await db().attempt(actor, `SELECT jev_api_key FROM platform_ai_settings`)).toEqual([]);
    }
  });
});
