import { describe, expect, it } from 'vitest';
import { buildSupportAgentPrompt, parseAgentReply } from '@/lib/ai/support-agent';

describe('parseAgentReply', () => {
  it('strips the tags and reads the source', () => {
    const p = parseAgentReply('Max drawdown is 10%. [SOURCE: 2]');
    expect(p).toEqual({ text: 'Max drawdown is 10%.', sourceIndex: 2, handover: false, handoverReason: null });
  });

  it('reads a handover and its reason', () => {
    const p = parseAgentReply('The team will check your payout.\n[HANDOVER: payout status]');
    expect(p).toMatchObject({ text: 'The team will check your payout.', handover: true, handoverReason: 'payout status' });
  });

  it('treats "passing you to the team" without the tag as a handover, so the team is really paged', () => {
    expect(parseAgentReply("I'm passing this to our team now.").handover).toBe(true);
    expect(parseAgentReply('Main ye team ko forward kar raha hoon.').handover).toBe(true);
  });

  it('a tag alone leaves no text', () => {
    expect(parseAgentReply('[NOT_COVERED]').text).toBe('');
  });

  it('removes links the model wrote', () => {
    expect(parseAgentReply('See [our rules](https://x.example/rules) or https://x.example').text).toBe('See our rules or');
  });

  it('keeps a link that is word for word in the help centre, so "Discord link?" is answered', () => {
    const help = 'Join our community: https://discord.gg/apexfund';
    expect(parseAgentReply('Here it is: https://discord.gg/apexfund.', help).text).toBe('Here it is: https://discord.gg/apexfund.');
    expect(parseAgentReply('[Discord](https://discord.gg/apexfund)', help).text).toBe('Discord: https://discord.gg/apexfund');
    // Changed by the model: not in the help centre, so removed.
    expect(parseAgentReply('Join https://discord.gg/apexfund2', help).text).toBe('Join');
  });
});

describe('troubleshooting before handover', () => {
  const prompt = buildSupportAgentPrompt({ botName: 'Ali', businessName: 'Apex', knowledge: '[ARTICLE 1]\nRules', lang: 'en' });
  it('tells the model to troubleshoot logins, dashboards and missing emails, and never to hand over a rules question', () => {
    expect(prompt).toContain('"invalid account" error');
    expect(prompt).toContain('NOT a handover on the first message');
    expect(prompt).toContain('master (trading) password');
    expect(prompt).toContain('check spam, junk and promotions');
    expect(prompt).toContain('are never handed over');
    expect(prompt).not.toContain('credentials that do not work');
    expect(prompt).not.toContain('is account specific');
  });
});

describe('buildSupportAgentPrompt', () => {
  const base = { botName: 'Ali', businessName: 'Apex', knowledge: '[ARTICLE 1]\nRules', lang: 'roman_ur' as const };

  it('is always a prop-firm agent that speaks the trader\'s language', () => {
    const prompt = buildSupportAgentPrompt(base);
    expect(prompt).toContain('proprietary trading (prop) firm');
    expect(prompt).toContain('HOW TRADERS TALK');
    expect(prompt).toContain('Roman Urdu');
  });

  it('adds the specialist brief and the workspace instructions for it', () => {
    const prompt = buildSupportAgentPrompt({
      ...base,
      specialist: { name: 'Payouts', brief: 'You handle payouts.', instructions: 'Mention the payout calendar.' },
    });
    expect(prompt).toContain('PAYOUTS SPECIALIST');
    expect(prompt).toContain('You handle payouts.');
    expect(prompt).toContain('Mention the payout calendar.');
    // The whole help centre is still after it.
    expect(prompt.indexOf('PAYOUTS SPECIALIST')).toBeLessThan(prompt.indexOf('# HELP CENTER'));
  });
});

describe('buildSupportAgentPrompt: the trader record', () => {
  const base = { botName: 'Ali', businessName: 'Apex', knowledge: '[ARTICLE 1]\nRules', lang: 'en' as const };

  it('a found record is in the prompt, for the verified email, and lifts "you cannot see the account" for what it covers', () => {
    const prompt = buildSupportAgentPrompt({
      ...base,
      traderRecord: { found: true, text: '{"record":{"status":"breached"}}', verifiedEmail: 'ali@x.com' },
    });
    expect(prompt).toContain('# TRADER RECORD');
    expect(prompt).toContain('{"record":{"status":"breached"}}');
    expect(prompt).toContain('ali@x.com');
    expect(prompt).toContain('rule 6 does not apply');
    expect(prompt.indexOf('# TRADER RECORD')).toBeLessThan(prompt.indexOf('# HELP CENTER'));
  });

  it('nothing found: the bot says so and asks to check the email or id', () => {
    const prompt = buildSupportAgentPrompt({ ...base, traderRecord: { found: false, text: '', verifiedEmail: 'ali@x.com' } });
    expect(prompt).toContain('Nothing was found');
    expect(prompt).not.toContain('rule 6 does not apply');
  });

  it('no record, no section', () => {
    expect(buildSupportAgentPrompt(base)).not.toContain('TRADER RECORD');
  });
});


describe("groundingPassages: Jev sees every article the reply's figures come from", () => {
  it("adds the articles holding the reply's numbers after the cited one", async () => {
    const { groundingPassages } = await import('@/lib/ai/anthropic');
    const knowledge = [
      '[ARTICLE 1]\nTitle: Instant accounts\nInstant accounts are funded at once.',
      '[ARTICLE 2]\nTitle: Prices\nInstant 5K costs $24.',
      '[ARTICLE 3]\nTitle: Rules\nDaily drawdown 5%.',
    ].join('\n\n---\n\n');
    const p = groundingPassages(knowledge, 1, 'The Instant 5K account is $24 and funded at once.');
    expect(p).toContain('Instant accounts are funded at once');
    expect(p).toContain('Instant 5K costs $24');
    expect(p).not.toContain('Daily drawdown');
  });
});
