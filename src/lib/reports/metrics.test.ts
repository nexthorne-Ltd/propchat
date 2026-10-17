import { describe, it, expect } from 'vitest';
import {
  calculateMedian,
  calculateAverage,
  formatDuration,
  generateDateBuckets,
  calculateCreatedVsSolved,
  calculateBacklogOverTime,
  calculateResponseTimes,
  calculateSlaAchievement,
  calculateCsatMetrics,
  calculateBreakdowns,
  calculateBusiestHoursHeatmap,
  calculateBotMetrics,
  calculateAgentLeaderboard,
  filterReportingEvents,
  escapeCsv,
  exportCreatedVsSolvedCsv,
  exportBacklogCsv,
  exportAgentLeaderboardCsv,
  exportSummaryOverviewCsv,
  type SlaEventItem,
} from './metrics';
import type { ReportingEvent } from '@/types/database';

describe('Reports & CSAT Metrics Calculations', () => {
  describe('calculateMedian', () => {
    it('returns null for empty array', () => {
      expect(calculateMedian([])).toBeNull();
    });

    it('returns the element for single item array', () => {
      expect(calculateMedian([42])).toBe(42);
    });

    it('returns middle element for odd length arrays', () => {
      expect(calculateMedian([10, 5, 20])).toBe(10);
      expect(calculateMedian([1, 2, 3, 4, 5])).toBe(3);
    });

    it('returns rounded average of two middle elements for even length arrays', () => {
      expect(calculateMedian([10, 20, 30, 40])).toBe(25);
      expect(calculateMedian([10, 20])).toBe(15);
      expect(calculateMedian([10, 11])).toBe(11); // (10+11)/2 = 10.5 -> 11
    });

    it('correctly handles unsorted inputs', () => {
      expect(calculateMedian([50, 10, 30, 20, 40])).toBe(30);
    });
  });

  describe('calculateAverage', () => {
    it('returns null for empty array', () => {
      expect(calculateAverage([])).toBeNull();
    });

    it('returns rounded arithmetic mean', () => {
      expect(calculateAverage([10, 20, 30])).toBe(20);
      expect(calculateAverage([10, 20])).toBe(15);
      expect(calculateAverage([10, 11])).toBe(11);
    });
  });

  describe('formatDuration', () => {
    it('formats null and undefined as em dash', () => {
      expect(formatDuration(null)).toBe('—');
      expect(formatDuration(undefined)).toBe('—');
    });

    it('formats seconds', () => {
      expect(formatDuration(45)).toBe('45s');
      expect(formatDuration(0)).toBe('0s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(120)).toBe('2m');
      expect(formatDuration(135)).toBe('2m 15s');
    });

    it('formats hours and minutes', () => {
      expect(formatDuration(3600)).toBe('1h');
      expect(formatDuration(5400)).toBe('1h 30m');
    });

    it('formats days and hours', () => {
      expect(formatDuration(86400)).toBe('1d');
      expect(formatDuration(97200)).toBe('1d 3h');
    });
  });

  describe('calculateCreatedVsSolved', () => {
    it('aggregates created and solved by day', () => {
      const buckets = generateDateBuckets(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T23:59:59Z'));
      const events: ReportingEvent[] = [
        {
          id: 1,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'ticket_created',
          occurred_at: '2026-10-01T10:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 2,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'ticket_created',
          occurred_at: '2026-10-01T15:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'email',
          priority: 'high',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 3,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'ticket_solved',
          occurred_at: '2026-10-01T18:00:00Z',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 28800,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 4,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'ticket_created',
          occurred_at: '2026-10-02T09:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'low',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
      ];

      const res = calculateCreatedVsSolved(events, buckets);
      expect(res).toHaveLength(2);
      expect(res[0].date).toBe('2026-10-01');
      expect(res[0].created).toBe(2);
      expect(res[0].solved).toBe(1);

      expect(res[1].date).toBe('2026-10-02');
      expect(res[1].created).toBe(1);
      expect(res[1].solved).toBe(0);
    });
  });

  describe('calculateBacklogOverTime', () => {
    it('applies initial backlog and tracks running net backlog change', () => {
      const buckets = generateDateBuckets(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-03T23:59:59Z'));
      const events: ReportingEvent[] = [
        // Day 1: +2 created, -1 solved -> delta +1
        {
          id: 1,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'ticket_created',
          occurred_at: '2026-10-01T10:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 2,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'ticket_created',
          occurred_at: '2026-10-01T12:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 3,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'ticket_solved',
          occurred_at: '2026-10-01T16:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        // Day 2: -2 solved, +1 reopened -> delta -1
        {
          id: 4,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'ticket_solved',
          occurred_at: '2026-10-02T11:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 5,
          workspace_id: 'ws-1',
          ticket_id: 't-4',
          event_type: 'ticket_solved',
          occurred_at: '2026-10-02T13:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 6,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'ticket_reopened',
          occurred_at: '2026-10-02T17:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
      ];

      const initialBacklog = 10;
      const backlog = calculateBacklogOverTime(initialBacklog, events, buckets);

      expect(backlog).toHaveLength(3);
      // Day 1: 10 + 2 - 1 = 11
      expect(backlog[0].backlog).toBe(11);
      // Day 2: 11 - 2 + 1 = 10
      expect(backlog[1].backlog).toBe(10);
      // Day 3: no events -> 10
      expect(backlog[2].backlog).toBe(10);
    });
  });

  describe('calculateResponseTimes', () => {
    it('computes average and median for first reply and resolution durations', () => {
      const events: ReportingEvent[] = [
        {
          id: 1,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'first_reply',
          occurred_at: '2026-10-01T10:00:00Z',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 60, // 1 min
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 2,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'first_reply',
          occurred_at: '2026-10-01T11:00:00Z',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 180, // 3 min
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 3,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'first_reply',
          occurred_at: '2026-10-01T12:00:00Z',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 600, // 10 min
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 4,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'ticket_solved',
          occurred_at: '2026-10-01T14:00:00Z',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 1200, // 20 min
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 5,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'ticket_solved',
          occurred_at: '2026-10-01T16:00:00Z',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 3600, // 60 min
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
      ];

      const res = calculateResponseTimes(events);
      // FRT: 60, 180, 600 -> avg = (60+180+600)/3 = 280, median = 180
      expect(res.avgFrtSeconds).toBe(280);
      expect(res.medianFrtSeconds).toBe(180);

      // Resolution: 1200, 3600 -> avg = 2400, median = 2400
      expect(res.avgResolutionSeconds).toBe(2400);
      expect(res.medianResolutionSeconds).toBe(2400);
    });
  });

  describe('calculateSlaAchievement', () => {
    it('computes overall and per-metric SLA percentages', () => {
      const slaEvents: SlaEventItem[] = [
        { metric: 'first_reply', event: 'met', occurred_at: '2026-10-01' },
        { metric: 'first_reply', event: 'met', occurred_at: '2026-10-01' },
        { metric: 'first_reply', event: 'breached', occurred_at: '2026-10-01' },
        { metric: 'resolution', event: 'met', occurred_at: '2026-10-01' },
        { metric: 'resolution', event: 'breached', occurred_at: '2026-10-01' },
      ];

      const res = calculateSlaAchievement(slaEvents);
      expect(res.totalMet).toBe(3);
      expect(res.totalBreached).toBe(2);
      // Overall: 3 / 5 = 60%
      expect(res.overallPercent).toBe(60.0);
      // First reply: 2 / 3 = 66.7%
      expect(res.firstReplyPercent).toBe(66.7);
      // Resolution: 1 / 2 = 50%
      expect(res.resolutionPercent).toBe(50.0);
    });

    it('handles zero SLA events without error', () => {
      const res = calculateSlaAchievement([]);
      expect(res.totalMet).toBe(0);
      expect(res.totalBreached).toBe(0);
      expect(res.overallPercent).toBeNull();
    });
  });

  describe('calculateCsatMetrics', () => {
    it('computes CSAT %, good/bad counts, and response rate', () => {
      const events: ReportingEvent[] = [
        {
          id: 1,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'csat_rated',
          occurred_at: '2026-10-01T12:00:00Z',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: 'good',
          csat_comment: 'Super fast help!',
          metadata: {},
        },
        {
          id: 2,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'csat_rated',
          occurred_at: '2026-10-01T14:00:00Z',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'email',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: 'good',
          csat_comment: null,
          metadata: {},
        },
        {
          id: 3,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'csat_rated',
          occurred_at: '2026-10-01T16:00:00Z',
          agent_id: 'ag-2',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: 'bad',
          csat_comment: 'Took too long to answer.',
          metadata: {},
        },
      ];

      const res = calculateCsatMetrics(events, 10);
      expect(res.totalRatings).toBe(3);
      expect(res.goodRatings).toBe(2);
      expect(res.badRatings).toBe(1);
      // CSAT % = 2 / 3 = 66.7%
      expect(res.csatPercent).toBe(66.7);
      // Response rate = 3 / 10 = 30%
      expect(res.responseRatePercent).toBe(30.0);
      expect(res.recentFeedback).toHaveLength(3);
      // Newest first
      expect(res.recentFeedback[0].ticketId).toBe('t-3');
      expect(res.recentFeedback[0].comment).toBe('Took too long to answer.');
    });
  });

  describe('calculateBreakdowns', () => {
    it('computes counts and percentages by channel, priority, and tags', () => {
      const events: ReportingEvent[] = [
        {
          id: 1,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'ticket_created',
          occurred_at: '2026-10-01T10:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'urgent',
          tags: ['billing', 'vip'],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 2,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'ticket_created',
          occurred_at: '2026-10-01T11:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: ['billing'],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 3,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'ticket_created',
          occurred_at: '2026-10-01T12:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'email',
          priority: 'low',
          tags: ['support'],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
      ];

      const res = calculateBreakdowns(events);
      expect(res.channelBreakdown[0].key).toBe('chat');
      expect(res.channelBreakdown[0].count).toBe(2);
      expect(res.channelBreakdown[0].percentage).toBe(66.7);

      expect(res.priorityBreakdown).toHaveLength(3);
      const urgent = res.priorityBreakdown.find((p) => p.key === 'urgent');
      expect(urgent?.count).toBe(1);
      expect(urgent?.percentage).toBe(33.3);

      expect(res.tagBreakdown[0].key).toBe('billing');
      expect(res.tagBreakdown[0].count).toBe(2);
    });
  });

  describe('calculateBusiestHoursHeatmap', () => {
    it('slots created tickets into 7x24 matrix and identifies peak hour', () => {
      // 2026-10-07 is a Wednesday (UTC day = 3) at 14:00 UTC
      const events: ReportingEvent[] = [
        {
          id: 1,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'ticket_created',
          occurred_at: '2026-10-07T14:15:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 2,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'ticket_created',
          occurred_at: '2026-10-07T14:45:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 3,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'ticket_created',
          occurred_at: '2026-10-08T09:00:00Z', // Thursday (UTC day = 4) at 09:00
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
      ];

      const res = calculateBusiestHoursHeatmap(events);
      expect(res.heatmap).toHaveLength(7 * 24);

      const wed14 = res.heatmap.find((c) => c.dayOfWeek === 3 && c.hour === 14);
      expect(wed14?.count).toBe(2);

      const thu9 = res.heatmap.find((c) => c.dayOfWeek === 4 && c.hour === 9);
      expect(thu9?.count).toBe(1);

      expect(res.peakHour).toEqual({
        dayName: 'Wed',
        hour: 14,
        label: 'Wed at 2:00 PM',
        count: 2,
      });
    });
  });

  describe('calculateBotMetrics', () => {
    it('computes bot resolved vs bot handover rate', () => {
      const events: ReportingEvent[] = [
        {
          id: 1,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'bot_resolved',
          occurred_at: '2026-10-01T10:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 2,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'bot_resolved',
          occurred_at: '2026-10-01T11:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 3,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'bot_handover',
          occurred_at: '2026-10-01T12:00:00Z',
          agent_id: null,
          group_id: null,
          channel: 'chat',
          priority: 'high',
          tags: [],
          duration_seconds: null,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
      ];

      const res = calculateBotMetrics(events);
      expect(res.botResolvedCount).toBe(2);
      expect(res.botHandoverCount).toBe(1);
      expect(res.totalBotInquiries).toBe(3);
      // 2 / 3 = 66.7%
      expect(res.botResolutionRatePercent).toBe(66.7);
    });
  });

  describe('calculateAgentLeaderboard', () => {
    it('computes solved tickets, reply times, and CSAT per agent', () => {
      const agents = [
        { id: 'ag-1', name: 'Alice Smith', email: 'alice@example.com', role: 'agent' },
        { id: 'ag-2', name: 'Bob Jones', email: 'bob@example.com', role: 'admin' },
      ];

      const events: ReportingEvent[] = [
        // Alice: 2 solved (300s, 600s), 1 FRT (60s), 2 CSAT (good, good)
        {
          id: 1,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'first_reply',
          occurred_at: '2026-10-01',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 60,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 2,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'ticket_solved',
          occurred_at: '2026-10-01',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 300,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 3,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'ticket_solved',
          occurred_at: '2026-10-01',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 600,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 4,
          workspace_id: 'ws-1',
          ticket_id: 't-1',
          event_type: 'csat_rated',
          occurred_at: '2026-10-01',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: 'good',
          csat_comment: null,
          metadata: {},
        },
        {
          id: 5,
          workspace_id: 'ws-1',
          ticket_id: 't-2',
          event_type: 'csat_rated',
          occurred_at: '2026-10-01',
          agent_id: 'ag-1',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: 'good',
          csat_comment: null,
          metadata: {},
        },
        // Bob: 1 solved (900s), 1 FRT (120s), 1 CSAT (bad)
        {
          id: 6,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'first_reply',
          occurred_at: '2026-10-01',
          agent_id: 'ag-2',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 120,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 7,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'ticket_solved',
          occurred_at: '2026-10-01',
          agent_id: 'ag-2',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: 900,
          csat_rating: null,
          csat_comment: null,
          metadata: {},
        },
        {
          id: 8,
          workspace_id: 'ws-1',
          ticket_id: 't-3',
          event_type: 'csat_rated',
          occurred_at: '2026-10-01',
          agent_id: 'ag-2',
          group_id: null,
          channel: 'chat',
          priority: 'normal',
          tags: [],
          duration_seconds: null,
          csat_rating: 'bad',
          csat_comment: null,
          metadata: {},
        },
      ];

      const board = calculateAgentLeaderboard(events, agents);
      expect(board).toHaveLength(2);

      // Alice sorted first with 2 solved
      expect(board[0].agentId).toBe('ag-1');
      expect(board[0].solvedCount).toBe(2);
      expect(board[0].avgFrtSeconds).toBe(60);
      expect(board[0].avgResolutionSeconds).toBe(450); // (300+600)/2
      expect(board[0].medianResolutionSeconds).toBe(450);
      expect(board[0].csatPercent).toBe(100.0);

      // Bob has 1 solved
      expect(board[1].agentId).toBe('ag-2');
      expect(board[1].solvedCount).toBe(1);
      expect(board[1].csatPercent).toBe(0.0);
    });
  });

  describe('filterReportingEvents', () => {
    const events: ReportingEvent[] = [
      {
        id: 1,
        workspace_id: 'ws-1',
        ticket_id: 't-1',
        event_type: 'ticket_created',
        occurred_at: '2026-10-01',
        agent_id: 'ag-1',
        group_id: 'grp-billing',
        channel: 'chat',
        priority: 'normal',
        tags: [],
        duration_seconds: null,
        csat_rating: null,
        csat_comment: null,
        metadata: {},
      },
      {
        id: 2,
        workspace_id: 'ws-1',
        ticket_id: 't-2',
        event_type: 'ticket_created',
        occurred_at: '2026-10-01',
        agent_id: 'ag-2',
        group_id: 'grp-tech',
        channel: 'email',
        priority: 'normal',
        tags: [],
        duration_seconds: null,
        csat_rating: null,
        csat_comment: null,
        metadata: {},
      },
    ];

    it('filters by agentId', () => {
      const filtered = filterReportingEvents(events, { agentId: 'ag-1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe(1);
    });

    it('filters by groupId', () => {
      const filtered = filterReportingEvents(events, { groupId: 'grp-tech' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe(2);
    });

    it('filters by channel', () => {
      const filtered = filterReportingEvents(events, { channel: 'chat' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe(1);
    });
  });

  describe('CSV Exporters', () => {
    it('escapes CSV cells with commas, quotes, and newlines', () => {
      expect(escapeCsv('Simple')).toBe('Simple');
      expect(escapeCsv('Hello, World')).toBe('"Hello, World"');
      expect(escapeCsv('Quote "Here"')).toBe('"Quote ""Here"""');
      expect(escapeCsv('Line1\nLine2')).toBe('"Line1\nLine2"');
    });

    it('exports CreatedVsSolved to CSV', () => {
      const csv = exportCreatedVsSolvedCsv([
        { date: '2026-10-01', label: 'Oct 1', created: 5, solved: 3 },
      ]);
      expect(csv).toContain('Date,Tickets Created,Tickets Solved');
      expect(csv).toContain('2026-10-01,5,3');
    });

    it('exports Backlog to CSV', () => {
      const csv = exportBacklogCsv([
        { date: '2026-10-01', label: 'Oct 1', backlog: 14 },
      ]);
      expect(csv).toContain('Date,Active Backlog');
      expect(csv).toContain('2026-10-01,14');
    });

    it('exports Leaderboard to CSV', () => {
      const csv = exportAgentLeaderboardCsv([
        {
          agentId: 'ag-1',
          name: 'Jane Doe',
          email: 'jane@example.com',
          role: 'agent',
          solvedCount: 15,
          avgFrtSeconds: 65,
          medianFrtSeconds: 60,
          avgResolutionSeconds: 600,
          medianResolutionSeconds: 500,
          csatGood: 10,
          csatBad: 1,
          totalCsat: 11,
          csatPercent: 90.9,
        },
      ]);
      expect(csv).toContain('Agent Name,Email,Role,Solved Tickets');
      expect(csv).toContain('Jane Doe,jane@example.com,agent,15');
      expect(csv).toContain('90.9%');
    });
  });
});
