/**
 * 评分系统 —— §七
 * 与真实迁移质量绑定：速度 / 正确性 / 业务连续性 / SmartX 功能使用。
 */
export interface ScoreBonus {
  reason: string;
  points: number;
  examples?: string[];
}

export interface ScorePenalty {
  reason: string;
  points: number; // 负数
}

export interface ScoreBreakdown {
  total: number;
  categories: {
    speed: number;
    correctness: number;
    businessContinuity: number;
    smartxFeatureUsage: number;
  };
  bonuses: ScoreBonus[];
  penalties: ScorePenalty[];
}

export const SCORING_RULES = {
  USED_IO_LOCALITY: { points: +150, reason: '启用I/O本地化，延迟降低30%' },
  USED_RDMA: { points: +200, reason: '启用RDMA加速，吞吐提升2x' },
  USED_CHECKPOINT_RESUME: { points: +150, reason: '使用断点续传，节省重传时间' },
  USED_BANDWIDTH_LIMITER: { points: +100, reason: '合理控制迁移带宽，保障生产业务' },
  PERFECT_STORAGE_MAPPING: { points: +200, reason: '所有VM存储配置完全匹配工作负载类型' },
  ZERO_DOWNTIME: { points: +300, reason: '迁移全程业务零中断' },
  AGENTLESS_AWARENESS: { points: +50, reason: '未尝试在源VM安装任何agent（理解Agentless特性）' },
  // 故障注入修复奖励（与 SmartX 卖点正向耦合）
  FIXED_FAULT_SNAPSHOT: { points: +120, reason: '使用快照枪合并未提交快照，恢复迁移速度' },
  FIXED_FAULT_MTU: { points: +120, reason: '使用光纤跳线工具修正 MTU=9000，吞吐恢复' },
  FIXED_FAULT_RDMA: { points: +150, reason: '使用诊断平板触发驱动注入，RDMA 加速恢复' },
  WRONG_STORAGE_TIER: { points: -200, reason: '数据库VM放置到HDD存储池，性能严重下降' },
  IGNORED_SNAPSHOT_WARNING: { points: -100, reason: '未合并快照直接迁移，速度降低40%' },
  IGNORED_FAULT_MTU: { points: -120, reason: '忽略 MTU 不匹配，迁移期出现大包丢失' },
  IGNORED_FAULT_RDMA: { points: -150, reason: '忽略 RDMA 驱动缺失，存储 I/O 退回 TCP' },
  MANUAL_RESTART_TRANSFER: { points: -150, reason: '网络中断后选择重新传输，而非断点续传' },
  NETWORK_CONGESTION: { points: -100, reason: '迁移带宽未限速，导致生产业务延迟飙升' },
  WRONG_NETWORK_MAPPING: { points: -300, reason: '网络映射错误，VM启动后网络不通' },
} as const;

export type ScoringRuleKey = keyof typeof SCORING_RULES;

export class ScoringSystem {
  private bonuses: ScoreBonus[] = [];
  private penalties: ScorePenalty[] = [];

  private categoryScore = {
    speed: 0,
    correctness: 0,
    businessContinuity: 0,
    smartxFeatureUsage: 0,
  };

  apply(rule: ScoringRuleKey, examples?: string[]): void {
    const r = SCORING_RULES[rule];
    if (r.points >= 0) {
      this.bonuses.push({ reason: r.reason, points: r.points, examples });
    } else {
      this.penalties.push({ reason: r.reason, points: r.points });
    }
    // 简化归类：根据规则名推断分类权重
    if (rule.startsWith('USED_') || rule === 'PERFECT_STORAGE_MAPPING' || rule.startsWith('FIXED_FAULT_')) {
      this.categoryScore.smartxFeatureUsage += r.points;
    } else if (rule === 'ZERO_DOWNTIME' || rule === 'NETWORK_CONGESTION') {
      this.categoryScore.businessContinuity += r.points;
    } else if (
      rule === 'WRONG_STORAGE_TIER' ||
      rule === 'WRONG_NETWORK_MAPPING' ||
      rule.startsWith('IGNORED_FAULT_')
    ) {
      this.categoryScore.correctness += r.points;
    } else {
      this.categoryScore.speed += r.points;
    }
  }

  /** 根据完成时间增加速度分（越快分越高，上限 300） */
  addSpeedBonus(completionSeconds: number, parSeconds: number): void {
    const delta = Math.round(((parSeconds - completionSeconds) / parSeconds) * 300);
    const points = Math.max(-150, Math.min(300, delta));
    this.categoryScore.speed += points;
    if (points >= 0) {
      this.bonuses.push({ reason: `比基准时间快 ${parSeconds - completionSeconds}s`, points });
    } else {
      this.penalties.push({ reason: `比基准时间慢`, points });
    }
  }

  finalize(): ScoreBreakdown {
    const total = Object.values(this.categoryScore).reduce((s, v) => s + v, 0);
    return {
      total,
      categories: { ...this.categoryScore },
      bonuses: [...this.bonuses],
      penalties: [...this.penalties],
    };
  }
}
