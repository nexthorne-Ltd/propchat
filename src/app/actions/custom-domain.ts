'use server';

/**
 * Settings → Help center → Custom domain: everything the setup screen shows,
 * in one call it can repeat while the customer edits their DNS.
 *
 * It answers the questions customers kept asking: which records, what goes
 * in "Name", which of them are right already, and what is still missing. It
 * also re-attaches the domain to our Vercel project when it is not there (a
 * project move left domains behind), and, once Vercel has verified the
 * domain, runs the same "is it live on HTTPS" check as verifyWorkspaceDomainAction.
 */
import { createClient } from '@/lib/supabase/server';
import { assertAdminUser } from '@/app/actions/admin';
import { verifyWorkspaceDomainAction } from '@/app/actions/domain';
import { cleanDomain, splitDomain, type DnsProviderId } from '@/lib/domain';
import { detectDnsProvider } from '@/lib/dns-provider';
import { addDomain, getDomainStatus, getProjectDomainOrNull } from '@/lib/vercel-domains';
import { buildDomainRecords, checkDomainRecords, dnsPanelUrl, type SetupRecord } from '@/lib/custom-domain-setup';
import { errorMessage } from '@/lib/errors/user-error';

export interface CustomDomainSetup {
  domain: string;
  rootDomain: string;
  isApex: boolean;
  provider: { id: DnsProviderId; name: string; isCloudflare: boolean; panelUrl: string | null };
  records: SetupRecord[];
  steps: {
    /** Every record is in DNS. */
    dns: boolean;
    /** Vercel accepted the domain as ours. */
    verified: boolean;
    /** Served on HTTPS by our app. */
    live: boolean;
  };
  /** A problem on our side (hosting), in plain words. */
  hostingError: string | null;
  checkedAt: string;
}

type Result<T> = ({ success: true } & T) | { success: false; error: string };

export async function getCustomDomainSetupAction(
  workspaceId: string
): Promise<Result<{ setup: CustomDomainSetup | null; suggestion: string | null }>> {
  await assertAdminUser(workspaceId);
  try {
    const supabase = await createClient();
    const { data: ws, error } = await supabase
      .from('workspaces')
      .select('custom_domain, custom_domain_status, website_url')
      .eq('id', workspaceId)
      .single();
    if (error || !ws) return { success: false, error: 'Workspace not found.' };

    const site = cleanDomain(ws.website_url);
    const suggestion = site && !site.includes('localhost') ? `help.${site}` : null;
    const domain = cleanDomain(ws.custom_domain);
    if (!domain) return { success: true, setup: null, suggestion };

    const { rootDomain, isApex } = splitDomain(domain);

    // Our side first: the domain must be on the Vercel project.
    let hostingError: string | null = null;
    try {
      if (!(await getProjectDomainOrNull(domain))) await addDomain(domain);
    } catch (err) {
      hostingError = errorMessage(err, 'The domain could not be attached to our hosting.');
    }

    const [provider, vercel] = await Promise.all([
      detectDnsProvider(domain),
      hostingError ? Promise.resolve(null) : getDomainStatus(domain).catch(() => null),
    ]);
    const records = await checkDomainRecords(buildDomainRecords(domain, vercel?.verificationRecords ?? []));
    const dnsOk = records.every((r) => r.status === 'ok');

    let live = ws.custom_domain_status === 'live' || ws.custom_domain_status === 'verified';
    if (!live && vercel?.verified) {
      // Vercel is happy: check HTTPS and mark it live (sends the "live" email once).
      const res = await verifyWorkspaceDomainAction(workspaceId);
      live = Boolean(res.data?.verified);
    }

    return {
      success: true,
      suggestion,
      setup: {
        domain,
        rootDomain,
        isApex,
        provider: {
          id: provider.id,
          name: provider.name,
          isCloudflare: provider.isCloudflare,
          panelUrl: dnsPanelUrl(provider.id),
        },
        records,
        steps: { dns: dnsOk, verified: Boolean(vercel?.verified) || live, live },
        hostingError,
        checkedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    console.error('[Custom Domain Setup] Check failed:', err);
    return { success: false, error: errorMessage(err, 'Could not check the domain right now.') };
  }
}
