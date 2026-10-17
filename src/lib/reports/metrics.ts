/**
 * Metrics calculation engine for reports and analytics.
 * Computes all metrics from stored events (reporting_events, sla_events)
 * without scanning historical tickets on every page load.
 */

import type { ReportingEvent, ReportingEventType } from '@/types/database';

export interface SlaEventItem {
  id?: number | string;
  metric: 'first_reply' | 'next_reply' | 'resolution' | string;
  event: 'met' | 'breached' | 'warning' | string;
  target_minutes?: number;
  occurred_at: string;
  assignee_id?: string | null;
  group_id?: string | null;
  late?: boolean;
}

export interface MetricFilterOptions {
  groupId?: string | null;
  agentId?: string | null;
  channel?: string | null;
}

export interface DateBucket {
  key: string;       // YYYY-MM-DD
  label: string;     // e.g. "Oct 12"
  start: Date;
  end: Date;
}

export interface CreatedVsSolvedPoint {
  date: string;
  label: string;
  created: number;
  solved: number;
}

export interface BacklogPoint {
  date: string;
  label: string;
  backlog: number;
}

export interface BreakdownItem {
  key: string;
  label: string;
  count: number;
  percentage: number;
}

export interface HeatmapCell {
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  dayName: string;   // 'Sun', 'Mon', etc.
  hour: number;      // 0 - 23
  count: number;
}

export interface AgentLeaderboardRow {
  agentId: string;
  name: string;
  email: string;
  role: string;
  avatarUrl?: string | null;
  solvedCount: number;
  avgFrtSeconds: number | null;
  medianFrtSeconds: number | null;
  avgResolutionSeconds: number | null;
  medianResolutionSeconds: number | null;
  csatGood: number;
  csatBad: number;
  totalCsat: number;
  csatPercent: number | null; // e.g. 95.0
}

export interface CsatFeedbackItem {
  ticketId: string | null;
  rating: 'good' | 'bad';
  comment: string | null;
  occurredAt: string;
  agentId?: string | null;
  channel?: string | null;
}

export interface ReportsSummary {
  totalCreated: number;
  totalSolved: number;
  resolutionRatePercent: number | null;
  initialBacklog: number;
  finalBacklog: number;
  netBacklogChange: number;

  avgFrtSeconds: number | null;
  medianFrtSeconds: number | null;
  avgResolutionSeconds: number | null;
  medianResolutionSeconds: number | null;

  totalSlaMet: number;
  totalSlaBreached: number;
  overallSlaPercent: number | null;
  firstReplySlaPercent: number | null;
  nextReplySlaPercent: number | null;
  resolutionSlaPercent: number | null;

  totalCsatRatings: number;
  goodCsatRatings: number;
  badCsatRatings: number;
  csatPercent: number | null;
  csatResponseRatePercent: number | null;

  botResolvedCount: number;
  botHandoverCount: number;
  totalBotInquiries: number;
  botResolutionRatePercent: number | null;
}

export interface ReportsDashboardData {
  summary: ReportsSummary;
  createdVsSolved: CreatedVsSolvedPoint[];
  backlogOverTime: BacklogPoint[];
  channelBreakdown: BreakdownItem[];
  priorityBreakdown: BreakdownItem[];
  tagBreakdown: BreakdownItem[];
  heatmap: HeatmapCell[];
  peakHour: { dayName: string; hour: number; label: string; count: number } | null;
  leaderboard: AgentLeaderboardRow[];
  recentFeedback: CsatFeedbackItem[];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/* ── Math & Stat Helpers ──────────────────────────────────────────────── */

/** Computes the median of an array of numbers. Returns null if empty. */
export function calculateMedian(values: number[]): number | null {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

/** Computes the arithmetic mean. Returns null if empty. */
export function calculateAverage(values: number[]): number | null {
  if (!values || values.length === 0) return null;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return Math.round(sum / values.length);
}

/** Formats duration into human-readable SaaS format (e.g. 15m, 2h 30m, 1d 4h). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '—';
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return `${seconds}s`;

  const mins = Math.floor(seconds / 60);
  if (mins < 60) {
    const remSecs = seconds % 60;
    return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
  }

  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) {
    return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

/** Generates daily buckets between start and end dates in UTC. */
export function generateDateBuckets(startDate: Date, endDate: Date): DateBucket[] {
  const buckets: DateBucket[] = [];
  const current = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));

