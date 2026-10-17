import { NextRequest, NextResponse } from 'next/server';
import { serviceClient } from '@/lib/supabase/service';
import { clientIpOf } from '@/lib/geo';
import { checkRateLimit } from '@/lib/rate-limit';
import { verifyCsatToken } from '@/lib/csat/token';
import { verifyVisitorToken } from '@/lib/widget/visitor-token';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  try {
    const ip = clientIpOf(req.headers) || 'unknown';
    if (!(await checkRateLimit(`csat:${ip}`, 60, 60))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: CORS_HEADERS });
    }

    const { searchParams } = new URL(req.url);
    const ticketId = searchParams.get('ticket_id');
    const token = searchParams.get('token');

    if (!ticketId) {
      return NextResponse.json({ error: 'Missing ticket_id' }, { status: 400, headers: CORS_HEADERS });
    }

    const supabase = serviceClient();
    const { data: ticket, error } = await supabase
      .from('tickets')
      .select('id, number, subject, status, workspace_id, csat_rating, csat_comment, csat_rated_at, workspace:workspaces(id, name, logo_url, brand_color)')
      .eq('id', ticketId)
      .maybeSingle();

    if (error || !ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404, headers: CORS_HEADERS });
    }

    // If token provided, verify it (or allow checking if not required for preview)
    const validToken = token ? verifyCsatToken(ticket.id, ticket.workspace_id, token) : true;

    return NextResponse.json(
      {
        ticket: {
          id: ticket.id,
          number: ticket.number,
          subject: ticket.subject,
          status: ticket.status,
          csat_rating: ticket.csat_rating,
          csat_comment: ticket.csat_comment,
          csat_rated_at: ticket.csat_rated_at,
          workspace: ticket.workspace,
        },
        token_valid: validToken,
      },
      { headers: CORS_HEADERS }
    );
  } catch (err: unknown) {
    console.error('[CSAT Get Error]:', err);
    return NextResponse.json({ error: 'Could not load ticket details' }, { status: 500, headers: CORS_HEADERS });
  }
}

/**
 * Records a rating from one of two places, each proving who is rating:
 * the emailed survey link (ticket_id + its signed token) or the widget
 * (conversation_id + the visitor's session token, for their own conversation).
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpOf(req.headers) || 'unknown';
    if (!(await checkRateLimit(`csat:${ip}`, 60, 60))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: CORS_HEADERS });
    }

    const body = await req.json();
    const { ticket_id, conversation_id, rating, comment, token, visitor_id, visitor_token } = body;

    if (!rating || !['good', 'bad'].includes(rating)) {
      return NextResponse.json(
        { error: 'Rating must be either "good" or "bad"' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    if (!ticket_id && !conversation_id) {
      return NextResponse.json(
        { error: 'Either ticket_id or conversation_id must be provided' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const supabase = serviceClient();

    // 1. Locate the ticket, and check the caller may rate it.
    let ticket: {
      id: string;
      workspace_id: string;
      conversation_id: string | null;
      assignee_id: string | null;
      group_id: string | null;
      channel: string | null;
      priority: string | null;
      tags: string[] | null;
    } | null = null;
    if (ticket_id) {
      const { data, error: findErr } = await supabase.from('tickets').select('*').eq('id', ticket_id).maybeSingle();
      if (findErr || !data) {
        return NextResponse.json({ error: 'Ticket not found' }, { status: 404, headers: CORS_HEADERS });
      }
      if (typeof token !== 'string' || !verifyCsatToken(data.id, data.workspace_id, token)) {
        return NextResponse.json({ error: 'Invalid or expired survey token' }, { status: 403, headers: CORS_HEADERS });
      }
      ticket = data;
    } else {
      const session = await verifyVisitorToken(visitor_id, visitor_token);
      const { data: conv } = session
        ? await supabase.from('conversations').select('id, current_ticket_id').eq('id', conversation_id).eq('visitor_id', session.visitorId).maybeSingle()
        : { data: null };
      if (!conv) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404, headers: CORS_HEADERS });
      }
      // The conversation's current ticket; an older chat may only be linked by conversation_id.
      const { data } = conv.current_ticket_id
        ? await supabase.from('tickets').select('*').eq('id', conv.current_ticket_id).maybeSingle()
        : await supabase.from('tickets').select('*').eq('conversation_id', conv.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!data) {
        return NextResponse.json({ error: 'Ticket not found' }, { status: 404, headers: CORS_HEADERS });
      }
      ticket = data;
    }
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404, headers: CORS_HEADERS });
    }

    const trimmedComment = typeof comment === 'string' ? comment.trim().slice(0, 1000) : null;
    const now = new Date().toISOString();

    // 3. Update tickets table
    const { error: updateTicketErr } = await supabase
      .from('tickets')
      .update({
        csat_rating: rating,
        csat_comment: trimmedComment || null,
        csat_rated_at: now,
      })
      .eq('id', ticket.id);

    if (updateTicketErr) {
      console.error('[CSAT Update Ticket Error]:', updateTicketErr);
      return NextResponse.json({ error: 'Failed to record rating on ticket' }, { status: 500, headers: CORS_HEADERS });
    }

    // 4. Sync to conversation if ticket is linked to a conversation
    // Only the rated ticket's own conversation (never one named in the body).
    const convId = ticket.conversation_id;
    if (convId) {
      await supabase
        .from('conversations')
        .update({
          csat_rating: rating === 'good' ? 5 : 1,
          csat_feedback: trimmedComment || null,
        })
        .eq('id', convId);
    }

    // 5. Explicitly ensure reporting_events has the rating recorded
    await supabase.from('reporting_events').insert({
      workspace_id: ticket.workspace_id,
      ticket_id: ticket.id,
      event_type: 'csat_rated',
      occurred_at: now,
      agent_id: ticket.assignee_id,
      group_id: ticket.group_id,
      channel: ticket.channel,
      priority: ticket.priority,
      tags: ticket.tags || [],
      csat_rating: rating,
      csat_comment: trimmedComment || null,
    });

    return NextResponse.json(
      {
        success: true,
        rating,
        comment: trimmedComment,
        ticket_id: ticket.id,
      },
      { headers: CORS_HEADERS }
    );
  } catch (err: unknown) {
    console.error('[CSAT Submit Error]:', err);
    return NextResponse.json({ error: 'Could not submit rating' }, { status: 500, headers: CORS_HEADERS });
  }
}
