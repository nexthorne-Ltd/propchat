import { describe, expect, it } from 'vitest';
import { validateEmailSettings } from './settings';

const ctx = { inboundDomain: 'in.example.test', forwardingAddress: 'acme@in.example.test' };
const ok = { from_name: 'Acme Support', signature: '{{agent.name}}\n{{workspace.name}}', custom_address: 'help@acme.test' };

describe('email channel settings', () => {
  it('accepts good settings, and an empty custom address', () => {
    expect(validateEmailSettings(ok, ctx)).toEqual({});
    expect(validateEmailSettings({ ...ok, custom_address: '' }, ctx)).toEqual({});
  });

  it('rejects addresses that are malformed, ours, or on a free mail domain', () => {
    expect(validateEmailSettings({ ...ok, custom_address: 'help@' }, ctx).custom_address).toMatch(/full email address/);
    expect(validateEmailSettings({ ...ok, custom_address: 'Acme@In.Example.test' }, ctx).custom_address).toMatch(/address we gave you/);
    expect(validateEmailSettings({ ...ok, custom_address: 'other@in.example.test' }, ctx).custom_address).toMatch(/address we gave you/);
    expect(validateEmailSettings({ ...ok, custom_address: 'me@gmail.com' }, ctx).custom_address).toMatch(/Free mail/);
  });

  it('limits the name and signature, and only allows known placeholders', () => {
    expect(validateEmailSettings({ ...ok, from_name: 'x'.repeat(81) }, ctx).from_name).toBeTruthy();
    expect(validateEmailSettings({ ...ok, signature: 'x'.repeat(501) }, ctx).signature).toBeTruthy();
    expect(validateEmailSettings({ ...ok, signature: 'Hi {{ticket.id}}' }, ctx).signature).toMatch(/Only \{\{agent\.name\}\}/);
  });
});
