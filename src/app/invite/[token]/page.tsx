import type { Metadata } from 'next';
import { InviteAccept } from './InviteAccept';

export const metadata: Metadata = {
  title: 'Join your team',
  robots: { index: false, follow: false },
};

/** Where an invited team member accepts and chooses their password. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteAccept token={token} />;
}