  while (current <= end) {
    const key = current.toISOString().slice(0, 10);
    const month = current.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const day = current.getUTCDate();
    buckets.push({
      key,
      label: `${month} ${day}`,
      start: new Date(current),
      end: new Date(current.getTime() + 24 * 60 * 60 * 1000 - 1),
    });
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return buckets;
}

/* ── Event Filtering ──────────────────────────────────────────────────── */

export function filterReportingEvents(
  events: ReportingEvent[],
  filters: MetricFilterOptions
): ReportingEvent[] {
  return events.filter((e) => {
    if (filters.groupId && e.group_id !== filters.groupId) return false;
    if (filters.agentId && e.agent_id !== filters.agentId) return false;
    if (filters.channel && e.channel !== filters.channel) return false;
    return true;
  });
}

export function filterSlaEvents(
  events: SlaEventItem[],
  filters: MetricFilterOptions
): SlaEventItem[] {
  return events.filter((e) => {
    if (filters.groupId && e.group_id !== filters.groupId) return false;
    if (filters.agentId && e.assignee_id !== filters.agentId) return false;
    return true;
  });
}

/* ── Metric Calculations ──────────────────────────────────────────────── */

/** 1. Created vs Solved timeline */
export function calculateCreatedVsSolved(
  events: ReportingEvent[],
  buckets: DateBucket[]
): CreatedVsSolvedPoint[] {
  const pointMap = new Map<string, { created: number; solved: number }>();
  for (const b of buckets) {
    pointMap.set(b.key, { created: 0, solved: 0 });
  }

  for (const e of events) {
    const dayKey = e.occurred_at.slice(0, 10);
    const pt = pointMap.get(dayKey);
    if (!pt) continue;

    if (e.event_type === 'ticket_created') {
      pt.created += 1;
    } else if (e.event_type === 'ticket_solved') {
      pt.solved += 1;
    }
  }

  return buckets.map((b) => {
    const pt = pointMap.get(b.key)!;
    return {
      date: b.key,
      label: b.label,
      created: pt.created,
      solved: pt.solved,
    };
  });
}

/** 2. Backlog over time */
export function calculateBacklogOverTime(
  initialBacklog: number,
  events: ReportingEvent[],
  buckets: DateBucket[]
): BacklogPoint[] {
  const dayDelta = new Map<string, number>();
  for (const b of buckets) {
    dayDelta.set(b.key, 0);
  }

  for (const e of events) {
    const dayKey = e.occurred_at.slice(0, 10);
    if (!dayDelta.has(dayKey)) continue;

    if (e.event_type === 'ticket_created') {
      dayDelta.set(dayKey, dayDelta.get(dayKey)! + 1);
    } else if (e.event_type === 'ticket_solved') {
      dayDelta.set(dayKey, dayDelta.get(dayKey)! - 1);
    } else if (e.event_type === 'ticket_reopened') {
      dayDelta.set(dayKey, dayDelta.get(dayKey)! + 1);
    }
  }

  let running = Math.max(0, initialBacklog);
  return buckets.map((b) => {
    running = Math.max(0, running + (dayDelta.get(b.key) || 0));
    return {
      date: b.key,
      label: b.label,
      backlog: running,
    };
  });
}

/** 3. First Reply Time & Resolution Time (Median and Average) */
export function calculateResponseTimes(events: ReportingEvent[]): {
  avgFrtSeconds: number | null;
  medianFrtSeconds: number | null;
  avgResolutionSeconds: number | null;
  medianResolutionSeconds: number | null;
} {
  const frtList: number[] = [];
  const resList: number[] = [];

  for (const e of events) {
    if (e.event_type === 'first_reply' && typeof e.duration_seconds === 'number') {
      frtList.push(e.duration_seconds);
    } else if (e.event_type === 'ticket_solved' && typeof e.duration_seconds === 'number') {
      resList.push(e.duration_seconds);
    }
  }

  return {
    avgFrtSeconds: calculateAverage(frtList),
    medianFrtSeconds: calculateMedian(frtList),
    avgResolutionSeconds: calculateAverage(resList),
    medianResolutionSeconds: calculateMedian(resList),
  };
}

/** 4. SLA achievement % */
export function calculateSlaAchievement(slaEvents: SlaEventItem[]): {
  totalMet: number;
  totalBreached: number;
  overallPercent: number | null;
  firstReplyPercent: number | null;
  nextReplyPercent: number | null;
  resolutionPercent: number | null;
} {
  let metTotal = 0;
  let breachedTotal = 0;

  const metricCounts: Record<string, { met: number; breached: number }> = {
    first_reply: { met: 0, breached: 0 },
    next_reply: { met: 0, breached: 0 },
    resolution: { met: 0, breached: 0 },
  };

  for (const e of slaEvents) {
    if (e.event === 'met') {
      metTotal += 1;
      if (metricCounts[e.metric]) metricCounts[e.metric].met += 1;
    } else if (e.event === 'breached') {
      breachedTotal += 1;
      if (metricCounts[e.metric]) metricCounts[e.metric].breached += 1;
    }
  }

  const calcPct = (met: number, breached: number): number | null => {
    const total = met + breached;
    if (total === 0) return null;
    return Number(((met / total) * 100).toFixed(1));
  };

  return {
    totalMet: metTotal,
    totalBreached: breachedTotal,
    overallPercent: calcPct(metTotal, breachedTotal),
    firstReplyPercent: calcPct(metricCounts.first_reply.met, metricCounts.first_reply.breached),
    nextReplyPercent: calcPct(metricCounts.next_reply.met, metricCounts.next_reply.breached),
    resolutionPercent: calcPct(metricCounts.resolution.met, metricCounts.resolution.breached),
  };
}

/** 5. CSAT % */
export function calculateCsatMetrics(
  events: ReportingEvent[],
  totalSolved: number
): {
  totalRatings: number;
  goodRatings: number;
  badRatings: number;
  csatPercent: number | null;
  responseRatePercent: number | null;
  recentFeedback: CsatFeedbackItem[];
} {
  let good = 0;
  let bad = 0;
  const feedbackList: CsatFeedbackItem[] = [];

  for (const e of events) {
    if (e.event_type === 'csat_rated' && e.csat_rating) {
      if (e.csat_rating === 'good') good += 1;
      else if (e.csat_rating === 'bad') bad += 1;

      feedbackList.push({
        ticketId: e.ticket_id,
        rating: e.csat_rating,
        comment: e.csat_comment,
        occurredAt: e.occurred_at,
        agentId: e.agent_id,
        channel: e.channel,
      });
    }
  }

  const total = good + bad;
  const csatPercent = total > 0 ? Number(((good / total) * 100).toFixed(1)) : null;
  const responseRate = totalSolved > 0 ? Number(((total / totalSolved) * 100).toFixed(1)) : null;

  // Sort feedback descending by timestamp
  feedbackList.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

  return {
    totalRatings: total,
    goodRatings: good,
    badRatings: bad,
    csatPercent,
    responseRatePercent: responseRate,
    recentFeedback: feedbackList.slice(0, 20),
  };
}

/** 6. Breakdowns by Channel, Priority, Tag */
export function calculateBreakdowns(events: ReportingEvent[]): {
  channelBreakdown: BreakdownItem[];
  priorityBreakdown: BreakdownItem[];
  tagBreakdown: BreakdownItem[];
} {
  const channelMap = new Map<string, number>();
  const priorityMap = new Map<string, number>();
  const tagMap = new Map<string, number>();

  let totalTickets = 0;

  for (const e of events) {
    if (e.event_type === 'ticket_created') {
      totalTickets += 1;
      const ch = e.channel || 'chat';
      channelMap.set(ch, (channelMap.get(ch) || 0) + 1);

      const pr = e.priority || 'normal';
      priorityMap.set(pr, (priorityMap.get(pr) || 0) + 1);

      if (Array.isArray(e.tags)) {
        for (const t of e.tags) {
          if (t && typeof t === 'string') {
            const clean = t.trim().toLowerCase();
            if (clean) tagMap.set(clean, (tagMap.get(clean) || 0) + 1);
          }
        }
      }
    }
  }

  const toBreakdown = (map: Map<string, number>): BreakdownItem[] => {
    return Array.from(map.entries())
      .map(([key, count]) => ({
        key,
        label: key.charAt(0).toUpperCase() + key.slice(1).replace('_', ' '),
        count,
        percentage: totalTickets > 0 ? Number(((count / totalTickets) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  };

  return {
    channelBreakdown: toBreakdown(channelMap),
    priorityBreakdown: toBreakdown(priorityMap),
    tagBreakdown: toBreakdown(tagMap).slice(0, 10),
  };
}

/** 7. Busiest hours heatmap (7 days of week × 24 hours) */
export function calculateBusiestHoursHeatmap(events: ReportingEvent[]): {
  heatmap: HeatmapCell[];
  peakHour: { dayName: string; hour: number; label: string; count: number } | null;
} {
  // Matrix grid 7 x 24
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

  for (const e of events) {
    if (e.event_type === 'ticket_created') {
      const d = new Date(e.occurred_at);
      const day = d.getUTCDay(); // 0..6
      const hour = d.getUTCHours(); // 0..23
      if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
        grid[day][hour] += 1;
      }
    }
  }

  const cells: HeatmapCell[] = [];
  let maxCount = -1;
  let peak: { dayName: string; hour: number; label: string; count: number } | null = null;

  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const count = grid[day][hour];
      cells.push({
        dayOfWeek: day,
        dayName: DAY_NAMES[day],
        hour,
        count,
      });

      if (count > maxCount && count > 0) {
        maxCount = count;
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const displayHour = hour % 12 === 0 ? 12 : hour % 12;
        peak = {
          dayName: DAY_NAMES[day],
          hour,
          label: `${DAY_NAMES[day]} at ${displayHour}:00 ${ampm}`,
          count,
        };
      }
    }
  }

  return { heatmap: cells, peakHour: peak };
}

/** 8. AI Bot Resolved vs Handed to Human */
export function calculateBotMetrics(events: ReportingEvent[]): {
  botResolvedCount: number;
  botHandoverCount: number;
  totalBotInquiries: number;
  botResolutionRatePercent: number | null;
} {
  let resolved = 0;
  let handedOver = 0;

  for (const e of events) {
    if (e.event_type === 'bot_resolved') resolved += 1;
    else if (e.event_type === 'bot_handover') handedOver += 1;
  }

  const total = resolved + handedOver;
  const rate = total > 0 ? Number(((resolved / total) * 100).toFixed(1)) : null;

  return {
    botResolvedCount: resolved,
    botHandoverCount: handedOver,
    totalBotInquiries: total,
    botResolutionRatePercent: rate,
  };
}

/** 9. Agent Leaderboard */
export function calculateAgentLeaderboard(
  events: ReportingEvent[],
  agents: Array<{ id: string; name: string; email: string; role: string; avatar_url?: string | null }>
): AgentLeaderboardRow[] {
  const map = new Map<
    string,
    {
      solvedCount: number;
      frtList: number[];
      resList: number[];
      good: number;
      bad: number;
    }
  >();

  for (const a of agents) {
    map.set(a.id, {
      solvedCount: 0,
      frtList: [],
      resList: [],
      good: 0,
      bad: 0,
    });
  }

  for (const e of events) {
    if (!e.agent_id || !map.has(e.agent_id)) continue;
    const item = map.get(e.agent_id)!;

    if (e.event_type === 'ticket_solved') {
      item.solvedCount += 1;
      if (typeof e.duration_seconds === 'number') {
        item.resList.push(e.duration_seconds);
      }
    } else if (e.event_type === 'first_reply') {
      if (typeof e.duration_seconds === 'number') {
        item.frtList.push(e.duration_seconds);
      }
    } else if (e.event_type === 'csat_rated') {
      if (e.csat_rating === 'good') item.good += 1;
      else if (e.csat_rating === 'bad') item.bad += 1;
    }
  }

  return agents
    .map((a) => {
      const stats = map.get(a.id)!;
      const totalCsat = stats.good + stats.bad;
      const csatPercent = totalCsat > 0 ? Number(((stats.good / totalCsat) * 100).toFixed(1)) : null;

      return {
        agentId: a.id,
        name: a.name || 'Unnamed Agent',
        email: a.email,
        role: a.role,
        avatarUrl: a.avatar_url,
        solvedCount: stats.solvedCount,
        avgFrtSeconds: calculateAverage(stats.frtList),
        medianFrtSeconds: calculateMedian(stats.frtList),
        avgResolutionSeconds: calculateAverage(stats.resList),
        medianResolutionSeconds: calculateMedian(stats.resList),
        csatGood: stats.good,
        csatBad: stats.bad,
        totalCsat,
        csatPercent,
      };
    })
    .sort((a, b) => b.solvedCount - a.solvedCount);
}

/** Master calculation function */
export function calculateReportsDashboard(
  events: ReportingEvent[],
  slaEvents: SlaEventItem[],
  agents: Array<{ id: string; name: string; email: string; role: string; avatar_url?: string | null }>,
  initialBacklog: number,
  startDate: Date,
  endDate: Date,
  filters: MetricFilterOptions = {}
): ReportsDashboardData {
  const filteredEvents = filterReportingEvents(events, filters);
  const filteredSla = filterSlaEvents(slaEvents, filters);
  const buckets = generateDateBuckets(startDate, endDate);

  const createdVsSolved = calculateCreatedVsSolved(filteredEvents, buckets);
  const backlogOverTime = calculateBacklogOverTime(initialBacklog, filteredEvents, buckets);
  const responseTimes = calculateResponseTimes(filteredEvents);
  const slaAchievement = calculateSlaAchievement(filteredSla);

  let totalCreated = 0;
  let totalSolved = 0;
  for (const e of filteredEvents) {
    if (e.event_type === 'ticket_created') totalCreated += 1;
    else if (e.event_type === 'ticket_solved') totalSolved += 1;
  }

  const csat = calculateCsatMetrics(filteredEvents, totalSolved);
  const breakdowns = calculateBreakdowns(filteredEvents);
  const heatmapResult = calculateBusiestHoursHeatmap(filteredEvents);
  const botMetrics = calculateBotMetrics(filteredEvents);
  const leaderboard = calculateAgentLeaderboard(filteredEvents, agents);

  const finalBacklog = backlogOverTime.length > 0 ? backlogOverTime[backlogOverTime.length - 1].backlog : initialBacklog;

  const summary: ReportsSummary = {
    totalCreated,
    totalSolved,
    resolutionRatePercent: totalCreated > 0 ? Number(((totalSolved / totalCreated) * 100).toFixed(1)) : null,
    initialBacklog,
    finalBacklog,
    netBacklogChange: finalBacklog - initialBacklog,
    avgFrtSeconds: responseTimes.avgFrtSeconds,
    medianFrtSeconds: responseTimes.medianFrtSeconds,
    avgResolutionSeconds: responseTimes.avgResolutionSeconds,
    medianResolutionSeconds: responseTimes.medianResolutionSeconds,
    totalSlaMet: slaAchievement.totalMet,
    totalSlaBreached: slaAchievement.totalBreached,
    overallSlaPercent: slaAchievement.overallPercent,
    firstReplySlaPercent: slaAchievement.firstReplyPercent,
    nextReplySlaPercent: slaAchievement.nextReplyPercent,
    resolutionSlaPercent: slaAchievement.resolutionPercent,
    totalCsatRatings: csat.totalRatings,
    goodCsatRatings: csat.goodRatings,
    badCsatRatings: csat.badRatings,
    csatPercent: csat.csatPercent,
    csatResponseRatePercent: csat.responseRatePercent,
    botResolvedCount: botMetrics.botResolvedCount,
    botHandoverCount: botMetrics.botHandoverCount,
    totalBotInquiries: botMetrics.totalBotInquiries,
    botResolutionRatePercent: botMetrics.botResolutionRatePercent,
  };

  return {
    summary,
    createdVsSolved,
    backlogOverTime,
    channelBreakdown: breakdowns.channelBreakdown,
    priorityBreakdown: breakdowns.priorityBreakdown,
    tagBreakdown: breakdowns.tagBreakdown,
    heatmap: heatmapResult.heatmap,
    peakHour: heatmapResult.peakHour,
    leaderboard,
    recentFeedback: csat.recentFeedback,
  };
}

/* ── CSV Export Generators ────────────────────────────────────────────── */

export function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportCreatedVsSolvedCsv(data: CreatedVsSolvedPoint[]): string {
  const headers = ['Date', 'Tickets Created', 'Tickets Solved'];
  const rows = data.map((pt) => [escapeCsv(pt.date), escapeCsv(pt.created), escapeCsv(pt.solved)].join(','));
  return [headers.join(','), ...rows].join('\n');
}

export function exportBacklogCsv(data: BacklogPoint[]): string {
  const headers = ['Date', 'Active Backlog'];
  const rows = data.map((pt) => [escapeCsv(pt.date), escapeCsv(pt.backlog)].join(','));
  return [headers.join(','), ...rows].join('\n');
}

export function exportAgentLeaderboardCsv(data: AgentLeaderboardRow[]): string {
  const headers = [
    'Agent Name',
    'Email',
    'Role',
    'Solved Tickets',
    'Avg First Reply Time',
    'Median First Reply Time',
    'Avg Resolution Time',
    'Median Resolution Time',
    'Good CSAT',
    'Bad CSAT',
    'Total Ratings',
    'CSAT %',
  ];
  const rows = data.map((r) =>
    [
      escapeCsv(r.name),
      escapeCsv(r.email),
      escapeCsv(r.role),
      escapeCsv(r.solvedCount),
      escapeCsv(formatDuration(r.avgFrtSeconds)),
      escapeCsv(formatDuration(r.medianFrtSeconds)),
      escapeCsv(formatDuration(r.avgResolutionSeconds)),
      escapeCsv(formatDuration(r.medianResolutionSeconds)),
      escapeCsv(r.csatGood),
      escapeCsv(r.csatBad),
      escapeCsv(r.totalCsat),
      escapeCsv(r.csatPercent !== null ? `${r.csatPercent}%` : '—'),
    ].join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

export function exportBreakdownsCsv(
  channels: BreakdownItem[],
  priorities: BreakdownItem[],
  tags: BreakdownItem[]
): string {
  const lines = ['Dimension,Key,Count,Percentage'];
  for (const c of channels) {
    lines.push(`Channel,${escapeCsv(c.label)},${escapeCsv(c.count)},${escapeCsv(c.percentage)}%`);
  }
  for (const p of priorities) {
    lines.push(`Priority,${escapeCsv(p.label)},${escapeCsv(p.count)},${escapeCsv(p.percentage)}%`);
  }
  for (const t of tags) {
    lines.push(`Tag,${escapeCsv(t.label)},${escapeCsv(t.count)},${escapeCsv(t.percentage)}%`);
  }
  return lines.join('\n');
}

export function exportHeatmapCsv(heatmap: HeatmapCell[]): string {
  const headers = ['Day of Week', 'Hour of Day (UTC)', 'Tickets Created'];
  const rows = heatmap.map((c) => [escapeCsv(c.dayName), escapeCsv(c.hour), escapeCsv(c.count)].join(','));
  return [headers.join(','), ...rows].join('\n');
}

export function exportSummaryOverviewCsv(summary: ReportsSummary): string {
  const rows = [
    ['Metric', 'Value'],
    ['Tickets Created', summary.totalCreated],
    ['Tickets Solved', summary.totalSolved],
    ['Resolution Rate %', summary.resolutionRatePercent !== null ? `${summary.resolutionRatePercent}%` : '—'],
    ['Initial Backlog', summary.initialBacklog],
    ['Final Backlog', summary.finalBacklog],
    ['Net Backlog Change', summary.netBacklogChange],
    ['Avg First Reply Time', formatDuration(summary.avgFrtSeconds)],
    ['Median First Reply Time', formatDuration(summary.medianFrtSeconds)],
    ['Avg Resolution Time', formatDuration(summary.avgResolutionSeconds)],
    ['Median Resolution Time', formatDuration(summary.medianResolutionSeconds)],
    ['SLA Achievement %', summary.overallSlaPercent !== null ? `${summary.overallSlaPercent}%` : '—'],
    ['First Reply SLA %', summary.firstReplySlaPercent !== null ? `${summary.firstReplySlaPercent}%` : '—'],
    ['Resolution SLA %', summary.resolutionSlaPercent !== null ? `${summary.resolutionSlaPercent}%` : '—'],
    ['CSAT Satisfaction %', summary.csatPercent !== null ? `${summary.csatPercent}%` : '—'],
    ['Total CSAT Ratings', summary.totalCsatRatings],
    ['Good CSAT Ratings', summary.goodCsatRatings],
    ['Bad CSAT Ratings', summary.badCsatRatings],
    ['CSAT Response Rate %', summary.csatResponseRatePercent !== null ? `${summary.csatResponseRatePercent}%` : '—'],
    ['Bot Resolved Count', summary.botResolvedCount],
    ['Bot Handed to Human Count', summary.botHandoverCount],
    ['Bot Resolution %', summary.botResolutionRatePercent !== null ? `${summary.botResolutionRatePercent}%` : '—'],
  ];
  return rows.map((r) => r.map(escapeCsv).join(',')).join('\n');
}
