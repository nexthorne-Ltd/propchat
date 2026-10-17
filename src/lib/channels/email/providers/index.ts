import type { EmailProvider } from '../types';
import { postmarkProvider } from './postmark';
import { userError } from '@/lib/errors/user-error';

/**
 * The one place that chooses the email provider. To swap providers, write a
 * file implementing EmailProvider (../types.ts), add it here and set
 * EMAIL_PROVIDER. Nothing else in the app names a provider.
 */
const PROVIDERS: Record<string, EmailProvider> = {
  postmark: postmarkProvider,
};

export function getEmailProvider(): EmailProvider {
  const id = (process.env.EMAIL_PROVIDER || 'postmark').toLowerCase();
  const provider = PROVIDERS[id];
  if (!provider) throw userError(`Unknown EMAIL_PROVIDER "${id}". Available: ${Object.keys(PROVIDERS).join(', ')}.`);
  return provider;
}
