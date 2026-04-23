import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScoringSystem } from '../src/simulation/ScoringSystem.js';

test('scoring: positive rules go into bonuses and smartxFeatureUsage', () => {
  const s = new ScoringSystem();
  s.apply('USED_RDMA');
  s.apply('USED_IO_LOCALITY');
  s.apply('PERFECT_STORAGE_MAPPING');
  const r = s.finalize();
  assert.equal(r.total, 200 + 150 + 200);
  assert.equal(r.categories.smartxFeatureUsage, 200 + 150 + 200);
  assert.equal(r.bonuses.length, 3);
  assert.equal(r.penalties.length, 0);
});

test('scoring: penalties are routed correctly', () => {
  const s = new ScoringSystem();
  s.apply('WRONG_STORAGE_TIER');
  s.apply('WRONG_NETWORK_MAPPING');
  s.apply('NETWORK_CONGESTION');
  const r = s.finalize();
  assert.equal(r.total, -200 - 300 - 100);
  assert.equal(r.categories.correctness, -200 - 300);
  assert.equal(r.categories.businessContinuity, -100);
  assert.equal(r.penalties.length, 3);
});

test('scoring: speed bonus is clamped', () => {
  const fast = new ScoringSystem();
  fast.addSpeedBonus(0, 100); // best case: still clamped to 300
  assert.equal(fast.finalize().categories.speed, 300);

  const slow = new ScoringSystem();
  slow.addSpeedBonus(1000, 100); // worst case: clamped to -150
  assert.equal(slow.finalize().categories.speed, -150);
});
