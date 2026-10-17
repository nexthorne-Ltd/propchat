import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, upload, logInbound, updateConnection, settings } = vi.hoisted(() => ({
  rpc: vi.fn(),
  upload: vi.fn(),
  logInbound: vi.fn(),
  updateConnection: vi.fn(),
  settings: {} as Record<string, unknown>,
}));

vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => ({
    rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  }),
}));
vi.mock('@/lib/cloudinary', () => ({ isCloudinaryConfigured: () => true, uploadToCloudinary: upload }));
vi.mock('@/lib/channels/store', () => ({
  loadConnectionByAccount: async (_channel: string, address: string) =>
    address === 'acme@in.example.test'
      ? { connection: { id: 'conn-1', workspace_id: '11111111-1111-1111-1111-111111111111', external_account_id: address, settings }, credentials: {} }
      : null,
  updateConnection,
}));
vi.mock('./runtime', () => ({ logInbound }));

import { taggedAddress } from './addresses';
import { parseRawEmail } from './parse';
import { processInboundEmail } from './inbound';

const WS = '11111111-1111-1111-1111-111111111111';
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));
const ingestArgs = () => rpc.mock.calls.find((c) => c[0] === 'fn_email_ingest_inbound')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(settings)) delete settings[k];
  process.env.EMAIL_TOKEN_SECRET = 'test-secret';
  process.env.EMAIL_INBOUND_DOMAIN = 'in.example.test';
  rpc.mockResolvedValue({ data: { duplicate: false, created: true, ticket_id: 't1', conversation_id: 'c1', message_id: 'm1', ai_mode: 'copilot', matched_by: 'new' }, error: null });
  upload.mockImplementation(async (_buf: Buffer, o: { filename?: string }) => ({ secure_url: `https://cdn.test/${o.filename}` }));
});

const toAcme = (raw: string | Buffer, extras = {}) => parseRawEmail(raw.toString().replace('help@acme.test', 'acme@in.example.test'), { envelopeTo: ['acme@in.example.test'], ...extras });

