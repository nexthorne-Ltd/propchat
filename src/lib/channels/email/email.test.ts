import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanSubject,
  forwardingAddressFor,
  normalizeMessageId,
  parseAddressList,
  parseMessageIds,
  replySubject,
  splitTaggedAddress,
  taggedAddress,
  ticketNumberFromSubject,
  ticketToken,
  verifiedTicketFromTag,
} from './addresses';
import { classifyInbound } from './classify';
import { htmlToPlainText, sanitizeEmailHtml } from './html';
import { parseRawEmail } from './parse';
import { splitQuotedText } from './quote';
import { composeNotification, composeReply } from './compose';
import { notificationContent, renderBrandedEmail } from './template';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));
const OWN = ['help@acme.test', 'acme@in.example.test'];

describe('parsing raw emails', () => {
  it('reads a new ticket: sender, recipients, CC, subject and body', async () => {
    const mail = await parseRawEmail(fixture('new-ticket.eml'));
    expect(mail.messageId).toBe('caf+new1@mail.example.org');
    expect(mail.from).toEqual({ email: 'alice@example.org', name: 'Alice Example' });
    expect(mail.to.map((a) => a.email)).toEqual(['help@acme.test']);
    expect(mail.cc.map((a) => a.email)).toEqual(['bob@example.org', 'carol@example.org']);
    expect(mail.subject).toBe('Cannot log in to my account');
    expect(mail.text).toContain('invalid token');
    expect(mail.attachments).toHaveLength(0);
  });

  it('reads the threading headers of a reply', async () => {
    const mail = await parseRawEmail(fixture('reply.eml'), { envelopeTo: ['acme+t1042-aaaaaaaaaa@in.example.test'] });
    expect(mail.inReplyTo).toBe('9d1c3a52-0001@in.example.test');
    expect(mail.references).toEqual(['caf+new1@mail.example.org', '9d1c3a52-0001@in.example.test']);
    expect(mail.mailboxHash).toBe('t1042-aaaaaaaaaa');
    expect(ticketNumberFromSubject(mail.subject)).toBe(1042);
  });

  it('reads an attachment and an inline image', async () => {
    const mail = await parseRawEmail(fixture('attachment.eml'));
    const file = mail.attachments.find((a) => a.filename === 'error.log')!;
    expect(file.inline).toBe(false);
    expect(file.content.toString()).toContain('login failed');
    const image = mail.attachments.find((a) => a.filename === 'shot.png')!;
    expect(image.inline).toBe(true);
    expect(image.contentId).toBe('shot1@mail.example.org');
    expect(image.contentType).toBe('image/png');
    expect(mail.text).toContain('attached log'); // text derived from the HTML-only body
  });
});

describe('quoted reply stripping', () => {
  it('cuts a Gmail attribution and the ">" lines below it', async () => {
    const mail = await parseRawEmail(fixture('reply.eml'));
    const { reply, quoted } = splitQuotedText(mail.text);
    expect(reply).toBe('That worked, thank you! One more question: can I change my email?');
    expect(quoted).toContain('wrote:');
    expect(quoted).toContain('Please try resetting your password');
  });

  it('cuts an Outlook header block', async () => {
    const mail = await parseRawEmail(fixture('outlook-reply.eml'));
    const { reply } = splitQuotedText(mail.text);
    expect(reply).toBe('Yes please send the corrected invoice.\n\nDan');
  });

  it('handles wrapped attributions, other languages and our own marker', () => {
    expect(splitQuotedText('Thanks!\n\nOn Mon, 2 Jun 2025 at 09:00, Someone Long Name\n<someone@example.org> wrote:\n> hi').reply).toBe('Thanks!');
    expect(splitQuotedText('Merci\n\nLe 2 juin 2025 à 09:00, Alice <a@b.c> a écrit :\n> salut').reply).toBe('Merci');
    expect(splitQuotedText('Ok\n\n-- Please reply above this line --\nold stuff').reply).toBe('Ok');
  });

  it('keeps inline answers between quoted lines', () => {
    const text = '> Is it blue?\nYes, blue.\n> Is it big?\nVery big.';
    expect(splitQuotedText(text).reply).toBe(text);
  });

  it('never leaves an empty ticket message', () => {
    const forwarded = '> only quoted text\n> nothing new';
    expect(splitQuotedText(forwarded).reply).toBe(forwarded);
    expect(splitQuotedText('').reply).toBe('');
  });
});

