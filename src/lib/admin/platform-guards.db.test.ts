/**
 * Tests that all 10 Phase 3 platform super-admin SQL functions enforce
 * the super-admin security guard (AUDIT M-4):
 *   IF NOT (public.is_current_user_super_admin() OR coalesce(auth.role(), '') = 'service_role')
 *
 * Normal signed-in agents and anon callers are forbidden.
 * Platform super admins and service role callers are permitted.
 *
 * Run with `npm run test:db`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspace, hasDatabase, useTestDatabase } from '@/test/db';

const MIGRATION = fs.readFileSync(
  path.resolve('supabase/migrations/20261113090000_platform_super_admin_guards.sql'),
  'utf8'
);

describe.skipIf(!hasDatabase)('platform super admin SQL guards (database)', () => {
  const { db } = useTestDatabase();

  async function setupPlatformDependencies() {
    await db().q(`
      CREATE TABLE IF NOT EXISTS public.platform_access (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        role text NOT NULL CHECK (role IN ('owner', 'admin')),
        created_at timestamptz DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION public.is_current_user_super_admin()
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.platform_access
          WHERE user_id = auth.uid()
            AND role IN ('owner', 'admin')
        );
      $$;

      CREATE OR REPLACE FUNCTION public.is_current_user_platform_owner()
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.platform_access
          WHERE user_id = auth.uid()
            AND role = 'owner'
        );
      $$;

      CREATE TABLE IF NOT EXISTS public.platform_super_admin_invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text,
        role text,
        invited_by uuid,
        token text,
        created_at timestamptz DEFAULT now(),
        expires_at timestamptz,
        accepted_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS public.automation_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid,
        action_type text,
        status text,
        error text,
        created_at timestamptz DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.channel_outbound_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid,
        channel text,
        error text,
        attempts integer DEFAULT 0,
        status text,
        created_at timestamptz DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.channel_connections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid,
        channel text,
        status text,
        last_error text,
        created_at timestamptz DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.unanswered_questions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid,
        created_at timestamptz DEFAULT now(),
        status text
      );

      CREATE TABLE IF NOT EXISTS public.bot_answer_cache (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid,
        created_at timestamptz DEFAULT now()
      );
    `);
  }

  it('rejects normal signed-in agents and anon with Forbidden from all 10 platform functions', async () => {
    const ws = await createWorkspace(db(), 'Guard Test Workspace');
    await setupPlatformDependencies();
    await db().q(MIGRATION);

    const calls = [
      { name: 'fn_get_platform_users', sql: `SELECT public.fn_get_platform_users()` },
      { name: 'fn_get_platform_overview_metrics', sql: `SELECT public.fn_get_platform_overview_metrics()` },
      { name: 'fn_get_platform_system_health', sql: `SELECT public.fn_get_platform_system_health()` },
      { name: 'fn_get_platform_analytics', sql: `SELECT public.fn_get_platform_analytics(30)` },
      { name: 'fn_get_platform_companies_summary', sql: `SELECT public.fn_get_platform_companies_summary()` },
      { name: 'fn_get_platform_workspaces', sql: `SELECT public.fn_get_platform_workspaces()` },
      { name: 'fn_get_platform_overview', sql: `SELECT public.fn_get_platform_overview(30)` },
      { name: 'fn_get_workspace_owner_detail', sql: `SELECT public.fn_get_workspace_owner_detail('${ws.id}', 30)` },
      { name: 'fn_get_platform_super_admins', sql: `SELECT public.fn_get_platform_super_admins()` },
      { name: 'fn_get_company_analytics', sql: `SELECT public.fn_get_company_analytics('${ws.id}', 30)` },
    ];

    const agentActor = { kind: 'user' as const, id: ws.agentId };
    const anonActor = { kind: 'anon' as const };

    for (const call of calls) {
      // 1. Normal authenticated agent must be forbidden
      const agentErr = await db().rejects(agentActor, call.sql);
      expect(agentErr, `${call.name} for agent`).toContain('Forbidden: platform super admin only');

      // 2. Anon must be rejected (either revoked execute or forbidden guard)
      const anonErr = await db().rejects(anonActor, call.sql);
      expect(anonErr, `${call.name} for anon`).toMatch(/Forbidden|permission denied/i);
    }
  });

  it('permits platform super admins and service role to execute the functions', async () => {
    const ws = await createWorkspace(db(), 'Super Admin Workspace');
    await setupPlatformDependencies();
    await db().q(MIGRATION);

    // Grant super admin role to ws.ownerId in platform_access
    await db().q(`INSERT INTO public.platform_access (user_id, role) VALUES ($1, 'admin')`, [ws.ownerId]);

    const superAdminActor = { kind: 'user' as const, id: ws.ownerId };
    const serviceActor = { kind: 'service' as const };

    for (const actor of [superAdminActor, serviceActor]) {
      const res = await db().as(actor, `SELECT public.fn_get_platform_users()`);
      expect(Array.isArray(res)).toBe(true);
    }
  });
});
