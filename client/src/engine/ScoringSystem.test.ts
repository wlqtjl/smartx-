import { describe, expect, it } from 'vitest';
import { ScoringSystem, SCORING_RULES } from './ScoringSystem';

describe('ScoringSystem', () => {
  it('starts at zero', () => {
    const s = new ScoringSystem();
    const b = s.finalize();
    expect(b.total).toBe(0);
    expect(b.bonuses).toEqual([]);
    expect(b.penalties).toEqual([]);
  });

  it('routes positive rules to bonuses and correct categories', () => {
    const s = new ScoringSystem();
    s.apply('USED_IO_LOCALITY');
    s.apply('USED_RDMA');
    s.apply('PERFECT_STORAGE_MAPPING');
    const b = s.finalize();
    const expected =
      SCORING_RULES.USED_IO_LOCALITY.points +
      SCORING_RULES.USED_RDMA.points +
      SCORING_RULES.PERFECT_STORAGE_MAPPING.points;
    expect(b.total).toBe(expected);
    expect(b.bonuses).toHaveLength(3);
    expect(b.categories.smartxFeatureUsage).toBe(expected);
  });

  it('routes negative rules to penalties', () => {
    const s = new ScoringSystem();
    s.apply('WRONG_STORAGE_TIER');
    s.apply('NETWORK_CONGESTION');
    const b = s.finalize();
    expect(b.penalties).toHaveLength(2);
    expect(b.total).toBeLessThan(0);
    expect(b.categories.correctness).toBe(SCORING_RULES.WRONG_STORAGE_TIER.points);
    expect(b.categories.businessContinuity).toBe(SCORING_RULES.NETWORK_CONGESTION.points);
  });

  it('categorizes ZERO_DOWNTIME under business continuity', () => {
    const s = new ScoringSystem();
    s.apply('ZERO_DOWNTIME');
    expect(s.finalize().categories.businessContinuity).toBe(SCORING_RULES.ZERO_DOWNTIME.points);
  });

  it('attaches examples when provided', () => {
    const s = new ScoringSystem();
    s.apply('USED_IO_LOCALITY', ['vm-db-01']);
    const b = s.finalize();
    expect(b.bonuses[0].examples).toEqual(['vm-db-01']);
  });

  it('caps speed bonus in [-150, +300]', () => {
    const fast = new ScoringSystem();
    fast.addSpeedBonus(0, 100);
    expect(fast.finalize().categories.speed).toBe(300);

    const slow = new ScoringSystem();
    slow.addSpeedBonus(1000, 100);
    expect(slow.finalize().categories.speed).toBe(-150);
  });

  it('finalize snapshots are independent copies', () => {
    const s = new ScoringSystem();
    s.apply('USED_IO_LOCALITY');
    const a = s.finalize();
    s.apply('USED_RDMA');
    const b = s.finalize();
    expect(a.total).not.toBe(b.total);
    expect(a.bonuses).toHaveLength(1);
    expect(b.bonuses).toHaveLength(2);
  });
});
