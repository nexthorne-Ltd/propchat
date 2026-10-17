/**
 * Custom-domain records as the setup screen shows them: what goes in the
 * DNS panel's Name box, and whether each record is already right. DNS is
 * faked.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/app/actions/domain', () => ({ connectCustomDomainAction: vi.fn(), removeWorkspaceDomainAction: vi.fn() }));
vi.mock('@/app/actions/custom-domain', () => ({ getCustomDomainSetupAction: vi.fn() }));

import { buildDomainRecords, checkDomainRecords, relativeHost, type DnsLookup } from './custom-domain-setup';
import { DomainSetupView } from '@/components/settings/CustomDomainSetup';

const vercelTxt = [{ type: 'TXT', domain: '_vercel.range4ex.com', value: 'vc-domain-verify=help.range4ex.com,abc123', reason: 'x' }];

function fakeDns(zone: Record<string, { cname?: string[]; a?: string[]; txt?: string[] }>): DnsLookup {
  const get = (n: string) => zone[n] ?? {};
  const none = () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
  return {
    resolveCname: (n) => (get(n).cname ? Promise.resolve(get(n).cname!) : none()),
    resolve4: (n) => (get(n).a ? Promise.resolve(get(n).a!) : none()),
    resolveTxt: (n) => (get(n).txt ? Promise.resolve(get(n).txt!.map((t) => [t])) : none()),
  };
}

describe('records to add', () => {
  it('writes names the way DNS panels ask for them', () => {
    expect(relativeHost('_vercel.range4ex.com', 'range4ex.com')).toBe('_vercel');
    expect(relativeHost('help.range4ex.com.', 'range4ex.com')).toBe('help');
    expect(relativeHost('range4ex.com', 'range4ex.com')).toBe('@');
  });

  it('a subdomain needs a CNAME, plus Vercel’s TXT only when Vercel asks', () => {
    expect(buildDomainRecords('help.range4ex.com')).toEqual([
      { role: 'route', type: 'CNAME', host: 'help', fqdn: 'help.range4ex.com', value: 'cname.vercel-dns.com' },
    ]);
    const withTxt = buildDomainRecords('help.range4ex.com', vercelTxt);
    expect(withTxt[1]).toMatchObject({ role: 'verify', type: 'TXT', host: '_vercel', fqdn: '_vercel.range4ex.com' });
  });

  it('a root domain needs an A record on @', () => {
    expect(buildDomainRecords('range4ex.com')[0]).toMatchObject({ type: 'A', host: '@', value: '76.76.21.21' });
  });
});

describe('checking DNS', () => {
  const records = buildDomainRecords('help.range4ex.com', vercelTxt);

  it('accepts any Vercel CNAME target and a TXT next to old ones', async () => {
    const out = await checkDomainRecords(
      records,
      fakeDns({
        'help.range4ex.com': { cname: ['69cddd13e718676e.vercel-dns-017.com'] },
        '_vercel.range4ex.com': { txt: ['vc-domain-verify=help.range4ex.com,OLD', 'vc-domain-verify=help.range4ex.com,abc123'] },
      })
    );
    expect(out.map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('tells missing from wrong, and shows what is there now', async () => {
    const out = await checkDomainRecords(
      records,
      fakeDns({
        'help.range4ex.com': { cname: ['shops.myshopify.com'] },
      })
    );
    expect(out[0]).toMatchObject({ status: 'wrong', found: ['shops.myshopify.com'] });
    expect(out[1]).toMatchObject({ status: 'missing', found: [] });
  });
});

describe('the setup screen', () => {
  const base = {
    domain: 'help.range4ex.com',
    rootDomain: 'range4ex.com',
    isApex: false,
    provider: { id: 'hostinger' as const, name: 'Hostinger', isCloudflare: false, panelUrl: 'https://hpanel.hostinger.com/domains' },
    hostingError: null,
    checkedAt: '2026-10-14T10:00:00Z',
  };
  const view = (setup: Parameters<typeof DomainSetupView>[0]['setup']) =>
    renderToStaticMarkup(
      React.createElement(DomainSetupView, {
        domain: 'help.range4ex.com',
        setup,
        loading: false,
        checking: false,
        removing: false,
        error: null,
        onCheck: () => {},
        onRemove: () => {},
      })
    );

  it('shows each record with what to type and its status', () => {
    const html = view({
      ...base,
      records: [
        { role: 'route', type: 'CNAME', host: 'help', fqdn: 'help.range4ex.com', value: 'cname.vercel-dns.com', status: 'ok', found: ['cname.vercel-dns.com'] },
        { role: 'verify', type: 'TXT', host: '_vercel', fqdn: '_vercel.range4ex.com', value: 'vc-domain-verify=x', status: 'missing', found: [] },
      ],
      steps: { dns: false, verified: false, live: false },
    });
    expect(html).toContain('Add these 2 records in Hostinger');
    expect(html).toContain('>_vercel<');
    expect(html).toContain('vc-domain-verify=x');
    expect(html).toContain('✓ Found');
    expect(html).toContain('Not added yet');
    expect(html).toContain('Open Hostinger');
  });

  it('says what to change when a record points elsewhere', () => {
    const html = view({
      ...base,
      records: [{ role: 'route', type: 'CNAME', host: 'help', fqdn: 'help.range4ex.com', value: 'cname.vercel-dns.com', status: 'wrong', found: ['old.example.com'] }],
      steps: { dns: false, verified: false, live: false },
    });
    expect(html).toContain('Right now it points to old.example.com. Change it to cname.vercel-dns.com.');
  });

  it('shows the live state with the link', () => {
    const html = view({ ...base, records: [], steps: { dns: true, verified: true, live: true } });
    expect(html).toContain('Live');
    expect(html).toContain('href="https://help.range4ex.com"');
  });
});
