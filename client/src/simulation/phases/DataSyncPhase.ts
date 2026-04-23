/**
 * 阶段五：块级数据同步（DATA_SYNC）—— §3.5
 * 分全量 / 增量；期间随机触发挑战事件（抖动、带宽挤占等）。
 */
import * as THREE from 'three';
import { EventBus } from '../../core/EventBus';
import { delay } from '../../core/utils';
import type { MigrationTask } from '../MigrationStateMachine';

export interface DataSyncState {
  taskId: string;
  vmId: string;
  phase: 'FULL_SYNC' | 'INCREMENTAL_SYNC';
  fullSync: {
    totalBlocks: number;
    transferredBlocks: number;
    speedMbps: number;
    estimatedRemainSeconds: number;
    agentless: true;
  };
  incrementalSync: {
    rounds: number;
    dirtiedBlocksPerSecond: number;
    syncLag: number;
    readyToCutover: boolean;
  };
  activeChallenge: SyncChallenge | null;
}

export interface ChallengeResponse {
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
  responses: ChallengeResponse[];
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

export interface DataCableVisual {
  sourcePosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  pulsesPerSecond: number;
  cableColor: string;
  cableThickness: number;
  particleCount: number;
}

export class DataSyncPhase {
  private tickHandle: number | null = null;

  /** 推进传输；tickMs 为模拟时钟步长（默认 200ms） */
  start(task: MigrationTask, speedMbps = 800, tickMs = 200): void {
    this.stop();
    const totalBytes = task.progress.dataTotalGB * 1024 ** 3;
    const bytesPerTick = ((speedMbps * 1_000_000) / 8) * (tickMs / 1000);

    task.progress.transferSpeedMbps = speedMbps;
    const visual: DataCableVisual = {
      sourcePosition: new THREE.Vector3(-5, 1.5, 0),
      targetPosition: new THREE.Vector3(5, 1.5, 0),
      pulsesPerSecond: Math.round(speedMbps / 50),
      cableColor: '#0088FF',
      cableThickness: Math.min(0.2, 0.05 + speedMbps / 20000),
      particleCount: Math.min(200, Math.round(speedMbps / 10)),
    };
    EventBus.emit('fx:data_cable_visual', visual);

    const tick = (): void => {
      if (task.state === 'PAUSED_NETWORK_FAULT' || task.state === 'PAUSED_STORAGE_FAULT') return;

      const transferredBytes = task.progress.dataTransferredGB * 1024 ** 3 + bytesPerTick;
      task.progress.dataTransferredGB = Math.min(totalBytes, transferredBytes) / 1024 ** 3;
      task.progress.fullSyncPercent = Math.min(
        100,
        (task.progress.dataTransferredGB / task.progress.dataTotalGB) * 100,
      );
      const remainBytes = totalBytes - transferredBytes;
      task.progress.etaSeconds = Math.max(0, remainBytes / ((speedMbps * 1_000_000) / 8));
      EventBus.emit('migration:progress', { taskId: task.id, progress: task.progress });
    };

    this.tickHandle = window.setInterval(tick, tickMs);
  }

  stop(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** 随机挑战事件触发（游戏节奏控制） */
  triggerRandomChallenge(): SyncChallenge | null {
    if (SYNC_CHALLENGES.length === 0) return null;
    const ch = SYNC_CHALLENGES[Math.floor(Math.random() * SYNC_CHALLENGES.length)];
    EventBus.emit('ui:show_sync_challenge', ch);
    return ch;
  }

  /** 模拟增量同步：N 轮，直到同步延迟 < 100 块 */
  async runIncrementalRounds(task: MigrationTask, maxRounds = 4): Promise<void> {
    let lag = 2000;
    for (let i = 1; i <= maxRounds; i++) {
      await delay(800);
      lag = Math.max(80, Math.round(lag * 0.45));
      task.progress.incrementalRounds = i;
      EventBus.emit('migration:incrementalRound', { taskId: task.id, round: i, syncLag: lag });
      if (lag < 100) break;
    }
  }
}
