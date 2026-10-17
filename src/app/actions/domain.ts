'use server';

import dns, { Resolver } from 'node:dns/promises';
import { createClient } from '@/lib/supabase/server';
import { Workspace } from '@/types/database';
import {
  cleanDomain,
  CNAME_TARGET,
  APEX_A_RECORD,
  splitDomain,
  HELP_BASE_DOMAIN,
  validateCustomDomainInput,
  getExpectedDnsRecords,
  DnsProviderGuide,
} from '@/lib/domain';
import { detectDnsProvider } from '@/lib/dns-provider';
import { sendDomainLiveEmail } from '@/lib/email/domain-notifications';
import { addDomain, removeDomain, getDomainStatus } from '@/lib/vercel-domains';
import { assertAdminUser } from '@/app/actions/admin';
import { assertSuperAdmin, recordSuperAdminAudit } from '@/app/actions/platform';
import { validateWorkspaceSlug } from '@/lib/slug';
import { assertWorkspaceFeature } from '@/lib/plans/enforce';
import { assertSettingNotLocked } from '@/lib/settings/precedence';
import { userError } from '@/lib/errors/user-error';
import { refreshHelpAddresses } from '@/lib/help/refresh';

interface ActionResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * 1-Step Custom Domain Connection Flow (Requirement 2 & Requirement 3):
 * 1. Validates input (no protocol, no slashes, not apex domain).
 * 2. Cross-workspace collision check.
 * 3. Connects domain to Vercel project via Vercel SDK addDomain(domain).
 * 4. Detects DNS provider from nameservers.
 * 5. Stores domain in database with status 'connecting'.
 * 6. Returns expected DNS records: single CNAME help -> cname.vercel-dns.com,
 *    and appends TXT challenge ONLY if Vercel returned verification records.
 */
export async function connectCustomDomainAction(
  workspaceId: string,
  rawDomain: string
): Promise<
  ActionResult<{
    workspace: Workspace;
    domain: string;
    dnsProvider: DnsProviderGuide;
    expectedRecords: ReturnType<typeof getExpectedDnsRecords>;
    hostingReady?: boolean | null;
    hostingError?: string;
  }>
> {
  try {
    await assertSettingNotLocked(workspaceId, 'help_center');
    await assertAdminUser(workspaceId);
    await assertWorkspaceFeature(workspaceId, 'custom_help_center_domain');
    const supabase = await createClient();

    // 1. Input validation & sanitization (no protocol, no slashes, not an apex domain)
    const validation = validateCustomDomainInput(rawDomain);
    if (!validation.valid || !validation.domain) {
      return {
        success: false,
        error: validation.error || 'Please enter a valid subdomain (e.g. help.yourcompany.com).',
      };
    }
    const domain = validation.domain;

    // 2. Cross-workspace collision check (not used by another workspace)
    // public_workspaces: RLS hides other tenants' rows from `workspaces`.
    const { data: existing } = await supabase
      .from('public_workspaces')
      .select('id, name')
      .ilike('custom_domain', domain)
      .neq('id', workspaceId)
      .maybeSingle();

    if (existing) {
      return {
        success: false,
        error: `This domain is already registered to "${existing.name}". A domain can only be used by one workspace at a time.`,
      };
    }

    // 3. Register domain on Vercel project using Vercel SDK addDomain
    let vercelRes: any = null;
    try {
      vercelRes = await addDomain(domain);
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Failed to add domain to Vercel project.',
      };
    }

    // 4. Detect DNS provider from nameservers
    const dnsProvider = await detectDnsProvider(domain);

    // 5. Store pending domain in Supabase with status 'connecting'
    const now = new Date().toISOString();
    const token = `zentry_tok_${Math.random().toString(36).substring(2, 10)}${Date.now().toString(36)}`;

    const { data: updated, error: updateErr } = await supabase
      .from('workspaces')
      .update({
        custom_domain: domain,
        custom_domain_status: 'connecting',
        custom_domain_verified_at: null,
        custom_domain_verification_token: token,
        custom_domain_connected_at: now,
        custom_domain_last_checked_at: now,
        custom_domain_notification_sent: null,
      })
      .eq('id', workspaceId)
      .select()
      .single();

    if (updateErr || !updated) {
      throw userError(updateErr?.message || 'Failed to save custom domain.');
    }

    // 6. Generate DNS records (single CNAME by default, TXT challenge only if Vercel returned it)
    const expectedRecords = getExpectedDnsRecords(updated as Workspace, {
      vercelVerification: vercelRes?.verificationRecords,
    });

    refreshHelpAddresses(workspaceId);
    return {
      success: true,
      data: {
        workspace: updated as Workspace,
        domain,
        dnsProvider,
        expectedRecords,
        hostingReady: vercelRes?.success ?? false,
      },
    };
  } catch (err: any) {
    console.error('Failed to connect custom domain:', err);
    return { success: false, error: err.message || 'Failed to connect custom domain.' };
  }
}

