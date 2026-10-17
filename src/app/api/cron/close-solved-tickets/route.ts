import { NextResponse } from 'next/server';
import { hasServiceRole, serviceClient } from '@/lib/supabase/service';

export const dynamic = 'force-dynamic';

/**
 * Closes tickets that have been solved for 4 days (fn_close_solved_tickets).
 *
 * Scheduled daily in vercel.json (the most often Vercel's Hobby plan allows),
 * so a ticket closes between 4 and 5 days after it was solved. Vercel sends
 * `Authorization: Bearer $CRON_SECRET` when that variable is set; without it
 * the route refuses to run, so nobody who finds the URL can trigger it
 * (docs/AUDIT.md H-5).
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasServiceRole()) {
    return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not set' }, { status: 500 });
  }

  const { data, error } = await serviceClient().rpc('fn_close_solved_tickets');
  if (error) {
    console.error('[Close Solved Tickets Cron Error]:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ closed: data ?? 0 });
}

export const GET = handle;
export const POST = handle;
