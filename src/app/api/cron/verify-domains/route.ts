import { NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/service';
import { Workspace } from '@/types/database';
import { cleanDomain } from '@/lib/domain';
import { getDomainStatus } from '@/lib/vercel-domains';
import { sendDomainLiveEmail } from '@/lib/email/domain-notifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60s timeout for cron

export async function GET(request: Request) {
  return handleDomainVerificationCron(request);
}

export async function POST(request: Request) {
  return handleDomainVerificationCron(request);
}

/**
 * Requirement 4 Polling Job:
 * Every 30 seconds for 30 minutes, then hourly, call getDomainStatus.
 * Mark the domain "live" ONLY when Vercel reports verified AND a server-side request
 * to https://<domain>/ returns 200 from our app.
 * Until then keep "connecting" with no red errors.
 */
async function handleDomainVerificationCron(request: Request) {
  // Each run calls the Vercel API for every pending domain; only the
  // scheduler may start it (docs/AUDIT.md H-5).
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const supabase = serviceClient();
  const now = new Date();

  // Fetch all workspaces with custom domains that are not yet 'live'
  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('*')
    .not('custom_domain', 'is', null)
    .neq('custom_domain_status', 'live');

  if (error || !workspaces) {
    return NextResponse.json(
      { error: error?.message || 'Failed to fetch pending domains' },
      { status: 500 }
    );
  }

  const results = {
    totalPending: workspaces.length,
    checked: 0,
    markedLive: 0,
    stillConnecting: 0,
    notificationsSent: 0,
  };

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  for (const ws of workspaces as Workspace[]) {
    if (!ws.custom_domain) continue;

    const domain = cleanDomain(ws.custom_domain);
    const connectedAt = ws.custom_domain_connected_at ? new Date(ws.custom_domain_connected_at) : now;
    const lastCheckedAt = ws.custom_domain_last_checked_at ? new Date(ws.custom_domain_last_checked_at) : null;

    const elapsedMinutes = (now.getTime() - connectedAt.getTime()) / (1000 * 60);
    const secondsSinceLastCheck = lastCheckedAt
      ? (now.getTime() - lastCheckedAt.getTime()) / 1000
      : Infinity;
    const minutesSinceLastCheck = secondsSinceLastCheck / 60;

    // Polling schedule rule:
    // - Every 30 seconds for first 30 minutes
    // - Hourly (every ~60 minutes) thereafter
    // - Force check if ?force=1 or ?workspaceId=... is passed
    const isTargetWorkspace = url.searchParams.get('workspaceId') === ws.id;
    const shouldCheck =
      force ||
      isTargetWorkspace ||
      (elapsedMinutes <= 30 && secondsSinceLastCheck >= 25) ||
      (elapsedMinutes > 30 && minutesSinceLastCheck >= 55);

    if (!shouldCheck) {
      continue;
    }

    results.checked++;

    try {
      // 1. Call getDomainStatus via Vercel SDK
      const vercelStatus = await getDomainStatus(domain).catch((err) => ({
        verified: false,
        verificationRecords: [],
        error: err.message,
      }));

      let appReachable = false;

      // 2. If Vercel reports verified, check if server-side request to https://<domain>/ returns 200 from our app
      if (vercelStatus.verified) {
        try {
          const probe = await fetch(`https://${domain}/api/domain-check`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal: AbortSignal.timeout(8000),
          });

          if (probe.ok) {
            let body: any = null;
            try {
              body = await probe.clone().json();
            } catch {}
            if (body?.app === 'zentry' || body?.app === 'chatify' || body?.workspaceId === ws.id) {
              appReachable = true;
            }
          }
        } catch {}

        if (!appReachable) {
          try {
            const rootProbe = await fetch(`https://${domain}/`, {
              headers: { accept: 'text/html' },
              cache: 'no-store',
              signal: AbortSignal.timeout(8000),
            });
            if (rootProbe.status === 200 || rootProbe.ok) {
              appReachable = true;
            }
          } catch {}
        }
      }

      // Mark domain "live" only when Vercel reports verified AND https://<domain>/ returns 200 from our app
      const isLive = vercelStatus.verified && appReachable;

      if (isLive) {
        const verifiedAt = now.toISOString();
        await supabase
          .from('workspaces')
          .update({
            custom_domain_status: 'live',
            custom_domain_verified_at: verifiedAt,
            custom_domain_last_checked_at: verifiedAt,
            custom_domain_notification_sent: 'live',
          })
          .eq('id', ws.id);

        if (ws.custom_domain_notification_sent !== 'live') {
          await sendDomainLiveEmail({ workspace: ws, domain }).catch((e) =>
            console.error('[Domain Live Email Error]:', e)
          );
          results.notificationsSent++;
        }

        results.markedLive++;
      } else {
        // Until then keep "connecting" with no red errors
        results.stillConnecting++;
        await supabase
          .from('workspaces')
          .update({
            custom_domain_status: 'connecting',
            custom_domain_last_checked_at: now.toISOString(),
          })
          .eq('id', ws.id);
      }
    } catch (err: any) {
      console.error(`[Cron Verify] Error checking domain ${domain}:`, err);
    }
  }

  return NextResponse.json({
    success: true,
    timestamp: now.toISOString(),
    results,
  });
}
