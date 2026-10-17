import { NextRequest, NextResponse } from 'next/server';
import { guardWorkspace } from '@/lib/team/route-guard';
import { calculateReportsDashboard, type SlaEventItem } from '@/lib/reports/metrics';
import type { ReportingEvent } from '@/types/database';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const workspaceId = searchParams.get('workspace_id');

    if (!workspaceId) {
      return NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 });
    }

    const guard = await guardWorkspace(workspaceId, 'view');
    if (!guard.ok) return guard.response;

    const supabase = guard.access.supabase;

    // Filters
    const range = searchParams.get('range') || '30d'; // '7d' | '30d' | '90d' | 'custom'
    const customStart = searchParams.get('start_date');
    const customEnd = searchParams.get('end_date');
    const groupId = searchParams.get('group_id') || undefined;
    const agentId = searchParams.get('agent_id') || undefined;
    const channel = searchParams.get('channel') || undefined;

    // Date range computation
    const now = new Date();
    let startDate: Date;
    let endDate: Date = now;

    if (customStart && customEnd) {
      startDate = new Date(customStart);
      endDate = new Date(customEnd);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return NextResponse.json({ error: 'Invalid custom dates' }, { status: 400 });
      }
    } else {
      let daysBack = 30;
      if (range === '7d') daysBack = 7;
      else if (range === '90d') daysBack = 90;
      startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    }

    // 1. Fetch reporting events in the period
    let eventsQuery = supabase
      .from('reporting_events')
      .select('*')
      .eq('workspace_id', workspaceId)
      .gte('occurred_at', startDate.toISOString())
      .lte('occurred_at', endDate.toISOString())
      .order('occurred_at', { ascending: true });

    if (groupId) eventsQuery = eventsQuery.eq('group_id', groupId);
    if (agentId) eventsQuery = eventsQuery.eq('agent_id', agentId);
    if (channel) eventsQuery = eventsQuery.eq('channel', channel);

    // 2. Fetch prior events count to compute exact initial backlog before startDate
    let priorCreatedQuery = supabase
      .from('reporting_events')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('event_type', 'ticket_created')
      .lt('occurred_at', startDate.toISOString());

    let priorSolvedQuery = supabase
      .from('reporting_events')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('event_type', 'ticket_solved')
      .lt('occurred_at', startDate.toISOString());

    let priorReopenedQuery = supabase
      .from('reporting_events')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('event_type', 'ticket_reopened')
      .lt('occurred_at', startDate.toISOString());

    if (groupId) {
      priorCreatedQuery = priorCreatedQuery.eq('group_id', groupId);
      priorSolvedQuery = priorSolvedQuery.eq('group_id', groupId);
      priorReopenedQuery = priorReopenedQuery.eq('group_id', groupId);
    }
    if (agentId) {
      priorCreatedQuery = priorCreatedQuery.eq('agent_id', agentId);
      priorSolvedQuery = priorSolvedQuery.eq('agent_id', agentId);
      priorReopenedQuery = priorReopenedQuery.eq('agent_id', agentId);
    }
    if (channel) {
      priorCreatedQuery = priorCreatedQuery.eq('channel', channel);
      priorSolvedQuery = priorSolvedQuery.eq('channel', channel);
      priorReopenedQuery = priorReopenedQuery.eq('channel', channel);
    }

    // 3. Fetch SLA events in the period
    let slaQuery = supabase
      .from('sla_events')
      .select('id, metric, event, target_minutes, occurred_at, assignee_id, group_id, late')
      .eq('workspace_id', workspaceId)
      .gte('occurred_at', startDate.toISOString())
      .lte('occurred_at', endDate.toISOString())
      .order('occurred_at', { ascending: true });

    if (groupId) slaQuery = slaQuery.eq('group_id', groupId);
    if (agentId) slaQuery = slaQuery.eq('assignee_id', agentId);

    // 4. Fetch agents and groups metadata
    const [
      { data: eventsData, error: eventsErr },
      { count: priorCreatedCount },
      { count: priorSolvedCount },
      { count: priorReopenedCount },
      { data: slaData, error: slaErr },
      { data: agentsData },
      { data: groupsData },
    ] = await Promise.all([
      eventsQuery,
      priorCreatedQuery,
      priorSolvedQuery,
      priorReopenedQuery,
      slaQuery,
      supabase.from('agents').select('id, name, email, role, avatar_url').eq('workspace_id', workspaceId),
      supabase.from('ticket_groups').select('id, name').eq('workspace_id', workspaceId),
    ]);

    if (eventsErr) {
      console.error('[Reports Error] Failed to load reporting events:', eventsErr);
      return NextResponse.json({ error: 'Could not load report metrics' }, { status: 500 });
    }

    const priorCreated = priorCreatedCount || 0;
    const priorSolved = priorSolvedCount || 0;
    const priorReopened = priorReopenedCount || 0;
    const initialBacklog = Math.max(0, priorCreated - priorSolved + priorReopened);

    const events = (eventsData || []) as ReportingEvent[];
    const slaEvents = (slaData || []) as SlaEventItem[];
    const agents = (agentsData || []) as Array<{ id: string; name: string; email: string; role: string; avatar_url?: string | null }>;
    const groups = (groupsData || []) as Array<{ id: string; name: string }>;

    // Compute metrics
    const dashboardData = calculateReportsDashboard(
      events,
      slaEvents,
      agents,
      initialBacklog,
      startDate,
      endDate,
      { groupId, agentId, channel }
    );

    return NextResponse.json({
      ...dashboardData,
      meta: {
        workspace_id: workspaceId,
        range,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        groups,
        agents: agents.map((a) => ({ id: a.id, name: a.name || a.email, role: a.role })),
      },
    });
  } catch (err: unknown) {
    console.error('[Reports Route Error]:', err);
    return NextResponse.json({ error: 'An unexpected error occurred while calculating reports' }, { status: 500 });
  }
}
