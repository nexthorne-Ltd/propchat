import { NextResponse } from 'next/server';
import { hasServiceRole } from '@/lib/supabase/service';
import { pollDueConnections } from '@/lib/channels/poll';
import { processOutboundQueue } from '@/lib/channels/outbound';

export const dynamic = 'force-dynamic';

/**
 * Checks X, Threads and LinkedIn for new mentions, replies and comments (the
 * channels that are polled rather than pushed). Each connection is looked at
 * no more often than its channel allows, however often this runs. Scheduled
 * every 5 minutes in vercel.json (Vercel's Hobby plan only allows daily
 * crons: use Pro, or call this URL every few minutes from any scheduler with
 * `Authorization: Bearer $CRON_SECRET`).
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasServiceRole()) {
    return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not set' }, { status: 500 });
  }
  const summary = await pollDueConnections(process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin);
  // New items may have woken the bot; send whatever it answered.
  const sent = await processOutboundQueue({ limit: 20 });
  return NextResponse.json({ ...summary, outbound: sent });
}

export const GET = handle;
export const POST = handle;
