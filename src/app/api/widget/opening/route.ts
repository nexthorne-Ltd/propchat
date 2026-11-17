import { NextRequest, NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/service';
import { clientIpOf } from '@/lib/geo';
import { checkRateLimit } from '@/lib/rate-limit';
import { verifyVisitorToken } from '@/lib/widget/visitor-token';
import { openingOffer } from '@/lib/ai/sales';
import { subAgentEnabled } from '@/lib/ai/sub-agents';
import { loadStorefront } from '@/lib/ai/trader-data/storefront';

// Called by the embeddable widget from the customer's own site.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * The widget writes the welcome itself the moment a chat opens, before the
 * bot sees anything, so the opening offer (running offers, coupon, cheapest
 * plan; sales.ts openingOffer) has to reach it from here. It needs the
 * firm's backend key, which only the server holds. The workspace comes from
 * the visitor's session, never from the body. `{ text: null }` means "send
 * the usual menu": no connection, nothing on sale, or Sales switched off.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpOf(req.headers) || 'unknown';
    if (!(await checkRateLimit(`opening:${ip}`, 30, 60))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: CORS_HEADERS });
    }
    const body = await req.json().catch(() => ({}));
    const session = await verifyVisitorToken(body.visitor_id, body.visitor_token);
    if (!session?.workspaceId) {
      return NextResponse.json({ error: 'session_invalid' }, { status: 401, headers: CORS_HEADERS });
    }

    const { data: ws, error } = await serviceClient()
      .from('workspaces')
      .select('ai_settings')
      .eq('id', session.workspaceId)
      .maybeSingle();
    if (error) console.warn('[Widget Opening] Could not read the workspace:', error.message);
    const subAgents = (ws?.ai_settings as { sub_agents?: Parameters<typeof subAgentEnabled>[0] } | null)?.sub_agents ?? null;
    if (!subAgentEnabled(subAgents, 'pricing_offers')) {
      return NextResponse.json({ text: null }, { headers: CORS_HEADERS });
    }

    const store = await loadStorefront(session.workspaceId);
    const intro = typeof body.intro === 'string' ? body.intro.slice(0, 120) : null;
    const offer = openingOffer('en', null, store, intro);
    return NextResponse.json({ text: offer?.text ?? null }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error('[Widget Opening Error]:', err);
    return NextResponse.json({ error: 'failed' }, { status: 500, headers: CORS_HEADERS });
  }
}
