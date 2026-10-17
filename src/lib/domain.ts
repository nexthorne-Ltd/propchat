import { Workspace, PublicWorkspace } from '@/types/database';

/**
 * Platform base domain for zero-setup ready-made help center subdomains.
 * E.g. chatifyhelp.com -> <slug>.chatifyhelp.com
 */
export const HELP_BASE_DOMAIN =
  process.env.NEXT_PUBLIC_HELP_BASE_DOMAIN ||
  process.env.HELP_BASE_DOMAIN ||
  'chatifyhelp.com';

/**
 * Checks whether a hostname is a subdomain on HELP_BASE_DOMAIN.
 * E.g.: "apex-shoes.chatifyhelp.com" -> { isSubdomain: true, slug: "apex-shoes" }
 */
export function parseHelpBaseSubdomain(host: string): {
  isSubdomain: boolean;
  slug: string | null;
  baseDomain: string;
} {
  const h = (host || '').toLowerCase().split(':')[0].trim();
  const base = HELP_BASE_DOMAIN.toLowerCase().split(':')[0].trim();

  if (!base || !h || h === base) {
    return { isSubdomain: false, slug: null, baseDomain: base };
  }

  const suffix = `.${base}`;
  if (h.endsWith(suffix)) {
    const slug = h.slice(0, -suffix.length);
    if (slug && !slug.includes('.')) {
      return { isSubdomain: true, slug, baseDomain: base };
    }
  }

  return { isSubdomain: false, slug: null, baseDomain: base };
}

/**
 * Returns true if host is HELP_BASE_DOMAIN itself or a subdomain on it.
 */
export function isHelpBaseHost(host: string): boolean {
  const h = (host || '').toLowerCase().split(':')[0].trim();
  const base = HELP_BASE_DOMAIN.toLowerCase().split(':')[0].trim();
  if (!base || !h) return false;
  return h === base || h.endsWith(`.${base}`);
}

/**
 * Where customers point their CNAME.
 *
 * This used to be hardcoded to `cname.chatify.dev` — a host this project does
 * not own. It resolves to an unrelated server, so every customer who followed
 * our instructions pointed their subdomain at a stranger and got
 * ERR_CERT_COMMON_NAME_INVALID, because that server naturally has no
 * certificate for their domain.
 *
 * Vercel's shared CNAME target is the correct default; override it with
 * NEXT_PUBLIC_CNAME_TARGET if the platform ever moves.
 */
export const CNAME_TARGET =
  process.env.NEXT_PUBLIC_CNAME_TARGET || 'cname.vercel-dns.com';

/**
 * Where customers point an apex domain (mycompany.com with no subdomain).
 *
 * A CNAME cannot legally sit on an apex record, and most registrars refuse to
 * save one, so those workspaces need an A record instead. Vercel's anycast
 * address is the default; override with NEXT_PUBLIC_APEX_A_RECORD.
 */
export const APEX_A_RECORD =
  process.env.NEXT_PUBLIC_APEX_A_RECORD || '76.76.21.21';

/**
 * Registry suffixes that are two labels long, so `acme.co.uk` is recognised as
 * an apex rather than as the subdomain "acme" of "co.uk". Not exhaustive — a
 * full public-suffix list is far heavier than this is worth — but it covers the
 * suffixes customers actually register under.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'com.br', 'com.mx', 'com.ar',
  'co.nz', 'co.za', 'co.in', 'co.jp', 'co.kr', 'co.il',
  'com.pk', 'com.tr', 'com.sg', 'com.my', 'com.hk', 'com.tw',
  'com.cn', 'com.ua', 'com.pl', 'com.ph', 'com.vn', 'com.ng',
]);

/**
 * Splits a hostname into the DNS "host" field a registrar asks for and the
 * registrable domain, and says whether the record sits on the apex.
 * "help.acme.com"      -> { hostRecord: 'help',    isApex: false }
 * "help.eu.acme.co.uk" -> { hostRecord: 'help.eu', isApex: false }
 * "acme.co.uk"         -> { hostRecord: '@',       isApex: true  }
 */
export function splitDomain(domain: string): {
  hostRecord: string;
  rootDomain: string;
  isApex: boolean;
} {
  const parts = cleanDomain(domain).split('.').filter(Boolean);
  if (parts.length < 2) {
    return { hostRecord: '@', rootDomain: parts.join('.'), isApex: true };
  }

  const lastTwo = parts.slice(-2).join('.');
  const rootLength = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;

  if (parts.length <= rootLength) {
    return { hostRecord: '@', rootDomain: parts.join('.'), isApex: true };
  }

  return {
    hostRecord: parts.slice(0, parts.length - rootLength).join('.'),
    rootDomain: parts.slice(parts.length - rootLength).join('.'),
    isApex: false,
  };
}

