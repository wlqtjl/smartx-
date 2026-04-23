/**
 * 阶段五：DATA_SYNC —— 服务端权威的 tick 驱动数据同步。
 */
import type { MigrationTask } from '@shared/index';
import { EventBus } from '../../core/EventBus.js';
import { delay } from '../../core/utils.js';

export interface SyncChallengeResponse {
  id: string;
  label: string;
  isSmartXWay: boolean;
  scoreBonus: number;
  effect: string;
}

export interface SyncChallenge {
  type: 'NETWORK_JITTER' | 'STORAGE_QUEUE_FULL' | 'SOURCE_VM_SPIKE' | 'BANDWIDTH_STOLEN';
  severity: 'low' | 'medium' | 'high';
  description: string;
  responses: SyncChallengeResponse[];
  timeoutSeconds: number;
}

export const SYNC_CHALLENGES: SyncChallenge[] = [
  {
    type: 'NETWORK_JITTER',
    severity: 'medium',
    description: '检测到网络抖动，数据包丢失率 3%，传输速度下降40%',
    timeoutSeconds: 30,
    responses: [
      {
        id: 'smartx_retry',
        label: '启用SmartX智能断点续传',
        isSmartXWay: true,
        scoreBonus: 100,
        effect: '自动记录传输偏移量，网络恢复后从断点继续，无需重传',
      },
      {
        id: 'restart_transfer',
        label: '重新开始全量传输',
        isSmartXWay: false,
        scoreBonus: -50,
        effect: '重置进度，浪费已传输数据',
      },
      {
        id: 'wait_network',
        label: '等待网络自愈',
        isSmartXWay: false,
        scoreBonus: 20,
        effect: '消极等待，时间成本较高',
      },
    ],
  },
  {
    type: 'BANDWIDTH_STOLEN',
    severity: 'high',
    description: '迁移流量占满 10GbE 上行，生产业务延迟升至 80ms！',
    timeoutSeconds: 20,
    responses: [
      {
        id: 'smartx_qos',
        label: '使用带宽调速器限制迁移至30%带宽',
        isSmartXWay: true,
        scoreBonus: 120,
        effect: '迁移带宽降至 3Gbps，生产延迟恢复正常，迁移继续',
      },
      {
        id: 'pause_migration',
        label: '暂停迁移任务',
        isSmartXWay: false,
        scoreBonus: 30,
        effect: '业务恢复，但迁移时间大幅增加',
      },
    ],
  },
];

/**
 * 服务端固定的 tick 周期（ms）。
 * 安全性：定时器的周期必须为模块常量，不能来自外部输入，
 * 否则会触发 CodeQL `js/resource-exhaustion`（用户可控定时器周期）风险。
 */
const TICK_MS = 200;

export class DataSyncPhase {
  private handle: NodeJS.Timeout | null = null;

  start(task: MigrationTask, speedMbps = 800): void {
    this.stop();
    // 速度参数允许客户端建议，但严格限定在安全范围。
    const speedInRange =
      Number.isFinite(speedMbps) && speedMbps >= 1 && speedMbps <= 100_000;
    const safeSpeedMbps: number = speedInRange ? speedMbps : 800;

    const totalBytes = task.progress.dataTotalGB * 1024 ** 3;
    const bytesPerTick = ((safeSpeedMbps * 1_000_000) / 8) * (TICK_MS / 1000);

    task.progress.transferSpeedMbps = safeSpeedMbps;

    EventBus.emit('fx:data_cable_visual', {
      pulsesPerSecond: Math.round(safeSpeedMbps / 50),
      cableColor: '#0088FF',
      cableThickness: Math.min(0.2, 0.05 + safeSpeedMbps / 20000),
      particleCount: Math.min(200, Math.round(safeSpeedMbps / 10)),
    });

    const tick = (): void => {
      if (task.state === 'PAUSED_NETWORK_FAULT' || task.state === 'PAUSED_STORAGE_FAULT') return;

      const transferredBytes = task.progress.dataTransferredGB * 1024 ** 3 + bytesPerTick;
      task.progress.dataTransferredGB = Math.min(totalBytes, transferredBytes) / 1024 ** 3;
      task.progress.fullSyncPercent = Math.min(
        100,
        (task.progress.dataTransferredGB / task.progress.dataTotalGB) * 100,
      );
      const remainBytes = totalBytes - transferredBytes;
      task.progress.etaSeconds = Math.max(0, remainBytes / ((safeSpeedMbps * 1_000_000) / 8));
      EventBus.emit('migration:progress', { taskId: task.id, progress: task.progress });

      if (task.progress.fullSyncPercent >= 100) this.stop();
    };

    // tick 周期为模块常量，不受调用方控制，避免 js/resource-exhaustion。
    this.handle = setInterval(tick, TICK_MS);
    // Allow process to exit even if this interval is pending (avoid hanging tests).
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  triggerRandomChallenge(): SyncChallenge | null {
    if (SYNC_CHALLENGES.length === 0) return null;
    const ch = SYNC_CHALLENGES[Math.floor(Math.random() * SYNC_CHALLENGES.length)];
    EventBus.emit('ui:show_sync_challenge', ch);
    return ch;
  }

  async runIncrementalRounds(task: MigrationTask, maxRounds = 4): Promise<void> {
    let lag = 2000;
    for (let i = 1; i <= maxRounds; i++) {
      await delay(300);
      lag = Math.max(80, Math.round(lag * 0.45));
      task.progress.incrementalRounds = i;
      EventBus.emit('migration:incrementalRound', {
        taskId: task.id,
        round: i,
        syncLag: lag,
      });
      if (lag < 100) break;
    }
  }
}
