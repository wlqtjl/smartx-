/**
 * CharacterController 单元测试 —— 验证 idle/walk/run 权重混合的纯函数行为。
 */
import { describe, it, expect } from 'vitest';
import { computeBlendWeights } from './CharacterController';

const sumOne = (w: { idle: number; walk: number; run: number }): number =>
  w.idle + w.walk + w.run;

describe('computeBlendWeights', () => {
  const walkT = 0.1;
  const runT = 4.5;

  it('full idle when stationary', () => {
    const w = computeBlendWeights(0, walkT, runT);
    expect(w).toEqual({ idle: 1, walk: 0, run: 0 });
  });

  it('full run at or above run threshold', () => {
    const w = computeBlendWeights(5.0, walkT, runT);
    expect(w).toEqual({ idle: 0, walk: 0, run: 1 });
  });

  it('blends idle ↔ walk in lower half of mid range', () => {
    const mid = (walkT + runT) / 2;
    const s = (walkT + mid) / 2; // halfway in the idle→walk segment
    const w = computeBlendWeights(s, walkT, runT);
    expect(w.run).toBe(0);
    expect(w.idle).toBeGreaterThan(0);
    expect(w.walk).toBeGreaterThan(0);
    expect(sumOne(w)).toBeCloseTo(1, 5);
  });

  it('blends walk ↔ run in upper half of mid range', () => {
    const mid = (walkT + runT) / 2;
    const s = (mid + runT) / 2; // halfway in the walk→run segment
    const w = computeBlendWeights(s, walkT, runT);
    expect(w.idle).toBe(0);
    expect(w.walk).toBeGreaterThan(0);
    expect(w.run).toBeGreaterThan(0);
    expect(sumOne(w)).toBeCloseTo(1, 5);
  });

  it('weights always sum to 1 across speed sweep', () => {
    for (let s = 0; s <= 6; s += 0.05) {
      expect(sumOne(computeBlendWeights(s, walkT, runT))).toBeCloseTo(1, 5);
    }
  });

  it('clamps negative speed to idle', () => {
    expect(computeBlendWeights(-1, walkT, runT)).toEqual({ idle: 1, walk: 0, run: 0 });
  });
});