/** Hostnames that are the platform itself rather than a customer's domain. */
export function isPlatformHost(host: string): boolean {
  const h = (host || '').toLowerCase().split(':')[0].trim();
  if (!h) return false;

  const appUrlHost = process.env.NEXT_PUBLIC_APP_URL
    ? cleanDomain(process.env.NEXT_PUBLIC_APP_URL)
    : '';
  const vercelProdHost = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? cleanDomain(process.env.VERCEL_PROJECT_PRODUCTION_URL)
    : '';

  const extra = (process.env.NEXT_PUBLIC_PLATFORM_HOSTS || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h.startsWith('192.168.') ||
    h.startsWith('10.') ||
    h.startsWith('172.') ||
    /^[0-9.]+$/.test(h) ||
    h === 'zen-try.site' ||
    h.endsWith('.zen-try.site') ||
    h === 'zen-try.com' ||
    h.endsWith('.zen-try.com') ||
    Boolean(appUrlHost && (h === appUrlHost || h.endsWith(`.${appUrlHost}`))) ||
    Boolean(vercelProdHost && (h === vercelProdHost || h.endsWith(`.${vercelProdHost}`))) ||
    h.endsWith('.vercel.app') ||
    h.endsWith('.loca.lt') ||
    extra.includes(h)
  );
}

/**
 * Normalizes any website URL or hostname into a clean root domain or host.
 * E.g.: "https://www.apexshoes.com/store" -> "apexshoes.com"
 *       "http://localhost:3000/demo.html" -> "localhost:3000"
 *       "support.mybrand.com" -> "support.mybrand.com"
 */
