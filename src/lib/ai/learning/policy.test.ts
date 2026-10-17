import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}), hasServiceRole: () => true }));

import { chooseArm, DEFAULT_ARM, POLICY_ARMS, sampleBeta, type ArmPosterior } from './policy';

/** Deterministic generator (mulberry32) so the tests do not flake. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sampleBeta', () => {
  it('has the right mean', () => {
    const rng = seeded(1);
    for (const [a, b] of [[2, 8], [9, 1], [0.5, 0.5], [30, 30]]) {
      let sum = 0;
      for (let i = 0; i < 20_000; i++) sum += sampleBeta(a, b, rng);
      expect(sum / 20_000).toBeCloseTo(a / (a + b), 1);
    }
  });

  it('stays within 0 and 1', () => {
    const rng = seeded(2);
    for (let i = 0; i < 2000; i++) {
      const x = sampleBeta(0.3, 0.7, rng);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });
});

describe('chooseArm', () => {
  it('starts mostly from the default', () => {
    const rng = seeded(3);
    const picks = Array.from({ length: 1000 }, () => chooseArm([], rng));
    const share = picks.filter((p) => p === DEFAULT_ARM).length / picks.length;
    expect(share).toBeGreaterThan(0.6);
    // ...but still explores the others.
    expect(new Set(picks).size).toBe(3);
  });

  it('settles on the arm visitors respond to best', () => {
    const rng = seeded(4);
    const posteriors: ArmPosterior[] = [
      { arm: 'strict', alpha: 20, beta: 30, pulls: 50 },
      { arm: 'standard', alpha: 25, beta: 25, pulls: 50 },
      { arm: 'open', alpha: 45, beta: 5, pulls: 50 },
    ];
    const picks = Array.from({ length: 500 }, () => chooseArm(posteriors, rng));
    expect(picks.filter((p) => p === 'open').length / picks.length).toBeGreaterThan(0.95);
  });

  it('never leaves the fixed, bounded settings', () => {
    for (const arm of Object.values(POLICY_ARMS)) {
      expect(arm.similarity).toBeGreaterThanOrEqual(0.6);
      expect(arm.combined).toBeGreaterThanOrEqual(0.5);
    }
  });
});
