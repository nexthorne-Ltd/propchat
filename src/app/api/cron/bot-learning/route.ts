import { NextResponse } from 'next/server';
import { hasServiceRole } from '@/lib/supabase/service';
import { runBotLearning } from '@/lib/ai/learning/learner';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The bot's learning loop (src/lib/ai/learning/learner.ts): scores the
 * retrieval policy's recent answers, re-checks learned answers whose sources
 * changed, and turns newly solved handovers into suggestions. Scheduled hourly
 * by pg_cron (20261119090000_bot_learning.sql). Without CRON_SECRET the route
 * refuses to run.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasServiceRole()) {
    return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not set' }, { status: 500 });
  }
  try {
    return NextResponse.json(await runBotLearning());
  } catch (err) {
    console.error('[Bot Learning Cron Error]:', err);
    return NextResponse.json({ error: 'Learning run failed' }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
