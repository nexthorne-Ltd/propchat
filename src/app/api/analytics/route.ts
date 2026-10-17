import { NextRequest, NextResponse } from 'next/server';
import { guardWorkspace } from '@/lib/team/route-guard';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const workspaceId = searchParams.get('workspace_id');
    const guard = await guardWorkspace(workspaceId, 'view');
    if (!guard.ok) return guard.response;
    if (!workspaceId) return NextResponse.json({ error: 'Missing workspace_id' }, { status: 400 });
    const timeRange = searchParams.get('range') || '30d'; // '7d' | '30d' | '90d'
    const granularity = searchParams.get('granularity') || 'daily'; // 'daily' | 'weekly' | 'monthly'

    const supabase = guard.access.supabase;

    // Determine cutoff date
    const now = new Date();
    let daysBack = 30;
    if (timeRange === '7d') daysBack = 7;
    else if (timeRange === '90d') daysBack = 90;

    const startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const prevStartDate = new Date(now.getTime() - daysBack * 2 * 24 * 60 * 60 * 1000);

    // 1. Fetch conversations in current and previous periods
    const [{ data: conversations }, { data: prevConversations }, { data: agents }] =
      await Promise.all([
        supabase
          .from('conversations')
          .select('*, visitor:visitors(*), agent:agents(*)')
          .eq('workspace_id', workspaceId)
          .gte('created_at', startDate.toISOString())
          .order('created_at', { ascending: true }),
        supabase
          .from('conversations')
          .select('id, status, csat_rating')
          .eq('workspace_id', workspaceId)
          .gte('created_at', prevStartDate.toISOString())
          .lt('created_at', startDate.toISOString()),
        supabase
          .from('agents')
          .select('*')
          .eq('workspace_id', workspaceId),
      ]);

    const convList = conversations || [];
    const convIds = convList.map((c) => c.id);

    const { data: messages } = convIds.length
      ? await supabase
          .from('messages')
          .select('conversation_id, sender_type, sender_id, is_internal, created_at')
          .in('conversation_id', convIds)
          .gte('created_at', startDate.toISOString())
          .order('created_at', { ascending: true })
      : { data: [] };

    const prevConvList = prevConversations || [];
    const agentList = agents || [];
    const msgList = messages || [];

    // Map messages by conversation_id
    interface MsgItem {
      conversation_id: string;
      sender_type: string;
      sender_id?: string | null;
      is_internal?: boolean;
      created_at: string;
    }

    const msgsByConv = new Map<string, MsgItem[]>();
    for (const m of msgList as MsgItem[]) {
      if (!msgsByConv.has(m.conversation_id)) {
        msgsByConv.set(m.conversation_id, []);
      }
      msgsByConv.get(m.conversation_id)!.push(m);
    }

    // 2. Compute First Response Times & Resolution Times
    const frtValues: number[] = [];
    const resValues: number[] = [];
    const csatValues: number[] = [];

    // Per-agent metrics map
    const agentMetrics = new Map<
      string,
      {
        handled: number;
        resolved: number;
        frtList: number[];
        resList: number[];
        csatList: number[];
      }
    >();

    for (const a of agentList) {
      agentMetrics.set(a.id, {
        handled: 0,
        resolved: 0,
        frtList: [],
        resList: [],
        csatList: [],
      });
    }

    for (const c of convList) {
      const convMsgs = msgsByConv.get(c.id) || [];
      const humanMsgs = convMsgs.filter(
        (m) => m.sender_type === 'agent' && !m.is_internal && m.sender_id
      );

      // Distinct human agents who actively sent replies in this conversation
      const respondingAgentIds = new Set<string>();
      for (const hm of humanMsgs) {
        if (hm.sender_id) respondingAgentIds.add(hm.sender_id);
      }

      // If no human reply has been sent yet, fall back to assigned_agent_id
      const handlingAgentIds = new Set<string>(respondingAgentIds);
      if (handlingAgentIds.size === 0 && c.assigned_agent_id) {
        handlingAgentIds.add(c.assigned_agent_id);
      }

      // 1. Handled Count: attribute to each agent who worked on / replied in this conversation
      for (const agentId of handlingAgentIds) {
        if (!agentMetrics.has(agentId)) {
          agentMetrics.set(agentId, {
            handled: 0,
            resolved: 0,
            frtList: [],
            resList: [],
            csatList: [],
          });
        }
        agentMetrics.get(agentId)!.handled += 1;
      }

      // 2. First Response Time (FRT)
      if (convMsgs.length > 1) {
        const firstVisitorMsg = convMsgs.find((m) => m.sender_type === 'visitor');
        if (firstVisitorMsg) {
          // Overall workspace FRT: first agent or AI message after visitor message
          const firstAnyAgentMsg = convMsgs.find(
            (m) =>
              (m.sender_type === 'agent' || m.sender_type === 'ai') &&
              !m.is_internal &&
              new Date(m.created_at) >= new Date(firstVisitorMsg.created_at)
          );

          if (firstAnyAgentMsg) {
            const frtSeconds =
              (new Date(firstAnyAgentMsg.created_at).getTime() -
                new Date(firstVisitorMsg.created_at).getTime()) /
              1000;
            if (frtSeconds >= 0 && frtSeconds < 7 * 24 * 3600) {
              frtValues.push(frtSeconds);
            }
          }

          // Per-agent FRT: calculated from the human agent who sent the first human reply!
          const firstHumanReply = convMsgs.find(
            (m) =>
              m.sender_type === 'agent' &&
              !m.is_internal &&
              new Date(m.created_at) >= new Date(firstVisitorMsg.created_at)
          );

          if (firstHumanReply) {
            const agentFrtSeconds =
              (new Date(firstHumanReply.created_at).getTime() -
                new Date(firstVisitorMsg.created_at).getTime()) /
              1000;
            if (agentFrtSeconds >= 0 && agentFrtSeconds < 7 * 24 * 3600) {
              const responderId = firstHumanReply.sender_id || c.assigned_agent_id;
              if (responderId) {
                if (!agentMetrics.has(responderId)) {
                  agentMetrics.set(responderId, {
                    handled: 0,
                    resolved: 0,
                    frtList: [],
                    resList: [],
                    csatList: [],
                  });
                }
                agentMetrics.get(responderId)!.frtList.push(agentFrtSeconds);
              }
            }
          }
        }
      }

      // 3. Resolution Time & CSAT
      const lastHumanMsg = [...humanMsgs].reverse()[0];
      const primaryAgentId = lastHumanMsg?.sender_id || c.assigned_agent_id;

      // CSAT
      if (c.csat_rating && c.csat_rating >= 1 && c.csat_rating <= 5) {
        csatValues.push(c.csat_rating);
        if (primaryAgentId) {
          if (!agentMetrics.has(primaryAgentId)) {
            agentMetrics.set(primaryAgentId, {
              handled: 0,
              resolved: 0,
              frtList: [],
              resList: [],
              csatList: [],
            });
          }
          agentMetrics.get(primaryAgentId)!.csatList.push(c.csat_rating);
        }
      }

      // Resolution Time
      if (c.status === 'closed' && c.closed_at) {
        const resSeconds = (new Date(c.closed_at).getTime() - new Date(c.created_at).getTime()) / 1000;
        if (resSeconds > 0 && resSeconds < 30 * 24 * 3600) {
          resValues.push(resSeconds);
          if (primaryAgentId) {
            if (!agentMetrics.has(primaryAgentId)) {
              agentMetrics.set(primaryAgentId, {
                handled: 0,
                resolved: 0,
                frtList: [],
                resList: [],
                csatList: [],
              });
            }
            const aMetric = agentMetrics.get(primaryAgentId)!;
            aMetric.resolved += 1;
            aMetric.resList.push(resSeconds);
          }
        }
      }
    }

    // Averages.
    //
    // These return null, never a placeholder. Earlier revisions fell back to
    // "benchmark" figures (84s, 18m, 4.8 stars, 95% positive) when there was
    // nothing to measure, so a workspace with zero ratings still displayed a
    // healthy-looking CSAT. A reporting screen that invents numbers is worse
    // than one that admits it has none.
    const avgFrt =
      frtValues.length > 0
        ? Math.round(frtValues.reduce((a, b) => a + b, 0) / frtValues.length)
        : null;

    const avgResolution =
      resValues.length > 0
        ? Math.round(resValues.reduce((a, b) => a + b, 0) / resValues.length)
        : null;

    const avgCsat =
      csatValues.length > 0
        ? Number((csatValues.reduce((a, b) => a + b, 0) / csatValues.length).toFixed(1))
        : null;

    const positiveCsatCount = csatValues.filter((v) => v >= 4).length;
    const positiveCsatPercent =
      csatValues.length > 0
        ? Math.round((positiveCsatCount / csatValues.length) * 100)
        : null;

    // Volume comparison
    const totalCurrent = convList.length;
    const totalPrev = prevConvList.length;
    // null when there is nothing to compare against. Going from zero
    // conversations to six is not "+100%" — it is the first period with any
    // data at all, and reporting a percentage there invents a baseline.
    const volumeChangePercent =
      totalPrev > 0
        ? Number((((totalCurrent - totalPrev) / totalPrev) * 100).toFixed(1))
        : null;

    // 3. Status Breakdown
    const statusCounts = {
      open: convList.filter((c) => c.status === 'open').length,
      closed: convList.filter((c) => c.status === 'closed').length,
      snoozed: convList.filter((c) => c.status === 'snoozed').length,
    };

    const statusBreakdown = [
      { name: 'Open', value: statusCounts.open, color: '#2563eb' },
      { name: 'Resolved', value: statusCounts.closed, color: '#10b981' },
      { name: 'Snoozed', value: statusCounts.snoozed, color: '#f59e0b' },
    ];

    // 4. Timeline Aggregation (Daily / Weekly / Monthly)
    const timelineMap = new Map<
      string,
      { date: string; conversations: number; resolved: number; csatScores: number[] }
    >();

    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      let key = d.toISOString().split('T')[0];
      let displayLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      if (granularity === 'weekly') {
        // Round to Monday
        const dayOfWeek = d.getDay();
        const diff = d.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        const monday = new Date(d.setDate(diff));
        key = monday.toISOString().split('T')[0];
        displayLabel = `Wk ${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      } else if (granularity === 'monthly') {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        displayLabel = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      }

      if (!timelineMap.has(key)) {
        timelineMap.set(key, {
          date: displayLabel,
          conversations: 0,
          resolved: 0,
          csatScores: [],
        });
      }
    }

    for (const c of convList) {
      const cDate = new Date(c.created_at);
      let key = cDate.toISOString().split('T')[0];

      if (granularity === 'weekly') {
        const dayOfWeek = cDate.getDay();
        const diff = cDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        const monday = new Date(cDate.setDate(diff));
        key = monday.toISOString().split('T')[0];
      } else if (granularity === 'monthly') {
        key = `${cDate.getFullYear()}-${String(cDate.getMonth() + 1).padStart(2, '0')}`;
      }

      const item = timelineMap.get(key);
      if (item) {
        item.conversations += 1;
        if (c.status === 'closed') item.resolved += 1;
        if (c.csat_rating) item.csatScores.push(c.csat_rating);
      }
    }

    const timelineData = Array.from(timelineMap.values()).map((t) => {
      // null, so the trend line breaks on days with no ratings instead of
      // drawing a flat invented 4.8 across an empty month.
      const avgDayCsat =
        t.csatScores.length > 0
          ? Number((t.csatScores.reduce((a, b) => a + b, 0) / t.csatScores.length).toFixed(1))
          : null;
      return {
        date: t.date,
        total: t.conversations,
        resolved: t.resolved,
        csat: avgDayCsat,
      };
    });

    // 5. Per-Agent Performance Table
    const perAgentPerformance = agentList.map((agent) => {
      const m = agentMetrics.get(agent.id) || {
        handled: 0,
        resolved: 0,
        frtList: [],
        resList: [],
        csatList: [],
      };

      // Same rule as the workspace summary: an agent who has handled nothing
      // reports nothing, rather than a flattering 65s / 4.9 stars / 100%.
      const agentAvgFrt =
        m.frtList.length > 0
          ? Math.round(m.frtList.reduce((a, b) => a + b, 0) / m.frtList.length)
          : null;

      const agentAvgRes =
        m.resList.length > 0
          ? Math.round(m.resList.reduce((a, b) => a + b, 0) / m.resList.length)
          : null;

      const agentAvgCsat =
        m.csatList.length > 0
          ? Number((m.csatList.reduce((a, b) => a + b, 0) / m.csatList.length).toFixed(1))
          : null;

      const resolutionRate =
        m.handled > 0 ? Math.round((m.resolved / m.handled) * 100) : null;

      return {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        status: agent.status,
        role: agent.role,
        handled: m.handled,
        resolved: m.resolved,
        resolutionRate,
        avgFrt: agentAvgFrt,
        avgResolution: agentAvgRes,
        csatScore: agentAvgCsat,
        csatCount: m.csatList.length,
      };
    });

    // Sort by handled conversations descending
    perAgentPerformance.sort((a, b) => b.handled - a.handled);

    return NextResponse.json({
      summary: {
        totalConversations: totalCurrent,
        volumeChangePercent,
        avgFirstResponseSeconds: avgFrt,
        avgResolutionSeconds: avgResolution,
        avgCsat,
        positiveCsatPercent,
        totalCsatRatings: csatValues.length,
      },
      statusBreakdown,
      timelineData,
      perAgentPerformance,
    });
  } catch (error: any) {
    console.error('[Analytics API Error]:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to aggregate analytics' },
      { status: 500 }
    );
  }
}
