import 'server-only';
import { Resolver } from 'node:dns/promises';
import { APEX_A_RECORD, CNAME_TARGET, splitDomain, type DnsProviderId } from './domain';

/*
 * The DNS records a customer adds for their help-center domain, worded the
 * way DNS panels ask for them, and checked against what DNS answers today.
 *
 * Customers were unsure which records to add and what to type in "Name":
 * Vercel's ownership TXT lives on the ROOT domain (`_vercel.shop.com` for
 * `help.shop.com`), and showing the full name made people type it into a
 * box that appends the domain itself (`_vercel.shop.com.shop.com`). Every
 * record here carries `host`, exactly what goes in the Name/Host box, and a
 * live status, so the screen can show a tick per record.
 */

export type RecordStatus = 'ok' | 'missing' | 'wrong';

export interface SetupRecord {
  /** route: sends visitors to us. verify: proves ownership to Vercel. */
  role: 'route' | 'verify';
  type: 'CNAME' | 'A' | 'TXT';
  /** What to type in the DNS panel's Name / Host box. */
  host: string;
  /** The full record name. */
  fqdn: string;
  value: string;
  status: RecordStatus;
  /** What DNS answers today when it is not right (to say "change X to Y"). */
  found: string[];
}

/** `fqdn` written relative to its zone, as DNS panels expect it. */
export function relativeHost(fqdn: string, rootDomain: string): string {
  const name = fqdn.toLowerCase().replace(/\.$/, '');
  const root = rootDomain.toLowerCase();
  if (name === root) return '@';
  return name.endsWith(`.${root}`) ? name.slice(0, -(root.length + 1)) : name;
}

/**
 * The records for `domain`: always the one that routes it (CNAME for a
 * subdomain, A for a root domain), plus Vercel's ownership TXT records
 * only when Vercel asks for them.
 */
export function buildDomainRecords(
  domain: string,
  vercelVerification: { type?: string; domain?: string; value?: string }[] = []
): Omit<SetupRecord, 'status' | 'found'>[] {
  const { hostRecord, rootDomain, isApex } = splitDomain(domain);
  const records: Omit<SetupRecord, 'status' | 'found'>[] = [
    isApex
      ? { role: 'route', type: 'A', host: '@', fqdn: domain, value: APEX_A_RECORD }
      : { role: 'route', type: 'CNAME', host: hostRecord, fqdn: domain, value: CNAME_TARGET },
  ];
  for (const v of vercelVerification) {
    if (!v?.value) continue;
    const fqdn = (v.domain || `_vercel.${rootDomain}`).toLowerCase();
    records.push({
      role: 'verify',
      type: (String(v.type || 'TXT').toUpperCase() as SetupRecord['type']) || 'TXT',
      host: relativeHost(fqdn, rootDomain),
      fqdn,
      value: v.value,
    });
  }
  return records;
}

export interface DnsLookup {
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

function publicResolver(): DnsLookup {
  // Public resolvers, so a stale local cache does not hide a fresh record.
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  return resolver;
}

const answers = async (fn: () => Promise<string[]>): Promise<string[]> => {
  try {
    return (await fn()).map((x) => x.toLowerCase().replace(/\.$/, ''));
  } catch {
    // ENOTFOUND / ENODATA: nothing there yet.
    return [];
  }
};

/**
 * Looks each record up. A CNAME counts when it points anywhere on Vercel's
 * DNS (`cname.vercel-dns.com` or a project-specific `…vercel-dns-0xx.com`),
 * since both work. A TXT counts when the exact value is present, even next
 * to old ones.
 */
export async function checkDomainRecords(
  records: Omit<SetupRecord, 'status' | 'found'>[],
  lookup: DnsLookup = publicResolver()
): Promise<SetupRecord[]> {
  return Promise.all(
    records.map(async (r): Promise<SetupRecord> => {
      if (r.type === 'CNAME') {
        const found = await answers(() => lookup.resolveCname(r.fqdn));
        const ok = found.some((x) => x === r.value.toLowerCase() || /(^|\.)vercel-dns(-\d+)?\.com$/.test(x));
        return { ...r, found, status: ok ? 'ok' : found.length ? 'wrong' : 'missing' };
      }
      if (r.type === 'A') {
        const found = await answers(() => lookup.resolve4(r.fqdn));
        const ok = found.includes(r.value) || found.some((ip) => ip.startsWith('76.76.21.'));
        return { ...r, found, status: ok ? 'ok' : found.length ? 'wrong' : 'missing' };
      }
      let txt: string[] = [];
      try {
        txt = (await lookup.resolveTxt(r.fqdn)).map((chunks) => chunks.join(''));
      } catch {
        txt = [];
      }
      const ok = txt.includes(r.value);
      return { ...r, found: txt, status: ok ? 'ok' : txt.length ? 'wrong' : 'missing' };
    })
  );
}

/** Where the customer manages DNS, for an "Open DNS settings" button. */
export function dnsPanelUrl(provider: DnsProviderId): string | null {
  switch (provider) {
    case 'hostinger':
      return 'https://hpanel.hostinger.com/domains';
    case 'cloudflare':
      return 'https://dash.cloudflare.com/';
    case 'godaddy':
      return 'https://dcc.godaddy.com/domains';
    case 'namecheap':
      return 'https://ap.www.namecheap.com/domains/list/';
    default:
      return null;
  }
}