/**
 * Retrieves the DNS provider guide and expected records for a workspace's current domain.
 */
export async function getCustomDomainGuideAction(
  workspaceId: string
): Promise<
  ActionResult<{
    domain: string;
    status: string;
    dnsProvider: DnsProviderGuide;
    expectedRecords: ReturnType<typeof getExpectedDnsRecords>;
    isVerified: boolean;
  }>
> {
  try {
    const supabase = await createClient();
    const { data: ws, error } = await supabase
      .from('workspaces')
      .select('id, custom_domain, custom_domain_status, custom_domain_verification_token, website_url')
      .eq('id', workspaceId)
      .single();

    if (error || !ws || !ws.custom_domain) {
      return { success: false, error: 'No custom domain configured.' };
    }

    const domain = cleanDomain(ws.custom_domain);
    const [dnsProvider, vercelStatus] = await Promise.all([
      detectDnsProvider(domain),
      getDomainStatus(domain).catch(() => ({ verified: false, verificationRecords: [] })),
    ]);

    const expectedRecords = getExpectedDnsRecords(ws as Workspace, {
      vercelVerification: vercelStatus.verificationRecords,
    });

    const isVerified = ws.custom_domain_status === 'live' || ws.custom_domain_status === 'verified';

    return {
      success: true,
      data: {
        domain,
        status: ws.custom_domain_status || 'connecting',
        dnsProvider,
        expectedRecords,
        isVerified,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to fetch domain guide.' };
  }
}

/**
 * Configure or update a workspace's custom domain (compatibility wrapper).
 */
export async function updateWorkspaceDomainAction(
  workspaceId: string,
  rawDomain: string
): Promise<
  ActionResult<{
    workspace: Workspace;
    token: string;
    hostingReady?: boolean | null;
    hostingError?: string;
  }>
> {
  const res = await connectCustomDomainAction(workspaceId, rawDomain);
  if (!res.success || !res.data) {
    return { success: false, error: res.error };
  }
  return {
    success: true,
    data: {
      workspace: res.data.workspace,
      token: res.data.workspace.custom_domain_verification_token || '',
      hostingReady: res.data.hostingReady,
    },
  };
}

/**
 * Perform live DNS verification check for a workspace (Requirement 4).
 * Domain is marked "live" ONLY when Vercel reports verified AND a server-side request
 * to https://<domain>/ (or https://<domain>/api/domain-check) returns 200 from our app.
 * Until then, status remains "connecting" with no red errors.
 */
export async function verifyWorkspaceDomainAction(
  workspaceId: string
): Promise<
  ActionResult<{
    verified: boolean;
    status: 'live' | 'connecting' | 'failed';
    details: string;
  }>
> {
  try {
    await assertAdminUser(workspaceId);
    const supabase = await createClient();

    // 1. Fetch workspace
    const { data: ws, error: wsError } = await supabase
      .from('workspaces')
      .select('*')
      .eq('id', workspaceId)
      .single();

    if (wsError || !ws) {
      return { success: false, error: 'Workspace not found' };
    }

    const domain = cleanDomain(ws.custom_domain);
    if (!domain) {
      return { success: false, error: 'No custom domain configured for this workspace' };
    }

    // 2. Allow test domains / local simulated domains for development
    const isTestDomain =
      domain.includes('localhost') ||
      domain.endsWith('.test') ||
      domain.endsWith('.local');

    if (isTestDomain) {
      const now = new Date().toISOString();
      await supabase
        .from('workspaces')
        .update({
          custom_domain_status: 'live',
          custom_domain_verified_at: now,
          custom_domain_last_checked_at: now,
        })
        .eq('id', workspaceId);

      refreshHelpAddresses(workspaceId);
      return {
        success: true,
        data: {
          verified: true,
          status: 'live',
          details: 'Local/test domain verified and live!',
        },
      };
    }

    // 3. Call getDomainStatus via Vercel SDK
    const vercelStatus = await getDomainStatus(domain).catch((err) => ({
      verified: false,
      verificationRecords: [],
      error: err.message,
    }));

    let appReachable = false;
    if (vercelStatus.verified) {
      // Check server-side request to https://<domain>/ or https://<domain>/api/domain-check
      try {
        const probe = await fetch(`https://${domain}/api/domain-check`, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        });

        if (probe.ok) {
          let body: any = null;
          try {
            body = await probe.clone().json();
          } catch {}
          if (body?.app === 'zentry' || body?.app === 'chatify' || body?.workspaceId === workspaceId) {
            appReachable = true;
          }
        }
      } catch {
        // Probe check failed or DNS still propagating
      }

      // Fallback check to https://<domain>/ returning 200 HTTP status
      if (!appReachable) {
        try {
          const rootProbe = await fetch(`https://${domain}/`, {
            headers: { accept: 'text/html' },
            cache: 'no-store',
            signal: AbortSignal.timeout(8000),
          });
          if (rootProbe.status === 200 || rootProbe.ok) {
            appReachable = true;
          }
        } catch {}
      }
    }

    const isLive = vercelStatus.verified && appReachable;
    const now = new Date().toISOString();

    if (isLive) {
      await supabase
        .from('workspaces')
        .update({
          custom_domain_status: 'live',
          custom_domain_verified_at: now,
          custom_domain_last_checked_at: now,
          custom_domain_notification_sent: 'live',
        })
        .eq('id', workspaceId);

      // Send live notification email if not already sent
      if (ws.custom_domain_notification_sent !== 'live') {
        sendDomainLiveEmail({ workspace: ws as Workspace, domain }).catch((err) =>
          console.error('[Domain Live Email Error]:', err)
        );
      }

      refreshHelpAddresses(workspaceId);
      return {
        success: true,
        data: {
          verified: true,
          status: 'live',
          details: `Live — your help center is actively being served on https://${domain}.`,
        },
      };
    } else {
      // Keep status as 'connecting' with no red errors
      await supabase
        .from('workspaces')
        .update({
          custom_domain_status: 'connecting',
          custom_domain_last_checked_at: now,
        })
        .eq('id', workspaceId);

      const message = vercelStatus.verified
        ? `Domain verified by Vercel. Finalizing SSL and HTTPS routing on https://${domain}...`
        : `Connecting custom domain ${domain}. Point your CNAME record to cname.vercel-dns.com.`;

      return {
        success: false,
        data: {
          verified: false,
          status: 'connecting',
          details: message,
        },
      };
    }
  } catch (err: any) {
    console.error('DNS verification error:', err);
    return { success: false, error: err.message || 'Verification process failed' };
  }
}

/**
 * Reset / remove custom domain configuration (Requirement 6).
 * Calls removeDomain from Vercel SDK and clears the database row.
 */
export async function removeWorkspaceDomainAction(
  workspaceId: string
): Promise<ActionResult> {
  try {
    await assertAdminUser(workspaceId);
    const supabase = await createClient();

    // Read custom domain before clearing database row
    const { data: ws } = await supabase
      .from('workspaces')
      .select('custom_domain')
      .eq('id', workspaceId)
      .maybeSingle();

    if (ws?.custom_domain) {
      try {
        await removeDomain(ws.custom_domain);
      } catch (err: any) {
        console.warn('[domain] Vercel removeDomain notice:', err.message);
      }
    }

    const { error } = await supabase
      .from('workspaces')
      .update({
        custom_domain: null,
        custom_domain_status: null,
        custom_domain_verified_at: null,
        custom_domain_verification_token: null,
        custom_domain_connected_at: null,
        custom_domain_last_checked_at: null,
        custom_domain_notification_sent: null,
      })
      .eq('id', workspaceId);

    if (error) throw userError(error.message);

    refreshHelpAddresses(workspaceId);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to remove domain' };
  }
}

/**
 * Checks whether a proposed workspace subdomain slug is available and valid.
 */
export async function checkWorkspaceSlugAvailabilityAction(
  workspaceId: string,
  rawSlug: string
): Promise<{ available: boolean; error?: string; formattedSlug: string }> {
  try {
    const { valid, error, formattedSlug } = validateWorkspaceSlug(rawSlug);
    if (!valid || !formattedSlug) {
      return { available: false, error: error || 'Invalid slug format', formattedSlug };
    }

    const supabase = await createClient();
    // public_workspaces: RLS hides other tenants' rows from `workspaces`.
    const { data: existing } = await supabase
      .from('public_workspaces')
      .select('id, name')
      .ilike('slug', formattedSlug)
      .neq('id', workspaceId)
      .maybeSingle();

    if (existing) {
      return {
        available: false,
        error: `"${formattedSlug}" is already taken by another workspace.`,
        formattedSlug,
      };
    }

    return { available: true, formattedSlug };
  } catch (err: any) {
    return { available: false, error: err.message || 'Error checking slug availability', formattedSlug: rawSlug };
  }
}

/**
 * Allows the workspace owner to edit their ready-made subdomain slug once.
 */
export async function updateWorkspaceSlugAction(
  workspaceId: string,
  rawSlug: string
): Promise<ActionResult<{ workspace: Workspace; slug: string }>> {
  try {
    await assertSettingNotLocked(workspaceId, 'help_center');
    const { user, agent } = await assertAdminUser(workspaceId);
    if (agent.role !== 'owner') {
      return { success: false, error: 'Only the workspace owner can customize the subdomain slug.' };
    }

    const supabase = await createClient();
    const { data: ws, error: fetchErr } = await supabase
      .from('workspaces')
      .select('*')
      .eq('id', workspaceId)
      .single();

    if (fetchErr || !ws) {
      return { success: false, error: 'Workspace not found.' };
    }

    if ((ws.slug_changes_count ?? 0) >= 1) {
      return {
        success: false,
        error: 'The workspace slug can only be customized once. It has already been customized.',
      };
    }

    const { valid, error: valErr, formattedSlug } = validateWorkspaceSlug(rawSlug);
    if (!valid || !formattedSlug) {
      return { success: false, error: valErr || 'Invalid slug format.' };
    }

    if (ws.slug === formattedSlug) {
      return { success: true, data: { workspace: ws as Workspace, slug: formattedSlug } };
    }

    // public_workspaces: RLS hides other tenants' rows from `workspaces`.
    const { data: conflict } = await supabase
      .from('public_workspaces')
      .select('id')
      .ilike('slug', formattedSlug)
      .neq('id', workspaceId)
      .maybeSingle();

    if (conflict) {
      return { success: false, error: `The slug "${formattedSlug}" is already taken by another workspace.` };
    }

    const { data: updated, error: updateErr } = await supabase
      .from('workspaces')
      .update({
        slug: formattedSlug,
        slug_changes_count: (ws.slug_changes_count ?? 0) + 1,
        slug_changed_at: new Date().toISOString(),
      })
      .eq('id', workspaceId)
      .select()
      .single();

    if (updateErr || !updated) {
      return { success: false, error: updateErr?.message || 'Failed to update workspace slug.' };
    }

    refreshHelpAddresses(workspaceId);
    return {
      success: true,
      data: {
        workspace: updated as Workspace,
        slug: formattedSlug,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to update workspace slug.' };
  }
}

/**
 * Registers the platform help center base domain and wildcard domain (*.HELP_BASE_DOMAIN)
 * on the Vercel hosting project.
 */
export async function registerHelpBaseDomainAction(): Promise<
  ActionResult<{ wildcard: any; apex: any }>
> {
  try {
    const { agent } = await assertSuperAdmin();

    if (!HELP_BASE_DOMAIN) {
      return { success: false, error: 'HELP_BASE_DOMAIN environment variable is not defined.' };
    }

    const base = HELP_BASE_DOMAIN.trim().toLowerCase();
    const wildcardDomain = `*.${base}`;

    const [wildcardRes, apexRes] = await Promise.all([
      addDomain(wildcardDomain).catch((e) => ({ success: false, error: e.message })),
      addDomain(base).catch((e) => ({ success: false, error: e.message })),
    ]);

    await recordSuperAdminAudit({
      admin: agent,
      action: 'register_help_base_domain',
      details: {
        base,
        wildcardDomain,
      },
    });

    return {
      success: true,
      data: {
        wildcard: wildcardRes,
        apex: apexRes,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to register base domain.' };
  }
}
