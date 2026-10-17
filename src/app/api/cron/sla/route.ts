import { NextResponse } from 'next/server';
import { hasServiceRole, serviceClient } from '@/lib/supabase/service';
import { processAutomationOutbox } from '@/lib/automation/outbox';

export const dynamic = 'force-dynamic';

/**
 * Records SLA breaches and sends the "due soon" warnings (fn_sla_tick), then
 * sends the alert emails it queued. Scheduled every 5 minutes in vercel.json
 * (Vercel's Hobby plan only allows daily crons: use Pro, or call this URL
 * every few minutes from any scheduler with `Authorization: Bearer $CRON_SECRET`).
 *
 * Breaches are stamped with the moment they happened, not the moment this ran,
 * and the "SLA breached" / "Hours until breach" rule conditions read the
 * timers live, so a late run delays the alert emails but never the numbers.
 * Without CRON_SECRET the route refuses to run (docs/AUDIT.md H-5).
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasServiceRole()) {
    return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not set' }, { status: 500 });
  }

  const { data, error } = await serviceClient().rpc('fn_sla_tick');
  if (error) {
    console.error('[SLA Cron Error]:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const outbox = await processAutomationOutbox({ limit: 100 });
  return NextResponse.json({ events: data ?? 0, ...outbox });
}

export const GET = handle;
export const POST = handle;
