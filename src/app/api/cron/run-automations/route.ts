import { NextResponse } from 'next/server';
import { hasServiceRole, serviceClient } from '@/lib/supabase/service';
import { processAutomationOutbox } from '@/lib/automation/outbox';

export const dynamic = 'force-dynamic';

/**
 * Runs the time-based automations (fn_run_automations) and then sends any
 * emails and webhooks rules have queued. Scheduled hourly in vercel.json
 * (Vercel's Hobby plan only allows daily crons: use Pro, or call this URL
 * hourly from any scheduler with `Authorization: Bearer $CRON_SECRET`).
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

  const { data, error } = await serviceClient().rpc('fn_run_automations');
  if (error) {
    console.error('[Run Automations Cron Error]:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const outbox = await processAutomationOutbox({ limit: 100 });
  return NextResponse.json({ fired: data ?? 0, ...outbox });
}

export const GET = handle;
export const POST = handle;