export function cleanDomain(urlOrDomain: string | null | undefined): string {
  if (!urlOrDomain) return '';
  let str = urlOrDomain.trim().toLowerCase();

  // Strip protocol
  str = str.replace(/^https?:\/\//, '');

  // Strip trailing path/query/hashes
  str = str.split('/')[0].split('?')[0].split('#')[0];

  // Strip leading www. if present (preserve subdomains like support. or help.)
  if (str.startsWith('www.')) {
    str = str.slice(4);
  }

  return str;
}

/**
 * Computes the recommended help center subdomain from a website URL.
 * E.g.: "https://apexshoes.com" -> "help.apexshoes.com"
 *       "http://localhost:3000/demo.html" -> "help.localhost"
 */
export function getDefaultSubdomain(websiteUrl: string | null | undefined, prefix = 'help'): string {
  const domain = cleanDomain(websiteUrl);
  if (!domain) return '';

  // If already prefixed with help/support, return as is
  if (domain.startsWith('help.') || domain.startsWith('support.') || domain.startsWith('kb.')) {
    return domain;
  }

  // If localhost, strip port for clean display
  if (domain.startsWith('localhost')) {
    return `${prefix}.localhost`;
  }

  return `${prefix}.${domain}`;
}

/**
 * Resolves the platform root origin.
 */
export function getPlatformOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    const { origin, hostname } = window.location;
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname) && !hostname.endsWith('.localhost')) {
      return origin;
    }
  }
  if (process.env.NEXT_PUBLIC_APP_URL && !process.env.NEXT_PUBLIC_APP_URL.includes('localhost') && !process.env.NEXT_PUBLIC_APP_URL.includes('127.0.0.1')) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
  }
  if (process.env.APP_URL && !process.env.APP_URL.includes('localhost') && !process.env.APP_URL.includes('127.0.0.1')) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`.replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
  }
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, '');
  }
  return PRODUCTION_APP_ORIGIN;
}

/**
 * Returns the public Help Center URL scoped specifically to this workspace.
 *
 * Rules:
 * 1. If the request was received on the customer's own domain or on their <slug>.HELP_BASE_DOMAIN,
 *    serve links relative to that domain.
 * 2. If the workspace has a verified custom domain (e.g. support.mycompany.com),
 *    the helpdesk is served directly from that domain: https://support.mycompany.com
 * 3. Ready-made platform subdomain URL: https://<slug>.HELP_BASE_DOMAIN with zero setup!
 * 4. Fallback under platform origin: /help/<slug>
 */
export function getWorkspaceHelpCenterUrl(
  workspace: Workspace | PublicWorkspace | null | undefined,
  article?: { id: string; slug?: string | null } | null,
  options?: {
    host?: string | null;
  }
): string {
  if (!workspace) {
    return `${getPlatformOrigin()}/help`;
  }

  const articlePath = article ? `/${article.slug || article.id}` : '';

  // 0. Being served on the customer's own domain
  const requestHost = options?.host?.toLowerCase().split(':')[0];
  if (
    requestHost &&
    !isPlatformHost(requestHost) &&
    workspace.custom_domain &&
    cleanDomain(workspace.custom_domain) === requestHost
  ) {
    return `https://${requestHost}${articlePath}`;
  }

  // 1. Being served on the workspace's help center subdomain (<slug>.HELP_BASE_DOMAIN)
  if (requestHost) {
    const { isSubdomain, slug } = parseHelpBaseSubdomain(requestHost);
    if (isSubdomain && slug && (slug === workspace.slug || slug === workspace.id)) {
      const proto = requestHost.includes('localhost') ? 'http' : 'https';
      return `${proto}://${requestHost}${articlePath}`;
    }
  }

  // 2. Verified custom domain mode
  if (workspace.custom_domain && (workspace.custom_domain_status === 'live' || workspace.custom_domain_status === 'verified')) {
    const domain = cleanDomain(workspace.custom_domain);
    return `https://${domain}${articlePath}`;
  }

  // 3. Client-side check: if the page is currently being viewed through a custom domain or help subdomain
  if (typeof window !== 'undefined') {
    const host = window.location.host.toLowerCase().split(':')[0];
    const isPlatform = isPlatformHost(host);

    if (!isPlatform && workspace.custom_domain && cleanDomain(workspace.custom_domain) === host) {
      return `https://${host}${articlePath}`;
    }

    const { isSubdomain, slug } = parseHelpBaseSubdomain(host);
    if (isSubdomain && slug && (slug === workspace.slug || slug === workspace.id)) {
      return `${window.location.origin}${articlePath}`;
    }
  }

  // 4. Ready-made platform subdomain URL with zero setup!
  if (HELP_BASE_DOMAIN) {
    const targetSlug = workspace.slug || workspace.id;
    const baseHost = HELP_BASE_DOMAIN.toLowerCase().split(':')[0];
    const proto = baseHost.includes('localhost') ? 'http' : 'https';
    return `${proto}://${targetSlug}.${HELP_BASE_DOMAIN}${articlePath}`;
  }

  // 5. Workspace-scoped fallback under platform
  const identifier = workspace.slug || workspace.id;
  return `${getPlatformOrigin()}/help/${identifier}${articlePath}`;
}

/**
 * Returns the canonical display domain and configuration info for a workspace.
 */
export function getWorkspaceDomainInfo(workspace: Workspace | PublicWorkspace | null | undefined) {
  if (!workspace) {
    return {
      targetDomain: '',
      isVerified: false,
      isCustom: false,
      status: 'pending' as const,
      verificationToken: '',
      publicUrl: getPlatformOrigin(),
      isLive: false,
    };
  }

  const websiteDomain = cleanDomain(workspace.website_url);
  const targetDomain = workspace.custom_domain || '';
  const isVerified = workspace.custom_domain_status === 'live' || workspace.custom_domain_status === 'verified';
  const status = workspace.custom_domain_status || 'pending';
  const verificationToken =
    ('custom_domain_verification_token' in workspace
      ? workspace.custom_domain_verification_token
      : '') || '';

  return {
    targetDomain,
    websiteDomain,
    isVerified,
    isCustom: !!workspace.custom_domain,
    status,
    verificationToken,
    publicUrl: getWorkspaceHelpCenterUrl(workspace),
    isLive: true,
  };
}

/**
/**
 * Validates a custom domain input string:
 * 1. Automatically strips https://, http://, trailing slashes, paths, and queries.
 * 2. Validates hostname syntax.
 * 3. Rejects apex/root domains with an explanation that CNAME records require a subdomain.
 * 4. Rejects platform domains.
 */
