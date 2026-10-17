/**
 * Team alerts are sent with the workspace's SMTP, or the platform's when the
 * workspace has none, so a handover always reaches someone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: Record<string, unknown> = {};
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }),
      }),
    }),
  }),
}));

import { loadTeamAlertSmtp } from './workspace-smtp';

const ready = { enabled: true, host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', from_email: 'a@example.com' };

describe('loadTeamAlertSmtp', () => {
  beforeEach(() => {
    for (const k of Object.keys(rows)) delete rows[k];
  });

  it("uses the workspace's own SMTP when it has one", async () => {
    rows.workspaces = { smtp_settings: { ...ready, host: 'smtp.business.com' } };
    rows.platform_settings = { smtp_settings: ready };
    expect(await loadTeamAlertSmtp('ws')).toMatchObject({ source: 'workspace', smtp: { host: 'smtp.business.com' } });
  });

  it("falls back to the platform's SMTP", async () => {
    rows.workspaces = { smtp_settings: null };
    rows.platform_settings = { smtp_settings: ready };
    expect(await loadTeamAlertSmtp('ws')).toMatchObject({ source: 'platform', smtp: { host: 'smtp.example.com' } });
  });

  it('returns null only when neither is set up', async () => {
    rows.workspaces = { smtp_settings: { ...ready, enabled: false } };
    rows.platform_settings = { smtp_settings: { ...ready, pass: '' } };
    expect(await loadTeamAlertSmtp('ws')).toBeNull();
  });
});
