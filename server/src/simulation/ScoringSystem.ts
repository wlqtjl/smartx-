/**
 * 评分系统（服务端权威）
 */
import {
  SCORING_RULES,
  type ScoreBonus,
  type ScoreBreakdown,
  type ScorePenalty,
  type ScoringRuleKey,
} from '@shared/index';
import { clamp } from '../core/utils.js';

export class ScoringSystem {
  private bonuses: ScoreBonus[] = [];
  private penalties: ScorePenalty[] = [];
  private category = { speed: 0, correctness: 0, businessContinuity: 0, smartxFeatureUsage: 0 };

  apply(rule: ScoringRuleKey, examples?: string[]): void {
    const r = SCORING_RULES[rule];
    if (r.points >= 0) this.bonuses.push({ reason: r.reason, points: r.points, examples });
    else this.penalties.push({ reason: r.reason, points: r.points });

    if (rule.startsWith('USED_') || rule === 'PERFECT_STORAGE_MAPPING') {
      this.category.smartxFeatureUsage += r.points;
    } else if (rule === 'ZERO_DOWNTIME' || rule === 'NETWORK_CONGESTION') {
      this.category.businessContinuity += r.points;
    } else if (rule === 'WRONG_STORAGE_TIER' || rule === 'WRONG_NETWORK_MAPPING') {
      this.category.correctness += r.points;
    } else {
      this.category.speed += r.points;
    }
  }

  addSpeedBonus(completionSeconds: number, parSeconds: number): void {
    const delta = Math.round(((parSeconds - completionSeconds) / parSeconds) * 300);
    const points = clamp(delta, -150, 300);
    this.category.speed += points;
    if (points >= 0) this.bonuses.push({ reason: `比基准时间快 ${parSeconds - completionSeconds}s`, points });
    else this.penalties.push({ reason: '比基准时间慢', points });
  }

  finalize(): ScoreBreakdown {
    return {
      total: Object.values(this.category).reduce((s, v) => s + v, 0),
      categories: { ...this.category },
      bonuses: [...this.bonuses],
      penalties: [...this.penalties],
    };
  }

  reset(): void {
    this.bonuses = [];
    this.penalties = [];
    this.category = { speed: 0, correctness: 0, businessContinuity: 0, smartxFeatureUsage: 0 };
  }
}

/** Per-task scoring registry. */
export class ScoringRegistry {
  private map = new Map<string, ScoringSystem>();

  for(taskId: string): ScoringSystem {
    let s = this.map.get(taskId);
    if (!s) {
      s = new ScoringSystem();
      this.map.set(taskId, s);
    }
    return s;
  }

  peek(taskId: string): ScoringSystem | undefined {
    return this.map.get(taskId);
  }

  delete(taskId: string): void {
    this.map.delete(taskId);
  }
}
