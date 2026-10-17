'use server';

/**
 * Super admin → System health → Vercel domains.
 *
 * Customer help-center domains, the help-center base domain (and its
 * wildcard) and the platform's own domain must all be attached to the Vercel
 * project this app runs on. After the project moved to another Vercel team or
 * account they were not: the env still pointed at the old project, or the
 * domains were still attached there. This shows what the app is connected to,
 * which expected domains are missing from that project, and re-adds them,
 * explaining any it cannot add.
 */
import { assertSuperAdmin, recordSuperAdminAudit } from '@/app/actions/platform';
import { serviceClient } from '@/lib/supabase/service';
import { HELP_BASE_DOMAIN, cleanDomain } from '@/lib/domain';
import { addDomain, checkVercelSetup, type VercelSetupStatus } from '@/lib/vercel-domains';
import { errorMessage } from '@/lib/errors/user-error';

export type ExpectedDomainKind = 'platform' | 'help_base' | 'help_wildcard' | 'workspace';

export interface ExpectedDomain {
  domain: string;
  kind: ExpectedDomainKind;
  /** For workspace domains: whose it is. */
  workspaceName?: string;
  onProject: boolean;
  verified: boolean;
}

export interface VercelDomainsView {
  setup: VercelSetupStatus;
  expected: ExpectedDomain[];
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function expectedDomains(): Promise<Omit<ExpectedDomain, 'onProject' | 'verified'>[]> {
  const list: Omit<ExpectedDomain, 'onProject' | 'verified'>[] = [];
  const platform = hostOf(process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL);
  if (platform && !platform.endsWith('.vercel.app') && platform !== 'localhost') {
    list.push({ domain: platform, kind: 'platform' });
  }
  // Only when it is really configured; HELP_BASE_DOMAIN falls back to a
  // placeholder that is not ours.
  const configuredBase = process.env.NEXT_PUBLIC_HELP_BASE_DOMAIN || process.env.HELP_BASE_DOMAIN;
  const base = configuredBase ? cleanDomain(HELP_BASE_DOMAIN) : '';
  if (base && base !== platform) {
    list.push({ domain: base, kind: 'help_base' }, { domain: `*.${base}`, kind: 'help_wildcard' });
  }
  const { data, error } = await serviceClient()
    .from('workspaces')
    .select('name, custom_domain, deleted_at')
    .not('custom_domain', 'is', null);
  if (error) throw new Error(`Could not read workspace domains: ${error.message}`);
  for (const w of (data || []) as { name: string; custom_domain: string | null; deleted_at?: string | null }[]) {
    if (w.deleted_at) continue;
    const domain = cleanDomain(w.custom_domain);
    if (domain && !list.some((x) => x.domain === domain)) list.push({ domain, kind: 'workspace', workspaceName: w.name });
  }
  return list;
}

async function buildView(): Promise<VercelDomainsView> {
  const [setup, wanted] = await Promise.all([checkVercelSetup(), expectedDomains()]);
  const onProject = new Map(setup.domains.map((d) => [d.name.toLowerCase(), d.verified]));
  return {
    setup,
    expected: wanted.map((d) => ({ ...d, onProject: onProject.has(d.domain), verified: onProject.get(d.domain) ?? false })),
  };
}

export async function getVercelDomainsAction(): Promise<{ success: true; view: VercelDomainsView } | { success: false; error: string }> {
  await assertSuperAdmin();
  try {
    return { success: true, view: await buildView() };
  } catch (err) {
    console.error('[Vercel Domains] Load failed:', err);
    return { success: false, error: errorMessage(err, 'Could not check the Vercel setup.') };
  }
}

export interface DomainSyncResult {
  domain: string;
  kind: ExpectedDomainKind;
  status: 'added' | 'error';
  /** DNS records Vercel still needs, when it gave any. */
  needsDns: boolean;
  message?: string;
}

/**
 * Adds every expected domain that is missing from the connected project.
 * Domains already there are left alone. One failure does not stop the rest.
 */
export async function syncVercelDomainsAction(): Promise<
  { success: true; results: DomainSyncResult[]; view: VercelDomainsView } | { success: false; error: string }
> {
  const { agent } = await assertSuperAdmin();
  let view: VercelDomainsView;
  try {
    view = await buildView();
  } catch (err) {
    return { success: false, error: errorMessage(err, 'Could not check the Vercel setup.') };
  }
  if (!view.setup.project) {
    return { success: false, error: view.setup.error || 'The Vercel project could not be read; fix the settings first.' };
  }

  const results: DomainSyncResult[] = [];
  for (const d of view.expected.filter((x) => !x.onProject)) {
    try {
      const res = await addDomain(d.domain);
      results.push({ domain: d.domain, kind: d.kind, status: 'added', needsDns: !res.verified && res.verificationRecords.length > 0 });
    } catch (err) {
      results.push({ domain: d.domain, kind: d.kind, status: 'error', needsDns: false, message: errorMessage(err, 'Vercel did not accept this domain.') });
    }
  }

  await recordSuperAdminAudit({
    admin: agent,
    action: 'sync_vercel_domains',
    details: {
      project: view.setup.project.name,
      added: results.filter((r) => r.status === 'added').map((r) => r.domain),
      failed: results.filter((r) => r.status === 'error').map((r) => r.domain),
    },
  });

  let fresh = view;
  try {
    fresh = await buildView();
  } catch {
    // Keep the earlier view; the results above still say what happened.
  }
  return { success: true, results, view: fresh };
}