describe('the inbound email pipeline', () => {
  it('a new email becomes a ticket with its subject, sender and everyone copied', async () => {
    const out = await processInboundEmail(await toAcme(fixture('new-ticket.eml')), 'https://app.test');
    expect(out.status).toBe(200);
    expect(ingestArgs()).toMatchObject({
      p_connection_id: 'conn-1',
      p_from_email: 'alice@example.org',
      p_from_name: 'Alice Example',
      p_message_id: 'caf+new1@mail.example.org',
      p_subject: 'Cannot log in to my account',
      p_verified_ticket_number: null,
      p_subject_ticket_number: null,
    });
    expect(ingestArgs().p_cc.map((c: { email: string }) => c.email)).toEqual(['bob@example.org', 'carol@example.org']);
    expect(logInbound).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ticket_created' }));
  });

  it('a reply to the signed address joins its ticket with only the new text', async () => {
    const address = taggedAddress('acme@in.example.test', 'test-secret', WS, 1042);
    const raw = fixture('reply.eml').toString().replace('acme+t1042-aaaaaaaaaa@in.example.test', address);
    rpc.mockResolvedValueOnce({ data: { duplicate: false, created: false, matched_by: 'token', ticket_id: 't1', conversation_id: 'c1', message_id: 'm1', ai_mode: 'copilot' }, error: null });
    const out = await processInboundEmail(await parseRawEmail(raw, { envelopeTo: [address] }), 'https://app.test');
    expect(out.status).toBe(200);
    const args = ingestArgs();
    expect(args).toMatchObject({
      p_in_reply_to: '9d1c3a52-0001@in.example.test',
      p_references: ['caf+new1@mail.example.org', '9d1c3a52-0001@in.example.test'],
      p_verified_ticket_number: 1042,
      p_subject_ticket_number: 1042,
      p_subject: 'Cannot log in to my account',
      p_content: 'That worked, thank you! One more question: can I change my email?',
    });
    expect(args.p_metadata.email.quoted).toContain('Please try resetting your password');
    expect(args.p_metadata.email.html).toContain('That worked');
    expect(args.p_metadata.email.html).not.toContain('resetting');
    expect(logInbound).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ticket_updated' }));
  });

  it('does not trust a ticket token signed with another secret', async () => {
    const forged = taggedAddress('acme@in.example.test', 'attacker-secret', WS, 1042);
    const raw = fixture('reply.eml').toString().replace('acme+t1042-aaaaaaaaaa@in.example.test', forged);
    await processInboundEmail(await parseRawEmail(raw, { envelopeTo: [forged] }), 'https://app.test');
    expect(ingestArgs().p_verified_ticket_number).toBeNull();
  });

  it('keeps attachments and inline images, and links the images in the sanitised HTML', async () => {
    await processInboundEmail(await toAcme(fixture('attachment.eml')), 'https://app.test');
    expect(upload).toHaveBeenCalledTimes(2);
    const args = ingestArgs();
    expect(args.p_attachments).toEqual([
      expect.objectContaining({ name: 'shot.png', inline: true, url: 'https://cdn.test/shot.png', cid: 'shot1@mail.example.org' }),
      expect.objectContaining({ name: 'error.log', inline: false, url: 'https://cdn.test/error.log' }),
    ]);
    expect(args.p_metadata.email.html).toContain('<img src="https://cdn.test/shot.png"');
  });

  it('refuses to store executable attachments but still records them', async () => {
    const raw = fixture('attachment.eml').toString().replaceAll('error.log', 'virus.exe');
    await processInboundEmail(await toAcme(raw), 'https://app.test');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(ingestArgs().p_attachments).toContainEqual(expect.objectContaining({ name: 'virus.exe', url: null, skipped: expect.stringContaining('blocked') }));
  });

  it('ignores an auto-reply: no ticket, and the log says why', async () => {
    const out = await processInboundEmail(await toAcme(fixture('auto-reply.eml')), 'https://app.test');
    expect(out.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
    expect(logInbound).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ignored_auto_reply', detail: expect.stringContaining('auto-replied') }));
  });

  it('turns a bounce into a failed message and a suppressed address, not a ticket', async () => {
    const out = await processInboundEmail(await toAcme(fixture('bounce.eml')), 'https://app.test');
    expect(out.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_email_record_bounce', {
      p_connection_id: 'conn-1',
      p_original_message_id: '9d1c3a52-0002@in.example.test',
      p_recipient: 'ghost@example.org',
      p_reason: expect.stringContaining('550 5.1.1'),
      p_hard: true,
    });
  });

  it('drops mail from the workspace’s own address instead of mailing itself forever', async () => {
    const raw = fixture('new-ticket.eml').toString().replace('Alice@Example.org', 'acme@in.example.test');
    await processInboundEmail(await toAcme(raw), 'https://app.test');
    expect(rpc).not.toHaveBeenCalled();
    expect(logInbound).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ignored_loop' }));
  });

  it('answers 200 and stores nothing for mail to an address we do not serve', async () => {
    const out = await processInboundEmail(await parseRawEmail(fixture('new-ticket.eml'), { envelopeTo: ['stranger@in.example.test'] }), 'https://app.test');
    expect(out.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a database failure is a 500 so the provider retries; the rate limit is a quiet 200', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    expect((await processInboundEmail(await toAcme(fixture('new-ticket.eml')), 'https://app.test')).status).toBe(500);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Too many emails from a@b.c: paused', hint: 'email_rate_limited' } });
    expect((await processInboundEmail(await toAcme(fixture('new-ticket.eml')), 'https://app.test')).status).toBe(200);
  });

  it('marks forwarding as working when our own test email comes back, even though it is From our address', async () => {
    settings.forwarding_check = { code: 'ZENTRY-CHECK-abc123', sent_at: new Date().toISOString() };
    const raw = fixture('new-ticket.eml').toString().replace('Alice@Example.org', 'acme@in.example.test').replace('I cannot log in', 'ZENTRY-CHECK-abc123');
    const out = await processInboundEmail(await toAcme(raw), 'https://app.test');
    expect(out.body).toBe('Forwarding verified');
    expect(updateConnection).toHaveBeenCalledWith('conn-1', { settings: expect.objectContaining({ forwarding_check: null, forwarding_verified_at: expect.any(String) }) });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('hands the new ticket to the bot only in autopilot', async () => {
    const copilot = await processInboundEmail(await toAcme(fixture('new-ticket.eml')), 'https://app.test');
    expect(copilot.followUps).toHaveLength(0);
    rpc.mockResolvedValueOnce({ data: { duplicate: false, created: true, ticket_id: 't2', conversation_id: 'c2', message_id: 'm2', ai_mode: 'autopilot' }, error: null });
    const auto = await processInboundEmail(await toAcme(fixture('outlook-reply.eml')), 'https://app.test');
    expect(auto.followUps).toHaveLength(1);
  });
});
