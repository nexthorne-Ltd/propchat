import { describe, expect, it } from 'vitest';
import { errorMessage, markUserFacing, userError } from './user-error';

/** What a production client receives for any error a server action threw. */
function asReceivedInProduction(thrown: Error & { digest?: string }) {
  const masked = new Error('Minified React error #441; visit https://react.dev/errors/441 for the full message') as Error & {
    digest?: string;
  };
  masked.digest = thrown.digest ?? '1265973703';
  return masked;
}

describe('server action error messages', () => {
  it('a userError reaches the client through the digest', () => {
    const received = asReceivedInProduction(userError('Your plan allows 3 agents.'));
    expect(errorMessage(received)).toBe('Your plan allows 3 agents.');
  });

  it('marked error classes too', () => {
    class AccessError extends Error {}
    const received = asReceivedInProduction(markUserFacing(new AccessError('Forbidden: this workspace is not yours.')));
    expect(errorMessage(received)).toBe('Forbidden: this workspace is not yours.');
  });

  it('anything else becomes a plain sentence, not the minified code', () => {
    const received = asReceivedInProduction(new Error('duplicate key value violates unique constraint'));
    expect(errorMessage(received)).toBe('Something went wrong. Please try again.');
    expect(errorMessage(received, 'Could not load the team.')).toBe('Could not load the team.');
  });

  it('ordinary errors (dev, fetch, validation) keep their message', () => {
    expect(errorMessage(new Error('Network down'))).toBe('Network down');
    expect(errorMessage('Plain string')).toBe('Plain string');
    expect(errorMessage(undefined, 'Fallback')).toBe('Fallback');
  });

  it('a tab from before a deploy is told the app was updated', () => {
    const stale = new Error('Server Action "4069d3c82fee5cee47877e26f25d1aa53c7890ba6c" was not found on the server.');
    expect(errorMessage(stale)).toMatch(/updated/);
  });
});