describe('sanitising HTML', () => {
  it('removes scripts, styles, handlers, forms, frames, bad links and remote images', async () => {
    const mail = await parseRawEmail(fixture('hostile-html.eml'));
    const { html } = sanitizeEmailHtml(mail.html!);
    expect(html).toContain('<b>team</b>');
    expect(html).toContain('href="https://example.org/docs"');
    for (const bad of ['script', 'alert(1)', 'onclick', 'style', 'javascript:', 'iframe', 'form', 'input', 'tracker.example.org', '<img']) {
      expect(html.toLowerCase(), bad).not.toContain(bad);
    }
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('keeps only inline images we stored ourselves', () => {
    const { html } = sanitizeEmailHtml('<p>x</p><img src="cid:a@b"><img src="cid:other"><img src="https://remote.test/x.png">', { 'a@b': 'https://cdn.example.test/a.png' });
    expect(html).toBe('<p>x</p><img src="https://cdn.example.test/a.png" alt="" />');
  });

  it('cuts quoted history from HTML', async () => {
    const mail = await parseRawEmail(fixture('reply.eml'));
    const { html, quotedRemoved } = sanitizeEmailHtml(mail.html!);
    expect(quotedRemoved).toBe(true);
    expect(html).toContain('That worked');
    expect(html).not.toContain('resetting your password');
  });

  it('gives a plain-text version of HTML', () => {
    expect(htmlToPlainText('<p>Hello&nbsp;<b>you</b> &amp; me</p><p>Bye</p>')).toBe('Hello you & me\nBye');
  });
});

describe('telling people from machines', () => {
  it('lets a person through, including a reply with CC', async () => {
    expect(classifyInbound(await parseRawEmail(fixture('new-ticket.eml')), OWN)).toEqual({ kind: 'person' });
    expect(classifyInbound(await parseRawEmail(fixture('reply.eml')), OWN)).toEqual({ kind: 'person' });
  });

  it('drops an out-of-office auto-reply', async () => {
    const result = classifyInbound(await parseRawEmail(fixture('auto-reply.eml')), OWN);
    expect(result.kind).toBe('auto_reply');
  });

  it('recognises a hard bounce and the email that bounced', async () => {
    const result = classifyInbound(await parseRawEmail(fixture('bounce.eml')), OWN);
    expect(result).toMatchObject({
      kind: 'bounce',
      hard: true,
      originalMessageId: '9d1c3a52-0002@in.example.test',
      recipient: 'ghost@example.org',
    });
  });

  it('treats a 4.x.x delivery status as a soft bounce', async () => {
    const raw = fixture('bounce.eml').toString().replace('Status: 5.1.1', 'Status: 4.2.2').replace('550 5.1.1', '452 4.2.2');
    expect(classifyInbound(await parseRawEmail(raw), OWN)).toMatchObject({ kind: 'bounce', hard: false });
  });

  it('refuses mail from our own addresses and copies of our own mail', async () => {
    const own = await parseRawEmail(fixture('new-ticket.eml').toString().replace('Alice@Example.org', 'help@acme.test'));
    expect(classifyInbound(own, OWN).kind).toBe('loop');
    const echoed = await parseRawEmail(fixture('new-ticket.eml').toString().replace('Subject:', 'X-Zentry-Mail: 1\nSubject:'));
    expect(classifyInbound(echoed, OWN).kind).toBe('loop');
  });

  it('drops mailing lists, no-reply senders and "out of office" subjects without headers', async () => {
    const base = fixture('new-ticket.eml').toString();
    expect(classifyInbound(await parseRawEmail(base.replace('Subject:', 'List-Id: <news.example.org>\nSubject:')), OWN).kind).toBe('auto_reply');
    expect(classifyInbound(await parseRawEmail(base.replace('Alice@Example.org', 'noreply@example.org')), OWN).kind).toBe('auto_reply');
    expect(classifyInbound(await parseRawEmail(base.replace('Cannot log in to my account', 'Out of office: back Monday')), OWN).kind).toBe('auto_reply');
  });

  it('rejects mail with no sender', async () => {
    const mail = await parseRawEmail(fixture('new-ticket.eml'));
    expect(classifyInbound({ ...mail, from: null }, OWN).kind).toBe('invalid');
  });
});

describe('matching an email to a ticket', () => {
  const SECRET = 'test-secret';
  const WS = '11111111-1111-1111-1111-111111111111';

  it('issues a tagged reply-to address and accepts only its own token', () => {
    const address = taggedAddress('Acme@In.Example.test', SECRET, WS, 1042);
    expect(address).toBe(`acme+t1042-${ticketToken(SECRET, WS, 1042)}@in.example.test`);
    const { base, tag } = splitTaggedAddress(address);
    expect(base).toBe('acme@in.example.test');
    expect(verifiedTicketFromTag(tag, SECRET, WS)).toBe(1042);
  });

  it('rejects a forged, truncated, other-ticket or other-workspace token', () => {
    const { tag } = splitTaggedAddress(taggedAddress('a@b.test', SECRET, WS, 1042));
    expect(verifiedTicketFromTag(tag!.replace('t1042', 't1043'), SECRET, WS)).toBeNull();
    expect(verifiedTicketFromTag('t1042-0000000000', SECRET, WS)).toBeNull();
    expect(verifiedTicketFromTag('t1042', SECRET, WS)).toBeNull();
    expect(verifiedTicketFromTag(tag, SECRET, '22222222-2222-2222-2222-222222222222')).toBeNull();
    expect(verifiedTicketFromTag(tag, 'other-secret', WS)).toBeNull();
    expect(verifiedTicketFromTag(null, SECRET, WS)).toBeNull();
  });

  it('reads message ids in every common shape', () => {
    expect(normalizeMessageId('<ABC@Mail.Example>')).toBe('abc@mail.example');
    expect(normalizeMessageId('abc@x.y')).toBe('abc@x.y');
    expect(normalizeMessageId('has spaces')).toBeNull();
    expect(parseMessageIds('<a@x> <B@x>\n <a@x>')).toEqual(['a@x', 'b@x']);
    expect(parseMessageIds(null)).toEqual([]);
  });

  it('finds the ticket reference in a subject, but only as a hint', () => {
    expect(ticketNumberFromSubject('Re: Help [#1042]')).toBe(1042);
    expect(ticketNumberFromSubject('Re: [Ticket #2001] Help')).toBe(2001);
    expect(ticketNumberFromSubject('Re: Help')).toBeNull();
    expect(ticketNumberFromSubject('Order #1042')).toBeNull();
  });

  it('cleans reply prefixes and builds the subject of our replies', () => {
    expect(cleanSubject('RE: Re: AW: Fwd: Cannot log in [#1042]')).toBe('Cannot log in');
    expect(replySubject('Re: Cannot log in [#1042]', 1042)).toBe('Re: Cannot log in [#1042]');
    expect(replySubject('', 7)).toBe('Re: Your request [#7]');
  });

  it('builds a workspace address from its slug', () => {
    expect(forwardingAddressFor('Acme Corp!', 'in.example.test')).toBe('acme-corp@in.example.test');
    expect(forwardingAddressFor('', 'in.example.test')).toBeNull();
    expect(forwardingAddressFor('acme', 'nodot')).toBeNull();
  });

  it('parses address lists', () => {
    expect(parseAddressList('Bob <Bob@x.test>, "Doe, Jane" <jane@x.test>, plain@x.test, junk')).toEqual([
      { email: 'bob@x.test', name: 'Bob' },
      { email: 'jane@x.test', name: 'Doe, Jane' },
      { email: 'plain@x.test' },
    ]);
  });
});

describe('the branded template', () => {
  it('uses the workspace colour and signature and escapes everything else', () => {
    const { html, text } = renderBrandedEmail({
      workspaceName: 'Acme <script>',
      brandColor: '#112233',
      logoUrl: 'javascript:alert(1)',
      body: 'Hi <b>there</b>\n\nSee https://example.org/help?a=1&b=2.',
      signature: 'Alex\nAcme Support',
      ticketNumber: 1042,
    });
    expect(html).toContain('background:#112233');
    expect(html).toContain('Acme &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Hi &lt;b&gt;there&lt;/b&gt;');
    expect(html).toContain('href="https://example.org/help?a=1&amp;b=2"');
    expect(html).toContain('Alex<br>Acme Support');
    expect(html).toContain('Ticket #1042');
    expect(text).toContain('-- Please reply above this line --');
    expect(text).toContain('-- \nAlex\nAcme Support');
  });

  it('falls back to a safe colour and refuses non-https logos', () => {
    const { html } = renderBrandedEmail({ workspaceName: 'A', brandColor: 'red;}</style>', logoUrl: 'http://x.test/l.png', body: 'x' });
    expect(html).toContain('background:#2563eb');
    expect(html).not.toContain('<img');
  });

  it('writes the three requester notifications', () => {
    const base = { requesterName: 'Alice Example', ticketNumber: 1042, ticketSubject: 'Cannot log in' };
    expect(notificationContent({ ...base, template: 'received' }).subject).toBe('We received your request [#1042]');
    const replied = notificationContent({ ...base, template: 'replied', reply: 'Try again.', agentName: 'Sam' });
    expect(replied.subject).toBe('Re: Cannot log in [#1042]');
    expect(replied.body).toContain('Sam replied to your request');
    expect(replied.body).toContain('Try again.');
    expect(notificationContent({ ...base, template: 'solved' }).body).toContain('reply to this email and we will reopen it');
  });

  it('a customer reply to our own template strips back to what they wrote', () => {
    const { text } = renderBrandedEmail({ workspaceName: 'A', body: 'Please try again.', ticketNumber: 5 });
    const customer = `Thanks, done.\n\nOn Tue, 3 Jun 2025 at 11:02, A <a@b.test> wrote:\n> ${text.split('\n').join('\n> ')}`;
    expect(splitQuotedText(customer).reply).toBe('Thanks, done.');
  });
});

describe('composing the emails we send', () => {
  const sender = { forwardingAddress: 'acme@in.example.test', customAddress: 'help@acme.test', domainVerified: false, fromName: 'Acme Support', signature: null, platformFromDomain: 'in.example.test' };
  const workspace = { id: '11111111-1111-1111-1111-111111111111', name: 'Acme', brandColor: '#336699', logoUrl: null };
  const base = { workspace, tokenSecret: 'secret', to: { email: 'alice@example.org', name: 'Alice' }, ticket: { number: 1042, subject: 'Re: Cannot log in [#1042]' }, agentName: 'Sam', text: 'Try again.' };

  it('sends From the platform address until the custom domain is verified, then from the custom one', () => {
    expect(composeReply({ ...base, sender }).from).toEqual({ email: 'acme@in.example.test', name: 'Acme Support' });
    expect(composeReply({ ...base, sender: { ...sender, domainVerified: true } }).from.email).toBe('help@acme.test');
  });

  it('sets Reply-To to the signed ticket address, whichever address it is sent From', () => {
    const mail = composeReply({ ...base, sender: { ...sender, domainVerified: true } });
    expect(mail.replyTo).toBe(taggedAddress('acme@in.example.test', 'secret', workspace.id, 1042));
    expect(verifiedTicketFromTag(splitTaggedAddress(mail.replyTo!).tag, 'secret', workspace.id)).toBe(1042);
  });

  it('threads on the customer’s message and keeps a clean subject', () => {
    const mail = composeReply({ ...base, sender, inReplyTo: 'first@mail.test', references: ['first@mail.test', 'out1@in.example.test'], cc: ['bob@example.org'] });
    expect(mail.subject).toBe('Re: Cannot log in [#1042]');
    expect(mail.headers['In-Reply-To']).toBe('<first@mail.test>');
    expect(mail.headers['References']).toBe('<first@mail.test> <out1@in.example.test>');
    expect(mail.headers['Message-ID']).toBe(`<${mail.messageId}>`);
    expect(mail.messageId).toMatch(/^[0-9a-f-]{36}@in\.example\.test$/);
    expect(mail.cc).toEqual([{ email: 'bob@example.org' }]);
  });

  it('marks every mail as ours, and a human reply is not marked automatic', () => {
    const mail = composeReply({ ...base, sender });
    expect(mail.headers['X-Zentry-Mail']).toBe('1');
    expect(mail.headers['Auto-Submitted']).toBeUndefined();
  });

  it('fills the signature with the agent and workspace names', () => {
    const mail = composeReply({ ...base, sender });
    expect(mail.text).toContain('-- \nSam\nAcme Support');
    expect(composeReply({ ...base, sender: { ...sender, signature: 'Cheers,\n{{agent.name}} at {{workspace.name}}' } }).text).toContain('Cheers,\nSam at Acme');
  });

  it('marks notifications automatic, so nothing auto-answers them', () => {
    const mail = composeNotification({ workspace, sender, tokenSecret: 'secret', to: { email: 'alice@example.org', name: 'Alice Example' }, template: 'received', ticket: { number: 1042, subject: 'Cannot log in' } });
    expect(mail.headers['Auto-Submitted']).toBe('auto-generated');
    expect(mail.headers['X-Auto-Response-Suppress']).toBe('All');
    expect(mail.subject).toBe('We received your request [#1042]');
    expect(mail.text).toContain('Hi Alice,');
  });

  it('an auto-reply to our notification is dropped, not turned into a ticket', async () => {
    const note = composeNotification({ workspace, sender, tokenSecret: 'secret', to: { email: 'frank@example.org' }, template: 'received', ticket: { number: 1042, subject: 'x' } });
    const raw = `Message-ID: <ooo-2@example.org>\nIn-Reply-To: <${note.messageId}>\nFrom: Frank <frank@example.org>\nTo: ${note.replyTo}\nSubject: Re: ${note.subject}\nAuto-Submitted: auto-replied\n\nI am away.`;
    expect((classifyInbound(await parseRawEmail(raw), OWN)).kind).toBe('auto_reply');
  });
});