export function validateCustomDomainInput(rawDomain: string): {
  valid: boolean;
  domain?: string;
  hostRecord?: string;
  rootDomain?: string;
  error?: string;
} {
  if (!rawDomain || !rawDomain.trim()) {
    return {
      valid: false,
      error: 'Please enter a subdomain for your Help Center (e.g. help.yourcompany.com).',
    };
  }

  // Strip protocol, slashes, paths, whitespace
  let cleaned = rawDomain.trim().toLowerCase();
  cleaned = cleaned.replace(/^https?:\/\//, '');
  cleaned = cleaned.split('/')[0].split('?')[0].split('#')[0].trim();

  // Strip leading www. if present
  if (cleaned.startsWith('www.')) {
    cleaned = cleaned.slice(4);
  }

  if (!cleaned) {
    return {
      valid: false,
      error: 'Please enter a valid subdomain (e.g. help.yourcompany.com).',
    };
  }

  // Hostname regex validation: RFC 1123 compliant hostname
  const hostnameRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  if (!hostnameRegex.test(cleaned)) {
    return {
      valid: false,
      domain: cleaned,
      error: 'Please enter a valid domain format (e.g. help.yourcompany.com) without special characters or spaces.',
    };
  }

  // Reject platform hostnames
  if (isPlatformHost(cleaned) || isHelpBaseHost(cleaned)) {
    return {
      valid: false,
      domain: cleaned,
      error: 'Cannot use a platform domain or reserved host for a custom domain.',
    };
  }

  // Check if domain is apex/root
  const { hostRecord, rootDomain, isApex } = splitDomain(cleaned);
  if (isApex) {
    return {
      valid: false,
      domain: cleaned,
      error: `Apex/root domains (e.g. "${cleaned}") cannot be used because DNS standards do not allow a CNAME record at the root zone. Please use a subdomain such as help.${cleaned} or support.${cleaned}.`,
    };
  }

  return {
    valid: true,
    domain: cleaned,
    hostRecord,
    rootDomain,
  };
}

export type DnsProviderId = 'cloudflare' | 'godaddy' | 'namecheap' | 'hostinger' | 'other';

export interface DnsProviderGuide {
  id: DnsProviderId;
  name: string;
  nameservers: string[];
  isCloudflare: boolean;
  steps: string[];
  warning?: string;
  hasProxySetting?: boolean;
}

export interface DnsRecordConfig {
  type: 'CNAME' | 'TXT' | 'A';
  name: string;
  value: string;
  description: string;
  required: boolean;
}

/**
 * Expected DNS records for custom domain verification.
 * Shows exactly ONE record by default (CNAME help -> cname.vercel-dns.com).
 * Includes TXT challenge only if Vercel reports domain ownership verification is required.
 */
export function getExpectedDnsRecords(
  workspace: Workspace,
  options?: {
    vercelVerification?: Array<{ type: string; domain: string; value: string; reason: string }>;
  }
) {
  const domain = cleanDomain(workspace.custom_domain || getDefaultSubdomain(workspace.website_url));
  const { hostRecord, isApex } = splitDomain(domain);

  const primary: DnsRecordConfig = isApex
    ? {
        type: 'A',
        name: '@',
        value: APEX_A_RECORD,
        description: 'Points your domain at the servers hosting your help center',
        required: true,
      }
    : {
        type: 'CNAME',
        name: hostRecord,
        value: CNAME_TARGET,
        description: 'Points your subdomain at the servers hosting your help center',
        required: true,
      };

  const records: DnsRecordConfig[] = [primary];

  // Only append TXT verification challenge if Vercel reports the domain is claimed by another account
  if (options?.vercelVerification && options.vercelVerification.length > 0) {
    for (const v of options.vercelVerification) {
      records.push({
        type: (v.type?.toUpperCase() as any) || 'TXT',
        name: v.domain ? v.domain.replace(`.${domain}`, '').replace(domain, hostRecord) : `_vercel.${hostRecord}`,
        value: v.value,
        description: v.reason || 'Prove domain ownership required by Vercel',
        required: true,
      });
    }
  }

  return {
    domain,
    isApex,
    primary,
    records,
    hasTxtChallenge: (options?.vercelVerification?.length ?? 0) > 0,
  };
}

/** Public production origin that serves widget.js. */
export const PRODUCTION_APP_ORIGIN = 'https://zen-try.site';

/**
 * Origin used in copy-paste install snippets. Uses the current deployment's
 * origin in the browser, but never hands customers a localhost URL.
 */
export function getWidgetOrigin(): string {
  if (typeof window !== 'undefined') {
    const { origin, hostname } = window.location;
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname) && !hostname.endsWith('.localhost')) {
      return origin;
    }
  }
  return PRODUCTION_APP_ORIGIN;
}
