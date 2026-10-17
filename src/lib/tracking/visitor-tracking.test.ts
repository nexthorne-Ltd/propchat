import { describe, expect, it } from 'vitest';
import {
  isVisitorOnline,
  filterOnlineVisitors,
  formatTimeOnPage,
  calculateTimeOnPage,
  shouldThrottleNavigation,
  formatPageDisplay,
  ONLINE_PRESENCE_WINDOW_SECONDS,
  ROUTE_CHANGE_THROTTLE_MS,
} from './visitor-tracking';

describe('visitor-tracking core logic', () => {
  const BASE_TIME = new Date('2026-10-10T12:00:00.000Z').getTime();

  describe('isVisitorOnline', () => {
    it('returns false for null or undefined visitor', () => {
      expect(isVisitorOnline(null, BASE_TIME)).toBe(false);
      expect(isVisitorOnline(undefined, BASE_TIME)).toBe(false);
    });

    it('returns false immediately when is_online is explicitly false (tab closed / offline beacon)', () => {
      const visitor = {
        is_online: false,
        last_seen: new Date(BASE_TIME - 5000).toISOString(), // 5s ago
      };
      expect(isVisitorOnline(visitor, BASE_TIME)).toBe(false);
    });

    it('returns false when last_seen timestamp is missing or invalid', () => {
      expect(isVisitorOnline({ is_online: true }, BASE_TIME)).toBe(false);
      expect(isVisitorOnline({ is_online: true, last_seen: 'invalid-date' }, BASE_TIME)).toBe(false);
    });

    it('returns true when visitor sent a heartbeat within the 90-second window', () => {
      const visitor = {
        is_online: true,
        last_seen: new Date(BASE_TIME - 30000).toISOString(), // 30s ago
      };
      expect(isVisitorOnline(visitor, BASE_TIME)).toBe(true);
    });

    it('returns false when visitor heartbeat is 90 seconds or older (expiry)', () => {
      const exactly90sAgo = {
        is_online: true,
        last_seen: new Date(BASE_TIME - 90000).toISOString(),
      };
      const olderThan90s = {
        is_online: true,
        last_seen: new Date(BASE_TIME - 120000).toISOString(), // 2 mins ago
      };
      expect(isVisitorOnline(exactly90sAgo, BASE_TIME)).toBe(false);
      expect(isVisitorOnline(olderThan90s, BASE_TIME)).toBe(false);
    });

    it('supports last_seen_at column alias', () => {
      const visitor = {
        is_online: true,
        last_seen_at: new Date(BASE_TIME - 15000).toISOString(), // 15s ago
      };
      expect(isVisitorOnline(visitor, BASE_TIME)).toBe(true);
    });

    it('respects custom windowSeconds', () => {
      const visitor = {
        is_online: true,
        last_seen: new Date(BASE_TIME - 45000).toISOString(), // 45s ago
      };
      expect(isVisitorOnline(visitor, BASE_TIME, 60)).toBe(true);
      expect(isVisitorOnline(visitor, BASE_TIME, 30)).toBe(false);
    });
  });

  describe('filterOnlineVisitors', () => {
    it('filters out offline and expired visitors, keeping only live ones', () => {
      const visitors = [
        { id: '1', is_online: true, last_seen: new Date(BASE_TIME - 10000).toISOString() }, // Online (10s)
        { id: '2', is_online: false, last_seen: new Date(BASE_TIME - 5000).toISOString() }, // Offline (explicit)
        { id: '3', is_online: true, last_seen: new Date(BASE_TIME - 100000).toISOString() }, // Expired (>90s)
        { id: '4', is_online: true, last_seen_at: new Date(BASE_TIME - 25000).toISOString() }, // Online (25s)
      ];

      const active = filterOnlineVisitors(visitors, BASE_TIME);
      expect(active.map((v) => v.id)).toEqual(['1', '4']);
    });
  });

  describe('formatTimeOnPage', () => {
    it('formats 0, negative, null, or undefined as 0s', () => {
      expect(formatTimeOnPage(0)).toBe('0s');
      expect(formatTimeOnPage(-5)).toBe('0s');
      expect(formatTimeOnPage(null)).toBe('0s');
      expect(formatTimeOnPage(undefined)).toBe('0s');
      expect(formatTimeOnPage(NaN)).toBe('0s');
    });

    it('formats seconds under one minute', () => {
      expect(formatTimeOnPage(1)).toBe('1s');
      expect(formatTimeOnPage(14)).toBe('14s');
      expect(formatTimeOnPage(59)).toBe('59s');
    });

    it('formats minutes and seconds', () => {
      expect(formatTimeOnPage(60)).toBe('1m');
      expect(formatTimeOnPage(65)).toBe('1m 5s');
      expect(formatTimeOnPage(155)).toBe('2m 35s');
      expect(formatTimeOnPage(360)).toBe('6m');
      expect(formatTimeOnPage(3599)).toBe('59m 59s');
    });

    it('formats hours and minutes', () => {
      expect(formatTimeOnPage(3600)).toBe('1h');
      expect(formatTimeOnPage(4320)).toBe('1h 12m');
      expect(formatTimeOnPage(7200)).toBe('2h');
    });
  });

  describe('calculateTimeOnPage', () => {
    it('calculates elapsed seconds from enteredAt timestamp', () => {
      const enteredAt = new Date(BASE_TIME - 45000).toISOString(); // entered 45s ago
      expect(calculateTimeOnPage(enteredAt, 0, BASE_TIME)).toBe(45);
    });

    it('falls back to fallbackSeconds if enteredAt is missing or invalid', () => {
      expect(calculateTimeOnPage(null, 18, BASE_TIME)).toBe(18);
      expect(calculateTimeOnPage('invalid', 25, BASE_TIME)).toBe(25);
    });

    it('guards against future timestamps', () => {
      const futureStamp = new Date(BASE_TIME + 10000).toISOString();
      expect(calculateTimeOnPage(futureStamp, 10, BASE_TIME)).toBe(10);
    });
  });

  describe('shouldThrottleNavigation', () => {
    it('throttles when newUrl is missing or identical to previousUrl', () => {
      expect(shouldThrottleNavigation('https://site.com/app', '', BASE_TIME, BASE_TIME)).toBe(true);
      expect(shouldThrottleNavigation('https://site.com/app', 'https://site.com/app', BASE_TIME, BASE_TIME)).toBe(true);
    });

    it('throttles rapid route transitions under 500ms debounce threshold', () => {
      const lastNav = BASE_TIME;
      const rapidNav = BASE_TIME + 250; // 250ms elapsed (< 500ms)
      expect(
        shouldThrottleNavigation('https://site.com/page1', 'https://site.com/page2', lastNav, rapidNav, ROUTE_CHANGE_THROTTLE_MS)
      ).toBe(true);
    });

    it('allows valid route transition after throttle window has elapsed', () => {
      const lastNav = BASE_TIME;
      const validNav = BASE_TIME + 600; // 600ms elapsed (> 500ms)
      expect(
        shouldThrottleNavigation('https://site.com/page1', 'https://site.com/page2', lastNav, validNav, ROUTE_CHANGE_THROTTLE_MS)
      ).toBe(false);
    });
  });

  describe('formatPageDisplay', () => {
    it('formats absolute URLs with pathname, domain, and title', () => {
      const formatted = formatPageDisplay('https://acme.org/docs/billing?ref=nav#plans', 'Billing Documentation');
      expect(formatted).toEqual({
        url: 'https://acme.org/docs/billing?ref=nav#plans',
        path: '/docs/billing?ref=nav#plans',
        domain: 'acme.org',
        title: 'Billing Documentation',
      });
    });

    it('derives default title from path when raw title is empty', () => {
      const formatted = formatPageDisplay('https://acme.org/pricing');
      expect(formatted.title).toBe('/pricing');
      expect(formatted.path).toBe('/pricing');
      expect(formatted.domain).toBe('acme.org');
    });

    it('handles root URL appropriately', () => {
      const formatted = formatPageDisplay('https://acme.org/');
      expect(formatted.title).toBe('Home');
      expect(formatted.path).toBe('/');
    });

    it('handles relative paths', () => {
      const formatted = formatPageDisplay('/settings/team', 'Team Settings');
      expect(formatted.domain).toBe('');
      expect(formatted.path).toBe('/settings/team');
      expect(formatted.title).toBe('Team Settings');
    });
  });
});
