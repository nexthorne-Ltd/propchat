import { NextRequest, NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/service';
import { clientIpOf, geoFromRequest } from '@/lib/geo';
import { checkRateLimit } from '@/lib/rate-limit';
import { looksLikeVisitorId, openVisitorSession, verifyVisitorToken } from '@/lib/widget/visitor-token';

// CORS headers to permit embedding on external websites
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Handle CORS preflight requests
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

const reply = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: CORS_HEADERS });

const clip = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value ? value.slice(0, max) : null;

const seconds = (value: unknown) => Math.max(0, Math.min(86400, Math.round(Number(value) || 0)));

/**
 * Visitor tracking for tracker.js (and older widget builds):
 * 1. 'init' (first pageview: opens the visitor's session and registers them)
 * 2. 'pageview' (SPA route change logged to visitor_page_history)
 * 3. 'heartbeat' (periodic ping updating last_seen_at, time_on_page & is_online)
 * 4. 'offline' (tab closed / pagehide beacon)
 * 5. 'expire' (marks visitors offline after 90+ seconds of silence)
 *
 * Every event but 'expire' is about one visitor, so it needs that visitor's
 * session token (docs/AUDIT.md H-3): 'init' gets one issued for a new visitor
 * and returns it; the rest must present it. A visitor id alone changes nothing,
 * and the workspace always comes from the session, never from the body.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpOf(req.headers) || 'unknown';
    if (!(await checkRateLimit(`tracking:${ip}`, 60, 60))) {
      return reply({ error: 'rate_limited' }, 429);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return reply({ error: 'Invalid body' }, 400);
    const { event, visitor_id } = body;

    if (event === 'expire') {
      // Anyone may ask; it only does what the cron does, and never sooner than 60s.
      const staleSeconds = Math.max(60, Number(body.stale_seconds) || 90);
      const thresholdIso = new Date(Date.now() - staleSeconds * 1000).toISOString();
      const { data, error } = await serviceClient()
        .from('visitors')
        .update({ is_online: false })
        .eq('is_online', true)
        .lt('last_seen_at', thresholdIso)
        .select('id');
      if (error) console.error('[Tracker API] Expire failed:', error.message);
      return reply({ success: true, expired_count: data?.length || 0 });
    }

    if (!looksLikeVisitorId(visitor_id)) return reply({ error: 'Missing visitor_id' }, 400);

    const supabase = serviceClient();
    const nowIso = new Date().toISOString();

    if (event === 'init') {
      if (!looksLikeVisitorId(body.workspace_id)) return reply({ error: 'Missing workspace_id' }, 400);
      const session = await openVisitorSession(body.workspace_id, visitor_id, body.visitor_token ?? null);
      if (!session.ok) {
        // 'invalid': this id belongs to someone else (or another workspace);
        // tracker.js starts over with a fresh id.
        return reply({ error: 'session_invalid' }, session.reason === 'invalid' ? 401 : 503);
      }

      const geo = await geoFromRequest(req.headers);
      const city = geo.country ? geo.city : clip(body.ip_location_city, 120);
      const country = geo.country || clip(body.ip_location_country, 120);
      const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || null;
      const pageUrl = clip(body.current_page_url, 2000);

      const { error: visitorErr } = await supabase
        .from('visitors')
        .update({
          current_page_url: pageUrl || '/',
          current_url: pageUrl || '/',
          current_page_title: clip(body.current_page_title, 300),
          referrer_source: clip(body.referrer_source, 2000),
          current_page_entered_at: nowIso,
          time_on_page_seconds: seconds(body.time_on_page),
          device: clip(body.device, 60),
          browser: clip(body.browser, 60),
          os: clip(body.os, 60),
          ip_location_city: city || null,
          ip_location_country: country || null,
          ip_address: clientIp,
          visit_count: Math.max(1, Math.min(100000, Math.round(Number(body.visit_count) || 1))),
          is_online: true,
          last_seen_at: nowIso,
          last_seen: nowIso,
        })
        .eq('id', visitor_id);
      if (visitorErr) console.error('[Tracker API] Error updating visitor:', visitorErr.message);

      if (pageUrl) {
        const { error: pageErr } = await supabase.from('visitor_page_history').insert({
          visitor_id,
          workspace_id: session.workspaceId,
          url: pageUrl,
          title: clip(body.current_page_title, 300),
          referrer: clip(body.referrer_source, 2000),
          duration_seconds: seconds(body.time_on_page),
          visited_at: nowIso,
        });
        if (pageErr) console.error('[Tracker API] Error logging page:', pageErr.message);
      }

      return reply({ success: true, action: 'registered', visitor_token: session.token });
    }

    const session = await verifyVisitorToken(visitor_id, body.visitor_token);
    if (!session) return reply({ error: 'session_invalid' }, 401);

    switch (event) {
      // SPA route change / client-side navigation
      case 'pageview': {
        const url = clip(body.url, 2000);
        if (!url) return reply({ error: 'Missing url' }, 400);

        const { error: pageErr } = await supabase.from('visitor_page_history').insert({
          visitor_id,
          workspace_id: session.workspaceId,
          url,
          title: clip(body.title, 300),
          referrer: clip(body.referrer, 2000),
          duration_seconds: seconds(body.duration_seconds),
          visited_at: nowIso,
        });
        if (pageErr) console.error('[Tracker API] Error logging page:', pageErr.message);

        const updates: Record<string, unknown> = {
          current_page_url: url,
          current_url: url,
          current_page_title: clip(body.title, 300),
          current_page_entered_at: nowIso,
          time_on_page_seconds: 0,
          last_seen_at: nowIso,
          last_seen: nowIso,
          is_online: true,
        };
        const referrer = clip(body.referrer, 2000);
        if (referrer) updates.referrer_source = referrer;
        await supabase.from('visitors').update(updates).eq('id', visitor_id);

        return reply({ success: true, action: 'page_logged' });
      }

      case 'heartbeat': {
        const updates: Record<string, unknown> = {
          last_seen_at: nowIso,
          last_seen: nowIso,
          is_online: true,
          time_on_page_seconds: seconds(body.time_on_page),
        };
        const pageUrl = clip(body.current_page_url, 2000);
        if (pageUrl) {
          updates.current_page_url = pageUrl;
          updates.current_url = pageUrl;
        }
        const title = clip(body.current_page_title, 300);
        if (title) updates.current_page_title = title;
        const referrer = clip(body.referrer_source, 2000);
        if (referrer) updates.referrer_source = referrer;
        await supabase.from('visitors').update(updates).eq('id', visitor_id);

        return reply({ success: true, action: 'heartbeat_received' });
      }

      case 'offline': {
        await supabase
          .from('visitors')
          .update({ is_online: false, last_seen_at: nowIso, last_seen: nowIso })
          .eq('id', visitor_id);
        return reply({ success: true, action: 'marked_offline' });
      }

      default:
        return reply({ error: `Unknown event type: ${event}` }, 400);
    }
  } catch (err: unknown) {
    console.error('[Tracker API Error]:', err);
    return reply({ error: 'Internal server error' }, 500);
  }
}
