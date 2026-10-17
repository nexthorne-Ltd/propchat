import dns, { Resolver } from 'node:dns/promises';
import { splitDomain, DnsProviderGuide, DnsProviderId } from './domain';

/**
 * Resolves authoritative NS (nameserver) records for a domain,
 * falling back to root domain and public resolvers (1.1.1.1, 8.8.8.8).
 */
export async function lookupNameservers(domain: string): Promise<string[]> {
  const { rootDomain } = splitDomain(domain);
  const targets = [rootDomain, domain];

  for (const target of targets) {
    try {
      const records = await dns.resolveNs(target);
      if (records && records.length > 0) {
        return records.map((r) => r.toLowerCase().trim());
      }
    } catch {}

    try {
      const resolver = new Resolver();
      resolver.setServers(['1.1.1.1', '8.8.8.8']);
      const records = await resolver.resolveNs(target);
      if (records && records.length > 0) {
        return records.map((r) => r.toLowerCase().trim());
      }
    } catch {}
  }

  return [];
}

/**
 * Detects the DNS provider from the nameservers and produces
 * customized instructions (Cloudflare, GoDaddy, Namecheap, Hostinger, Other).
 */
export async function detectDnsProvider(domain: string): Promise<DnsProviderGuide> {
  const { hostRecord } = splitDomain(domain);
  const nameservers = await lookupNameservers(domain);
  const nsString = nameservers.join(' ').toLowerCase();

  // 1. Cloudflare
  if (nsString.includes('cloudflare.com') || nsString.includes('.ns.cloudflare.com')) {
    return {
      id: 'cloudflare',
      name: 'Cloudflare',
      nameservers,
      isCloudflare: true,
      hasProxySetting: true,
      warning:
        'CRITICAL: Proxy status must be set to "DNS only" (gray cloud icon). Cloudflare proxy hides the CNAME target and prevents Vercel from provisioning your SSL certificate.',
      steps: [
        'Log into your Cloudflare dashboard and select your domain.',
        'Navigate to DNS > Records in the left sidebar and click Add record.',
        'Set Type to CNAME.',
        `Set Name to "${hostRecord}".`,
        'Set Target to "cname.vercel-dns.com".',
        'Toggle Proxy status from Proxied (orange cloud) to DNS only (gray cloud).',
        'Leave TTL set to Auto and click Save.',
      ],
    };
  }

  // 2. GoDaddy
  if (
    nsString.includes('domaincontrol.com') ||
    nsString.includes('godaddy.com') ||
    nsString.includes('secureserver.net')
  ) {
    return {
      id: 'godaddy',
      name: 'GoDaddy',
      nameservers,
      isCloudflare: false,
      steps: [
        'Sign in to your GoDaddy Domain Portfolio and select your domain.',
        'Scroll down to the DNS section (or click Manage DNS).',
        'Under DNS Records, click Add New Record.',
        'Select Type: CNAME.',
        `Enter Name: "${hostRecord}".`,
        'Enter Value: "cname.vercel-dns.com".',
        'Set TTL to 1/2 Hour (or 1 Hour) and click Save.',
      ],
    };
  }

  // 3. Namecheap
  if (
    nsString.includes('registrar-servers.com') ||
    nsString.includes('namecheap.com') ||
    nsString.includes('namecheaphosting.com')
  ) {
    return {
      id: 'namecheap',
      name: 'Namecheap',
      nameservers,
      isCloudflare: false,
      steps: [
        'Sign in to your Namecheap account and click Manage next to your domain in Domain List.',
        'Click the Advanced DNS tab at the top.',
        'In the Host Records section, click Add New Record.',
        'Select CNAME Record from the dropdown.',
        `Enter Host: "${hostRecord}".`,
        'Enter Target: "cname.vercel-dns.com".',
        'Leave TTL set to Automatic and click the green checkmark to save.',
      ],
    };
  }

  // 4. Hostinger
  if (
    nsString.includes('hostinger.com') ||
    nsString.includes('main-hosting.com') ||
    nsString.includes('hostingerdns.com')
  ) {
    return {
      id: 'hostinger',
      name: 'Hostinger',
      nameservers,
      isCloudflare: false,
      steps: [
        'Log into your Hostinger hPanel and go to Domains > select your domain.',
        'Click DNS / Nameservers in the left sidebar menu.',
        'Under Manage DNS Records, select Type: CNAME.',
        `In the Name field, enter "${hostRecord}".`,
        'In the Points to / Target field, enter "cname.vercel-dns.com".',
        'Leave TTL at default (300 or 14400) and click Add Record.',
      ],
    };
  }

  // 5. Generic / Other Provider
  const providerLabel = nameservers.length > 0 ? `DNS Provider (${nameservers[0]})` : 'Your DNS Provider';

  return {
    id: 'other',
    name: providerLabel,
    nameservers,
    isCloudflare: false,
    steps: [
      'Log into your domain registrar or DNS hosting provider.',
      "Navigate to your domain's DNS Management or Zone Editor.",
      'Add a new CNAME record.',
      `Enter Host / Name: "${hostRecord}".`,
      'Enter Target / Points To: "cname.vercel-dns.com".',
      'Save the record and allow a few minutes for DNS propagation.',
    ],
  };
}
