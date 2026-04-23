/**
 * 终极时刻：Cutover 切换（§3.7）—— 游戏高潮时刻。
 */
import { EventBus } from '../../core/EventBus';
import { delay } from '../../core/utils';
import type { MigrationTask } from '../MigrationStateMachine';

export interface CutoverStep {
  id: string;
  description: string;
  side: 'vmware' | 'smartx' | 'both';
  durationMs: number;
  visualEffect: string;
}

export interface BeforeAfterMetrics {
  bootTimeSeconds: { vmware: number; smartx: number };
  iopsAtPeak: { vmware: number; smartx: number };
  latencyMs: { vmware: number; smartx: number };
  memoryOverheadMB: { vmware: number; smartx: number };
  cpuOverheadPercent: { vmware: number; smartx: number };
}

export interface CutoverSequence {
  steps: CutoverStep[];
  totalDurationMs: number;
  vmwareShutdownMs: number;
  smartxBootMs: number;
  beforeAfterMetrics: BeforeAfterMetrics;
}

export const CUTOVER_STEPS: CutoverStep[] = [
  {
    id: 'stop_incremental',
    description: '停止增量同步，等待最后一批脏块传输完成',
    side: 'both',
    durationMs: 2000,
    visualEffect: 'data_cable_slowdown',
  },
  {
    id: 'vmware_shutdown',
    description: '向 VMware 源端发送关机指令',
    side: 'vmware',
    durationMs: 8000,
    visualEffect: 'rack_lights_shutdown',
  },
  {
    id: 'final_delta_sync',
    description: '同步最终增量数据（关机后产生的最后脏块）',
    side: 'both',
    durationMs: 1500,
    visualEffect: 'data_cable_final_pulse',
  },
  {
    id: 'smartx_boot',
    description: 'SmartX ELF 虚拟化平台拉起虚拟机',
    side: 'smartx',
    durationMs: 5000,
    visualEffect: 'rack_lights_boot_green',
  },
  {
    id: 'network_reconnect',
    description: '更新 DNS/ARP 表，业务IP切换至SmartX',
    side: 'smartx',
    durationMs: 1000,
    visualEffect: 'network_reroute_animation',
  },
  {
    id: 'service_verify',
    description: '自动化服务验证（HTTP探活/数据库连接测试）',
    side: 'smartx',
    durationMs: 3000,
    visualEffect: 'service_check_scanlines',
  },
];

/** 每一步开始前先与音效同步广播，确保 ±50ms 内（参见关键约束） */
export class CutoverDirector {
  async executeCutover(task: MigrationTask): Promise<BeforeAfterMetrics> {
    for (const step of CUTOVER_STEPS) {
      EventBus.emit(`fx:${step.visualEffect}`, { vmId: task.vmId });
      if (step.id === 'vmware_shutdown') EventBus.emit('audio:play', { sfx: 'cutoverClick' });
      if (step.id === 'smartx_boot') EventBus.emit('audio:play', { sfx: 'bootupChime' });

      EventBus.emit('ui:cutover_step', { stepId: step.id, status: 'running' });
      await delay(step.durationMs);
      EventBus.emit('ui:cutover_step', { stepId: step.id, status: 'done' });
    }

    const metrics = this.calculatePerformanceGains(task);
    EventBus.emit('ui:show_performance_comparison', metrics);
    EventBus.emit('fx:victory_particle_burst', { color: '#00FF88' });
    EventBus.emit('audio:play_success_fanfare');
    return metrics;
  }

  /** SmartX vs VMware 典型性能差异（演示值） */
  calculatePerformanceGains(_task: MigrationTask): BeforeAfterMetrics {
    return {
      bootTimeSeconds: { vmware: 65, smartx: 8 },
      iopsAtPeak: { vmware: 5000, smartx: 18000 },
      latencyMs: { vmware: 3.2, smartx: 0.4 },
      memoryOverheadMB: { vmware: 128, smartx: 40 },
      cpuOverheadPercent: { vmware: 6, smartx: 2 },
    };
  }
}
