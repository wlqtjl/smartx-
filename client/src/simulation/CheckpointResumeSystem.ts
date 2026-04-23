/**
 * 断点续传系统 —— §4
 * 体现 SmartX 相对 VMware 热迁移中断必须重头开始的优势。
 */
import { EventBus } from '../core/EventBus';
import { socketClient } from '../net/socketClient';
import { UIManager } from '../ui/UIManager';
import type { DiscoveredVM } from './phases/EnvScanPhase';
import type { NetworkMapping } from './phases/NetworkMappingPhase';
import type { StorageMapping } from './phases/StorageMappingPhase';
import type { MigrationTask } from './MigrationStateMachine';

export interface MigrationCheckpoint {
  taskId: string;
  vmId: string;
  timestamp: number;
  lastCompletedBlockOffset: number;
  transferredBlocks: number[];
  totalBlocks: number;
  networkMetricsAtFailure: {
    packetLoss: number;
    jitterMs: number;
    failureReason: string;
  };
  cachedVMMetadata: DiscoveredVM | null;
  networkMappingSnapshot: NetworkMapping | null;
  storageMappingSnapshot: StorageMapping | null;
}

export type ResumeStrategy = 'FROM_CHECKPOINT' | 'RESTART_INCREMENTAL' | 'FULL_RESTART';

const BLOCK_SIZE_BYTES = 4 * 1024 * 1024; // 4MB/块
const BLOCK_SIZE_MB = 4;
/** 演示用固定估算速率（MB/s），用于计算续传节省时间 */
const EXPECTED_TRANSFER_SPEED_MBPS = 800;

export class CheckpointResumeSystem {
  private checkpoints: Map<string, MigrationCheckpoint[]> = new Map();

  /** 每 60 秒由调度器调用 */
  saveCheckpoint(task: MigrationTask): MigrationCheckpoint {
    const totalBlocks = Math.ceil(
      (task.progress.dataTotalGB * 1024 ** 3) / BLOCK_SIZE_BYTES,
    );
    const completedBlocks = Math.floor(
      (task.progress.dataTransferredGB * 1024 ** 3) / BLOCK_SIZE_BYTES,
    );

    const checkpoint: MigrationCheckpoint = {
      taskId: task.id,
      vmId: task.vmId,
      timestamp: Date.now(),
      lastCompletedBlockOffset: completedBlocks * BLOCK_SIZE_BYTES,
      transferredBlocks: Array.from({ length: completedBlocks }, (_, i) => i),
      totalBlocks,
      networkMetricsAtFailure: { packetLoss: 0, jitterMs: 0, failureReason: '' },
      cachedVMMetadata: null,
      networkMappingSnapshot: task.networkMapping,
      storageMappingSnapshot: task.storageMapping,
    };

    const history = this.checkpoints.get(task.id) ?? [];
    history.push(checkpoint);
    // 仅保留最近 5 个断点（与文档一致）
    this.checkpoints.set(task.id, history.slice(-5));
    socketClient.emit('checkpoint:save', checkpoint);
    return checkpoint;
  }

  getHistory(taskId: string): MigrationCheckpoint[] {
    return this.checkpoints.get(taskId) ?? [];
  }

  /** 计算断点续传节省的时间（用于游戏弹窗展示 SmartX 优势） */
  calculateTimeSaved(checkpoint: MigrationCheckpoint): {
    savedPercent: number;
    savedMinutes: number;
    vmwareWouldRestartFrom: string;
  } {
    const progress =
      checkpoint.totalBlocks === 0
        ? 0
        : checkpoint.transferredBlocks.length / checkpoint.totalBlocks;
    // 按固定估算速率计算
    const totalEstimatedMinutes =
      (checkpoint.totalBlocks * BLOCK_SIZE_MB) / 1024 / EXPECTED_TRANSFER_SPEED_MBPS * 60;
    return {
      savedPercent: Math.round(progress * 100),
      savedMinutes: Math.round(progress * totalEstimatedMinutes),
      vmwareWouldRestartFrom: '0%',
    };
  }

  /** 网络故障剧情：保存断点 → 弹窗选项 → 执行续传/重传 */
  async handleNetworkFault(
    task: MigrationTask,
    faultType: 'link_down' | 'packet_loss' | 'timeout',
  ): Promise<ResumeStrategy> {
    this.saveCheckpoint(task);
    const checkpoint = this.getLatestCheckpoint(task.id);
    if (!checkpoint) throw new Error('无法创建断点');

    EventBus.emit('fx:data_cable_break', { taskId: task.id, faultType });
    EventBus.emit('ui:show_fault_dialog', {
      title: '网络中断！',
      description: `已安全保存迁移进度（${Math.round(task.progress.fullSyncPercent)}%）`,
      options: [
        { id: 'resume', label: '网络恢复后自动续传', recommended: true, isSmartXWay: true },
        { id: 'restart', label: '重新开始传输', recommended: false, isSmartXWay: false },
      ],
    });

    const choice = await UIManager.waitForUserChoice(['resume', 'restart']);

    if (choice === 'resume') {
      const saved = this.calculateTimeSaved(checkpoint);
      EventBus.emit('ui:show_resume_summary', {
        message: `✅ 断点续传：跳过已完成的 ${saved.savedPercent}% 数据，节省 ${saved.savedMinutes} 分钟`,
        vmwareComparison: 'VMware 热迁移中断后需要从 0% 重新开始',
      });
      await this.resumeFromCheckpoint(task, checkpoint);
      return 'FROM_CHECKPOINT';
    }

    EventBus.emit('ui:show_penalty', {
      message: '进度归零。SmartX 的断点续传功能可以避免此类浪费。',
      scorePenalty: -200,
    });
    await this.restartTransfer(task);
    return 'FULL_RESTART';
  }

  private getLatestCheckpoint(taskId: string): MigrationCheckpoint | null {
    const history = this.checkpoints.get(taskId);
    return history && history.length > 0 ? history[history.length - 1] : null;
  }

  private async resumeFromCheckpoint(
    task: MigrationTask,
    checkpoint: MigrationCheckpoint,
  ): Promise<void> {
    EventBus.emit('fx:data_cable_reconnect', { taskId: task.id });
    socketClient.emit('migration:resume', {
      taskId: task.id,
      checkpointOffset: checkpoint.lastCompletedBlockOffset,
    });
  }

  private async restartTransfer(task: MigrationTask): Promise<void> {
    task.progress.dataTransferredGB = 0;
    task.progress.fullSyncPercent = 0;
    socketClient.emit('migration:restart', { taskId: task.id });
  }
}
